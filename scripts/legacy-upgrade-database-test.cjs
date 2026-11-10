const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { inspectLegacyGradeIdentities } = require('./lib/legacy-preflight.cjs');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');
const { ensureUninitializedAdminDatabase } = require('../dist/config/admin-database');
const root = join(__dirname, '..');
const migrations = ['20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql', '20260528000003_invites.sql',
  '20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql', '20261026000003_institutional_management.sql',
  '20261026000004_activity_workflow.sql', '20261026000005_academic_communication.sql'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = ['schema.sql', ...migrations.map(name => `migrations/${name}`)].map(name => ({ name, sql: readFileSync(join(root, 'supabase', name), 'utf8') }));
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const password = randomBytes(24).toString('hex');
let containerId, config, control, checks = 0, serial = 0;
const clients = [];
const evidence = { scope: 'Synthetic legacy variants, disposable PostgreSQL 16; not an inventory of remote Supabase.', scenarios: [], sourceHashes: sources.map(({ name, sql }) => ({ name, sha256: hash(sql) })) };
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function check(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const migration = index => sources[index + 1].sql;
const apply = (db, index, sql = migration(index)) => applyGuardedMigration(db, { name: migrations[index], sql });
async function fresh(variant = 'current') {
  const database = `stage9_legacy_${++serial}`;
  await control.query(`create database ${database}`);
  const db = new Client({ ...config, database, statement_timeout: 60000 });
  clients.push(db); await db.connect();
  await ensureUninitializedAdminDatabase(db); checks++;
  await db.query(`create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$`);
  await applyGuardedMigration(db, sources[0]);
  await assert.rejects(ensureUninitializedAdminDatabase(db), /Banco ja inicializado/); checks++;
  if (variant === 'old-columns') await db.query(`alter table activities rename column due_date to due_at;
    alter table grades rename column grade to value; alter table grades add column label text not null default 'Legacy';
    alter table grades drop constraint grades_student_id_fkey;
    alter table grades add constraint grades_student_id_fkey foreign key(student_id) references app_users(id)`);
  await db.query(`insert into auth.users(id,email) values ($1,'student-a@example.invalid'),($2,'teacher-a@example.invalid'),($3,'student-b@example.invalid');
  `, [uuid(10), uuid(11), uuid(12)]);
  await db.query(`insert into tenants(id,name,slug) values ($1,'Synthetic A','legacy-a'),($2,'Synthetic B','legacy-b')`, [uuid(1), uuid(2)]);
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role) values
    ($1,$2,$3,'Student A','student-a@example.invalid','student'),($4,$2,$5,'Teacher A','teacher-a@example.invalid','teacher'),
    ($6,$7,$8,'Student B','student-b@example.invalid','student')`, [uuid(20),uuid(1),uuid(10),uuid(21),uuid(11),uuid(22),uuid(2),uuid(12)]);
  await db.query(`insert into courses(id,tenant_id,name) values($1,$2,'Same name'),($3,$2,'Same name'),($4,$5,'Other')`, [uuid(30),uuid(1),uuid(31),uuid(32),uuid(2)]);
  await db.query(`insert into classes(id,tenant_id,course_id,name,teacher_id) values($1,$2,$3,'Legacy class',$4)`, [uuid(40),uuid(1),uuid(30),uuid(11)]);
  const dateColumn = variant === 'old-columns' ? 'due_at' : 'due_date';
  await db.query(`insert into activities(id,tenant_id,class_id,title,${dateColumn}) values($1,$2,$3,'Legacy task','2026-01-02T12:00:00Z'),($4,$2,$3,'Empty task',null)`, [uuid(50),uuid(1),uuid(40),uuid(51)]);
  const valueColumn = variant === 'old-columns' ? 'value' : 'grade';
  await db.query(`insert into grades(id,tenant_id,activity_id,student_id,${valueColumn},feedback,graded_at) values
    ($1,$2,$3,$4,0,'Synthetic feedback','2026-01-03T12:00:00Z'),($5,$2,$6,$4,null,null,null)`, [uuid(60),uuid(1),uuid(50),variant === 'old-columns' ? uuid(20) : uuid(10),uuid(61),uuid(51)]);
  await db.query(`insert into messages(id,tenant_id,sender_id,class_id,content) values($1,$2,$3,$4,'Legacy same tenant'),($5,$2,$6,null,'Legacy inconsistent tenant')`, [uuid(70),uuid(1),uuid(20),uuid(40),uuid(71),uuid(22)]);
  return db;
}
async function fingerprint(db) {
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  const data = [];
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    data.push([tablename, (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as value from public.${tablename} t`)).rows[0].value]);
  }
  const columns = (await db.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows;
  const constraints = (await db.query("select c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname")).rows;
  const indexes = (await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname")).rows;
  const routines = (await db.query("select p.proname,pg_get_function_identity_arguments(p.oid) as args,pg_get_functiondef(p.oid) as definition,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by p.proname,args")).rows;
  const triggers = (await db.query("select c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname")).rows;
  const policies = (await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  const privileges = (await db.query("select c.relname,c.relacl,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname")).rows;
  return hash(JSON.stringify({ data, columns, constraints, indexes, routines, triggers, policies, privileges }));
}
async function preflight(db) {
  await db.query('begin read only');
  try { return await inspectLegacyGradeIdentities(db); } finally { await db.query('rollback'); }
}
async function fullChain(db) { for (let i = 0; i < migrations.length; i++) await apply(db, i); }
async function preserved(variant) {
  const db = await fresh(variant);
  const before = await fingerprint(db);
  const messages = (await db.query('select * from messages order by id')).rows;
  const oldCells = variant === 'old-columns' ? (await db.query('select id,value,label from grades order by id')).rows : null;
  check((await preflight(db)).safe, true); check(await fingerprint(db), before);
  await fullChain(db);
  check((await db.query('select id,tenant_id,sender_id,class_id,content,created_at from messages order by id')).rows, messages);
  if (oldCells) {
    check((await db.query('select id,value,label from grades order by id')).rows,oldCells);
    check((await db.query('select due_at from activities order by id')).rows.map(x=>x.due_at),[new Date('2026-01-02T12:00:00Z'),null]);
  }
  check((await db.query('select student_id,grade::text,feedback,graded_at from grades order by id')).rows,
    [{ student_id:uuid(10), grade:'0.00', feedback:'Synthetic feedback', graded_at:new Date('2026-01-03T12:00:00Z') }, { student_id:uuid(10), grade:null, feedback:null, graded_at:null }]);
  check((await db.query('select due_date from activities order by id')).rows.map(x => x.due_date), [new Date('2026-01-02T12:00:00Z'),null]);
  check((await db.query('select academic_period_id,subject_id from classes')).rows, [{ academic_period_id:null, subject_id:null }]);
  check((await db.query('select count(*)::int as n from enrollments')).rows[0].n, 0);
  check((await db.query('select count(*)::int as n from messages')).rows[0].n, 2);
  check((await db.query("select convalidated from pg_constraint where conname='messages_sender_tenant_fkey'")).rows[0].convalidated, false);
  await assert.rejects(db.query(`insert into messages(tenant_id,sender_id,content) values($1,$2,'Rejected')`, [uuid(1),uuid(22)]),e=>e.code==='23503'); checks++;
  check((await db.query('select id from courses where tenant_id=$1 order by name,id limit 1 offset 1',[uuid(1)])).rows[0].id, uuid(31));
  const upgraded = await fingerprint(db);
  for (let i=3;i<8;i++) {
    await assert.rejects(apply(db, i), e => ['42P07','42710','42701'].includes(e.code)); checks++;
    await db.query('rollback'); check(await fingerprint(db), upgraded);
  }
  await assert.rejects(db.query(`begin; create table public.stage9_rollback_probe(id int); select 1/0; commit;`), e => e.code === '22012'); checks++;
  await db.query('rollback'); check(await fingerprint(db), upgraded);
  evidence.scenarios.push({ scenario:variant, result:'PASS', zeroAndNull:true, historicalMessages:2, legacyMessageConstraintValidated:false, inventedEnrollments:0, replayRejectedWithoutChanges:true });
}
async function ambiguity() {
  const db = await fresh();
  await db.query('delete from grades where id=$1',[uuid(61)]);
  await db.query('insert into auth.users(id) values($1)',[uuid(13)]);
  await db.query("insert into app_users(id,tenant_id,auth_user_id,name,email,role) values($1,$2,$3,'Ambiguous student','ambiguous@example.invalid','student')",[uuid(10),uuid(1),uuid(13)]);
  const before = await fingerprint(db), result = await preflight(db);
  check(result.safe, false); check(result.reasons, ['AUTH_ID_WOULD_BE_REASSIGNED']); check(await fingerprint(db), before);
  await assert.rejects(apply(db, 1), e => e.code === 'LEGACY_GRADE_IDENTITY_BLOCKED'); checks++;
  check(await fingerprint(db), before);
  await apply(db, 0);
  await db.query(migration(1));
  const owner = (await db.query('select student_id from grades')).rows[0].student_id;
  evidence.baselineReachedIdentityCheck = true;
  if (process.argv.includes('--baseline')) check(owner, uuid(10));
  check(owner, uuid(13));
  await apply(db, 2); await apply(db, 3);
  check((await db.query('select student_id from grades')).rows[0].student_id, uuid(13));
  evidence.scenarios.push({ scenario:'ambiguous-auth-uuid', result:'PASS', mandatoryBoundaryBlockedBeforeMutation:true, rawHistoricalSqlUnsafeReproductionOnly:true, riskReproduced:true, existingSecurityMigrationDoesNotDetectOriginalOwner:true, readOnlyPreflightRejectsBeforeMutation:true });
}
async function invalidCases() {
  const cases = [
    ['duplicate-grade', "insert into grades(tenant_id,activity_id,student_id,grade) select tenant_id,activity_id,student_id,grade from grades limit 1"],
    ['grade-out-of-range', 'update grades set grade=11'],
    ['grade-recipient-teacher', `update grades set student_id='${uuid(11)}'`],
    ['grade-other-tenant', `update grades set student_id='${uuid(12)}'`],
    ['course-other-tenant', `update classes set course_id='${uuid(32)}'`],
    ['teacher-wrong-role', `update classes set teacher_id='${uuid(10)}'`],
    ['activity-other-tenant', `update activities set tenant_id='${uuid(2)}'`],
  ];
  for (const [name, sql] of cases) {
    const db = await fresh();
    for (let i=0;i<3;i++) await apply(db, i);
    await db.query(sql); const before = await fingerprint(db);
    await assert.rejects(apply(db, 3), e => e.code === '23514'); checks++;
    await db.query('rollback'); check(await fingerprint(db),before);
    evidence.scenarios.push({ scenario:name,result:'PASS', invalidDataRejected:true, unchangedAfterRollback:true });
  }
  const db = await fresh(); const before = await fingerprint(db);
  await assert.rejects(apply(db, 4)); checks++;
  await db.query('rollback'); check(await fingerprint(db),before);
  evidence.scenarios.push({ scenario:'out-of-order',result:'PASS', unchangedAfterRollback:true });
  for (const index of [6,7]) {
    const partial = await fresh();
    for(let i=0;i<index;i++) await apply(partial, i);
    const previous = await fingerprint(partial);
    const injected = migration(index).replace(/commit;\s*$/i,'select 1/0; commit;');
    assert.notEqual(injected,migration(index)); checks++;
    // Fault injection in this owned disposable fixture only; not a supported migration path.
    await assert.rejects(partial.query(injected),e=>e.code==='22012'); checks++;
    await partial.query('rollback'); check(await fingerprint(partial),previous);
    evidence.scenarios.push({scenario:`injected-late-failure-${migrations[index]}`,result:'PASS',unchangedAfterRollback:true});
  }
}
async function main() {
  if (!process.argv.includes('--allow-local-migrations')) throw new Error('Required --allow-local-migrations; own disposable container only.');
  assert.equal(process.versions.node.split('.')[0], '22');
  containerId = docker('run','--rm','-d','--name',`uniconnect-legacy-${randomBytes(8).toString('hex')}`,'-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','postgres:16-alpine');
  assert.match(containerId,/^[a-f0-9]{64}$/);
  const published = docker('port',containerId,'5432/tcp'); assert.match(published,/^127\.0\.0\.1:\d+$/);
  config = {host:'127.0.0.1',port:Number(published.split(':')[1]),user:'postgres',password,ssl:false,database:'postgres'};
  for(let n=0;n<80;n++) { control=new Client(config); try {await control.connect();break;} catch {await control.end().catch(()=>{});if(n===79)throw new Error('Local PG unavailable');await new Promise(r=>setTimeout(r,250));} }
  evidence.postgres=(await control.query('show server_version')).rows[0].server_version;
  await control.query('create role anon;create role authenticated;create role service_role bypassrls');
  if(process.argv.includes('--baseline')) await ambiguity();
  else {await preserved('current');await preserved('old-columns');await ambiguity();await invalidCases();}
  evidence.result='PASS'; evidence.checks=checks;
}
main().catch(error=>{evidence.result='FAIL';evidence.errorCode=error.code||'ASSERTION_OR_LOCAL_FAILURE';console.error(`Legacy verification FAIL: ${evidence.errorCode}; synthetic values and connection details withheld.`);process.exitCode=1;}).finally(async()=>{
  await Promise.allSettled(clients.map(db=>db.end()));if(control)await control.end().catch(()=>{});
  if(containerId && /^[a-f0-9]{64}$/.test(containerId)) {try {docker('rm','-f','-v',containerId);evidence.containerRemoved=true;}catch {evidence.containerRemoved=false;evidence.result='FAIL';process.exitCode=1;}}
  evidence.sourcesUnchanged=sources.every(row=>hash(readFileSync(join(root,'supabase',row.name),'utf8'))===hash(row.sql));
  if(!evidence.sourcesUnchanged){evidence.result='FAIL';process.exitCode=1;}
  if(process.argv.includes('--evidence'))writeFileSync(join(root,'docs/evidence/stage-10-1-legacy-upgrade.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
});
