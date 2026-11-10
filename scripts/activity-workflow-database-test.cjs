const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const withAssessmentPlan = process.argv.includes('--with-assessment-plan');
const withExamGrades = process.argv.includes('--with-exam-grades');
const withReportCards = process.argv.includes('--with-report-cards');
const containerName = `uniconnect-workflow-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const peers = [];
let sequence = 1000;
let checks = 0;
let db;
let config;
let containerId;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const scalar = async (sql, params, client = db) => (await client.query(sql, params)).rows[0].result;
async function rejected(sql, params, code, client = db) {
  await assert.rejects(client.query(sql, params), (error) => { assert.equal(error.code, code, error.message); return true; }, `${code}: ${sql}`);
  checks++;
}
async function member(role, tenant = uuid(1), active = true) {
  const auth = uuid(sequence++);
  const id = uuid(sequence++);
  const email = `synthetic-${sequence}@example.invalid`;
  await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,clock_timestamp())', [auth, email]);
  await db.query('insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) values ($1,$2,$3,$4,$5,$6,$7)', [id, tenant, auth, 'Synthetic', email, role, active]);
  return { id, auth };
}
const manageSql = 'select manage_academic_activity($1,$2,$3,$4,$5,$6) as result';
const submitSql = 'select submit_activity_answer($1,$2,$3,$4,$5) as result';
const reviewSql = 'select review_activity_submission($1,$2,$3,$4,$5,$6,$7,$8) as result';
const publishSql = 'select publish_activity_review($1,$2,$3,$4) as result';
const manualGradeSql = 'select record_activity_grade($1,$2,$3,$4,$5,$6) as result';
const manage = (actor, operation, activity, payload = {}, classId = uuid(40), client = db) => scalar(manageSql, [uuid(1), actor.id, operation, activity, classId, payload], client);
const create = (actor, payload = {}) => manage(actor, 'create', null, { title: 'Synthetic task', ...payload });
const submit = (student, activity, version = 0, answer = 'Synthetic answer', client = db) => scalar(submitSql, [uuid(1), student.id, activity, version, answer], client);
const review = (teacher, submission, revision = 0, version = 1, grade = null, feedback = null, publish = false, client = db) => scalar(reviewSql, [uuid(1), teacher.id, submission, revision, version, grade, feedback, publish], client);
async function peer() {
  const client = new Client({ ...config, statement_timeout: 12000 });
  peers.push(client);
  await client.connect();
  return client;
}
async function waitForLock(client, observer = db) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected PostgreSQL lock wait.');
}

async function checkAssessmentPlan(teacher, foreign, student) {
  const plan = (stage, category, maxPoints) => ({ assessment: { stage, category, maxPoints } });
  const racePlan = { title: 'Competing exam', ...plan('N1', 'exam', '4.00') };
  check(await scalar('select assessment_stage as result from activities where id=$1', [uuid(50)]), null);
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40),
    { title: 'Incomplete', assessment: { stage: 'N1', category: 'activity' } }], '22023');
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40),
    { title: 'Overweight', ...plan('N1', 'activity', '3.01') }], '23514');

  const contender = await peer();
  await db.query('begin');
  const exam = await create(teacher, racePlan);
  const competing = manage(teacher, 'create', null, racePlan, uuid(40), contender)
    .then(() => null, error => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await competing, '23514');
  await create(teacher, plan('N1', 'exam', '3.00'));
  check(await scalar("select sum(assessment_max_points)::text as result from activities where tenant_id=$1 and class_id=$2 and assessment_stage='N1' and assessment_category='exam'", [uuid(1), uuid(40)]), '7.00');

  await rejected(manageSql, [uuid(1), teacher.id, 'publish', exam.id, null, { expected_version: 1 }], '23514');
  await rejected(submitSql, [uuid(1), student.id, exam.id, 0, 'Not a text task'], '23514');
  await rejected(manualGradeSql, [uuid(1), teacher.id, exam.id, student.id, 4, null], '23514');

  const work = await create(teacher, plan('N2', 'activity', '2.00'));
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40),
    { title: 'Competing task', ...plan('N2', 'activity', '1.01') }], '23514');
  check((await manage(teacher, 'update', work.id, { expected_version: 1, ...plan('N2', 'activity', '1.00') })).assessment_max_points, 1);
  const other = await create(teacher, plan('N2', 'activity', '2.00'));
  await manage(teacher, 'publish', work.id, { expected_version: 2 });
  await manage(teacher, 'close', work.id, { expected_version: 3 });
  await rejected(manageSql, [uuid(1), teacher.id, 'update', other.id, null,
    { expected_version: 1, ...plan('N2', 'activity', '2.01') }], '23514');
  await manage(teacher, 'publish', other.id, { expected_version: 1 });
  await rejected(manageSql, [uuid(1), teacher.id, 'update', other.id, null,
    { expected_version: 2, assessment: null }], '23514');
  check((await manage(teacher, 'update', other.id, { expected_version: 2, title: 'Corrected title' })).title, 'Corrected title');

  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Other offering',$6)",
    [uuid(42), uuid(1), uuid(30), uuid(80), uuid(70), teacher.auth]);
  check((await manage(teacher, 'create', null, racePlan, uuid(42))).assessment_max_points, 4);

  await db.query("insert into courses(id,tenant_id,name) values ($1,$2,'Synthetic')", [uuid(31), uuid(2)]);
  await db.query("insert into academic_periods(id,tenant_id,code,name,status) values ($1,$2,'SYN','Synthetic','active')", [uuid(71), uuid(2)]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'SYN','Synthetic')", [uuid(81), uuid(2), uuid(31)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Synthetic',$6)",
    [uuid(43), uuid(2), uuid(31), uuid(81), uuid(71), foreign.auth]);
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(43), racePlan], 'P0002');
  check((await scalar(manageSql, [uuid(2), foreign.id, 'create', null, uuid(43), racePlan])).assessment_max_points, 4);

  await db.query('begin isolation level repeatable read');
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(42), racePlan], '25000');
  await db.query('rollback');
}

async function checkExamGrades(teacher, foreign, student, stranger) {
  const writeSql = 'select write_exam_grade($1,$2,$3,$4,$5,$6,$7) as result';
  const readSql = 'select read_exam_grades($1,$2,$3,$4,$5,$6) as result';
  const args = (actor, exam, action, revision, studentId = null, points = null) =>
    [uuid(1), actor.id, exam.id, action, revision, studentId, points];
  const roster = (exam, actor = teacher) => scalar(readSql, [uuid(1), actor.id, exam.id, false, 0, 10]);
  const own = exam => scalar(readSql, [uuid(1), student.id, exam.id, true, 0, 1]);
  const n1 = await scalar("select to_jsonb(a) as result from activities a where tenant_id=$1 and class_id=$2 and assessment_stage='N1' and assessment_category='exam' and assessment_max_points=4", [uuid(1), uuid(40)]);
  const n2 = await create(teacher, { title: 'In-person exam', assessment: { stage: 'N2', category: 'exam', maxPoints: '7.00' } });
  const other = await member('student');
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(1), uuid(42), other.id]);
  const foreignStudent = await member('student', uuid(2));
  for (const exam of [n1, n2]) {
    check((await roster(exam)).stage, exam.assessment_stage);
    const entries = (await roster(exam)).data;
    check(entries.find(entry => entry.studentId === student.id), { studentId: student.id, studentName: 'Synthetic', result: null });
    check(entries.some(entry => [other.id, foreignStudent.id].includes(entry.studentId)), false);
    await rejected(readSql, [uuid(1), student.id, exam.id, true, 0, 1], 'P0002');
    await rejected(writeSql, args(teacher, exam, 'save', 0, student.id, '0.00'), '23514');
    await rejected(writeSql, args(stranger, exam, 'activate', 1), '42501');
    await rejected(writeSql, args(teacher, exam, 'activate', 2), '23514');
    const opened = await scalar(writeSql, args(teacher, exam, 'activate', 1));
    check(opened.revision, 2);
    assert.ok(opened.gradingOpenedAt);
    check((await roster(exam)).gradingOpenedAt, opened.gradingOpenedAt);
    await rejected(manageSql, [uuid(1), teacher.id, 'publish', exam.id, null, { expected_version: 2 }], '23514');
    await rejected(manageSql, [uuid(1), teacher.id, 'update', exam.id, null, { expected_version: 2, assessment: null }], '23514');
    await rejected(manageSql, [uuid(1), teacher.id, 'delete', exam.id, null, {}], '23514');
    await rejected(submitSql, [uuid(1), student.id, exam.id, 0, 'Rejected'], '23514');
    await rejected(manualGradeSql, [uuid(1), teacher.id, exam.id, student.id, 4, null], '23514');
    check((await own(exam)).result, null);
  }
  const work = await create(teacher, { title: 'Ordinary activity' });
  await rejected(writeSql, args(teacher, work, 'activate', 1), 'P0002');
  await rejected(writeSql, args(stranger, n2, 'save', 0, student.id, '5.50'), '42501');
  await rejected(readSql, [uuid(1), stranger.id, n2.id, false, 0, 10], '42501');
  await rejected(readSql, [uuid(1), other.id, n2.id, true, 0, 1], '42501');
  await rejected(readSql, [uuid(2), foreign.id, n2.id, false, 0, 10], 'P0002');
  for (const id of [other.id, foreignStudent.id, student.auth]) {
    await rejected(writeSql, args(teacher, n2, 'save', 0, id, '5.50'), '42501');
  }
  for (const value of ['7.01', '-0.01', '5.505']) {
    await rejected(writeSql, args(teacher, n2, 'save', 0, student.id, value), '22023');
  }
  check((await scalar(writeSql, args(teacher, n1, 'save', 0, student.id, '0.00'))).points, '0.00');
  check((await own(n1)).result, null);
  check((await scalar(writeSql, args(teacher, n1, 'publish', 1, student.id))).points, '0.00');
  await rejected(writeSql, args(teacher, n2, 'publish', 1, student.id), '23514');
  const peerClient = await peer();
  await db.query('begin');
  const draft = await scalar(writeSql, args(teacher, n2, 'save', 0, student.id, '5.50'));
  const competing = scalar(writeSql, args(teacher, n2, 'save', 0, student.id, '6.00'), peerClient)
    .then(() => null, error => error.code);
  await waitForLock(peerClient);
  await db.query('commit');
  check(await competing, '23514');
  check([draft.points, draft.unit, draft.publicationState, draft.revision], ['5.50', 'exam_points', 'draft', 1]);
  check((await roster(n2)).data.find(entry => entry.studentId === student.id).result, draft);
  check((await own(n2)).result, null);
  await db.query('begin');
  await scalar(writeSql, args(teacher, n2, 'save', 1, student.id, '5.75'));
  const stalePublish = scalar(writeSql, args(teacher, n2, 'publish', 1, student.id), peerClient)
    .then(() => null, error => error.code);
  await waitForLock(peerClient);
  await db.query('commit');
  check(await stalePublish, '23514');
  const published = await scalar(writeSql, args(teacher, n2, 'publish', 2, student.id));
  check([published.points, published.publicationState, published.revision], ['5.75', 'published', 3]);
  check((await own(n2)).result, published);
  await rejected(writeSql, args(teacher, n2, 'save', 3, student.id, '0.00'), '23514');
  const corrected = await scalar(writeSql, args(teacher, n2, 'publish', 3, student.id, '0.00'));
  check([corrected.points, corrected.publicationState, corrected.revision], ['0.00', 'published', 4]);
  check((await own(n2)).result, corrected);
  await rejected('update grades set grade=1,revision=revision+1 where activity_id=$1', [n2.id], '23514');
  check((await db.query('select student_id,submission_id,submission_version,grade_unit from grades where activity_id=$1', [n2.id])).rows,
    [{ student_id: student.auth, submission_id: null, submission_version: null, grade_unit: 'exam_points' }]);
  check((await db.query('select revision,grade,graded_by,publication_state from grade_revisions where activity_id=$1 order by revision', [n2.id])).rows, [
    { revision: 1, grade: '5.50', graded_by: teacher.auth, publication_state: 'draft' },
    { revision: 2, grade: '5.75', graded_by: teacher.auth, publication_state: 'draft' },
    { revision: 3, grade: '5.75', graded_by: teacher.auth, publication_state: 'published' },
    { revision: 4, grade: '0.00', graded_by: teacher.auth, publication_state: 'published' },
  ]);
  check(await scalar('select count(*)::int as result from activity_submissions where activity_id=$1', [n2.id]), 0);
  check(await scalar("select count(*)::int as result from academic_notifications n join grades g on n.grade_id=g.id where g.activity_id=$1", [n2.id]), 0);
  for (const signature of ['write_exam_grade(uuid,uuid,uuid,text,integer,uuid,text)', 'read_exam_grades(uuid,uuid,uuid,boolean,integer,integer)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      check(await scalar("select has_function_privilege($1,$2,'EXECUTE') as result", [role, signature]), role === 'service_role');
    }
  }
  console.log('PASS PostgreSQL: exam activation, enrollment, identity, draft privacy, CAS, publication and revision history');
}

async function checkReportCards(teacher, student, stranger, foreign) {
  const tenant = uuid(1);
  const offering = uuid(44);
  const stageSql = 'select manage_academic_stage($1,$2,$3,$4,$5,$6,$7) as result';
  const cardSql = 'select read_academic_report_cards($1,$2,$3,$4,$5,$6,$7) as result';
  const examSql = 'select write_exam_grade($1,$2,$3,$4,$5,$6,$7) as result';
  const stage = (key, close = false, client = db) => scalar(stageSql, [tenant, teacher.id, offering, key, close, 0, 20], client);
  const own = (member = student) => scalar(cardSql, [tenant, member.id, offering, null, true, 0, 1]);
  const task = (stage, category, maxPoints, title = 'Planned assessment') => manage(teacher, 'create', null,
    { title, assessment: { stage, category, maxPoints } }, offering);
  const examWrite = (exam, action, revision, points = null, client = db) => scalar(examSql,
    [tenant, teacher.id, exam.id, action, revision, action === 'activate' ? null : student.id, points], client);

  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Report card offering',$6)",
    [offering, tenant, uuid(30), uuid(80), uuid(70), teacher.auth]);
  check((await stage('N1')).blockers, ['no_assessments', 'no_eligible_students']);
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [tenant, offering, student.id]);
  check((await stage('N1')).blockers, ['no_assessments']);
  const n1Exam = await task('N1', 'exam', '6.00');
  const n2Exam = await task('N2', 'exam', '7.00');
  const n1Work = await task('N1', 'activity', '1.50');
  const n2Work = await task('N2', 'activity', '2.00');
  check((await stage('N1')).data.map(issue => issue.reason), ['assessment_unavailable', 'assessment_unavailable']);
  await rejected(stageSql, [tenant, teacher.id, offering, 'N1', true, 0, 20], '23514');
  await rejected(stageSql, [tenant, stranger.id, offering, 'N1', true, 0, 20], '42501');
  await rejected(stageSql, [tenant, student.id, offering, 'N1', true, 0, 20], '42501');
  await rejected(cardSql, [tenant, stranger.id, offering, student.id, false, 0, 1], '42501');
  await rejected(cardSql, [tenant, student.id, offering, stranger.id, true, 0, 1], '22023');
  await rejected(cardSql, [uuid(2), foreign.id, offering, null, false, 0, 10], 'P0002');
  const otherStudent = await member('student');
  await rejected(cardSql, [tenant, otherStudent.id, offering, null, true, 0, 1], 'P0002');

  for (const exam of [n1Exam, n2Exam]) {
    await examWrite(exam, 'activate', 1);
    await examWrite(exam, 'save', 0, '5.50');
  }
  for (const work of [n1Work, n2Work]) {
    await manage(teacher, 'publish', work.id, { expected_version: 1 });
  }
  const legacy = await manage(teacher, 'create', null, { title: 'Unweighted legacy workflow' }, offering);
  await manage(teacher, 'publish', legacy.id, { expected_version: 1 });
  await scalar(manualGradeSql, [tenant, teacher.id, legacy.id, student.id, 10, null]);
  const submission = await submit(student, n1Work.id);
  await review(teacher, submission.id, 0, 1, 0);
  const before = await own();
  check(before.closedAt, { N1: null, N2: null });
  check(before.data[0].items.length, 4);
  check(before.data[0].items.every(item => item.publishedValue === null), true);
  check((await stage('N1')).data.map(issue => issue.reason), ['draft_grade', 'draft_grade']);
  check((await stage('N2')).data.map(issue => issue.reason).sort(), ['draft_grade', 'missing_grade']);

  await examWrite(n1Exam, 'publish', 1);
  const contender = await peer();
  await db.query('begin');
  await scalar(publishSql, [tenant, teacher.id, submission.id, 1]);
  const waitingClosure = stage('N1', true, contender);
  await waitForLock(contender);
  check(await scalar("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) as result", [contender.processID]), true);
  await db.query('commit');
  const n1 = await waitingClosure;
  check([n1.closedBy, n1.eligibleCount, n1.assessmentCount, n1.total], [teacher.id, 1, 2, 0]);
  check((await own()).data[0].closedStages, { N1: true, N2: false });
  check((await own()).data[0].items.find(item => item.id === n1Work.id).publishedValue, '0.00');
  await rejected(reviewSql, [tenant, teacher.id, submission.id, 2, 1, 7, null, true], '23514');

  await examWrite(n2Exam, 'publish', 1);
  await scalar(manualGradeSql, [tenant, teacher.id, n2Work.id, student.id, 8, null]);
  const observer = await peer();
  await db.query('begin');
  await stage('N2', true);
  const duplicate = stage('N2', true, contender).then(() => null, error => error.code);
  await waitForLock(contender, observer);
  const writer = await peer();
  const latePublish = examWrite(n2Exam, 'publish', 2, '6.00', writer).then(() => null, error => error.code);
  await waitForLock(writer, observer);
  const planner = await peer();
  const lateItem = manage(teacher, 'create', null,
    { title: 'Concurrent planned task', assessment: { stage: 'N2', category: 'activity', maxPoints: '0.50' } }, offering, planner)
    .then(() => null, error => error.code);
  await waitForLock(planner, observer);
  check(await scalar("select count(distinct pid)::int as result from pg_locks where pid=any($1::int[]) and locktype='advisory' and not granted",
    [[contender.processID, writer.processID, planner.processID]], observer), 3);
  await db.query('commit');
  check(await Promise.all([duplicate, latePublish, lateItem]), ['23514', '23514', '23514']);
  check(await scalar('select count(*)::int as result from academic_stage_closures where tenant_id=$1 and class_id=$2', [tenant, offering]), 2);
  await rejected(manualGradeSql, [tenant, teacher.id, n2Work.id, student.id, 3, null], '23514');
  await rejected(examSql, [tenant, teacher.id, n2Exam.id, 'publish', 2, student.id, '6.00'], '23514');
  await scalar(manualGradeSql, [tenant, teacher.id, legacy.id, student.id, 9, null]);
  const final = await own();
  check(final.data[0].closedStages, { N1: true, N2: true });
  check(final.data[0].items.find(item => item.id === n2Work.id).publishedValue, '8.00');
  check((await stage('N2')).data, []);
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [tenant, offering, otherStudent.id]);
  check((await own(otherStudent)).data[0].closedStages, { N1: false, N2: false });
  check((await own(otherStudent)).data[0].items, []);
  await db.query("update enrollments set status='cancelled' where tenant_id=$1 and class_id=$2 and student_id=$3", [tenant, offering, student.id]);
  check((await own()).data[0].items, final.data[0].items);
  check((await scalar(cardSql, [tenant, teacher.id, offering, null, false, 0, 1])).total, 2);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(await scalar("select has_table_privilege($1,'public.academic_stage_closures','SELECT,INSERT,UPDATE,DELETE') as result", [role]), false);
    check(await scalar("select has_function_privilege($1,'manage_academic_stage(uuid,uuid,uuid,text,boolean,integer,integer)','EXECUTE') as result", [role]), role === 'service_role');
    check(await scalar("select has_function_privilege($1,'read_academic_report_cards(uuid,uuid,uuid,uuid,boolean,integer,integer)','EXECUTE') as result", [role]), role === 'service_role');
  }
  console.log('PASS PostgreSQL: report card eligibility, closure blockers, publish/close races, immutable grades and legacy compatibility');
}

async function main() {
  if (!process.argv.includes('--allow-local-migrations')) throw new Error('Not executed: --allow-local-migrations is required for authorized disposable local migration tests.');
  if (baseline && withAssessmentPlan) throw new Error('--with-assessment-plan requires the activity workflow baseline.');
  if (withExamGrades && (!withAssessmentPlan || !process.argv.includes('--with-communication'))) {
    throw new Error('--with-exam-grades requires --with-assessment-plan and --with-communication.');
  }
  if (withReportCards && !withExamGrades) throw new Error('--with-report-cards requires --with-exam-grades.');
  containerId = docker('run', '--rm', '--pull=never', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m',
    '-d', '--name', containerName, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  const published = docker('port', containerId, '5432/tcp');
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, database: 'postgres', ssl: false };
  for (let attempt = 0; attempt < 80; attempt++) {
    db = new Client(config);
    try { await db.connect(); break; } catch {
      await db.end().catch(() => {});
      if (attempt === 79) throw new Error('Local PostgreSQL did not start.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await db.query(`create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role`);
  await applyGuardedMigration(db, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
  for (const name of ['20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql', '20260528000003_invites.sql', '20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql', '20261026000003_institutional_management.sql']) {
    await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  }
  await db.query("insert into tenants(id,name,slug) values ($1,'Synthetic A','synthetic-a'),($2,'Synthetic B','synthetic-b')", [uuid(1), uuid(2)]);
  const teacher = await member('teacher');
  const student = await member('student');
  const manager = await member('admin');
  const stranger = await member('teacher');
  const foreign = await member('teacher', uuid(2));
  const inactive = await member('teacher', uuid(1), false);
  await db.query("insert into courses(id,tenant_id,name) values ($1,$2,'Synthetic')", [uuid(30), uuid(1)]);
  await db.query("insert into academic_periods(id,tenant_id,code,name,status) values ($1,$2,'SYN','Synthetic','active')", [uuid(70), uuid(1)]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'SYN','Synthetic')", [uuid(80), uuid(1), uuid(30)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Synthetic',$6)", [uuid(40), uuid(1), uuid(30), uuid(80), uuid(70), teacher.auth]);
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(1), uuid(40), student.id]);
  await db.query("insert into classes(id,tenant_id,course_id,name) values ($1,$2,$3,'Unmapped legacy')", [uuid(41), uuid(1), uuid(30)]);
  await db.query("insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Legacy')", [uuid(50), uuid(1), uuid(40)]);
  await db.query("insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Legacy grade race'),($4,$2,$3,'Legacy submission race')", [uuid(51), uuid(1), uuid(40), uuid(52)]);
  await db.query('insert into grades(id,tenant_id,activity_id,student_id,grade) values ($1,$2,$3,$4,0)', [uuid(60), uuid(1), uuid(50), student.auth]);
  if (!baseline) {
    const migration = readFileSync(join(root, 'supabase/migrations/20261026000004_activity_workflow.sql'), 'utf8');
    await rejected(migration.replace(/commit;\s*$/, 'select 1/0; commit;'), [], '22012');
    await db.query('rollback');
    check(await scalar("select to_regclass('public.activity_submissions') is null as result"), true);
    check(await scalar("select count(*)::int as result from information_schema.columns where table_schema='public' and table_name='activities' and column_name='state'"), 0);
    check(await scalar('select grade::int as result from grades where id=$1', [uuid(60)]), 0);
    await applyGuardedMigration(db, { name: '20261026000004_activity_workflow.sql', sql: migration });
    if (process.argv.includes('--with-communication')) {
      await applyGuardedMigration(db, { name: '20261026000005_academic_communication.sql', sql: readFileSync(join(root, 'supabase/migrations/20261026000005_academic_communication.sql'), 'utf8') });
    }
    if (withAssessmentPlan) {
      // This candidate is intentionally outside the deployment manifest. Apply it
      // only to the disposable loopback database created by this harness.
      await db.query(readFileSync(join(root, 'supabase/migrations/20261103185100_activity_assessment_plan.sql'), 'utf8'));
      await checkAssessmentPlan(teacher, foreign, student);
    }
  }
  const activity = await create(teacher);
  check(activity.state, 'draft');
  check(activity.workflow_enabled, true);
  check(activity.revision, 1);
  check(activity.created_by, teacher.auth);
  const longText = 'x'.repeat(102400);
  check((await create(teacher, { title: longText, type: longText, description: longText, instructions: longText, evaluation_criteria: longText })).type, longText);
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40), { title: 'Synthetic', state: 'published' }], '22023');
  await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40), { title: 'Synthetic', type: ' ' }], '22023');
  for (const payload of [{ title: 'x'.repeat(102401) }, { type: 'x'.repeat(102401) }, { description: 3 }, { instructions: true }, { evaluation_criteria: [] }, { description: 'x'.repeat(102401) }, { due_date: 1 }]) {
    await rejected(manageSql, [uuid(1), teacher.id, 'create', null, uuid(40), { title: 'Synthetic', ...payload }], '22023');
  }
  check((await db.query('select state,workflow_enabled from activities where id=$1', [uuid(50)])).rows, [{ state: 'published', workflow_enabled: false }]);
  check((await db.query('select publication_state,revision from grades where id=$1', [uuid(60)])).rows, [{ publication_state: 'published', revision: 1 }]);
  check(await scalar('select count(*)::int as result from grade_revisions where grade_id=$1', [uuid(60)]), 1);
  check(await scalar('select count(*)::int as result from enrollments'), 1);
  check(await scalar('select subject_id is null as result from classes where id=$1', [uuid(41)]), true);
  for (const actor of [manager, stranger, foreign, inactive, student]) await rejected(manageSql, [uuid(1), actor.id, 'publish', activity.id, null, { expected_version: 1 }], '42501');
  await rejected(submitSql, [uuid(1), student.id, activity.id, 0, 'answer'], '23514');
  await rejected(manageSql, [uuid(1), teacher.id, 'update', activity.id, null, { title: 'missing CAS' }], '22023');
  await rejected(manageSql, [uuid(1), teacher.id, 'publish', activity.id, null, { expected_version: 9 }], '23514');
  await rejected(manageSql, [uuid(1), manager.id, 'close', activity.id, null, { expected_version: 1 }], '23514');
  await rejected(manageSql, [uuid(1), manager.id, 'create', null, uuid(41), { title: 'unmapped' }], '23514');
  await db.query("update academic_periods set status='closed' where id=$1", [uuid(70)]);
  await rejected(manageSql, [uuid(1), teacher.id, 'publish', activity.id, null, { expected_version: 1 }], '23514');
  await db.query("update academic_periods set status='active' where id=$1", [uuid(70)]);
  const publishedActivity = await manage(teacher, 'publish', activity.id, { expected_version: 1 });
  check(publishedActivity.state, 'published');
  check(publishedActivity.revision, 2);
  check(typeof publishedActivity.published_at, 'string');
  await rejected(manageSql, [uuid(1), teacher.id, 'update', activity.id, null, { expected_version: 2, state: 'draft' }], '22023');
  for (const answer of ['', ' '.repeat(5), 'a'.repeat(20001)]) await rejected(submitSql, [uuid(1), student.id, activity.id, 0, answer], '22023');
  for (const actor of [teacher, manager, foreign]) await rejected(submitSql, [uuid(1), actor.id, activity.id, 0, 'answer'], '42501');
  const delivery = await submit(student, activity.id);
  check(delivery.current_version, 1);
  check(delivery.student_id, student.id);
  check(delivery.class_id, uuid(40));
  check(delivery.is_late, false);
  check(typeof delivery.submitted_at, 'string');
  await rejected(submitSql, [uuid(1), student.id, activity.id, 0, 'duplicate'], '23514');
  const resend = await submit(student, activity.id, 1, 'Second answer');
  check(resend.current_version, 2);
  check(await scalar('select count(*)::int as result from activity_submission_versions where submission_id=$1', [delivery.id]), 2);
  await rejected(manageSql, [uuid(1), teacher.id, 'update', activity.id, null, { expected_version: 2, instructions: 'Changed' }], '23514');
  await rejected(manageSql, [uuid(1), teacher.id, 'update', activity.id, null, { expected_version: 2, due_date: new Date(Date.now() + 60000).toISOString() }], '23514');
  await rejected(manageSql, [uuid(1), teacher.id, 'delete', activity.id, null, {}], '23514');
  for (const actor of [stranger, manager, inactive, foreign, student]) await rejected(reviewSql, [uuid(1), actor.id, delivery.id, 0, 2, 7, null, false], '42501');
  await rejected(reviewSql, [uuid(1), teacher.id, delivery.id, 0, 1, 7, null, false], '23514');
  await rejected(reviewSql, [uuid(1), teacher.id, delivery.id, 0, 2, 11, null, false], '22023');
  let grade = await review(teacher, delivery.id, 0, 2, null, 'Review started');
  check(grade.publication_state, 'draft');
  check(grade.grade, null);
  check(grade.revision, 1);
  check(grade.student_id, student.auth);
  check(grade.submission_id, delivery.id);
  await rejected(submitSql, [uuid(1), student.id, activity.id, 2, 'blocked after correction'], '23514');
  await rejected(reviewSql, [uuid(1), teacher.id, delivery.id, 0, 2, 0, null, false], '23514');
  grade = await review(teacher, delivery.id, 1, 2, 0, 'Zero preserved');
  check(Number(grade.grade), 0);
  check(grade.revision, 2);
  grade = await scalar(publishSql, [uuid(1), teacher.id, delivery.id, 2]);
  check(grade.publication_state, 'published');
  check(grade.revision, 3);
  await rejected(reviewSql, [uuid(1), teacher.id, delivery.id, 3, 2, 8, null, false], '23514');
  grade = await review(teacher, delivery.id, 3, 2, 8, 'Explicit correction', true);
  check(grade.revision, 4);
  check(await scalar('select count(*)::int as result from grades where submission_id=$1', [delivery.id]), 1);
  check(await scalar('select count(*)::int as result from grade_revisions where grade_id=$1', [grade.id]), 4);
  check((await db.query('select revision,grade::float,publication_state,submission_version from grade_revisions where grade_id=$1 order by revision', [grade.id])).rows,
    [{ revision: 1, grade: null, publication_state: 'draft', submission_version: 2 }, { revision: 2, grade: 0, publication_state: 'draft', submission_version: 2 },
      { revision: 3, grade: 0, publication_state: 'published', submission_version: 2 }, { revision: 4, grade: 8, publication_state: 'published', submission_version: 2 }]);
  check((await db.query('select version,answer,is_late from activity_submission_versions where submission_id=$1 order by version', [delivery.id])).rows,
    [{ version: 1, answer: 'Synthetic answer', is_late: false }, { version: 2, answer: 'Second answer', is_late: false }]);
  await rejected('update grades set grade=9 where id=$1', [grade.id], '23514');
  await rejected('update grade_revisions set grade=9 where grade_id=$1', [grade.id], '23514');
  await rejected('delete from grade_revisions where grade_id=$1', [grade.id], '23514');
  await rejected('update activity_submission_versions set answer=$1 where submission_id=$2', ['tamper', delivery.id], '23514');
  await rejected('delete from activity_submission_versions where submission_id=$1', [delivery.id], '23514');
  await rejected('delete from activity_submissions where id=$1', [delivery.id], '23514');
  await rejected('update activity_submissions set student_id=$1 where id=$2', [teacher.id, delivery.id], '23514');
  await rejected("update activities set tenant_id=$1 where id=$2", [uuid(2), activity.id], '23514');
  await rejected("update app_users set role='teacher' where id=$1", [student.id], '23514');
  await db.query('update grades set grade=7 where id=$1', [uuid(60)]);
  check(await scalar('select revision as result from grades where id=$1', [uuid(60)]), 2);
  check(await scalar('select count(*)::int as result from grade_revisions where grade_id=$1', [uuid(60)]), 2);
  await rejected('update grades set student_id=$1 where id=$2', [teacher.auth, uuid(60)], '23514');
  await rejected(submitSql, [uuid(1), student.id, uuid(50), 0, 'legacy grade exists'], '23514');
  await manage(manager, 'close', activity.id, { expected_version: 2 });
  await rejected(submitSql, [uuid(1), student.id, activity.id, 2, 'closed'], '23514');
  await review(teacher, delivery.id, 4, 2, null, 'Feedback only result', true);
  check(await scalar('select grade is null as result from grades where id=$1', [grade.id]), true);
  await rejected(manageSql, [uuid(1), teacher.id, 'publish', activity.id, null, { expected_version: 3 }], '23514');
  console.log('PASS PostgreSQL: lifecycle, tenant/actor policy, versions/CAS, single grade, published correction and immutable history');

  const extra = await member('student');
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(1), uuid(40), extra.id]);
  const open = async (payload = {}) => { const a = await create(teacher, payload); return manage(teacher, 'publish', a.id, { expected_version: 1 }); };
  for (const status of ['completed', 'cancelled', 'suspended']) {
    const a = await open();
    await db.query('update enrollments set status=$1 where student_id=$2', [status, extra.id]);
    await rejected(submitSql, [uuid(1), extra.id, a.id, 0, 'answer'], '42501');
    await db.query("update enrollments set status='active' where student_id=$1", [extra.id]);
  }
  const expired = await open({ due_date: new Date(0).toISOString() });
  await rejected(submitSql, [uuid(1), extra.id, expired.id, 0, 'expired'], '23514');
  const late = await open({ due_date: new Date(0).toISOString(), allow_late: true });
  check((await submit(extra, late.id)).is_late, true);
  const extension = await manage(teacher, 'update', late.id, { expected_version: 2, due_date: new Date(Date.now() + 60000).toISOString() });
  check(extension.revision, 3);
  await rejected(manageSql, [uuid(1), teacher.id, 'update', late.id, null, { expected_version: 3, due_date: new Date(0).toISOString() }], '23514');
  const rollback = await open();
  await db.query('begin');
  await submit(extra, rollback.id);
  await db.query('rollback');
  check(await scalar('select count(*)::int as result from activity_submissions where activity_id=$1', [rollback.id]), 0);
  check(await scalar('select count(*)::int as result from activity_submission_versions v join activity_submissions s on s.id=v.submission_id where s.activity_id=$1', [rollback.id]), 0);
  const racing = await open();
  const contender = await peer();
  await db.query('begin');
  const winner = await submit(extra, racing.id);
  const duplicate = submit(extra, racing.id, 0, 'contender', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await duplicate, '23514');
  check(await scalar('select count(*)::int as result from activity_submissions where activity_id=$1', [racing.id]), 1);
  await db.query('begin');
  await submit(extra, racing.id, 1, 'version two');
  const stale = submit(extra, racing.id, 1, 'stale version', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await stale, '23514');
  await db.query('begin');
  await review(teacher, winner.id, 0, 2, null, 'draft');
  const afterDraft = submit(extra, racing.id, 2, 'review race', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await afterDraft, '23514');

  for (const scenario of ['close', 'disable', 'enrollment', 'expiry', 'period', 'assignment']) {
    const a = await open(scenario === 'expiry' ? { due_date: new Date(Date.now() + 1000).toISOString() } : {});
    await db.query('begin');
    if (scenario === 'close') await manage(teacher, 'close', a.id, { expected_version: 2 });
    if (scenario === 'disable') await db.query('update app_users set active=false where id=$1', [extra.id]);
    if (scenario === 'enrollment') await db.query("update enrollments set status='suspended' where student_id=$1", [extra.id]);
    if (scenario === 'expiry') await db.query('select id from app_users where id=$1 for update', [extra.id]);
    if (scenario === 'period') await db.query("update academic_periods set status='closed' where id=$1", [uuid(70)]);
    if (scenario === 'assignment') await db.query("update teaching_assignments set status='inactive' where class_id=$1 and teacher_id=$2 and not is_primary", [uuid(40), stranger.id]);
    let pending;
    if (scenario === 'assignment') {
      await db.query('rollback');
      await db.query("insert into teaching_assignments(tenant_id,class_id,teacher_id) values ($1,$2,$3) on conflict (tenant_id,class_id,teacher_id) do update set status='active'", [uuid(1), uuid(40), stranger.id]);
      const s = await submit(extra, a.id);
      await db.query('begin');
      await db.query("update teaching_assignments set status='inactive' where class_id=$1 and teacher_id=$2", [uuid(40), stranger.id]);
      pending = review(stranger, s.id, 0, 1, 5, null, true, contender).then(() => null, (e) => e.code);
    } else pending = submit(extra, a.id, 0, 'after lock', contender).then(() => null, (e) => e.code);
    await waitForLock(contender);
    if (scenario === 'expiry') await db.query('select pg_sleep(greatest(0,extract(epoch from (due_date-clock_timestamp())))+0.05) from activities where id=$1', [a.id]);
    await db.query('commit');
    check(await pending, ['disable', 'enrollment', 'assignment'].includes(scenario) ? '42501' : '23514');
    if (scenario !== 'assignment') check(await scalar('select count(*)::int as result from activity_submissions where activity_id=$1', [a.id]), 0);
    if (scenario === 'disable') await db.query('update app_users set active=true where id=$1', [extra.id]);
    if (scenario === 'enrollment') await db.query("update enrollments set status='active' where student_id=$1", [extra.id]);
    if (scenario === 'period') await db.query("update academic_periods set status='active' where id=$1", [uuid(70)]);
  }
  const draftRace = await create(teacher);
  await db.query('begin');
  await manage(teacher, 'publish', draftRace.id, { expected_version: 1 });
  const afterPublish = submit(extra, draftRace.id, 0, 'after publish', contender);
  await waitForLock(contender);
  await db.query('commit');
  check((await afterPublish).current_version, 1);
  await db.query('begin');
  await db.query('insert into grades(tenant_id,activity_id,student_id,grade) values ($1,$2,$3,5)', [uuid(1), uuid(51), extra.auth]);
  const afterLegacyGrade = submit(extra, uuid(51), 0, 'legacy grade race', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await afterLegacyGrade, '23514');
  await db.query('begin');
  const legacyDelivery = await submit(extra, uuid(52));
  const legacyInsert = contender.query('insert into grades(tenant_id,activity_id,student_id,grade) values ($1,$2,$3,5)', [uuid(1), uuid(52), extra.auth]).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await legacyInsert, '23514');
  check((await review(teacher, legacyDelivery.id, 0, 1, 5, 'Bound legacy delivery', true)).submission_id, legacyDelivery.id);
  await manage(manager, 'close', uuid(51));
  await rejected('update activities set title=$1 where id=$2', ['Closed legacy content edit', uuid(51)], '23514');
  const waitingDeadline = await open({ due_date: new Date(Date.now() + 1000).toISOString() });
  const waitingDelivery = await submit(extra, waitingDeadline.id);
  await db.query('begin');
  await db.query('select id from activity_submissions where id=$1 for update', [waitingDelivery.id]);
  const afterSubmissionLock = submit(extra, waitingDeadline.id, 1, 'Expired while waiting for submission lock', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('select pg_sleep(greatest(0,extract(epoch from (due_date-clock_timestamp())))+0.05) from activities where id=$1', [waitingDeadline.id]);
  await db.query('commit');
  check(await afterSubmissionLock, '23514');
  check(await scalar('select current_version as result from activity_submissions where id=$1', [waitingDelivery.id]), 1);
  const readSql = 'select list_academic_activities($1,$2,$3,$4,$5,$6) as result';
  const list = (actor = extra, offset = 0, limit = 100, activityId = null) => scalar(readSql, [uuid(1), actor.id, uuid(40), offset, limit, activityId]);
  const hiddenDraft = await create(teacher);
  const futurePublished = await open();
  check((await list(extra, 0, 100, hiddenDraft.id)).total, 0);
  check((await list(extra, 0, 100, futurePublished.id)).total, 1);
  const activeList = await list();
  check((await list(extra, 0, 1)).total, activeList.total);
  check((await list(extra, 0, 1)).activities.length, 1);
  const pageOne = await list(extra, 0, 1);
  const pageTwo = await list(extra, 1, 1);
  check(pageOne.activities[0].id === pageTwo.activities[0].id, false);
  for (const status of ['cancelled', 'suspended']) {
    await db.query('update enrollments set status=$1 where student_id=$2', [status, extra.id]);
    check((await list(extra, 0, 100, futurePublished.id)).total, 0);
    check((await list(extra, 0, 100, racing.id)).total, 1);
    check((await list(extra, 0, 100, uuid(51))).total, 1);
  }
  await db.query("update enrollments set status='completed' where student_id=$1", [extra.id]);
  check((await list(extra, 0, 100, futurePublished.id)).total, 1);
  await db.query("update enrollments set status='active' where student_id=$1", [extra.id]);
  const unenrolled = await member('student');
  check((await list(unenrolled)).total, 0);
  for (const actor of [teacher, manager, foreign, inactive]) await rejected(readSql, [uuid(1), actor.id, uuid(40), 0, 10, null], '42501');
  await rejected(readSql, [uuid(2), extra.id, uuid(40), 0, 10, null], '42501');
  await rejected(readSql, [uuid(1), extra.id, uuid(999), 0, 10, null], 'P0002');
  for (const [offset, limit] of [[-1, 1], [10000001, 1], [0, 0], [0, 101], [null, 10]]) await rejected(readSql, [uuid(1), extra.id, uuid(40), offset, limit, null], '22023');
  await db.query('update app_users set active=false where id=$1', [extra.id]);
  await rejected(readSql, [uuid(1), extra.id, uuid(40), 0, 10, null], '42501');
  await db.query('update app_users set active=true where id=$1', [extra.id]);
  const otherIdentity = await member('student');
  await rejected('update app_users set auth_user_id=$1 where id=$2', [otherIdentity.auth, unenrolled.id], '23505');
  const spareAuth = uuid(sequence++);
  await db.query('insert into auth.users(id) values ($1)', [spareAuth]);
  const ungraded = await member('student');
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(1), uuid(40), ungraded.id]);
  await submit(ungraded, futurePublished.id);
  await rejected('update app_users set auth_user_id=$1 where id=$2', [spareAuth, ungraded.id], '23514');
  await db.query('begin');
  await db.query("select set_config('app.activity_workflow',$1,true)", [futurePublished.id]);
  await rejected('insert into activity_submissions(tenant_id,activity_id,class_id,student_id,current_version,answer,submitted_at,is_late) values ($1,$2,$3,$4,1,$5,clock_timestamp(),false)', [uuid(1), futurePublished.id, uuid(41), extra.id, 'Wrong class'], '23503');
  await db.query('rollback');
  await db.query('begin');
  await db.query("select set_config('app.activity_workflow',$1,true)", [futurePublished.id]);
  await rejected('insert into activity_submissions(tenant_id,activity_id,class_id,student_id,current_version,answer,submitted_at,is_late) values ($1,$2,$3,$4,1,$5,clock_timestamp(),false)', [uuid(2), futurePublished.id, uuid(40), extra.id, 'Wrong tenant'], '23503');
  await db.query('rollback');
  await rejected('insert into grade_revisions(tenant_id,grade_id,revision,activity_id,student_id,grade,publication_state) values ($1,$2,99,$3,$4,7,$5)', [uuid(1), grade.id, activity.id, student.auth, 'published'], '23514');
  const manualActivity = await open();
  const closedEmpty = await open();
  await manage(manager, 'close', closedEmpty.id, { expected_version: 2 });
  await rejected(manageSql, [uuid(1), teacher.id, 'update', closedEmpty.id, null, { expected_version: 3, title: 'Cannot edit closed activity' }], '23514');
  const manual = (actor, targetActivity, target = extra, value = 0, feedback = 'Manual grade', client = db) => scalar(manualGradeSql, [uuid(1), actor.id, targetActivity, target.id, value, feedback], client);
  let manualGrade = await manual(manager, manualActivity.id);
  check(manualGrade.publication_state, 'published');
  check(Number(manualGrade.grade), 0);
  check(manualGrade.submission_id, null);
  check(manualGrade.revision, 1);
  manualGrade = await manual(teacher, manualActivity.id, extra, null, 'x'.repeat(102400));
  check(manualGrade.revision, 2);
  check(manualGrade.grade, null);
  check(await scalar('select count(*)::int as result from grade_revisions where grade_id=$1', [manualGrade.id]), 2);
  await rejected(manualGradeSql, [uuid(1), stranger.id, manualActivity.id, extra.id, 3, null], '42501');
  await rejected(manualGradeSql, [uuid(1), inactive.id, manualActivity.id, extra.id, 3, null], '42501');
  await rejected(manualGradeSql, [uuid(1), foreign.id, manualActivity.id, extra.id, 3, null], '42501');
  await rejected(manualGradeSql, [uuid(1), teacher.id, hiddenDraft.id, extra.id, 3, null], '23514');
  await rejected(manualGradeSql, [uuid(1), teacher.id, racing.id, extra.id, 3, null], '23514');
  await rejected(manualGradeSql, [uuid(1), teacher.id, manualActivity.id, teacher.id, 3, null], '42501');
  await rejected(manualGradeSql, [uuid(1), teacher.id, manualActivity.id, unenrolled.id, 3, null], '23514');
  await rejected(manualGradeSql, [uuid(1), teacher.id, manualActivity.id, extra.id, -1, null], '22023');
  await db.query('update app_users set active=false where id=$1', [extra.id]);
  await rejected(manualGradeSql, [uuid(1), teacher.id, manualActivity.id, extra.id, 3, null], '42501');
  await db.query('update app_users set active=true where id=$1', [extra.id]);
  await db.query("update enrollments set status='completed' where student_id=$1", [extra.id]);
  check((await manual(teacher, manualActivity.id)).revision, 3);
  await db.query("update enrollments set status='suspended' where student_id=$1", [extra.id]);
  await rejected(manualGradeSql, [uuid(1), teacher.id, manualActivity.id, extra.id, 3, null], '23514');
  await db.query("update enrollments set status='active' where student_id=$1", [extra.id]);
  const manualRace = await open();
  await db.query('begin');
  await manual(teacher, manualRace.id);
  const submitAfterManual = submit(extra, manualRace.id, 0, 'manual race', contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await submitAfterManual, '23514');
  const submitRace = await open();
  await db.query('begin');
  const submitWinner = await submit(extra, submitRace.id);
  const manualAfterSubmit = manual(teacher, submitRace.id, extra, 3, null, contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await manualAfterSubmit, '23514');
  await db.query('begin');
  await review(teacher, submitWinner.id, 0, 1, 4);
  const concurrentReview = review(teacher, submitWinner.id, 0, 1, 6, null, false, contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await concurrentReview, '23514');
  await db.query('begin');
  await scalar(publishSql, [uuid(1), teacher.id, submitWinner.id, 1]);
  const concurrentPublish = scalar(publishSql, [uuid(1), teacher.id, submitWinner.id, 1], contender).then(() => null, (e) => e.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await concurrentPublish, '23514');
  check(await scalar('select count(*)::int as result from grades where submission_id=$1', [submitWinner.id]), 1);
  check(await scalar('select count(*)::int as result from grade_revisions r join grades g on g.id=r.grade_id where g.submission_id=$1', [submitWinner.id]), 2);
  await rejected(manageSql, [uuid(2), teacher.id, 'update', manualActivity.id, null, { expected_version: 2, title: 'Foreign tenant' }], 'P0002');
  await rejected(submitSql, [uuid(2), extra.id, manualActivity.id, 0, 'Foreign tenant'], 'P0002');
  await rejected(reviewSql, [uuid(2), teacher.id, submitWinner.id, 2, 1, 7, null, true], 'P0002');
  await rejected(publishSql, [uuid(2), teacher.id, submitWinner.id, 2], 'P0002');
  const noLink = await member('student');
  const changedRole = await member('student');
  await db.query("update app_users set role='teacher' where id=$1", [changedRole.id]);
  await rejected(submitSql, [uuid(1), noLink.id, futurePublished.id, 0, 'No enrollment'], '42501');
  await rejected(submitSql, [uuid(1), changedRole.id, futurePublished.id, 0, 'Current role changed'], '42501');
  await db.query('begin');
  await db.query("select set_config('app.activity_workflow',$1,true)", [futurePublished.id]);
  await rejected('insert into activity_submissions(tenant_id,activity_id,class_id,student_id,current_version,answer,submitted_at,is_late) values ($1,$2,$3,$4,1,$5,clock_timestamp(),false)', [uuid(1), futurePublished.id, uuid(40), teacher.id, 'Teacher is not a student'], '23503');
  await db.query('rollback');
  await db.query('begin');
  await db.query("select set_config('app.activity_workflow',$1,true)", [activity.id]);
  await rejected('insert into grades(tenant_id,activity_id,student_id,grade,submission_id,submission_version) values ($1,$2,$3,8,$4,2)', [uuid(1), activity.id, extra.auth, delivery.id], '23514');
  await db.query('rollback');
  await db.query('begin');
  await review(teacher, submitWinner.id, 2, 1, 7, 'rolled back', true);
  await db.query('rollback');
  check(await scalar('select revision as result from grades where submission_id=$1', [submitWinner.id]), 2);
  check(await scalar('select count(*)::int as result from grade_revisions r join grades g on g.id=r.grade_id where g.submission_id=$1', [submitWinner.id]), 2);
  console.log('PASS PostgreSQL: rollback, duplicate/resubmission/review races, publish serialization and fresh close/member/enrollment/period/assignment/deadline after lock waits');

  const signatures = ['manage_academic_activity(uuid,uuid,text,uuid,uuid,jsonb)', 'submit_activity_answer(uuid,uuid,uuid,integer,text)', 'review_activity_submission(uuid,uuid,uuid,integer,integer,numeric,text,boolean)', 'publish_activity_review(uuid,uuid,uuid,integer)', 'list_academic_activities(uuid,uuid,uuid,integer,integer,uuid)', 'record_activity_grade(uuid,uuid,uuid,uuid,numeric,text)'];
  for (const signature of signatures) {
    check((await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows, [{ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] }]);
    for (const role of ['anon', 'authenticated', 'service_role']) check(await scalar("select has_function_privilege($1,$2,'EXECUTE') as result", [role, signature]), role === 'service_role');
    check(await scalar("select count(*)::int as result from pg_proc p,lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", [signature]), 0);
  }
  for (const table of ['activity_submissions', 'activity_submission_versions', 'grade_revisions']) {
    check(await scalar('select relrowsecurity as result from pg_class where oid=$1::regclass', [table]), true);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`set role ${role}`);
      await rejected(`select * from ${table}`, [], '42501');
      await db.query('reset role');
    }
    await db.query('begin');
    await db.query(`grant select on ${table} to authenticated`);
    await db.query('set local role authenticated');
    check(await scalar(`select count(*)::int as result from ${table}`), 0);
    await db.query('rollback');
  }
  await db.query('set role authenticated');
  await rejected(submitSql, [uuid(1), extra.id, racing.id, 2, 'forbidden'], '42501');
  await db.query('reset role');
  await db.query('set role service_role');
  check((await manage(teacher, 'create', null, { title: 'Trusted service RPC' })).state, 'draft');
  await db.query('reset role');
  if (withExamGrades) {
    await db.query(readFileSync(join(root, 'supabase/migrations/20261103190038_in_person_exam_grades.sql'), 'utf8'));
    await checkExamGrades(teacher, foreign, student, stranger);
  }
  if (withReportCards) {
    await db.query(readFileSync(join(root, 'supabase/migrations/20261103190622_academic_report_cards.sql'), 'utf8'));
    await checkReportCards(teacher, student, stranger, foreign);
  }
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, synthetic identities, no remote database.`);
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map((client) => client.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
