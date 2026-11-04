const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const migration = '20261031000006_platform_institutions.sql';
const baseline = process.argv.includes('--baseline');
const containerName = `uniconnect-platform-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const peers = [];
let db, config, containerId, checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const scalar = async (sql, params = [], client = db) => (await client.query(sql, params)).rows[0].result;
const platformSql = 'select public.platform_manage_institution($1,$2,$3,$4,$5) as result';
const membershipSql = 'select public.manage_institutional_membership($1,$2,$3,$4,$5) as result';
const inviteSql = 'select public.accept_institution_invite($1,$2,$3,$4,$5) as result';
const manage = (actor, operation, payload, key = randomUUID(), client = db, request = randomUUID()) => scalar(platformSql, [actor, operation, key, request, payload], client);
const membership = (tenant, actor, operation, payload, client = db) => scalar(membershipSql, [tenant, actor, operation, payload, randomUUID()], client);
async function rejected(sql, params, code, client = db, message) {
  await assert.rejects(client.query(sql, params), error => {
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
  checks++;
}
async function deny(actor, operation, payload, code = 'PT409', key = randomUUID(), client = db, message) {
  await rejected(platformSql, [actor, operation, key, randomUUID(), payload], code, client, message);
}
async function auth(email = `synthetic-${randomUUID()}@example.invalid`, confirmed = true) {
  const id = randomUUID();
  await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)', [id, email, confirmed ? new Date() : null]);
  return { id, email };
}
async function member(tenant, role, active = true) {
  const identity = await auth();
  const result = (await db.query('insert into public.app_users(tenant_id,auth_user_id,name,email,role,active) values ($1,$2,\'Synthetic\',$3,$4,$5) returning *', [tenant, identity.id, identity.email, role, active])).rows[0];
  return { ...result, auth: identity.id };
}
async function peer() {
  const client = new Client({ ...config, statement_timeout: 10000 });
  peers.push(client); await client.connect(); return client;
}
async function waitForLock(client) {
  for (let i = 0; i < 200; i++) {
    if ((await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Expected operation to wait for PostgreSQL lock.');
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
  for (const name of ['20260528000001_academic_base.sql','20260528000002_activities_grades_reports.sql','20260528000003_invites.sql','20261026000001_security_integrity.sql','20261026000002_academic_structure.sql','20261026000003_institutional_management.sql','20261026000004_activity_workflow.sql','20261026000005_academic_communication.sql']) {
    await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  }
  const legacy = randomUUID();
  await db.query("insert into tenants(id,name,slug,plan,status,active_users) values ($1,'Legacy synthetic','legacy-synthetic','enterprise','past_due',37)", [legacy]);
  if (!baseline) await applyGuardedMigration(db, { name: migration, sql: readFileSync(join(root, 'supabase/migrations', migration), 'utf8') });
  check(await scalar("select to_regprocedure('public.platform_manage_institution(uuid,text,uuid,uuid,jsonb)') is not null as result"), true);
  await scenarios(legacy);
  const evidence = { recordedAt: new Date().toISOString(), database: 'PostgreSQL 16 disposable loopback Docker container', checks, baseline: false,
    migrationSha256: createHash('sha256').update(readFileSync(join(root, 'supabase/migrations', migration), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
    coverage: ['legacy billing preserved','legacy institutional user name/email text compatibility','strict mutation inputs','actor identity','idempotency replay and mismatch','CAS','bootstrap existing confirmed Auth only','durable first administrator','atomic journal and audit rollback','administrative grants','administrative invitation membership/consumption/audit rollback','invite audit and tenant suspension','all 22 academic table guards','journal/audit ACL and append-only including TRUNCATE','internal helper EXECUTE denied to all API roles','concurrent same-key/CAS/bootstrap/membership','concurrent actor demotion blocks create and updateRole after locking','suspension serialization in both orders'],
    remoteDatabaseUsed: false, syntheticIdentitiesOnly: true };
  writeFileSync(join(root, 'docs/evidence/p0-2-postgres.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Database verification passed: ${checks} checks, PostgreSQL 16, disposable loopback container, synthetic identities, no remote database.`);
}

async function scenarios(legacy) {
  check((await db.query('select plan,status,active_users,operational_status,operational_version from tenants where id=$1', [legacy])).rows[0], { plan: 'enterprise', status: 'past_due', active_users: 37, operational_status: 'active', operational_version: 1 });
  const actor = (await auth()).id;
  const createKey = randomUUID();
  const payload = { name: 'Synthetic institution', slug: `synthetic-${randomBytes(8).toString('hex')}` };
  const institution = await manage(actor, 'create', payload, createKey);
  check(Object.keys(institution).sort(), ['id','name','slug','operationalStatus','version','createdAt','updatedAt'].sort());
  check(institution.operationalStatus, 'active'); check(institution.version, 1);
  check(await manage(actor, 'create', payload, createKey), institution);
  await deny(actor, 'create', { ...payload, name: 'Mismatch' }, 'PT409', createKey);
  await deny(actor, 'update', { id: institution.id, name: 'Changed', expectedVersion: 1 }, 'PT409', createKey);
  await deny(randomUUID(), 'create', { name: 'Denied', slug: 'denied' }, '42501');
  for (const extra of [{ plan: 'enterprise' }, { status: 'active' }, { role: 'owner' }, { actorId: actor }, { operationalStatus: 'suspended' }]) await deny(actor, 'create', { ...payload, ...extra }, '22023');
  await deny(actor, 'create', { name: ' ', slug: 'invalid' }, '22023');
  await deny(actor, 'create', { name: 'Synthetic', slug: 'INVALID' }, '22023');
  await deny(actor, 'create', { ...payload, name: 'x'.repeat(201) }, '22023');
  await deny(actor, 'create', { ...payload, name: 'Synthetic\nInstitution' }, '22023');
  const tenant = institution.id;
  let result = await manage(actor, 'update', { id: tenant, name: 'Changed synthetic', expectedVersion: 1 });
  check(result.name, 'Changed synthetic'); check(result.version, 2); check(result.slug, payload.slug);
  await deny(actor, 'update', { id: tenant, name: 'Stale', expectedVersion: 1 });
  const suspendedKey = randomUUID(), suspendPayload = { id: tenant, expectedVersion: 2 };
  result = await manage(actor, 'suspend', suspendPayload, suspendedKey);
  check(result.operationalStatus, 'suspended'); check(result.version, 3);
  result = await manage(actor, 'update', { id: tenant, name: 'Global edit suspended', expectedVersion: 3 });
  check(result.version, 4);
  const confirmed = await auth('bootstrap@example.invalid');
  await deny(actor, 'bootstrap', { id: tenant, email: confirmed.email, name: 'Synthetic admin' }, 'PT403');
  result = await manage(actor, 'reactivate', { id: tenant, expectedVersion: 4 });
  check(result.version, 5); check(result.operationalStatus, 'active');
  check(await manage(actor, 'suspend', suspendPayload, suspendedKey), { ...institution, name: 'Changed synthetic', version: 3, operationalStatus: 'suspended', updatedAt: (await manage(actor, 'suspend', suspendPayload, suspendedKey)).updatedAt });
  check(await scalar('select operational_status as result from tenants where id=$1', [tenant]), 'active');
  const sameState = await manage(actor, 'reactivate', { id: tenant, expectedVersion: 5 });
  check(sameState.version, 6); check(sameState.operationalStatus, 'active');
  await deny(actor, 'reactivate', { id: tenant, expectedVersion: 5 });
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='institution_suspended'", [tenant]), 1);
  await deny(actor, 'bootstrap', { id: tenant, email: 'absent@example.invalid', name: 'Synthetic' }, 'PT409', randomUUID(), db, /BOOTSTRAP_AUTH_REQUIRED/);
  const unconfirmed = await auth('unconfirmed@example.invalid', false);
  await deny(actor, 'bootstrap', { id: tenant, email: unconfirmed.email, name: 'Synthetic' }, 'PT409', randomUUID(), db, /BOOTSTRAP_AUTH_UNCONFIRMED/);
  await auth('ambiguous@example.invalid'); await auth(' AMBIGUOUS@EXAMPLE.INVALID ');
  await deny(actor, 'bootstrap', { id: tenant, email: 'ambiguous@example.invalid', name: 'Synthetic' }, 'PT409', randomUUID(), db, /BOOTSTRAP_AUTH_AMBIGUOUS/);
  const beforeAuth = (await db.query('select * from auth.users order by id')).rows;
  const bootstrapKey = randomUUID(), bootstrapPayload = { id: tenant, email: confirmed.email, name: 'Synthetic admin' };
  const bootstrapped = await manage(actor, 'bootstrap', bootstrapPayload, bootstrapKey);
  check(bootstrapped, { institutionId: tenant, administrator: { id: bootstrapped.administrator.id, role: 'admin', active: true } });
  check(await manage(actor, 'bootstrap', bootstrapPayload, bootstrapKey), bootstrapped);
  check((await db.query('select * from auth.users order by id')).rows, beforeAuth);
  const another = await auth();
  await deny(actor, 'bootstrap', { id: tenant, email: another.email, name: 'Another' });
  await db.query("update app_users set role='student',active=false where id=$1", [bootstrapped.administrator.id]);
  await deny(actor, 'bootstrap', { id: tenant, email: another.email, name: 'Another' });
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='administrator_bootstrapped'", [tenant]), 1);
  for (const role of ['owner','admin','coordinator']) {
    const t = (await manage(actor, 'create', { name: 'Existing manager', slug: `manager-${randomBytes(6).toString('hex')}` })).id;
    await member(t, role, false);
    await deny(actor, 'bootstrap', { id: t, email: another.email, name: 'Synthetic' });
  }
  for (const role of ['student','teacher']) {
    const t = (await manage(actor, 'create', { name: 'Existing learner', slug: `learner-${randomBytes(6).toString('hex')}` })).id;
    const existing = await member(t, role);
    await deny(actor, 'bootstrap', { id: t, email: existing.email, name: 'Synthetic' });
    check(await scalar('select role as result from app_users where id=$1', [existing.id]), role);
  }
  await rollbackChecks(actor, tenant);
  await hierarchyChecks(actor);
  await legacyUserCompatibilityChecks(actor, tenant);
  await concurrencyChecks(actor);
  await aclChecks(actor, tenant);
}

async function legacyUserCompatibilityChecks(actor, platformTenant) {
  const tenant = (await manage(actor, 'create', { name: 'Legacy user compatibility', slug: `legacy-users-${randomBytes(6).toString('hex')}` })).id;
  const owner = await member(tenant, 'owner');
  const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.invalid`;
  check(longEmail.length > 254, true);
  for (const fixture of [{ name: 'x'.repeat(201) }, { name: 'Synthetic\nLegacy\tName' }, { name: 'Synthetic legacy email', email: longEmail }]) {
    const identity = await auth(fixture.email);
    const result = await membership(tenant, owner.auth, 'create', { auth_user_id: identity.id, name: fixture.name, email: identity.email, role: 'student' });
    check(result.name, fixture.name); check(result.email, identity.email); check(result.role, 'student');
  }
  await deny(actor, 'bootstrap', { id: platformTenant, email: 'valid@example.invalid', name: 'x'.repeat(201) }, '22023');
  await deny(actor, 'bootstrap', { id: platformTenant, email: 'valid@example.invalid', name: 'Synthetic\nAdministrator' }, '22023');
  await deny(actor, 'bootstrap', { id: platformTenant, email: longEmail, name: 'Synthetic administrator' }, '22023');
}

async function rollbackChecks(actor, tenant) {
  const bootstrapTenant = (await manage(actor, 'create', { name: 'Bootstrap rollback', slug: `bootstrap-rollback-${randomBytes(6).toString('hex')}` })).id;
  const bootstrapIdentity = await auth();
  const grantTenant = (await manage(actor, 'create', { name: 'Grant rollback', slug: `grant-rollback-${randomBytes(6).toString('hex')}` })).id;
  const owner = await member(grantTenant, 'owner'), grantIdentity = await auth();
  const inviteIdentity = await auth(), inviteCode = `ROLLBACK-${randomBytes(6).toString('hex').toUpperCase()}`;
  await db.query("insert into invites(tenant_id,code,role,expires_at,created_by,recipient_email) values ($1,$2,'admin',now()+interval '1 hour',$3,$4)", [grantTenant, inviteCode, owner.auth, inviteIdentity.email]);
  const inviteRequest = randomUUID();
  const key = randomUUID();
  const before = await scalar('select count(*)::int as result from platform_audit_events');
  await db.query('begin');
  await manage(actor, 'create', { name: 'Rolled back', slug: 'rolled-back' }, key);
  await db.query('rollback');
  check(await scalar('select count(*)::int as result from tenants where slug=\'rolled-back\''), 0);
  check(await scalar('select count(*)::int as result from platform_operations where idempotency_key=$1', [key]), 0);
  check(await scalar('select count(*)::int as result from platform_audit_events'), before);
  await db.query(`create function public.synthetic_fail_audit() returns trigger language plpgsql as $$ begin raise exception using errcode='23514',message='Synthetic audit failure'; end $$;
    create trigger z_synthetic_fail_audit before insert on platform_audit_events for each row execute function public.synthetic_fail_audit()`);
  await deny(actor, 'create', { name: 'Audit failure', slug: 'audit-failure' }, '23514', key);
  check(await scalar("select count(*)::int as result from tenants where slug='audit-failure'"), 0);
  check(await scalar('select count(*)::int as result from platform_operations where idempotency_key=$1', [key]), 0);
  await deny(actor, 'bootstrap', { id: bootstrapTenant, email: bootstrapIdentity.email, name: 'Failed bootstrap' }, '23514', key);
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [bootstrapTenant]), 0);
  check(await scalar('select count(*)::int as result from platform_operations where idempotency_key=$1', [key]), 0);
  await rejected(membershipSql, [grantTenant, owner.auth, 'create', { auth_user_id: grantIdentity.id, name: 'Failed grant', email: grantIdentity.email, role: 'admin' }, randomUUID()], '23514');
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1 and auth_user_id=$2', [grantTenant, grantIdentity.id]), 0);
  await rejected(inviteSql, [inviteCode, inviteIdentity.id, inviteIdentity.email, 'Failed invited admin', inviteRequest], '23514');
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1 and auth_user_id=$2', [grantTenant, inviteIdentity.id]), 0);
  check((await db.query('select used_at,accepted_by from invites where code=$1', [inviteCode])).rows, [{ used_at: null, accepted_by: null }]);
  check(await scalar('select count(*)::int as result from platform_audit_events where request_id=$1', [inviteRequest]), 0);
  await db.query('drop trigger z_synthetic_fail_audit on platform_audit_events; drop function public.synthetic_fail_audit()');
  await deny(actor, 'update', { id: randomUUID(), name: 'Missing', expectedVersion: 1 }, 'PT404');
  check(await scalar('select count(*)::int as result from platform_audit_events'), before);
  check((await scalar(inviteSql, [inviteCode, inviteIdentity.id, inviteIdentity.email, 'Retried invited admin', inviteRequest])).role, 'admin');
  check((await db.query('select used_at is not null as used,accepted_by from invites where code=$1', [inviteCode])).rows, [{ used: true, accepted_by: inviteIdentity.id }]);
  check(await scalar('select count(*)::int as result from platform_audit_events where request_id=$1', [inviteRequest]), 1);
}

async function hierarchyChecks(actor) {
  const tenant = (await manage(actor, 'create', { name: 'Hierarchy', slug: `hierarchy-${randomBytes(6).toString('hex')}` })).id;
  const owner = await member(tenant, 'owner'), admin = await member(tenant, 'admin'), coordinator = await member(tenant, 'coordinator'), student = await member(tenant, 'student');
  const newIdentity = await auth();
  const created = await membership(tenant, owner.auth, 'create', { auth_user_id: newIdentity.id, name: 'Created coordinator', email: newIdentity.email, role: 'coordinator' });
  check(created.role, 'coordinator'); check(created.active, true); check(created.auth_user_id, newIdentity.id); check(created.registration, null);
  const promoted = await membership(tenant, owner.auth, 'updateRole', { id: student.id, role: 'admin', expected_role: 'student' });
  check(promoted.role, 'admin');
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='institutional_administrative_grant'", [tenant]), 2);
  for (const [principal, target, role, expected, code] of [
    [owner, owner, 'student', 'owner', '42501'], [admin, owner, 'student', 'owner', '42501'], [admin, student, 'teacher', 'admin', '42501'],
    [coordinator, created, 'student', 'coordinator', '42501'], [owner, student, 'teacher', 'student', 'PT409'],
  ]) await rejected(membershipSql, [tenant, principal.auth, 'updateRole', { id: target.id, role, expected_role: expected }, randomUUID()], code);
  await db.query('update app_users set active=false where id=$1', [admin.id]);
  await rejected(membershipSql, [tenant, admin.auth, 'updateRole', { id: coordinator.id, role: 'student', expected_role: 'coordinator' }, randomUUID()], '42501');
  const foreign = (await manage(actor, 'create', { name: 'Foreign', slug: `foreign-${randomBytes(6).toString('hex')}` })).id;
  await rejected(membershipSql, [foreign, owner.auth, 'create', { auth_user_id: newIdentity.id, name: 'Denied', email: newIdentity.email, role: 'student' }, randomUUID()], '42501');
  const recipient = await auth();
  const code = `INV-${randomBytes(6).toString('hex').toUpperCase()}`;
  await db.query("insert into invites(tenant_id,code,role,expires_at,created_by,recipient_email) values ($1,$2,'admin',now()+interval '1 hour',$3,$4)", [tenant, code, owner.auth, recipient.email]);
  const request = randomUUID();
  await rejected(inviteSql, [code, recipient.id, recipient.email, 'Invited', null], '22023');
  check((await scalar(inviteSql, [code, recipient.id, recipient.email, 'Invited', request])).role, 'admin');
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and request_id=$2 and actor_auth_id=$3 and action='institutional_administrative_grant'", [tenant, request, owner.auth]), 1);
  await manage(actor, 'suspend', { id: tenant, expectedVersion: 1 });
  const guards = (await db.query("select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='a0_require_operational_tenant' order by c.relname")).rows.map(row => row.relname);
  check(guards.length, 22);
  check((await db.query(`select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id' and table_name not in('platform_operations','platform_audit_events') order by table_name`)).rows.map(row => row.table_name), guards);
  for (const table of guards) {
    await rejected(`insert into public.${table}(tenant_id) values ($1)`, [tenant], 'PT403');
  }
  await rejected('update app_users set name=\'Denied\' where id=$1', [owner.id], 'PT403');
  await rejected('delete from app_users where id=$1', [owner.id], 'PT403');
  await rejected('update app_users set tenant_id=$1 where id=$2', [foreign, owner.id], 'PT403');
  await rejected(membershipSql, [tenant, owner.auth, 'updateRole', { id: coordinator.id, role: 'student', expected_role: 'coordinator' }, randomUUID()], 'PT403');
  await rejected(inviteSql, [code, recipient.id, recipient.email, 'Invited', randomUUID()], 'PT403');
  await manage(actor, 'reactivate', { id: tenant, expectedVersion: 2 });
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [tenant]), 6);
}

async function concurrencyChecks(actor) {
  const contender = await peer();
  const key = randomUUID(), payload = { name: 'Concurrent', slug: `race-${randomBytes(6).toString('hex')}` };
  await db.query('begin');
  const created = await manage(actor, 'create', payload, key);
  const replay = manage(actor, 'create', payload, key, contender);
  await waitForLock(contender); await db.query('commit'); check(await replay, created);
  const rollbackKey = randomUUID(), rollbackPayload = { name: 'Concurrent retry', slug: `retry-${randomBytes(6).toString('hex')}` };
  await db.query('begin');
  const rolledBack = await manage(actor, 'create', rollbackPayload, rollbackKey);
  const retry = manage(actor, 'create', rollbackPayload, rollbackKey, contender);
  await waitForLock(contender); await db.query('rollback');
  const retried = await retry;
  check(retried.name, rollbackPayload.name); check(retried.id === rolledBack.id, false);
  check(await scalar('select count(*)::int as result from tenants where slug=$1', [rollbackPayload.slug]), 1);
  await db.query('begin');
  await manage(actor, 'update', { id: created.id, name: 'First', expectedVersion: 1 });
  const stale = manage(actor, 'update', { id: created.id, name: 'Second', expectedVersion: 1 }, randomUUID(), contender).then(() => null, error => error.code);
  await waitForLock(contender); await db.query('commit'); check(await stale, 'PT409');
  const first = await auth(), second = await auth();
  await db.query('begin');
  await manage(actor, 'bootstrap', { id: created.id, email: first.email, name: 'First admin' });
  const twin = manage(actor, 'bootstrap', { id: created.id, email: second.email, name: 'Second admin' }, randomUUID(), contender).then(() => null, error => error.code);
  await waitForLock(contender); await db.query('commit'); check(await twin, 'PT409');
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [created.id]), 1);
  const administrator = (await db.query('select * from app_users where tenant_id=$1', [created.id])).rows[0];
  const teacher = await member(created.id, 'teacher');
  await db.query('begin');
  await db.query("update app_users set active=false where id=$1", [administrator.id]);
  const revoke = membership(created.id, administrator.auth_user_id, 'updateRole', { id: teacher.id, role: 'student', expected_role: 'teacher' }, contender).then(() => null, error => error.code);
  await waitForLock(contender); await db.query('commit'); check(await revoke, '42501');
  for (const operation of ['create','updateRole']) {
    const issuer = await member(created.id, 'admin'), recipient = await auth();
    const auditBefore = await scalar('select count(*)::int as result from platform_audit_events where tenant_id=$1', [created.id]);
    const grantPayload = operation === 'create'
      ? { auth_user_id: recipient.id, name: 'Concurrent denied coordinator', email: recipient.email, role: 'coordinator' }
      : { id: teacher.id, role: 'coordinator', expected_role: 'teacher' };
    await db.query('begin');
    await db.query("update app_users set role='coordinator' where id=$1", [issuer.id]);
    const demotion = membership(created.id, issuer.auth, operation, grantPayload, contender).then(() => null, error => error.code);
    await waitForLock(contender); await db.query('commit'); check(await demotion, '42501');
    check(await scalar('select role as result from app_users where id=$1', [issuer.id]), 'coordinator');
    check(await scalar('select role as result from app_users where id=$1', [teacher.id]), 'teacher');
    check(await scalar('select count(*)::int as result from app_users where tenant_id=$1 and auth_user_id=$2', [created.id, recipient.id]), 0);
    check(await scalar('select count(*)::int as result from platform_audit_events where tenant_id=$1', [created.id]), auditBefore);
  }
  await db.query('begin');
  await db.query('insert into courses(tenant_id,name) values ($1,\'In-flight\')', [created.id]);
  const suspend = manage(actor, 'suspend', { id: created.id, expectedVersion: 2 }, randomUUID(), contender);
  await waitForLock(contender); await db.query('commit'); check((await suspend).operationalStatus, 'suspended');
  check(await scalar('select count(*)::int as result from courses where tenant_id=$1', [created.id]), 1);
  await manage(actor, 'reactivate', { id: created.id, expectedVersion: 3 });
  await db.query('begin');
  await manage(actor, 'suspend', { id: created.id, expectedVersion: 4 });
  const blockedWrite = contender.query('insert into courses(tenant_id,name) values ($1,\'Blocked\')', [created.id]).then(() => null, error => error.code);
  await waitForLock(contender); await db.query('commit'); check(await blockedWrite, 'PT403');
  check(await scalar('select count(*)::int as result from courses where tenant_id=$1', [created.id]), 1);
  await manage(actor, 'reactivate', { id: created.id, expectedVersion: 5 });
  await db.query('begin');
  await db.query('insert into courses(tenant_id,name) values ($1,\'Rolled back in-flight\')', [created.id]);
  const suspendAfterRollback = manage(actor, 'suspend', { id: created.id, expectedVersion: 6 }, randomUUID(), contender);
  await waitForLock(contender); await db.query('rollback'); check((await suspendAfterRollback).operationalStatus, 'suspended');
  check(await scalar('select count(*)::int as result from courses where tenant_id=$1', [created.id]), 1);
}

async function aclChecks(actor, tenant) {
  const signatures = ['public.platform_manage_institution(uuid,text,uuid,uuid,jsonb)','public.manage_institutional_membership(uuid,uuid,text,jsonb,uuid)','public.accept_institution_invite(text,uuid,text,text,uuid)'];
  for (const signature of signatures) {
    check((await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog, public'] });
    check(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') as result", [signature]), true);
    for (const role of ['anon','authenticated']) check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') as result', [role, signature]), false);
    check(await scalar("select count(*)::int as result from pg_proc p,lateral aclexplode(p.proacl)a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", [signature]), 0);
  }
  for (const role of ['anon','authenticated','service_role']) {
    check(await scalar('select has_function_privilege($1,\'public.accept_institution_invite_pre_p02(text,uuid,text,text)\',\'EXECUTE\') as result', [role]), false);
    for (const signature of ['public.assert_operational_tenant(uuid)','public.require_operational_tenant()','public.reject_platform_audit_mutation()']) {
      check(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') as result', [role, signature]), false);
    }
    await db.query(`set role ${role}`);
    await rejected('select public.assert_operational_tenant($1)', [tenant], '42501');
    await rejected('truncate table platform_audit_events', [], '42501');
    await db.query('reset role');
    for (const table of ['platform_operations','platform_audit_events']) {
      check(await scalar('select relrowsecurity as result from pg_class where oid=$1::regclass', [table]), true);
      for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) check(await scalar('select has_table_privilege($1,$2,$3) as result', [role, table, privilege]), false);
    }
  }
  await db.query('set role service_role');
  check(await scalar('select count(*)::int as result from platform_audit_events where tenant_id=$1', [tenant]) > 0, true);
  await rejected('insert into platform_audit_events(tenant_id,actor_auth_id,action,request_id) values ($1,$2,\'institution_created\',$3)', [tenant, actor, randomUUID()], '42501');
  await rejected('update platform_operations set operation=\'create\'', [], '42501');
  check((await manage(actor, 'create', { name: 'Service RPC', slug: `service-${randomBytes(6).toString('hex')}` })).version, 1);
  await db.query('reset role');
  await rejected('delete from platform_audit_events where tenant_id=$1', [tenant], '42501');
  await rejected('update platform_audit_events set action=\'institution_updated\' where tenant_id=$1', [tenant], '42501');
  const auditCount = await scalar('select count(*)::int as result from platform_audit_events');
  await rejected('truncate table platform_audit_events', [], '42501');
  check(await scalar('select count(*)::int as result from platform_audit_events'), auditCount);
  const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='platform_audit_events' order by ordinal_position")).rows.map(row => row.column_name);
  check(columns, ['id','tenant_id','actor_auth_id','action','request_id','target_user_id','from_status','to_status','occurred_at']);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map(client => client.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
