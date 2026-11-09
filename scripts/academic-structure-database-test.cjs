const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const containerName = `uniconnect-academic-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db;
let containerId;
let checks = 0;
const peers = [];
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
async function rejected(sql, params, code) {
  await assert.rejects(db.query(sql, params), (error) => error.code === code);
  checks++;
}
async function waitForLock(client) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Expected concurrent operation to wait for database lock.');
}
async function main() {
  containerId = docker('run', '--rm', '-d', '--name', containerName, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  const published = docker('port', containerId, '5432/tcp');
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, database: 'postgres', ssl: false };
  for (let attempt = 0; attempt < 80; attempt++) {
    db = new Client(config);
    try { await db.connect(); break; } catch {
      await db.end().catch(() => {});
      if (attempt === 79) throw new Error('Local PostgreSQL did not start.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await db.query(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.role() returns text language sql stable as $$
      select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$`);
  await applyGuardedMigration(db, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
  for (const name of ['20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql', '20260528000003_invites.sql', '20261026000001_security_integrity.sql']) {
    await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  }
  await db.query('insert into auth.users(id) values ($1),($2),($3),($4),($5),($6)', [10,11,12,13,14,15].map(uuid));
  await db.query(`insert into tenants(id,name,slug) values ($1,'A','a'),($2,'B','b')`, [uuid(1),uuid(2)]);
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role) values
    ($1,$2,$3,'Student','student@example.invalid','student'),
    ($4,$2,$5,'Teacher','teacher@example.invalid','teacher'),
    ($6,$7,$8,'Other student','other@example.invalid','student'),
    ($9,$2,$10,'Co-teacher','co@example.invalid','teacher'),
    ($11,$2,$12,'Manager','manager@example.invalid','coordinator'),
    ($13,$2,$14,'Race student','race@example.invalid','student')`,
    [uuid(20),uuid(1),uuid(10),uuid(21),uuid(11),uuid(22),uuid(2),uuid(12),uuid(23),uuid(13),uuid(24),uuid(14),uuid(25),uuid(15)]);
  await db.query(`insert into courses(id,tenant_id,name) values ($1,$2,'A'),($3,$4,'B'),($5,$2,'A2')`, [uuid(30),uuid(1),uuid(31),uuid(2),uuid(32)]);
  await db.query(`insert into classes(id,tenant_id,course_id,name,teacher_id) values ($1,$2,$3,'Legacy',$4)`, [uuid(40),uuid(1),uuid(30),uuid(11)]);
  await db.query(`insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Legacy activity')`, [uuid(50),uuid(1),uuid(40)]);
  await db.query(`insert into grades(id,tenant_id,activity_id,student_id,grade) values ($1,$2,$3,$4,7)`, [uuid(60),uuid(1),uuid(50),uuid(10)]);
  if (!baseline) await applyGuardedMigration(db, { name: '20261026000002_academic_structure.sql', sql: readFileSync(join(root, 'supabase/migrations/20261026000002_academic_structure.sql'), 'utf8') });
  check((await db.query("select to_regclass('public.academic_periods') is not null as present")).rows[0].present, true);
  console.log('PASS PostgreSQL: academic structure exists');
  check((await db.query('select count(*)::int as n from grades where id=$1',[uuid(60)])).rows[0].n,1);
  await rejected('delete from activities where id=$1',[uuid(50)],'23514');
  check((await db.query('select count(*)::int as n from grades where id=$1',[uuid(60)])).rows[0].n,1);
  check((await db.query('select count(*)::int as n from enrollments')).rows[0].n,0);
  check((await db.query('select teacher_id,status,is_primary from teaching_assignments where class_id=$1',[uuid(40)])).rows,
    [{teacher_id:uuid(21),status:'active',is_primary:true}]);
  check((await db.query('select subject_id,academic_period_id,academic_status from classes where id=$1',[uuid(40)])).rows,
    [{subject_id:null,academic_period_id:null,academic_status:'active'}]);
  await db.query(`insert into academic_periods(id,tenant_id,code,name) values ($1,$2,'2026-2','Period A'),($3,$4,'2026-2','Period B')`,[uuid(70),uuid(1),uuid(71),uuid(2)]);
  await rejected(`insert into academic_periods(tenant_id,code,name) values ($1,'2026-2','Duplicate')`,[uuid(1)],'23505');
  await rejected(`insert into academic_periods(tenant_id,code,name,start_date,end_date) values ($1,'bad-date','Bad','2026-12-01','2026-01-01')`,[uuid(1)],'23514');
  await rejected(`insert into academic_periods(tenant_id,code,name,status) values ($1,'bad-status','Bad','inactive')`,[uuid(1)],'23514');
  await db.query(`insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'SUB','Subject A'),($4,$5,$6,'SUB','Subject B'),($7,$2,$8,'SUB2','Other course')`,[uuid(80),uuid(1),uuid(30),uuid(81),uuid(2),uuid(31),uuid(82),uuid(32)]);
  await rejected(`insert into subjects(tenant_id,course_id,code,name) values ($1,$2,'cross','Cross')`,[uuid(1),uuid(31)],'23503');
  await rejected(`insert into subjects(tenant_id,course_id,code,name) values ($1,$2,'SUB','Duplicate')`,[uuid(1),uuid(30)],'23505');
  await rejected(`update subjects set status='archived' where id=$1`,[uuid(80)],'23514');
  const enrollmentSql = 'insert into enrollments(id,tenant_id,class_id,student_id) values ($1,$2,$3,$4)';
  const gradeSql = 'insert into grades(tenant_id,activity_id,student_id,grade) values ($1,$2,$3,8)';
  await rejected(enrollmentSql,[uuid(90),uuid(1),uuid(40),uuid(20)],'23514');
  await rejected(`update grades set grade=8 where id=$1`,[uuid(60)],'23514');
  await rejected(`update classes set subject_id=$1 where id=$2`,[uuid(80),uuid(40)],'23514');
  await rejected(`update classes set subject_id=$1,academic_period_id=$2 where id=$3`,[uuid(82),uuid(70),uuid(40)],'23503');
  await rejected(`update classes set subject_id=$1,academic_period_id=$2 where id=$3`,[uuid(80),uuid(71),uuid(40)],'23503');
  await rejected(`insert into classes(tenant_id,course_id,subject_id,academic_period_id,name) values ($1,$2,$3,$4,'Cross subject')`,[uuid(1),uuid(30),uuid(81),uuid(70)],'23503');
  await db.query(`update classes set subject_id=$1,academic_period_id=$2 where id=$3`,[uuid(80),uuid(70),uuid(40)]);
  await rejected(`update classes set subject_id=null,academic_period_id=null where id=$1`,[uuid(40)],'23514');
  await rejected(enrollmentSql,[uuid(90),uuid(1),uuid(40),uuid(10)],'23514');
  await rejected(enrollmentSql,[uuid(90),uuid(1),uuid(40),uuid(21)],'23514');
  await rejected(enrollmentSql,[uuid(90),uuid(1),uuid(40),uuid(22)],'23514');
  await rejected(enrollmentSql,[uuid(90),uuid(2),uuid(40),uuid(22)],'23514');
  await db.query(enrollmentSql,[uuid(90),uuid(1),uuid(40),uuid(20)]);
  await rejected(enrollmentSql,[uuid(91),uuid(1),uuid(40),uuid(20)],'23505');
  await rejected(`update enrollments set status='inactive' where id=$1`,[uuid(90)],'23514');
  check((await db.query('select status from enrollment_status_history where enrollment_id=$1',[uuid(90)])).rows,[{status:'active'}]);
  await db.query('update grades set grade=8 where id=$1',[uuid(60)]);
  for (const status of ['completed','cancelled','suspended','active']) {
    await db.query('update enrollments set status=$1 where id=$2',[status,uuid(90)]);
    if (['active','completed'].includes(status)) await db.query('update grades set grade=9 where id=$1',[uuid(60)]);
    else await rejected('update grades set grade=9 where id=$1',[uuid(60)],'23514');
  }
  check((await db.query('select count(*)::int as n from enrollment_status_history where enrollment_id=$1',[uuid(90)])).rows[0].n,5);
  await db.query('update enrollments set status=status where id=$1',[uuid(90)]);
  check((await db.query('select count(*)::int as n from enrollment_status_history where enrollment_id=$1',[uuid(90)])).rows[0].n,5);
  await rejected('delete from enrollments where id=$1',[uuid(90)],'23503');
  await rejected('delete from enrollment_status_history where enrollment_id=$1',[uuid(90)],'23514');
  await rejected("update enrollment_status_history set status='cancelled' where enrollment_id=$1",[uuid(90)],'23514');
  await rejected("insert into enrollment_status_history(tenant_id,enrollment_id,status) values ($1,$2,'active')",[uuid(1),uuid(90)],'23514');
  await rejected('delete from classes where id=$1',[uuid(40)],'23514');
  await rejected('delete from courses where id=$1',[uuid(30)],'23514');
  await rejected('delete from subjects where id=$1',[uuid(80)],'23503');
  await rejected('delete from academic_periods where id=$1',[uuid(70)],'23503');
  await rejected('update subjects set course_id=$1 where id=$2',[uuid(32),uuid(80)],'23503');
  await rejected(`update app_users set role='teacher' where id=$1`,[uuid(20)],'23514');
  await rejected('update enrollments set student_id=$1 where id=$2',[uuid(25),uuid(90)],'23514');
  await rejected('update classes set course_id=$1,subject_id=$2 where id=$3',[uuid(32),uuid(82),uuid(40)],'23514');
  console.log('PASS PostgreSQL: real tenant FKs, institutional IDs, formal enrollment, immutable history and legacy mapping');
  const assignmentSql = 'insert into teaching_assignments(tenant_id,class_id,teacher_id) values ($1,$2,$3)';
  await rejected(assignmentSql,[uuid(1),uuid(40),uuid(20)],'23514');
  await rejected(assignmentSql,[uuid(2),uuid(40),uuid(21)],'23514');
  await db.query(assignmentSql,[uuid(1),uuid(40),uuid(23)]);
  await rejected(assignmentSql,[uuid(1),uuid(40),uuid(23)],'23505');
  await rejected(`update teaching_assignments set is_primary=true where class_id=$1 and teacher_id=$2`,[uuid(40),uuid(23)],'23514');
  await rejected(`update teaching_assignments set status='inactive' where class_id=$1 and teacher_id=$2`,[uuid(40),uuid(21)],'23514');
  await rejected('delete from teaching_assignments where class_id=$1 and teacher_id=$2',[uuid(40),uuid(21)],'23514');
  await db.query('update classes set teacher_id=$1 where id=$2',[uuid(13),uuid(40)]);
  check((await db.query('select teacher_id,status,is_primary from teaching_assignments where class_id=$1 order by teacher_id',[uuid(40)])).rows,
    [{teacher_id:uuid(21),status:'inactive',is_primary:false},{teacher_id:uuid(23),status:'active',is_primary:true}]);
  await db.query('update classes set teacher_id=null where id=$1',[uuid(40)]);
  check((await db.query('select count(*)::int as n from teaching_assignments where class_id=$1 and is_primary',[uuid(40)])).rows[0].n,0);
  await rejected(`update app_users set role='student' where id=$1`,[uuid(21)],'23514');
  await db.query('update classes set teacher_id=$1 where id=$2',[uuid(11),uuid(40)]);
  await db.query(`update teaching_assignments set status='active' where class_id=$1 and teacher_id=$2`,[uuid(40),uuid(23)]);
  await db.query('update classes set teacher_id=null where id=$1',[uuid(40)]);
  check((await db.query('select status,is_primary from teaching_assignments where class_id=$1 and teacher_id=$2',[uuid(40),uuid(23)])).rows,[{status:'active',is_primary:false}]);
  await db.query('update classes set teacher_id=$1 where id=$2',[uuid(11),uuid(40)]);
  await db.query(`insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Mapped',$6)`,[uuid(41),uuid(1),uuid(30),uuid(80),uuid(70),uuid(13)]);
  check((await db.query('select teacher_id,is_primary from teaching_assignments where class_id=$1',[uuid(41)])).rows,[{teacher_id:uuid(23),is_primary:true}]);
  await db.query(`insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Mapped activity')`,[uuid(51),uuid(1),uuid(41)]);
  await rejected(gradeSql,[uuid(1),uuid(51),uuid(10)],'23514');
  await db.query(enrollmentSql,[uuid(91),uuid(1),uuid(41),uuid(20)]);
  await db.query(gradeSql,[uuid(1),uuid(51),uuid(10)]);
  await rejected('delete from activities where id=$1',[uuid(51)],'23514');
  check((await db.query('select count(*)::int as n from grades where activity_id=$1',[uuid(51)])).rows[0].n,1);
  await db.query(`insert into courses(id,tenant_id,name) values ($1,$2,'Empty course')`,[uuid(33),uuid(1)]);
  await db.query(`insert into classes(id,tenant_id,course_id,name) values ($1,$2,$3,'Empty class')`,[uuid(42),uuid(1),uuid(33)]);
  await db.query(`insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Empty activity')`,[uuid(52),uuid(1),uuid(42)]);
  await rejected('delete from classes where id=$1',[uuid(42)],'23514');
  await rejected('delete from courses where id=$1',[uuid(33)],'23514');
  check((await db.query('delete from activities where id=$1',[uuid(52)])).rowCount,1);
  check((await db.query('delete from classes where id=$1',[uuid(42)])).rowCount,1);
  await db.query(`insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'EMPTY','Empty subject')`,[uuid(83),uuid(1),uuid(33)]);
  await rejected('delete from courses where id=$1',[uuid(33)],'23514');
  check((await db.query('delete from subjects where id=$1',[uuid(83)])).rowCount,1);
  check((await db.query('delete from courses where id=$1',[uuid(33)])).rowCount,1);
  await db.query(`insert into classes(id,tenant_id,course_id,name,teacher_id) values ($1,$2,$3,'Teacher history only',$4)`,[uuid(43),uuid(1),uuid(30),uuid(13)]);
  await db.query('update classes set teacher_id=null where id=$1',[uuid(43)]);
  await rejected('delete from classes where id=$1',[uuid(43)],'23514');
  console.log('PASS PostgreSQL: deletes preserve legacy and formal grades and class/course history; empty objects remain deletable');
  console.log('PASS PostgreSQL: teacher backfill, primary mirroring, co-teachers and per-class grades');
  const contender = new Client({...config,statement_timeout:5000}); peers.push(contender); await contender.connect();
  await db.query('set statement_timeout=5000');
  await db.query('begin');
  await db.query(enrollmentSql,[uuid(92),uuid(1),uuid(41),uuid(25)]);
  const promotion = contender.query(`update app_users set role='teacher' where id=$1`,[uuid(25)]).then(()=>null,error=>error.code);
  await waitForLock(contender); await db.query('commit');
  check(await promotion,'23514');
  await db.query('begin');
  await db.query(`update enrollments set status='suspended' where id=$1`,[uuid(92)]);
  const concurrentGrade = contender.query(gradeSql,[uuid(1),uuid(51),uuid(15)]).then(()=>null,error=>error.code);
  await waitForLock(contender); await db.query('commit');
  check(await concurrentGrade,'23514');
  await db.query(`update app_users set role='student' where id=$1`,[uuid(24)]);
  await db.query('begin');
  await db.query(`update app_users set role='teacher' where id=$1`,[uuid(24)]);
  const concurrentEnrollment = contender.query(enrollmentSql,[uuid(93),uuid(1),uuid(41),uuid(24)]).then(()=>null,error=>error.code);
  await waitForLock(contender); await db.query('commit');
  check(await concurrentEnrollment,'23514');
  console.log('PASS PostgreSQL: membership and enrollment-status races serialize safely');
  await db.query(`create role synthetic_authenticated nologin; grant usage on schema public,auth to synthetic_authenticated;
    grant select,insert,update,delete on all tables in schema public to synthetic_authenticated; set role synthetic_authenticated`);
  for (const table of ['academic_periods','subjects','enrollments','enrollment_status_history','teaching_assignments']) {
    check((await db.query(`select * from ${table}`)).rowCount,0);
  }
  await rejected(`insert into academic_periods(tenant_id,code,name) values ($1,'rls','RLS')`,[uuid(1)],'42501');
  await db.query("set request.jwt.claim.role='service_role'");
  check((await db.query('select * from enrollments')).rowCount,3);
  await db.query('reset role');
  check((await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`)).rows[0].n,0);
  await db.query('create database academic_preflight');
  const dirty = new Client({...config,database:'academic_preflight'}); peers.push(dirty); await dirty.connect();
  await dirty.query(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$`);
  await applyGuardedMigration(dirty, { name: 'schema.sql', sql: readFileSync(join(root,'supabase/schema.sql'),'utf8') });
  for (const name of ['20260528000001_academic_base.sql','20260528000002_activities_grades_reports.sql','20260528000003_invites.sql','20261026000001_security_integrity.sql']) {
    await applyGuardedMigration(dirty, { name, sql: readFileSync(join(root,'supabase/migrations',name),'utf8') });
  }
  await dirty.query('insert into auth.users(id) values ($1)',[uuid(10)]);
  await dirty.query(`insert into tenants(id,name,slug) values ($1,'Dirty','dirty')`,[uuid(1)]);
  await dirty.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role) values ($1,$2,$3,'Student','dirty@example.invalid','student')`,[uuid(20),uuid(1),uuid(10)]);
  await dirty.query(`insert into courses(id,tenant_id,name) values ($1,$2,'Course')`,[uuid(30),uuid(1)]);
  await dirty.query('alter table classes disable trigger classes_validate_teacher');
  await dirty.query(`insert into classes(id,tenant_id,course_id,name,teacher_id) values ($1,$2,$3,'Invalid teacher',$4)`,[uuid(40),uuid(1),uuid(30),uuid(10)]);
  await dirty.query('alter table classes enable trigger classes_validate_teacher');
  await assert.rejects(applyGuardedMigration(dirty, { name: '20261026000002_academic_structure.sql', sql: readFileSync(join(root,'supabase/migrations/20261026000002_academic_structure.sql'),'utf8') }),error=>error.code==='23514'); checks++;
  await dirty.query('rollback');
  check((await dirty.query('select count(*)::int as n from classes')).rows[0].n,1);
  check((await dirty.query("select to_regclass('public.academic_periods') as relation")).rows[0].relation,null);
  console.log('PASS PostgreSQL: migration preflight rejects invalid legacy membership atomically without deletion');
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, no remote database.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map((peer) => peer.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
