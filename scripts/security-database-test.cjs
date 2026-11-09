const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const migrationName = '20261026000001_security_integrity.sql';
const baseline = process.argv.includes('--baseline');
const containerName = `uniconnect-security-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let checks = 0;
let db;
let containerId;
const peers = [];

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
  throw new Error('Expected concurrent database operation to wait for membership lock.');
}

async function main() {
  containerId = docker('run', '--rm', '-d', '--name', containerName, '-e', `POSTGRES_PASSWORD=${password}`,
    '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  const published = docker('port', containerId, '5432/tcp');
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const config = { host: '127.0.0.1', port: Number(published.split(':')[1]), user: 'postgres', password, database: 'postgres', ssl: false };
  for (let attempt = 0; attempt < 80; attempt++) {
    db = new Client(config);
    try { await db.connect(); break; } catch {
      await db.end().catch(() => {});
      if (attempt === 79) throw new Error('PostgreSQL local nao iniciou.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await db.query(`create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.role() returns text language sql stable as $$
      select coalesce(current_setting('request.jwt.claim.role', true), 'authenticated')::text $$;`);
  await applyGuardedMigration(db, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
  for (const name of ['20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql', '20260528000003_invites.sql']) {
    await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  }
  await db.query(`insert into auth.users (id) values ($1),($2),($3),($4)`, [uuid(10), uuid(11), uuid(12), uuid(13)]);
  await db.query(`insert into tenants (id,name,slug) values ($1,'Synthetic A','synthetic-a'),($2,'Synthetic B','synthetic-b')`, [uuid(1), uuid(2)]);
  await db.query(`insert into app_users (id,tenant_id,auth_user_id,name,email,role) values
    ($1,$2,$3,'Student','student@example.invalid','student'),
    ($4,$2,$5,'Teacher','teacher@example.invalid','teacher'),
    ($6,$7,$8,'Other student','other@example.invalid','student'),
    ($9,$2,$10,'Manager','manager@example.invalid','coordinator')`,
    [uuid(20), uuid(1), uuid(10), uuid(21), uuid(11), uuid(22), uuid(2), uuid(12), uuid(23), uuid(13)]);
  await db.query(`insert into courses (id,tenant_id,name) values ($1,$2,'Synthetic course'),($3,$4,'Other course')`, [uuid(30), uuid(1), uuid(31), uuid(2)]);
  await db.query(`insert into classes (id,tenant_id,course_id,name,teacher_id) values ($1,$2,$3,'Synthetic class',$4)`, [uuid(40), uuid(1), uuid(30), uuid(11)]);
  await db.query(`insert into activities (id,tenant_id,class_id,title) values ($1,$2,$3,'Synthetic activity')`, [uuid(50), uuid(1), uuid(40)]);

  const gradeSql = `insert into grades (tenant_id,activity_id,student_id,grade,graded_by) values ($1,$2,$3,$4,$5)`;
  const invalid = [uuid(1), uuid(50), uuid(11), 7, uuid(13)];
  if (!baseline) {
    await applyGuardedMigration(db, { name: migrationName, sql: readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8') });
  }
  await rejected(gradeSql, invalid, '23514');
  console.log('PASS PostgreSQL: teacher cannot receive a grade');
  await rejected(gradeSql, [uuid(1), uuid(50), uuid(12), 7, uuid(13)], '23514');
  await rejected(gradeSql, [uuid(2), uuid(50), uuid(12), 7, uuid(13)], '23503');
  await rejected(gradeSql, [uuid(1), uuid(50), uuid(10), 11, uuid(13)], '23514');
  await rejected(`insert into classes (tenant_id,course_id,name,teacher_id) values ($1,$2,'Invalid',$3)`, [uuid(1), uuid(30), uuid(10)], '23514');
  await rejected(`insert into classes (tenant_id,course_id,name,teacher_id) values ($1,$2,'Invalid',$3)`, [uuid(2), uuid(31), uuid(11)], '23514');
  await rejected(`insert into classes (tenant_id,course_id,name) values ($1,$2,'Invalid')`, [uuid(2), uuid(30)], '23503');
  await rejected(`insert into activities (tenant_id,class_id,title) values ($1,$2,'Invalid')`, [uuid(2), uuid(40)], '23503');
  await rejected(`update classes set teacher_id = $1 where id = $2`, [uuid(10), uuid(40)], '23514');
  console.log('PASS PostgreSQL: tenant, role and grade range constraints');

  const upsertSql = `${gradeSql} on conflict (tenant_id,activity_id,student_id) do update set grade = excluded.grade`;
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const peer = new Client(config); peers.push(peer); await peer.connect();
    await peer.query(upsertSql, [uuid(1), uuid(50), uuid(10), index, uuid(13)]);
  }));
  assert.equal(Number((await db.query(`select count(*) from grades where tenant_id=$1 and activity_id=$2 and student_id=$3`, [uuid(1), uuid(50), uuid(10)])).rows[0].count), 1);
  checks++;
  await rejected(gradeSql, [uuid(1), uuid(50), uuid(10), 7, uuid(13)], '23505');
  await rejected(`update app_users set role='teacher' where id=$1`, [uuid(20)], '23514');
  await rejected(`update app_users set role='student' where id=$1`, [uuid(21)], '23514');
  console.log('PASS PostgreSQL: eight independent connections, one grade; linked roles cannot be invalidated');

  await db.query('insert into auth.users(id) values ($1)', [uuid(14)]);
  await db.query(`insert into app_users(id,tenant_id,auth_user_id,name,email,role)
    values ($1,$2,$3,'Race student','race@example.invalid','student')`, [uuid(24), uuid(1), uuid(14)]);
  const contender = new Client({ ...config, statement_timeout: 5000 });
  peers.push(contender); await contender.connect();
  await db.query('set statement_timeout=5000');
  await db.query('begin');
  await db.query(gradeSql, [uuid(1), uuid(50), uuid(14), 7, uuid(13)]);
  const promotion = contender.query(`update app_users set role='teacher' where id=$1`, [uuid(24)])
    .then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  assert.equal(await promotion, '23514'); checks++;
  await db.query('delete from grades where student_id=$1', [uuid(14)]);
  await db.query('begin');
  await db.query(`update app_users set role='teacher' where id=$1`, [uuid(24)]);
  const concurrentGrade = contender.query(gradeSql, [uuid(1), uuid(50), uuid(14), 7, uuid(13)])
    .then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  assert.equal(await concurrentGrade, '23514'); checks++;
  assert.equal((await db.query('select id from grades where student_id=$1', [uuid(14)])).rowCount, 0); checks++;
  console.log('PASS PostgreSQL: grade insertion versus role change races in both directions');

  await db.query(`create role synthetic_authenticated nologin; grant usage on schema public,auth to synthetic_authenticated;
    grant select,insert on all tables in schema public to synthetic_authenticated; set role synthetic_authenticated`);
  assert.equal((await db.query('select * from grades')).rowCount, 0);
  checks++;
  await rejected(gradeSql, [uuid(1), uuid(50), uuid(10), 7, uuid(13)], '42501');
  await db.query('reset role');
  console.log('PASS PostgreSQL: existing RLS does not authorize direct authenticated table access');

  for (const scenario of ['duplicate', 'role']) {
    const cleanDatabase = `security_${scenario}`;
    await db.query(`create database ${cleanDatabase}`);
    const dirty = new Client({ ...config, database: cleanDatabase });
    peers.push(dirty); await dirty.connect();
    await dirty.query(`create schema auth; create table auth.users(id uuid primary key);
      create function auth.role() returns text language sql as $$ select 'service_role'::text $$`);
    await applyGuardedMigration(dirty, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
    await dirty.query('insert into auth.users values ($1)', [uuid(10)]);
    await dirty.query('insert into tenants(id,name,slug) values ($1,\'Synthetic\',\'s\')', [uuid(1)]);
    await dirty.query(`insert into app_users(tenant_id,auth_user_id,name,email,role) values ($1,$2,'Synthetic','x@example.invalid',$3)`, [uuid(1), uuid(10), scenario === 'role' ? 'teacher' : 'student']);
    await dirty.query(`insert into courses(id,tenant_id,name) values ($1,$2,'C')`, [uuid(30), uuid(1)]);
    await dirty.query(`insert into classes(id,tenant_id,course_id,name) values ($1,$2,$3,'T')`, [uuid(40), uuid(1), uuid(30)]);
    await dirty.query(`insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'A')`, [uuid(50), uuid(1), uuid(40)]);
    await dirty.query(gradeSql, [uuid(1), uuid(50), uuid(10), 7, null]);
    if (scenario === 'duplicate') await dirty.query(gradeSql, [uuid(1), uuid(50), uuid(10), 8, null]);
    await assert.rejects(applyGuardedMigration(dirty, { name: migrationName, sql: readFileSync(join(root, 'supabase/migrations', migrationName), 'utf8') }), (error) => error.code === '23514');
    await dirty.query('rollback');
    assert.equal(Number((await dirty.query('select count(*) from grades')).rows[0].count), scenario === 'duplicate' ? 2 : 1);
    assert.equal(Number((await dirty.query("select count(*) from pg_constraint where conname='grades_tenant_activity_student_key'")).rows[0].count), 0);
    checks++;
  }
  console.log('PASS PostgreSQL: migration refuses inconsistent legacy data atomically without deleting it');
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, no remote database.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.allSettled(peers.map((peer) => peer.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
