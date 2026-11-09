const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

const root = join(__dirname, '..');
const names = ['schema.sql', 'migrations/20260528000002_activities_grades_reports.sql'];
const sources = names.map(name => ({ name, sql: readFileSync(join(root, 'supabase', name), 'utf8') }));
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clients = [];
const password = randomBytes(24).toString('hex');
const evidence = { scope: 'Owned disposable PostgreSQL 16 only; mandatory migration boundary; synthetic identities.', scenarios: [] };
let containerId, control, config, serial = 0, checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

async function fresh(institutional = false) {
  const database = `stage_10_1_identity_${++serial}`;
  await control.query(`create database ${database}`);
  const db = new Client({ ...config, database, statement_timeout: 15000 });
  clients.push(db); await db.connect();
  await db.query(`create schema auth; create table auth.users(id uuid primary key);
    create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$`);
  await applyGuardedMigration(db, sources[0]);
  await db.query(`insert into auth.users(id) values ($1),($2),($3);
  `, [uuid(10), uuid(11), uuid(12)]);
  await db.query(`insert into tenants(id,name,slug) values($1,'A','a'),($2,'B','b')`, [uuid(1), uuid(2)]);
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role) values
    ($1,$2,$3,'A','a@example.invalid','student'),($4,$5,$6,'B','b@example.invalid','student')`,
  [uuid(20), uuid(1), uuid(10), uuid(21), uuid(2), uuid(11)]);
  await db.query(`insert into courses(id,tenant_id,name) values($1,$2,'A')`, [uuid(30), uuid(1)]);
  await db.query(`insert into classes(id,tenant_id,course_id,name) values($1,$2,$3,'A')`, [uuid(40), uuid(1), uuid(30)]);
  await db.query(`insert into activities(id,tenant_id,class_id,title,due_date) values($1,$2,$3,'A','2026-01-02T12:00:00Z')`, [uuid(50), uuid(1), uuid(40)]);
  if (institutional) await db.query(`alter table grades drop constraint grades_student_id_fkey;
    alter table grades add foreign key(student_id) references app_users(id)`);
  await db.query(`insert into grades(id,tenant_id,activity_id,student_id,grade,feedback,graded_at) values
    ($1,$2,$3,$4,0,'Synthetic history','2026-01-03T12:00:00Z'),($5,$2,$3,$4,null,null,null)`,
  [uuid(60), uuid(1), uuid(50), uuid(institutional ? 20 : 10), uuid(61)]);
  return db;
}

async function fingerprint(db) {
  const data = [];
  for (const { tablename } of (await db.query("select tablename from pg_tables where schemaname in ('public','auth') order by schemaname,tablename")).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    const schema = tablename === 'users' ? 'auth' : 'public';
    data.push([schema, tablename, (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as data from ${schema}.${tablename} t`)).rows[0].data]);
  }
  const metadata = (await db.query(`select c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) as definition
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','auth') order by c.relname,k.conname`)).rows;
  const columns = (await db.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows;
  const policies = (await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  return hash(JSON.stringify({ data, metadata, columns, policies }));
}

async function blocked(db, scenario, migration = sources[1]) {
  const before = await fingerprint(db);
  await assert.rejects(applyGuardedMigration(db, migration), error => error.code === 'LEGACY_GRADE_IDENTITY_BLOCKED'); checks++;
  check(await fingerprint(db), before);
  evidence.scenarios.push({ scenario, result: 'PASS', unchanged: true });
}

async function collision(tenant, name) {
  const db = await fresh();
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role)
    values($1,$2,$3,'Collision','collision@example.invalid','student')`, [uuid(10), uuid(tenant), uuid(12)]);
  await blocked(db, name);
}

async function invalidMetadata() {
  const variants = [
    ['missing-source-fk', 'alter table grades drop constraint grades_student_id_fkey'],
    ['unvalidated-source-fk', `alter table grades drop constraint grades_student_id_fkey;
      alter table grades add foreign key(student_id) references auth.users(id) not valid`],
    ['incorrect-referenced-column', `alter table grades drop constraint grades_student_id_fkey;
      alter table app_users add unique(auth_user_id);
      alter table grades add foreign key(student_id) references app_users(auth_user_id)`],
    ['incorrect-auth-referenced-column', `alter table grades drop constraint grades_student_id_fkey;
      alter table auth.users add alternate_id uuid unique; update auth.users set alternate_id=id;
      alter table grades add foreign key(student_id) references auth.users(alternate_id)`],
    ['multiple-source-fks', 'alter table grades add foreign key(student_id) references auth.users(id)'],
    ['composite-source-fk', `alter table grades drop constraint grades_student_id_fkey;
      alter table grades add foreign key(student_id,tenant_id) references app_users(auth_user_id,tenant_id)`],
    ['wrong-role', `update app_users set role='teacher' where id='${uuid(20)}'`],
    ['cross-tenant-recipient', `update grades set student_id='${uuid(11)}'`],
    ['missing-institutional-student', `delete from app_users where id='${uuid(20)}'`],
    ['multiple-student-memberships', `alter table app_users drop constraint app_users_tenant_id_auth_user_id_key;
      insert into app_users(tenant_id,auth_user_id,name,email,role) values('${uuid(1)}','${uuid(10)}','Duplicate','duplicate@example.invalid','student')`],
    ['null-source-reference', 'alter table grades alter column student_id drop not null; update grades set student_id=null'],
    ['null-activity-reference', 'alter table grades alter column activity_id drop not null; update grades set activity_id=null'],
    ['missing-activity-column', 'alter table grades drop column activity_id'],
    ['orphan-activity-reference', `alter table grades drop constraint grades_activity_id_fkey; update grades set activity_id='${uuid(404)}'`],
    ['cross-tenant-activity-reference', `update activities set tenant_id='${uuid(2)}'`],
  ];
  for (const [name, mutation] of variants) {
    const db = await fresh(); await db.query(mutation); await blocked(db, name);
  }
  const member = await fresh(true);
  await member.query('insert into auth.users(id) values($1)', [uuid(20)]);
  await blocked(member, 'institutional-id-collides-with-auth-namespace');
}

async function legitimate() {
  for (const institutional of [false, true]) {
    const db = await fresh(institutional);
    const before = (await db.query('select id,tenant_id,grade,feedback,graded_at from grades order by id')).rows;
    await applyGuardedMigration(db, { name: 'renamed-base.sql', sql: sources[1].sql });
    check((await db.query('select id,tenant_id,grade,feedback,graded_at from grades order by id')).rows, before);
    check((await db.query('select student_id from grades order by id')).rows, [{ student_id: uuid(10) }, { student_id: uuid(10) }]);
    check((await db.query('select due_date from activities')).rows, [{ due_date: new Date('2026-01-02T12:00:00Z') }]);
    check((await db.query("select count(*)::int as n from pg_class where relname='stage_10_1_expected_grades'")).rows[0].n, 0);
    evidence.scenarios.push({ scenario: institutional ? 'legitimate-institutional-owner' : 'legitimate-auth-owner', result: 'PASS', zeroNullFeedbackHistoryPreserved: true, aliasGuarded: true });
  }
  const old = await fresh(true);
  await old.query(`alter table grades rename column grade to value;
    alter table grades add column label text not null default 'History';
    alter table activities rename column due_date to due_at`);
  await applyGuardedMigration(old, sources[1]);
  check((await old.query('select value::text,grade::text,label,feedback from grades order by id')).rows, [
    { value: '0.00', grade: '0.00', label: 'History', feedback: 'Synthetic history' },
    { value: null, grade: null, label: 'History', feedback: null },
  ]);
  evidence.scenarios.push({ scenario: 'old-value-date-columns', result: 'PASS', historyPreserved: true });
  const empty = await fresh(); await empty.query('delete from grades'); await applyGuardedMigration(empty, sources[1]);
  check((await empty.query('select count(*)::int as n from grades')).rows[0].n, 0);
  evidence.scenarios.push({ scenario: 'empty-grades', result: 'PASS' });
}

async function rollbackChecks() {
  const variants = [
    ['postcheck-owner-mismatch', `new.student_id:='${uuid(11)}'; return new;`],
    ['postcheck-cell-mismatch', "new.feedback:='Wrong history'; return new;"],
    ['postcheck-tenant-mismatch', `new.tenant_id:='${uuid(2)}'; return new;`],
    ['execution-late-error', "raise exception 'Synthetic migration failure';"],
  ];
  for (const [name, body] of variants) {
    const db = await fresh(true);
    await db.query(`create function public.synthetic_grade_failure() returns trigger language plpgsql as $$ begin ${body} end $$;
      create trigger synthetic_grade_failure before update on grades for each row execute function public.synthetic_grade_failure()`);
    await blocked(db, name);
  }
  const removed = await fresh(true);
  await removed.query(`create function public.synthetic_grade_delete() returns trigger language plpgsql as $$ begin delete from grades where id<new.id; return new; end $$;
    create trigger synthetic_grade_delete after update on grades for each row execute function public.synthetic_grade_delete()`);
  await blocked(removed, 'postcheck-row-count-mismatch');
}

async function renamedAndUnknown() {
  const renamed = await fresh();
  await renamed.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role)
    values($1,$2,$3,'Collision','collision@example.invalid','student')`, [uuid(10), uuid(1), uuid(12)]);
  await blocked(renamed, 'renamed-known-base-still-blocked', { name: 'alias.sql', sql: sources[1].sql });
  const unknown = await fresh();
  await blocked(unknown, 'named-base-with-unknown-bytes', { ...sources[1], sql: sources[1].sql + '\nselect 1;' });
  await blocked(unknown, 'renamed-base-with-unknown-bytes', { name: 'alias.sql', sql: sources[1].sql + '\nselect 1;' });
  await blocked(unknown, 'unknown-grade-owner-conversion', { name: 'custom.sql', sql: 'update public.grades set student_id=student_id' });
  await blocked(unknown, 'update-only-cannot-bypass-gate', { name: 'custom.sql', sql: `update only public.grades set student_id='${uuid(11)}'` });
  await blocked(unknown, 'tuple-assignment-cannot-bypass-gate', { name: 'custom.sql', sql: `update public.grades set (student_id)=ROW('${uuid(11)}'::uuid)` });
  await blocked(unknown, 'comment-obfuscated-identity-conversion', { name: 'alias.sql', sql: sources[1].sql.replace(/update public.grades/g, 'update/**/public.grades') });
  await blocked(unknown, 'quoted-identity-conversion', { name: 'alias.sql', sql: sources[1].sql.replace(/public.grades/g, '"public"."grades"') });
}

async function nestedTransaction() {
  const db = await fresh();
  await db.query('begin');
  await db.query('create temp table stage_10_1_outer_probe(id int) on commit drop');
  await blocked(db, 'existing-transaction-refused');
  check((await db.query("select to_regclass('pg_temp.stage_10_1_outer_probe') is not null as present")).rows[0].present, true);
  await db.query('rollback');
}

async function peer(db) {
  const connection = new Client({ ...config, database: db.connectionParameters.database, statement_timeout: 15000 });
  clients.push(connection); await connection.connect(); return connection;
}

async function waitForLock(observer, client) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID]);
    if (rows[0]?.wait_event_type === 'Lock') { checks++; return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected local PostgreSQL lock wait.');
}

async function concurrency() {
  const db = await fresh(true), observer = await peer(db);
  await db.query(`create function public.synthetic_pause_migration() returns event_trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(10101); end $$;
    create event trigger synthetic_pause_migration on ddl_command_start when tag in ('ALTER TABLE') execute function public.synthetic_pause_migration()`);
  await observer.query('select pg_advisory_lock(10101)');
  const migrating = applyGuardedMigration(db, sources[1]);
  await waitForLock(observer, db);
  check((await observer.query(`select n.nspname||'.'||c.relname as name from pg_locks l
    join pg_class c on c.oid=l.relation join pg_namespace n on n.oid=c.relnamespace
    where l.pid=$1 and l.granted and l.mode='AccessExclusiveLock'
      and (n.nspname||'.'||c.relname) in ('public.grades','public.app_users','auth.users','public.activities') order by name`, [db.processID])).rows,
  [{ name: 'auth.users' }, { name: 'public.activities' }, { name: 'public.app_users' }, { name: 'public.grades' }]);
  const writers = [];
  for (const sql of ['update grades set feedback=feedback', 'update app_users set name=name', 'update auth.users set id=id', 'update activities set title=title']) {
    const connection = await peer(db);
    const writing = connection.query(sql); writers.push(writing);
    await waitForLock(observer, connection);
  }
  await observer.query('select pg_advisory_unlock(10101)');
  await migrating; await Promise.all(writers);
  check((await observer.query('select student_id from grades order by id')).rows, [{ student_id: uuid(10) }, { student_id: uuid(10) }]);
  evidence.scenarios.push({ scenario: 'concurrent-writers-blocked-until-postcheck-commit', result: 'PASS', lockedRelations: 4, waitingWriters: 4 });

  const waiting = await fresh(), holder = await peer(waiting), monitor = await peer(waiting);
  await holder.query('begin; lock table public.app_users in row exclusive mode');
  const applying = applyGuardedMigration(waiting, sources[1]).then(() => null, error => error);
  await waitForLock(monitor, waiting);
  await holder.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role)
    values($1,$2,$3,'Late collision','late@example.invalid','student')`, [uuid(10), uuid(1), uuid(12)]);
  await holder.query('commit');
  const before = await fingerprint(monitor);
  const rejection = await applying;
  check(rejection?.code, 'LEGACY_GRADE_IDENTITY_BLOCKED');
  check(await fingerprint(monitor), before);
  evidence.scenarios.push({ scenario: 'diagnosis-after-lock-observes-concurrent-collision', result: 'PASS', unchanged: true });
}

async function rawHistoricalReproduction() {
  const db = await fresh();
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role)
    values($1,$2,$3,'Collision','collision@example.invalid','student')`, [uuid(10), uuid(1), uuid(12)]);
  await db.query(sources[1].sql);
  check((await db.query('select student_id from grades order by id')).rows, [{ student_id: uuid(12) }, { student_id: uuid(12) }]);
  evidence.scenarios.push({ scenario: 'raw-historical-sql-bypasses-boundary', result: 'PASS', unsafeBehaviorReproducedOnlyInOwnedDisposableDatabase: true });
}

async function main() {
  if (!process.argv.includes('--allow-local-migrations')) throw new Error('Required --allow-local-migrations; owned disposable local container only.');
  assert.equal(process.versions.node.split('.')[0], '22');
  containerId = docker('run', '--rm', '-d', '--name', `uniconnect-stage-10-1-identity-${randomBytes(8).toString('hex')}`, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const published = docker('port', containerId, '5432/tcp'); assert.match(published, /^127\.0\.0\.1:\d+$/);
  config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, ssl: false, database: 'postgres' };
  for (let n = 0; n < 80; n++) {
    control = new Client(config);
    try { await control.connect(); break; } catch { await control.end().catch(() => {}); if (n === 79) throw new Error('Local PostgreSQL unavailable'); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  evidence.postgres = (await control.query('show server_version')).rows[0].server_version;
  await collision(1, 'auth-member-collision-same-tenant');
  await collision(2, 'auth-member-collision-cross-tenant');
  await invalidMetadata();
  await legitimate();
  await rollbackChecks();
  await renamedAndUnknown();
  await rawHistoricalReproduction();
  await nestedTransaction();
  await concurrency();
  evidence.result = 'PASS';
}
main().catch(error => {
  evidence.result = 'FAIL'; evidence.errorCode = error.code || 'ASSERTION_OR_LOCAL_FAILURE';
  evidence.failure = error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : undefined;
  process.exitCode = 1;
}).finally(async () => {
  await Promise.allSettled(clients.map(db => db.end()));
  if (control) await control.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', '-v', containerId); evidence.containerRemoved = true; }
    catch { evidence.containerRemoved = false; evidence.result = 'FAIL'; process.exitCode = 1; }
  }
  evidence.sourcesUnchanged = sources.every(row => hash(readFileSync(join(root, 'supabase', row.name), 'utf8')) === hash(row.sql));
  evidence.sourceHashes = sources.map(({ name, sql }) => ({ name, sha256: hash(sql) }));
  evidence.checks = checks;
  if (!evidence.sourcesUnchanged) { evidence.result = 'FAIL'; process.exitCode = 1; }
  if (process.argv.includes('--evidence')) writeFileSync(join(root, 'docs/evidence/stage-10-1-grade-identity.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
});
