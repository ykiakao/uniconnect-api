const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const containerName = `uniconnect-communication-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const peers = [];
let db, config, containerId;
let checks = 0, sequence = 1000;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const scalar = async (sql, params = [], client = db) => (await client.query(sql, params)).rows[0].result;
async function rejected(sql, params, code, client = db) {
  await assert.rejects(client.query(sql, params), e => { assert.equal(e.code, code, e.message); return true; });
  checks++;
}
async function member(role, tenant = uuid(1), active = true) {
  const auth = uuid(sequence++), id = uuid(sequence++), email = `synthetic-${sequence}@example.invalid`;
  await db.query('insert into auth.users(id,email) values ($1,$2)', [auth, email]);
  await db.query('insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) values ($1,$2,$3,$4,$5,$6,$7)', [id, tenant, auth, 'Synthetic', email, role, active]);
  return { id, auth };
}
const rpcSql = 'select academic_communication($1,$2,$3,$4) as result';
const rpc = (actor, operation, payload = {}, client = db, tenant = uuid(1)) => scalar(rpcSql, [tenant, actor.id, operation, payload], client);
async function peer() {
  const client = new Client({ ...config, statement_timeout: 12000 });
  peers.push(client); await client.connect(); return client;
}
async function waitForLock(client) {
  for (let i = 0; i < 200; i++) {
    if ((await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected PostgreSQL lock wait.');
}
async function main() {
  if (!process.argv.includes('--allow-local-migrations')) throw new Error('Explicit --allow-local-migrations required for disposable local tests.');
  containerId = docker('run', '--rm', '-d', '--name', containerName, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  const published = docker('port', containerId, '5432/tcp');
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, database: 'postgres', ssl: false };
  for (let i = 0; i < 80; i++) {
    db = new Client(config);
    try { await db.connect(); break; } catch { await db.end().catch(() => {}); if (i === 79) throw new Error('Local PostgreSQL unavailable.'); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  await db.query(`create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role`);
  await applyGuardedMigration(db, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
  for (const name of ['20260528000001_academic_base.sql','20260528000002_activities_grades_reports.sql','20260528000003_invites.sql','20261026000001_security_integrity.sql','20261026000002_academic_structure.sql','20261026000003_institutional_management.sql']) await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  await db.query("insert into tenants(id,name,slug) values ($1,'Synthetic A','synthetic-a'),($2,'Synthetic B','synthetic-b')", [uuid(1), uuid(2)]);
  const teacher = await member('teacher'), student = await member('student'), manager = await member('admin'), stranger = await member('student'), foreign = await member('teacher', uuid(2));
  await db.query("insert into courses(id,tenant_id,name) values ($1,$2,'Synthetic')", [uuid(30), uuid(1)]);
  await db.query("insert into academic_periods(id,tenant_id,code,name,status) values ($1,$2,'SYN','Synthetic','active')", [uuid(70), uuid(1)]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'SYN','Synthetic')", [uuid(80), uuid(1), uuid(30)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Synthetic',$6)", [uuid(40), uuid(1), uuid(30), uuid(80), uuid(70), teacher.auth]);
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(1), uuid(40), student.id]);
  await db.query('insert into messages(id,tenant_id,sender_id,class_id,content) values ($1,$2,$3,$4,$5)', [uuid(90), uuid(1), teacher.id, uuid(40), 'Legacy private history']);
  await db.query('insert into messages(id,tenant_id,sender_id,content) values ($1,$2,$3,$4)', [uuid(91), uuid(2), teacher.id, 'Legacy tenant mismatch preserved for manual review']);
  await db.query("insert into activities(id,tenant_id,class_id,title,created_by) values ($1,$2,$3,'Legacy A',$4),($5,$2,$3,'Legacy B',$4)", [uuid(50), uuid(1), uuid(40), teacher.auth, uuid(51)]);
  await db.query('insert into grades(id,tenant_id,activity_id,student_id,grade) values ($1,$2,$3,$4,6)', [uuid(60), uuid(1), uuid(50), student.auth]);
  await applyGuardedMigration(db, { name: '20261026000004_activity_workflow.sql', sql: readFileSync(join(root, 'supabase/migrations/20261026000004_activity_workflow.sql'), 'utf8') });
  await db.query('grant select,insert,update,delete on tenants,app_users,courses,classes,activities,grades,messages,enrollments,teaching_assignments,academic_periods,subjects to service_role');
  if (!baseline) await applyGuardedMigration(db, { name: '20261026000005_academic_communication.sql', sql: readFileSync(join(root, 'supabase/migrations/20261026000005_academic_communication.sql'), 'utf8') });
  check(await scalar("select to_regprocedure('academic_communication(uuid,uuid,text,jsonb)') is not null as result"), true);
  await scenarios({ teacher, student, manager, stranger, foreign });
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, synthetic identities, no remote database.`);
}
async function scenarios({ teacher, student, manager, stranger, foreign }) {
  check(await scalar('select count(*)::int as result from academic_notifications'), 0);
  await db.query('set role service_role');
  await db.query('insert into grades(tenant_id,activity_id,student_id,grade) values ($1,$2,$3,5)', [uuid(1), uuid(51), student.auth]);
  await db.query('update grades set grade=7 where tenant_id=$1 and activity_id=$2 and student_id=$3', [uuid(1), uuid(51), student.auth]);
  await db.query('reset role');
  check(await scalar("select count(*)::int as result from academic_notifications n join grade_revisions r on r.tenant_id=n.tenant_id and r.id=n.grade_revision_id where r.activity_id=$1", [uuid(51)]), 2);
  const make = (actor = manager, extra = {}) => rpc(actor, 'notice_create', { title: 'Synthetic notice', content: 'Private content', audienceType: 'institution', priority: 'medium', ...extra });
  const deny = (actor, operation, payload, code = '42501') => rejected(rpcSql, [uuid(1), actor.id, operation, payload], code);
  let notice = await make();
  check(notice.state, 'draft'); check(notice.revision, 1);
  check((await rpc(student, 'notice_list', { view: 'active', offset: 0, limit: 20 })).total, 0);
  await deny(student, 'notice_get', { id: notice.id }, 'P0002');
  await deny(student, 'notice_create', { title: 'Denied', content: 'Denied', audienceType: 'institution', priority: 'medium' });
  await deny(teacher, 'notice_create', { title: 'Denied', content: 'Denied', audienceType: 'institution', priority: 'medium' });
  const classNotice = await make(teacher, { audienceType: 'class', classId: uuid(40) });
  await deny(foreign, 'notice_publish', { id: classNotice.id, expectedRevision: 1 });
  const otherTeacher = await member('teacher');
  await deny(otherTeacher, 'notice_create', { title: 'Denied', content: 'Denied', audienceType: 'class', classId: uuid(40), priority: 'medium' });
  await deny(manager, 'notice_create', { title: '', content: 'body', audienceType: 'institution' }, '22023');
  await deny(manager, 'notice_create', { title: 'Title', content: 'body', audienceType: 'course', courseId: uuid(999) }, 'P0002');
  notice = await rpc(manager, 'notice_publish', { id: notice.id, expectedRevision: 1 });
  check(notice.state, 'published'); check(notice.revision, 2);
  check((await rpc(student, 'notice_get', { id: notice.id })).id, notice.id);
  check((await rpc(student, 'notice_list', { view: 'active', offset: 0, limit: 1 })).total, 1);
  const receipt = await rpc(student, 'notice_read', { id: notice.id, expectedRevision: 2 });
  check(await rpc(student, 'notice_read', { id: notice.id, expectedRevision: 2 }), receipt);
  await deny(student, 'notice_read', { id: notice.id, expectedRevision: 2, userId: stranger.id }, '22023');
  const before = (await rpc(student, 'notification_count')).unread_count;
  notice = await rpc(manager, 'notice_update', { id: notice.id, expectedRevision: 2, content: 'Updated' });
  check(notice.revision, 3); check((await rpc(student, 'notification_count')).unread_count, before);
  await deny(manager, 'notice_update', { id: notice.id, expectedRevision: 3, audienceType: 'course' }, '22023');
  await deny(manager, 'notice_update', { id: notice.id, expectedRevision: 2, content: 'Stale' }, '23514');
  await deny(student, 'notice_read', { id: notice.id, expectedRevision: 2 }, '23514');
  const latestReceipt = await rpc(student, 'notice_read', { id: notice.id, expectedRevision: 3 });
  check(latestReceipt.read_revision, 3);
  check((await rpc(manager, 'notice_history', { id: notice.id, offset: 0, limit: 10 })).total, 3);
  await deny(student, 'notice_history', { id: notice.id, offset: 0, limit: 10 });
  const late = await member('student');
  await deny(late, 'notice_get', { id: notice.id }, 'P0002');
  await rpc(teacher, 'notice_publish', { id: classNotice.id, expectedRevision: 1 });
  await deny(stranger, 'notice_get', { id: classNotice.id }, 'P0002');
  await db.query("update enrollments set status='completed' where student_id=$1", [student.id]);
  check((await rpc(student, 'notice_get', { id: classNotice.id })).id, classNotice.id);
  await db.query("update enrollments set status='active' where student_id=$1", [student.id]);
  const courseNotice = await make(manager, { audienceType: 'course', courseId: uuid(30) });
  await rpc(manager, 'notice_publish', { id: courseNotice.id, expectedRevision: 1 });
  check((await rpc(student, 'notice_get', { id: courseNotice.id })).id, courseNotice.id);
  await deny(stranger, 'notice_get', { id: courseNotice.id }, 'P0002');
  const alreadyExpired = await make(manager, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  await deny(manager, 'notice_publish', { id: alreadyExpired.id, expectedRevision: 1 }, '23514');
  check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1', [alreadyExpired.id]), 0);
  const inactiveClassNotice = await make(teacher, { audienceType: 'class', classId: uuid(40) });
  await db.query("update academic_periods set status='closed' where id=$1", [uuid(70)]);
  await deny(teacher, 'notice_publish', { id: inactiveClassNotice.id, expectedRevision: 1 }, '23514');
  await db.query("update academic_periods set status='active' where id=$1", [uuid(70)]);
  const expired = await make(manager, { expiresAt: new Date(Date.now() + 500).toISOString() });
  await rpc(manager, 'notice_publish', { id: expired.id, expectedRevision: 1 });
  await db.query('select pg_sleep(0.6)');
  check((await rpc(student, 'notice_list', { view: 'active', offset: 0, limit: 100 })).data.some(n => n.id === expired.id), false);
  check((await rpc(student, 'notice_list', { view: 'history', offset: 0, limit: 100 })).data.some(n => n.id === expired.id), true);
  await rpc(manager, 'notice_archive', { id: notice.id, expectedRevision: 3 });
  check((await rpc(student, 'notice_get', { id: notice.id })).state, 'archived');
  await deny(manager, 'notice_publish', { id: notice.id, expectedRevision: 4 }, '23514');
  const conversation = await rpc(student, 'conversation_create', { classId: uuid(40), participantId: teacher.id });
  check((await rpc(teacher, 'conversation_create', { classId: uuid(40), participantId: student.id })).id, conversation.id);
  await deny(stranger, 'conversation_create', { classId: uuid(40), participantId: teacher.id });
  await deny(student, 'conversation_create', { classId: uuid(40), participantId: foreign.id }, 'P0002');
  await deny(manager, 'conversation_get', { id: conversation.id }, 'P0002');
  await deny(stranger, 'message_list', { id: conversation.id, afterSequence: 0, limit: 20 }, 'P0002');
  await deny(student, 'message_send', { id: conversation.id, content: 'Spoof', clientMessageId: uuid(200), senderId: teacher.id }, '22023');
  await deny(student, 'message_send', { id: conversation.id, content: ' ', clientMessageId: uuid(200) }, '22023');
  const message = await rpc(student, 'message_send', { id: conversation.id, content: 'Hello', clientMessageId: uuid(200) });
  check(message.sequence, 1); check(message.sender_id, student.id);
  check((await rpc(student, 'message_send', { id: conversation.id, content: 'Hello', clientMessageId: uuid(200) })).id, message.id);
  await deny(student, 'message_send', { id: conversation.id, content: 'Different', clientMessageId: uuid(200) }, '23514');
  await rpc(teacher, 'message_send', { id: conversation.id, content: 'Reply', clientMessageId: uuid(201) });
  const page = await rpc(student, 'message_list', { id: conversation.id, afterSequence: 0, limit: 1 });
  check(page.has_more, true); check(page.next_after_sequence, 1); check(page.data[0].id, message.id);
  check((await rpc(student, 'message_list', { id: conversation.id, afterSequence: 1, limit: 1 })).has_more, false);
  const watermark = await rpc(teacher, 'message_read', { id: conversation.id, upToSequence: 2 });
  check(watermark.last_read_sequence, 2);
  check((await rpc(teacher, 'message_read', { id: conversation.id, upToSequence: 1 })).last_read_sequence, 2);
  await deny(student, 'message_read', { id: conversation.id, upToSequence: 3 }, '23514');
  check((await rpc(student, 'message_list', { id: conversation.id, afterSequence: 0, limit: 20 })).data[0].read_by_recipient, true);
  await rejected('update messages set content=$1 where id=$2', ['Changed', message.id], '23514');
  await rejected('delete from messages where id=$1', [message.id], '23514');
  check(await scalar('select content as result from messages where id=$1', [uuid(90)]), 'Legacy private history');
  check((await rpc(student, 'message_list', { id: conversation.id, afterSequence: 0, limit: 100 })).data.length, 2);
  await db.query("update enrollments set status='completed' where student_id=$1", [student.id]);
  check((await rpc(student, 'conversation_get', { id: conversation.id })).id, conversation.id);
  await deny(student, 'message_send', { id: conversation.id, content: 'Closed enrollment', clientMessageId: uuid(202) });
  await db.query("update enrollments set status='active' where student_id=$1", [student.id]);
  const activitySql = 'select manage_academic_activity($1,$2,$3,$4,$5,$6) as result';
  const activity = (operation, id, payload = {}, client = db) => scalar(activitySql, [uuid(1), teacher.id, operation, id, uuid(40), payload], client);
  const task = await activity('create', null, { title: 'Task', due_date: new Date(Date.now() + 3600000).toISOString() });
  check(await scalar("select count(*)::int as result from academic_notifications where activity_id=$1", [task.id]), 0);
  await activity('publish', task.id, { expected_version: 1 });
  check(await scalar("select count(*)::int as result from academic_notifications where activity_id=$1 and event_type='activity_published'", [task.id]), 1);
  const submit = await scalar('select submit_activity_answer($1,$2,$3,$4,$5) as result', [uuid(1), student.id, task.id, 0, 'Answer']);
  const grade = await scalar('select review_activity_submission($1,$2,$3,$4,$5,$6,$7,$8) as result', [uuid(1), teacher.id, submit.id, 0, 1, 8, 'Private feedback', false]);
  check(await scalar("select count(*)::int as result from academic_notifications n join grade_revisions r on r.id=n.grade_revision_id where r.activity_id=$1", [task.id]), 0);
  await scalar('select publish_activity_review($1,$2,$3,$4) as result', [uuid(1), teacher.id, submit.id, grade.revision]);
  check(await scalar("select count(*)::int as result from academic_notifications n join grade_revisions r on r.id=n.grade_revision_id where r.activity_id=$1", [task.id]), 1);
  await scalar('select review_activity_submission($1,$2,$3,$4,$5,$6,$7,$8) as result', [uuid(1), teacher.id, submit.id, grade.revision + 1, 1, 9, 'New result', true]);
  check(await scalar("select count(*)::int as result from academic_notifications n join grade_revisions r on r.id=n.grade_revision_id where r.activity_id=$1", [task.id]), 2);
  const pending = await activity('create', null, { title: 'Due soon', due_date: new Date(Date.now() + 3600000).toISOString() });
  await activity('publish', pending.id, { expected_version: 1 });
  const deadlineSql = 'select generate_academic_deadline_notifications($1,$2,$3,$4) as result';
  let deadlines = await scalar(deadlineSql, [uuid(1), 120, 1, null]);
  let created = deadlines.created_notifications;
  while (deadlines.has_more) { deadlines = await scalar(deadlineSql, [uuid(1), 120, 1, deadlines.next_after_id]); created += deadlines.created_notifications; }
  check(created, 1);
  check((await scalar(deadlineSql, [uuid(1), 120, 100, null])).created_notifications, 0);
  await activity('update', pending.id, { expected_version: 2, due_date: new Date(Date.now() + 4000000).toISOString() });
  check((await scalar(deadlineSql, [uuid(1), 120, 100, null])).created_notifications, 1);
  await activity('close', pending.id, { expected_version: 3 });
  check((await scalar(deadlineSql, [uuid(1), 120, 100, null])).created_notifications, 0);
  const notifications = await rpc(student, 'notification_list', { offset: 0, limit: 100, unreadOnly: false });
  check(notifications.data.some(n => n.event_type === 'notice_published'), true);
  for (const n of notifications.data) { check('content' in n || 'grade' in n || 'feedback' in n, false); check(typeof n.resource_id, 'string'); check(typeof n.resource_type, 'string'); }
  const first = notifications.data[0];
  const marked = await rpc(student, 'notification_read', { id: first.id });
  check((await rpc(student, 'notification_read', { id: first.id })).read_at, marked.read_at);
  await deny(stranger, 'notification_read', { id: first.id }, 'P0002');
  check((await rpc(student, 'notification_count')).unread_count, notifications.total - 1);
  await db.query('update app_users set active=false where id=$1', [student.id]);
  for (const [op, payload] of [['notice_get', { id: notice.id }], ['conversation_list', { offset: 0, limit: 10 }], ['notification_count', {}]]) await deny(student, op, payload);
  await deny(teacher, 'message_send', { id: conversation.id, content: 'Inactive recipient', clientMessageId: uuid(203) });
  await db.query('update app_users set active=true where id=$1', [student.id]);
  const contender = await peer();
  await db.query('begin');
  await db.query('select id from academic_conversations where id=$1 for update', [conversation.id]);
  const delayedSend = rpc(student, 'message_send', { id: conversation.id, content: 'Sent after lock release', clientMessageId: uuid(207) }, contender);
  await waitForLock(contender);
  const releasedAt = await scalar('select clock_timestamp()::text as result');
  await db.query('commit');
  const delayedMessage = await delayedSend;
  check(await scalar('select created_at >= $2::timestamptz as result from messages where id=$1', [delayedMessage.id, releasedAt]), true);
  await db.query('begin');
  const racing = await rpc(student, 'message_send', { id: conversation.id, content: 'Race', clientMessageId: uuid(204) });
  const duplicate = rpc(student, 'message_send', { id: conversation.id, content: 'Race', clientMessageId: uuid(204) }, contender);
  await waitForLock(contender); await db.query('commit'); check((await duplicate).id, racing.id);
  await db.query('begin');
  await rpc(student, 'message_send', { id: conversation.id, content: 'Rollback', clientMessageId: uuid(205) });
  await db.query('rollback');
  check(await scalar('select count(*)::int as result from messages where client_message_id=$1', [uuid(205)]), 0);
  check(await scalar("select count(*)::int as result from academic_notifications where event_key like $1", [`message:${uuid(205)}%`]), 0);
  await db.query('begin');
  await db.query('update app_users set active=false where id=$1', [student.id]);
  const deactivated = rpc(student, 'message_send', { id: conversation.id, content: 'After deactivation', clientMessageId: uuid(206) }, contender).then(() => null, e => e.code);
  await waitForLock(contender); await db.query('commit'); check(await deactivated, '42501');
  await db.query('update app_users set active=true where id=$1', [student.id]);
  const raceNotice = await make();
  await db.query('begin'); await rpc(manager, 'notice_update', { id: raceNotice.id, expectedRevision: 1, title: 'Winner' });
  const stale = rpc(manager, 'notice_update', { id: raceNotice.id, expectedRevision: 1, title: 'Loser' }, contender).then(() => null, e => e.code);
  await waitForLock(contender); await db.query('commit'); check(await stale, '23514');
  await db.query('begin'); await rpc(manager, 'notice_publish', { id: raceNotice.id, expectedRevision: 2 }); await db.query('rollback');
  check((await rpc(manager, 'notice_get', { id: raceNotice.id })).state, 'draft');
  check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1', [raceNotice.id]), 0);
  check(await scalar('select count(*)::int as result from academic_notice_reads where notice_id=$1 and user_id=$2', [notice.id, student.id]), 2);
  check((await rpc(student, 'message_list', { id: conversation.id, afterSequence: 900, limit: 10 })).next_after_sequence, 900);
  check((await rpc(student, 'message_list', { id: conversation.id, afterSequence: 900, limit: 10 })).has_more, false);
  check((await rpc(student, 'conversation_get', { id: conversation.id })).updated_at > conversation.created_at, true);
  check((await rpc(manager, 'notice_history', { id: notice.id, offset: 0, limit: 10 })).data.every(r => r.changed_by === manager.id && typeof r.changed_at === 'string'), true);
  check(notifications.data.every(n => n.recipient_id === student.id), true);
  const publishedGrade = await scalar('select id as result from grades where submission_id=$1', [submit.id]);
  check(notifications.data.filter(n => n.event_type === 'activity_result_published' && n.grade_id === publishedGrade).every(n => n.resource_type === 'grade' && n.resource_id === publishedGrade), true);
  await db.query("set timezone='Pacific/Auckland'");
  check((await scalar(deadlineSql, [uuid(1), 120, 100, null])).created_notifications, 0);
  await db.query("set timezone='UTC'");
  await db.query('begin'); await db.query("update app_users set role='student' where id=$1", [manager.id]);
  const changedRole = rpc(manager, 'notice_update', { id: raceNotice.id, expectedRevision: 2, title: 'Changed authority' }, contender).then(() => null, e => e.code);
  await waitForLock(contender); await db.query('commit'); check(await changedRole, '42501');
  await db.query("update app_users set role='admin' where id=$1", [manager.id]);
  for (const op of ['notice_list','conversation_list','notification_list']) {
    await db.query('begin'); await db.query('update app_users set active=false where id=$1', [student.id]);
    const afterDisable = rpc(student, op, op === 'notice_list' ? { view: 'active', offset: 0, limit: 10 } : { offset: 0, limit: 10 }, contender).then(() => null, e => e.code);
    await waitForLock(contender); await db.query('commit'); check(await afterDisable, '42501');
    await db.query('update app_users set active=true where id=$1', [student.id]);
  }
  await db.query('insert into teaching_assignments(tenant_id,class_id,teacher_id) values ($1,$2,$3)', [uuid(1), uuid(40), otherTeacher.id]);
  const extraConversation = await rpc(student, 'conversation_create', { classId: uuid(40), participantId: otherTeacher.id });
  for (const scenario of ['enrollment','assignment','period','recipient']) {
    await db.query('begin');
    if (scenario === 'enrollment') await db.query("update enrollments set status='suspended' where student_id=$1", [student.id]);
    if (scenario === 'assignment') await db.query("update teaching_assignments set status='inactive' where teacher_id=$1", [otherTeacher.id]);
    if (scenario === 'period') await db.query("update academic_periods set status='closed' where id=$1", [uuid(70)]);
    if (scenario === 'recipient') await db.query('update app_users set active=false where id=$1', [otherTeacher.id]);
    const blocked = rpc(student, 'message_send', { id: extraConversation.id, content: scenario, clientMessageId: uuid(sequence++) }, contender).then(() => null, e => e.code);
    await waitForLock(contender); await db.query('commit'); check(await blocked, scenario === 'period' ? '23514' : '42501');
    if (scenario === 'enrollment') await db.query("update enrollments set status='active' where student_id=$1", [student.id]);
    if (scenario === 'assignment') await db.query("update teaching_assignments set status='active' where teacher_id=$1", [otherTeacher.id]);
    if (scenario === 'period') await db.query("update academic_periods set status='active' where id=$1", [uuid(70)]);
    if (scenario === 'recipient') await db.query('update app_users set active=true where id=$1', [otherTeacher.id]);
  }
  const deactivateTask = await activity('create', null, { title: 'Fresh recipient' });
  await db.query('begin'); await db.query('update app_users set active=false where id=$1', [student.id]);
  const freshPublish = activity('publish', deactivateTask.id, { expected_version: 1 }, contender);
  await waitForLock(contender); await db.query('commit'); check((await freshPublish).state, 'published');
  check(await scalar('select count(*)::int as result from academic_notifications where activity_id=$1 and user_id=$2', [deactivateTask.id, student.id]), 0);
  await db.query('update app_users set active=true where id=$1', [student.id]);
  const freshNotice = await make();
  await db.query('begin'); await db.query('update app_users set active=false where id=$1', [student.id]);
  const freshNoticePublish = rpc(manager, 'notice_publish', { id: freshNotice.id, expectedRevision: 1 }, contender);
  await waitForLock(contender); await db.query('commit'); check((await freshNoticePublish).state, 'published');
  check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1 and user_id=$2', [freshNotice.id, student.id]), 0);
  await db.query('update app_users set active=true where id=$1', [student.id]);
  const waitingExpiry = await make(manager, { expiresAt: new Date(Date.now() + 1000).toISOString() });
  await db.query('begin'); await db.query('select id from app_users where id=$1 for update', [student.id]);
  const expiredDuringLock = rpc(manager, 'notice_publish', { id: waitingExpiry.id, expectedRevision: 1 }, contender).then(() => null, e => e.code);
  await waitForLock(contender);
  await db.query('select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.05) from academic_notices where id=$1', [waitingExpiry.id]);
  await db.query('commit'); check(await expiredDuringLock, '23514');
  check(await scalar('select state as result from academic_notices where id=$1', [waitingExpiry.id]), 'draft');
  check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1', [waitingExpiry.id]), 0);
  const unpublished = await activity('create', null, { title: 'Atomic publication' });
  const manualTask = await activity('create', null, { title: 'Atomic result' });
  await activity('publish', manualTask.id, { expected_version: 1 });
  await db.query(`create function test_notification_failure() returns trigger language plpgsql as $$ begin
    if new.event_type=current_setting('test.reject_event',true) then raise exception using errcode='23514',message='Synthetic notification failure'; end if; return new; end $$;
    create trigger zz_test_notification_failure before insert on academic_notifications for each row execute function test_notification_failure()`);
  for (const type of ['notice_published','activity_published','activity_result_published','message_received']) {
    await db.query("select set_config('test.reject_event',$1,false)", [type]);
    if (type === 'notice_published') {
      await deny(manager, 'notice_publish', { id: raceNotice.id, expectedRevision: 2 }, '23514');
      check((await rpc(manager, 'notice_get', { id: raceNotice.id })).revision, 2);
      check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1', [raceNotice.id]), 0);
    }
    if (type === 'activity_published') {
      await rejected(activitySql, [uuid(1), teacher.id, 'publish', unpublished.id, uuid(40), { expected_version: 1 }], '23514');
      check(await scalar('select state as result from activities where id=$1', [unpublished.id]), 'draft');
    }
    if (type === 'activity_result_published') {
      await rejected('select record_activity_grade($1,$2,$3,$4,$5,$6)', [uuid(1), teacher.id, manualTask.id, student.id, 5, 'Secret'], '23514');
      check(await scalar('select count(*)::int as result from grades where activity_id=$1', [manualTask.id]), 0);
      check(await scalar('select count(*)::int as result from grade_revisions where activity_id=$1', [manualTask.id]), 0);
    }
    if (type === 'message_received') {
      const last = (await rpc(student, 'conversation_get', { id: conversation.id })).last_sequence;
      await deny(student, 'message_send', { id: conversation.id, content: 'Atomic failure', clientMessageId: uuid(800) }, '23514');
      check((await rpc(student, 'conversation_get', { id: conversation.id })).last_sequence, last);
      check(await scalar('select count(*)::int as result from messages where client_message_id=$1', [uuid(800)]), 0);
    }
  }
  await db.query("select set_config('test.reject_event','',false)");
  await db.query('drop trigger zz_test_notification_failure on academic_notifications; drop function test_notification_failure()');
  await fanout();
  for (const table of ['academic_notices','academic_notice_revisions','academic_notice_recipients','academic_notice_reads','academic_conversations','academic_conversation_reads','academic_notifications']) {
    check(await scalar('select relrowsecurity as result from pg_class where oid=$1::regclass', [table]), true);
    await db.query('begin'); await db.query(`grant select on ${table} to authenticated`); await db.query('set local role authenticated');
    check(await scalar(`select count(*)::int as result from ${table}`), 0); await db.query('rollback');
  }
  for (const signature of ['academic_communication(uuid,uuid,text,jsonb)','generate_academic_deadline_notifications(uuid,integer,integer,uuid)']) {
    check((await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows, [{ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] }]);
    for (const role of ['anon','authenticated','service_role']) check(await scalar("select has_function_privilege($1,$2,'EXECUTE') as result", [role, signature]), role === 'service_role');
  }
  await rejected('insert into academic_conversations(tenant_id,class_id,student_id,teacher_id) values ($1,$2,$3,$4)', [uuid(2), uuid(40), student.id, teacher.id], '23503');
  await rejected('update academic_notice_revisions set title=$1 where notice_id=$2', ['Alter history', notice.id], '23514');
  await rejected('delete from academic_notice_recipients where notice_id=$1', [notice.id], '23514');
  await rejected('insert into academic_notifications(tenant_id,user_id,event_type,event_key,notice_id) values ($1,$2,$3,$4,$5)', [uuid(1), student.id, 'notice_published', 'forged', notice.id], '23514');
  await rejected('update app_users set auth_user_id=$1 where id=$2', [stranger.auth, manager.id], '23514');
  for (const [op, payload] of [['message_list', { id: conversation.id, limit: 101, afterSequence: 0 }], ['notice_list', { view: 'active', offset: -1, limit: 20 }], ['notification_list', { offset: 0, limit: 10, unreadOnly: 'yes' }]]) await deny(student, op, payload, '22023');
  for (const params of [[uuid(1), 0, 10, null], [uuid(1), 10081, 10, null], [uuid(1), 60, 101, null], [null, 60, 10, null]]) await rejected(deadlineSql, params, '22023');
}
async function fanout() {
  await db.query("insert into tenants(id,name,slug) values ($1,'Fanout synthetic','fanout-synthetic')", [uuid(3)]);
  const teacher = await member('teacher', uuid(3)), manager = await member('admin', uuid(3));
  await db.query("insert into courses(id,tenant_id,name) values ($1,$2,'Fanout')", [uuid(31), uuid(3)]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'FAN','Fanout')", [uuid(81), uuid(3), uuid(31)]);
  await db.query("insert into academic_periods(id,tenant_id,code,name,status) values ($1,$2,'FAN','Fanout','active')", [uuid(71), uuid(3)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Fanout',$6)", [uuid(42), uuid(3), uuid(31), uuid(81), uuid(71), teacher.auth]);
  await db.query(`with synthetic as (select gen_random_uuid() as id,gen_random_uuid() as auth,n from generate_series(1,10000)n),
    users as(insert into auth.users(id,email) select auth,'fanout-'||n||'@example.invalid' from synthetic returning id)
    insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) select s.id,$1,s.auth,'Fanout','fanout-'||s.n||'@example.invalid','student',true from synthetic s join users u on u.id=s.auth`, [uuid(3)]);
  await db.query("insert into enrollments(tenant_id,class_id,student_id) select tenant_id,$1,id from app_users where tenant_id=$2 and role='student'", [uuid(42), uuid(3)]);
  const activitySql = 'select manage_academic_activity($1,$2,$3,$4,$5,$6) as result';
  const task = await scalar(activitySql, [uuid(3), teacher.id, 'create', null, uuid(42), { title: 'Fanout' }]);
  await scalar(activitySql, [uuid(3), teacher.id, 'publish', task.id, uuid(42), { expected_version: 1 }]);
  check(await scalar('select count(*)::int as result from academic_notifications where activity_id=$1', [task.id]), 10000);
  const extra = await member('student', uuid(3));
  await db.query('insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)', [uuid(3), uuid(42), extra.id]);
  const overflow = await scalar(activitySql, [uuid(3), teacher.id, 'create', null, uuid(42), { title: 'Overflow' }]);
  await rejected(activitySql, [uuid(3), teacher.id, 'publish', overflow.id, uuid(42), { expected_version: 1 }], '54000');
  check(await scalar('select state as result from activities where id=$1', [overflow.id]), 'draft');
  check(await scalar('select count(*)::int as result from academic_notifications where activity_id=$1', [overflow.id]), 0);
  const notice = await rpc(manager, 'notice_create', { title: 'Overflow', content: 'Synthetic', audienceType: 'institution' }, db, uuid(3));
  await rejected(rpcSql, [uuid(3), manager.id, 'notice_publish', { id: notice.id, expectedRevision: 1 }], '54000');
  check(await scalar('select state as result from academic_notices where id=$1', [notice.id]), 'draft');
  check(await scalar('select count(*)::int as result from academic_notice_recipients where notice_id=$1', [notice.id]), 0);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map(client => client.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
