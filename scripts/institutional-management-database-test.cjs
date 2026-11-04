const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const containerName = `uniconnect-institutional-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rpc = 'select public.accept_institution_invite($1,$2,$3,$4) as membership';
const peers = [];
let db;
let containerId;
let checks = 0;
let sequence = 1000;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
async function rejected(sql, params, code, client = db) {
  await assert.rejects(client.query(sql, params), (error) => error.code === code);
  checks++;
}
async function authUser(email, confirmed = true) {
  const id = uuid(sequence++);
  await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)', [id, email, confirmed ? new Date() : null]);
  return id;
}
async function member(role, tenant = uuid(1), active = true) {
  const email = `member-${sequence}@example.invalid`;
  const auth = await authUser(email);
  const id = uuid(sequence++);
  await db.query('insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) values ($1,$2,$3,$4,$5,$6,$7)',
    [id, tenant, auth, 'Synthetic member', email, role, active]);
  return { id, auth, email };
}
async function invite(issuer, email, role = 'student', tenant = uuid(1), options = {}) {
  const id = uuid(sequence++);
  const code = `SYNTHETIC-${sequence++}`;
  await db.query('insert into invites(id,tenant_id,code,role,expires_at,created_by,recipient_email) values ($1,$2,$3,$4,$5,$6,$7)',
    [id, tenant, code, role, options.expired ? new Date(0) : new Date(Date.now() + 3600000), issuer, email]);
  return { id, code };
}
async function unused(id) {
  check((await db.query('select used_at,accepted_by from invites where id=$1', [id])).rows, [{ used_at: null, accepted_by: null }]);
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
  if (!process.argv.includes('--allow-local-migrations')) {
    throw new Error('Not executed: pass --allow-local-migrations only after local migration execution is authorized.');
  }
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
  await db.query(`create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.role() returns text language sql stable as $$
      select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role`);
  await applyGuardedMigration(db, { name: 'schema.sql', sql: readFileSync(join(root, 'supabase/schema.sql'), 'utf8') });
  for (const name of [
    '20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql',
    '20260528000003_invites.sql', '20261026000001_security_integrity.sql',
    '20261026000002_academic_structure.sql', '20261026000003_institutional_management.sql',
  ]) await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  await db.query("insert into tenants(id,name,slug) values ($1,'Synthetic A','synthetic-a'),($2,'Synthetic B','synthetic-b')", [uuid(1), uuid(2)]);
  const owner = await member('owner');
  const admin = await member('admin');
  const coordinator = await member('coordinator');
  const teacher = await member('teacher');
  const inactive = await member('admin', uuid(1), false);
  const foreignOwner = await member('owner', uuid(2));

  const recipient = await authUser('recipient@example.invalid');
  const success = await invite(owner.auth, ' RECIPIENT@EXAMPLE.INVALID ');
  const accepted = (await db.query(rpc, [` ${success.code.toLowerCase()} `, recipient, 'Recipient@Example.Invalid', '  Synthetic Recipient  '])).rows[0].membership;
  check(accepted, {
    id: accepted.id, tenant_id: uuid(1), auth_user_id: recipient, name: 'Synthetic Recipient',
    email: 'recipient@example.invalid', role: 'student', active: true, course_id: null,
  });
  check((await db.query('select used_at is not null as used,accepted_by from invites where id=$1', [success.id])).rows,
    [{ used: true, accepted_by: recipient }]);
  await rejected(rpc, [success.code, recipient, 'recipient@example.invalid', 'Synthetic'], 'P0002');
  await rejected(rpc, ['UNKNOWN', recipient, 'recipient@example.invalid', 'Synthetic'], 'P0002');
  const expired = await invite(owner.auth, 'recipient@example.invalid', 'student', uuid(1), { expired: true });
  await rejected(rpc, [expired.code, recipient, 'recipient@example.invalid', 'Synthetic'], 'P0002');
  await unused(expired.id);

  const denied = await invite(owner.auth, 'intended@example.invalid');
  await rejected(rpc, [denied.code, recipient, 'recipient@example.invalid', 'Synthetic'], '42501');
  await rejected(rpc, [denied.code, recipient, 'intended@example.invalid', 'Synthetic'], '42501');
  await rejected(rpc, [denied.code, uuid(999999), 'intended@example.invalid', 'Synthetic'], '42501');
  const unconfirmed = await authUser('intended@example.invalid', false);
  await rejected(rpc, [denied.code, unconfirmed, 'intended@example.invalid', 'Synthetic'], '42501');
  await unused(denied.id);
  const legacy = await invite(owner.auth, null);
  await rejected(rpc, [legacy.code, recipient, 'recipient@example.invalid', 'Synthetic'], '42501');
  await unused(legacy.id);

  for (const [issuer, role, tenant] of [
    [inactive.auth, 'student', uuid(1)], [foreignOwner.auth, 'student', uuid(1)],
    [admin.auth, 'admin', uuid(1)], [coordinator.auth, 'coordinator', uuid(1)],
    [coordinator.auth, 'admin', uuid(1)], [teacher.auth, 'student', uuid(1)],
    [null, 'student', uuid(1)],
  ]) {
    const invitation = await invite(issuer, 'authority@example.invalid', role, tenant);
    const auth = await authUser('authority@example.invalid');
    await rejected(rpc, [invitation.code, auth, 'authority@example.invalid', 'Synthetic'], '42501');
    await unused(invitation.id);
  }
  await rejected("insert into invites(tenant_id,code,role,expires_at,created_by,recipient_email) values ($1,'OWNER-GRANT','owner',now()+interval '1 hour',$2,'owner@example.invalid')", [uuid(1), owner.auth], '23514');
  for (const [issuer, role] of [[owner.auth, 'admin'], [admin.auth, 'coordinator'], [coordinator.auth, 'teacher']]) {
    const email = `hierarchy-${sequence}@example.invalid`;
    const auth = await authUser(email);
    const invitation = await invite(issuer, email, role);
    check((await db.query(rpc, [invitation.code, auth, email, 'Synthetic'])).rows[0].membership.role, role);
  }
  const foreignInvite = await invite(foreignOwner.auth, 'recipient@example.invalid', 'teacher', uuid(2));
  check((await db.query(rpc, [foreignInvite.code, recipient, 'recipient@example.invalid', 'Synthetic'])).rows[0].membership.tenant_id, uuid(2));
  check((await db.query('select role from app_users where id=$1', [accepted.id])).rows[0].role, 'student');

  const duplicate = await invite(owner.auth, 'recipient@example.invalid', 'admin');
  await db.query('update app_users set active=false where id=$1', [accepted.id]);
  await rejected(rpc, [duplicate.code, recipient, 'recipient@example.invalid', 'Synthetic'], '23505');
  await unused(duplicate.id);
  check((await db.query('select active,role from app_users where id=$1', [accepted.id])).rows, [{ active: false, role: 'student' }]);
  const duplicateEmailAuth = await authUser('recipient@example.invalid');
  await rejected(rpc, [duplicate.code, duplicateEmailAuth, 'recipient@example.invalid', 'Synthetic'], '23505');
  await unused(duplicate.id);

  const validationAuth = await authUser('validation@example.invalid');
  const validationInvite = await invite(owner.auth, 'validation@example.invalid');
  for (const invalidName of ['', '   ', 'x'.repeat(201), 'Synthetic\nRecipient', '\tSynthetic']) {
    await rejected(rpc, [validationInvite.code, validationAuth, 'validation@example.invalid', invalidName], '23514');
  }
  await unused(validationInvite.id);
  await db.query('begin');
  await db.query(rpc, [validationInvite.code, validationAuth, 'validation@example.invalid', 'Synthetic']);
  await db.query('rollback');
  await unused(validationInvite.id);
  check((await db.query('select count(*)::int as n from app_users where auth_user_id=$1', [validationAuth])).rows[0].n, 0);
  console.log('PASS PostgreSQL: recipient/Auth checks, strict fresh hierarchy, legacy rejection, duplicate preservation and atomic rollback');

  const contender = new Client({ ...config, statement_timeout: 5000 });
  peers.push(contender);
  await contender.connect();
  await db.query('set statement_timeout=5000');
  const raceAuth = await authUser('race@example.invalid');
  const raceInvite = await invite(owner.auth, 'race@example.invalid');
  await db.query('begin');
  await db.query(rpc, [raceInvite.code, raceAuth, 'race@example.invalid', 'Synthetic']);
  const sameCode = contender.query(rpc, [raceInvite.code, raceAuth, 'race@example.invalid', 'Synthetic']).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await sameCode, 'P0002');
  check((await db.query('select count(*)::int as n from app_users where tenant_id=$1 and auth_user_id=$2', [uuid(1), raceAuth])).rows[0].n, 1);

  const twinAuth = await authUser('twins@example.invalid');
  const first = await invite(owner.auth, 'twins@example.invalid');
  const second = await invite(owner.auth, 'twins@example.invalid');
  await db.query('begin');
  await db.query(rpc, [first.code, twinAuth, 'twins@example.invalid', 'Synthetic']);
  const differentCodes = contender.query(rpc, [second.code, twinAuth, 'twins@example.invalid', 'Synthetic']).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await differentCodes, '23505');
  await unused(second.id);
  const demoted = await member('owner');
  const demotionAuth = await authUser('demotion@example.invalid');
  const demotionInvite = await invite(demoted.auth, 'demotion@example.invalid', 'admin');
  await db.query('begin');
  await db.query("update app_users set role='coordinator' where id=$1", [demoted.id]);
  const demotion = contender.query(rpc, [demotionInvite.code, demotionAuth, 'demotion@example.invalid', 'Synthetic']).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await demotion, '42501');
  await unused(demotionInvite.id);
  const revoked = await member('admin');
  const revokedAuth = await authUser('revoked@example.invalid');
  const revokedInvite = await invite(revoked.auth, 'revoked@example.invalid');
  await db.query('begin');
  await db.query('update app_users set active=false where id=$1', [revoked.id]);
  const revocation = contender.query(rpc, [revokedInvite.code, revokedAuth, 'revoked@example.invalid', 'Synthetic']).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await revocation, '42501');
  await unused(revokedInvite.id);
  for (const lockTarget of ['auth', 'issuer']) {
    const email = `expiry-${lockTarget}@example.invalid`;
    const expiringAuth = await authUser(email);
    const expiringInvite = await invite(owner.auth, email);
    await db.query("update invites set expires_at=clock_timestamp()+interval '2 seconds' where id=$1", [expiringInvite.id]);
    await db.query('begin');
    if (lockTarget === 'auth') await db.query('select id from auth.users where id=$1 for update', [expiringAuth]);
    else await db.query('select id from app_users where id=$1 for update', [owner.id]);
    const expiration = contender.query(rpc, [expiringInvite.code, expiringAuth, email, 'Synthetic']).then(() => null, (error) => error.code);
    await waitForLock(contender);
    await db.query('select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.05) from invites where id=$1', [expiringInvite.id]);
    await db.query('commit');
    check(await expiration, 'P0002');
    await unused(expiringInvite.id);
    check((await db.query('select count(*)::int as n from app_users where auth_user_id=$1', [expiringAuth])).rows[0].n, 0);
  }
  console.log('PASS PostgreSQL: same-code and different-code acceptance races have one winner; issuer demotion is checked after locking');
  console.log('PASS PostgreSQL: invitations expiring while waiting for Auth or issuer locks leave no membership and remain unused');

  await db.query("insert into courses(id,tenant_id,name) values ($1,$2,'Synthetic course A'),($3,$4,'Synthetic course B')", [uuid(30), uuid(1), uuid(31), uuid(2)]);
  await db.query('update app_users set course_id=$1 where id=$2', [uuid(30), accepted.id]);
  await rejected('update app_users set course_id=$1 where id=$2', [uuid(31), accepted.id], '23503');
  check((await db.query('select course_id from app_users where id=$1', [accepted.id])).rows[0].course_id, uuid(30));
  const student = await member('student');
  const inactiveStudent = await member('student', uuid(1), false);
  const inactiveTeacher = await member('teacher', uuid(1), false);
  await db.query("insert into academic_periods(id,tenant_id,code,name) values ($1,$2,'SYNTHETIC','Synthetic period')", [uuid(70), uuid(1)]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values ($1,$2,$3,'SYNTHETIC','Synthetic subject')", [uuid(80), uuid(1), uuid(30)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values ($1,$2,$3,$4,$5,'Synthetic class',$6),($7,$2,$3,$4,$5,'Synthetic class 2',null)",
    [uuid(40), uuid(1), uuid(30), uuid(80), uuid(70), teacher.auth, uuid(41)]);
  await db.query('insert into enrollments(id,tenant_id,class_id,student_id) values ($1,$2,$3,$4)', [uuid(90), uuid(1), uuid(40), student.id]);
  await db.query("insert into activities(id,tenant_id,class_id,title) values ($1,$2,$3,'Synthetic activity')", [uuid(50), uuid(1), uuid(40)]);
  await db.query('insert into grades(id,tenant_id,activity_id,student_id,grade) values ($1,$2,$3,$4,8)', [uuid(60), uuid(1), uuid(50), student.auth]);
  await db.query('update app_users set active=false where id=any($1::uuid[])', [[student.id, teacher.id]]);
  check((await db.query('select grade::float from grades where id=$1', [uuid(60)])).rows[0].grade, 8);
  check((await db.query('select status from enrollments where id=$1', [uuid(90)])).rows[0].status, 'active');
  check((await db.query('select count(*)::int as n from enrollment_status_history where enrollment_id=$1', [uuid(90)])).rows[0].n, 1);
  check((await db.query('select status,is_primary from teaching_assignments where class_id=$1 and teacher_id=$2', [uuid(40), teacher.id])).rows, [{ status: 'active', is_primary: true }]);
  check((await db.query('select count(*)::int as n from auth.users where id=any($1::uuid[]) and email_confirmed_at is not null', [[student.auth, teacher.auth]])).rows[0].n, 2);
  const enrollmentSql = 'insert into enrollments(tenant_id,class_id,student_id) values ($1,$2,$3)';
  const assignmentSql = 'insert into teaching_assignments(tenant_id,class_id,teacher_id) values ($1,$2,$3)';
  await rejected(enrollmentSql, [uuid(1), uuid(41), student.id], '23514');
  await rejected(enrollmentSql, [uuid(1), uuid(41), inactiveStudent.id], '23514');
  await rejected(assignmentSql, [uuid(1), uuid(41), teacher.id], '23514');
  await rejected(assignmentSql, [uuid(1), uuid(41), inactiveTeacher.id], '23514');
  await rejected('update classes set teacher_id=$1 where id=$2', [inactiveTeacher.auth, uuid(41)], '23514');
  await db.query("update enrollments set status='suspended' where id=$1", [uuid(90)]);
  await rejected("update enrollments set status='active' where id=$1", [uuid(90)], '23514');
  await db.query('update classes set teacher_id=null where id=$1', [uuid(40)]);
  await rejected("update teaching_assignments set status='active' where class_id=$1 and teacher_id=$2", [uuid(40), teacher.id], '23514');
  check((await db.query('select grade::float from grades where id=$1', [uuid(60)])).rows[0].grade, 8);
  check((await db.query('select count(*)::int as n from enrollment_status_history where enrollment_id=$1', [uuid(90)])).rows[0].n, 2);
  const raceStudent = await member('student');
  await db.query('begin');
  await db.query('update app_users set active=false where id=$1', [raceStudent.id]);
  const inactiveEnrollment = contender.query(enrollmentSql, [uuid(1), uuid(41), raceStudent.id]).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await inactiveEnrollment, '23514');
  const raceTeacher = await member('teacher');
  await db.query('begin');
  await db.query('update app_users set active=false where id=$1', [raceTeacher.id]);
  const inactiveAssignment = contender.query(assignmentSql, [uuid(1), uuid(41), raceTeacher.id]).then(() => null, (error) => error.code);
  await waitForLock(contender);
  await db.query('commit');
  check(await inactiveAssignment, '23514');
  console.log('PASS PostgreSQL: tenant course FK and inactive members preserve grades, Auth identities and historical participation');

  const signature = 'public.accept_institution_invite(text,uuid,text,text)';
  for (const role of ['anon', 'authenticated']) {
    check((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as permitted', [role, signature])).rows[0].permitted, false);
    await db.query(`set role ${role}`);
    await rejected(rpc, [validationInvite.code, validationAuth, 'validation@example.invalid', 'Synthetic'], '42501');
    await db.query('reset role');
  }
  check((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as permitted', ['service_role', signature])).rows[0].permitted, true);
  check((await db.query(`select p.prosecdef,p.proconfig from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows,
    [{ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] }]);
  check((await db.query(`select count(*)::int as n from pg_proc p, lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`, [signature])).rows[0].n, 0);
  await db.query('set role service_role');
  check((await db.query(rpc, [validationInvite.code, validationAuth, 'validation@example.invalid', 'Synthetic'])).rows[0].membership.active, true);
  await db.query('reset role');
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, synthetic identities, no remote database.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map((peer) => peer.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
