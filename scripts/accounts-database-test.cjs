const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');
const { applyGuardedMigration } = require('./lib/migration-executor.cjs');

const root = join(__dirname, '..');
const migration = '20261101000007_accounts_and_responsibility.sql';
const baseline = process.argv.includes('--baseline');
const containerName = `uniconnect-accounts-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const peers = [];
let db, config, containerId, checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const scalar = async (sql, params = [], client = db) => (await client.query(sql, params)).rows[0].result;
const rpcSql = 'select public.platform_manage_accounts($1,$2,$3,$4,$5) as result';
const institutionSql = 'select public.platform_manage_institution($1,$2,$3,$4,$5) as result';
const account = (actor, operation, payload, key = randomUUID(), client = db) => scalar(rpcSql, [actor, operation, key, randomUUID(), payload], client);
const institution = (actor, operation, payload, key = randomUUID(), client = db) => scalar(institutionSql, [actor, operation, key, randomUUID(), payload], client);
async function rejected(sql, params, code, message, client = db) {
  await assert.rejects(client.query(sql, params), error => {
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
  checks++;
}
const deny = (actor, operation, payload, message, code = 'PT409', key = randomUUID(), client = db) => rejected(rpcSql, [actor, operation, key, randomUUID(), payload], code, message, client);
async function auth(email = `synthetic-${randomUUID()}@example.invalid`, confirmed = true) {
  const id = randomUUID();
  await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,$3)', [id, email, confirmed ? new Date() : null]);
  return { id, email };
}
async function member(tenant, role = 'admin', active = true, identity) {
  identity ||= await auth();
  return (await db.query("insert into app_users(tenant_id,auth_user_id,name,email,role,active) values($1,$2,'Synthetic',$3,$4,$5) returning *", [tenant, identity.id, identity.email, role, active])).rows[0];
}
async function newTenant(actor) {
  return (await institution(actor, 'create', { name: 'Synthetic account institution', slug: `accounts-${randomBytes(6).toString('hex')}` })).id;
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
  throw new Error('Expected PostgreSQL lock wait.');
}
async function main() {
  if (!process.argv.includes('--allow-local-migrations')) throw new Error('Explicit --allow-local-migrations is required.');
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
  const historical = ['20260528000001_academic_base.sql','20260528000002_activities_grades_reports.sql','20260528000003_invites.sql','20261026000001_security_integrity.sql','20261026000002_academic_structure.sql','20261026000003_institutional_management.sql','20261026000004_activity_workflow.sql','20261026000005_academic_communication.sql','20261031000006_platform_institutions.sql'];
  for (const name of historical) await applyGuardedMigration(db, { name, sql: readFileSync(join(root, 'supabase/migrations', name), 'utf8') });
  const actor = (await auth()).id, legacyTenant = await newTenant(actor), legacyAuth = await auth();
  const legacyKey = randomUUID(), legacyPayload = { id: legacyTenant, name: 'Legacy administrator', email: legacyAuth.email };
  const legacyBootstrap = await institution(actor, 'bootstrap', legacyPayload, legacyKey);
  if (!baseline) await applyGuardedMigration(db, { name: migration, sql: readFileSync(join(root, 'supabase/migrations', migration), 'utf8') });
  check(await scalar("select to_regprocedure('public.platform_manage_accounts(uuid,text,uuid,uuid,jsonb)') is not null as result"), true);
  check(await account(actor, 'get_responsible', { institutionId: legacyTenant }), null);
  const auditBefore = await scalar('select count(*)::int as result from platform_audit_events');
  check(await institution(actor, 'bootstrap', legacyPayload, legacyKey), legacyBootstrap);
  check(await account(actor, 'get_responsible', { institutionId: legacyTenant }), null);
  check(await scalar('select count(*)::int as result from platform_audit_events'), auditBefore);
  await provisioning(actor);
  await responsibility(actor, legacyTenant, legacyBootstrap.administrator.id);
  await rollbackChecks(actor);
  await concurrentChecks(actor);
  await aclChecks(actor, legacyTenant);
  const evidence = { recordedAt: new Date().toISOString(), database: 'PostgreSQL 16 disposable loopback Docker container', checks, baseline: false,
    migrationSha256: createHash('sha256').update(readFileSync(join(root, 'supabase/migrations', migration), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
    coverage: ['historical protected executor and legacy bootstrap replay without backfill','strict inputs and actor-bound canonical-payload journal','durable provision identity and one invite claim','Auth side effect crash reconciliation','uncertain invite needs_review without resend','Auth identity ambiguity and changes','responsible designate and confirmed replacement','role protection without owner promotion','cross-tenant/Auth preservation','CAS and immutable snapshot replay','atomic audit rollback','real concurrent same-key reserve, invite claims, replacement, demotion and suspension','RLS, minimal column projection, private helpers and journal DML ACL','append-only audit and previous/new responsible correlation'],
    remoteDatabaseUsed: false, syntheticIdentitiesOnly: true, realAuthOrEmailUsed: false };
  writeFileSync(join(root, 'docs/evidence', process.argv.includes('--p0-4-regression') ? 'p0-4-postgres.json' : 'p0-3-postgres.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Accounts database verification passed: ${checks} checks, synthetic Auth, disposable local PostgreSQL 16.`);
}

async function provisioning(actor) {
  const tenant = await newTenant(actor), key = randomUUID(), payload = { institutionId: tenant, name: 'Synthetic account', email: 'provision@example.invalid' };
  const p = await account(actor, 'reserve_provision', payload, key);
  check(Object.keys(p).sort(), ['id','institutionId','state','createdAt','updatedAt'].sort()); check(p.state, 'pending');
  check(await account(actor, 'reserve_provision', payload, key), p);
  check((await account(actor, 'reserve_provision', payload)).id, p.id);
  await deny(actor, 'reserve_provision', { ...payload, name: 'Different' }, /IDEMPOTENCY_CONFLICT/, 'PT409', key);
  await deny(actor, 'designate_responsible', { institutionId: tenant, administratorId: randomUUID(), expectedVersion: 0 }, /IDEMPOTENCY_CONFLICT/, 'PT409', key);
  await deny(actor, 'reserve_provision', { ...payload, name: 'Different' }, /PROVISION_IDENTITY_CONFLICT/);
  await deny(actor, 'reserve_provision', { ...payload, password: 'denied' }, undefined, '22023');
  for (const change of [{ name: 'x'.repeat(201) }, { name: 'bad\nname' }, { email: 'x'.repeat(255) }, { email: 'bad\u0001@example.invalid' }]) await deny(actor, 'reserve_provision', { ...payload, ...change }, undefined, '22023');
  await deny(randomUUID(), 'reserve_provision', payload, undefined, '42501');
  await deny(actor, 'reserve_provision', payload, undefined, '22023', null);
  const payloadId = { institutionId: tenant, provisionId: p.id };
  check((await account(actor, 'prepare_provision', payloadId)).inviteRequired, true);
  const uncertain = await account(actor, 'prepare_provision', payloadId);
  check(uncertain.inviteRequired, false); check(uncertain.provision.state, 'needs_review');
  check((await account(actor, 'reconcile_provision', payloadId)).inviteRequired, false);
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [tenant]), 0);
  const identity = await auth(payload.email, false);
  const afterCrash = await account(actor, 'reconcile_provision', payloadId);
  check(afterCrash.provision.state, 'awaiting_confirmation'); check(afterCrash.inviteRequired, false);
  await db.query('update auth.users set email_confirmed_at=clock_timestamp() where id=$1', [identity.id]);
  check((await account(actor, 'reconcile_provision', payloadId)).provision.state, 'ready');
  check((await account(actor, 'reserve_provision', payload, key)).state, 'ready');
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [tenant]), 0);
  await db.query("update auth.users set email='moved@example.invalid' where id=$1", [identity.id]);
  await auth(payload.email);
  await deny(actor, 'reconcile_provision', payloadId, /PROVISION_IDENTITY_CHANGED/);
  await auth(payload.email);
  await deny(actor, 'reconcile_provision', payloadId, /ACCOUNT_AUTH_AMBIGUOUS/);
  const actor2 = (await auth()).id;
  check((await account(actor2, 'reserve_provision', { ...payload, email: 'other@example.invalid' }, key)).state, 'pending');
  const existing = await auth();
  const existingProvision = await account(actor, 'reserve_provision', { ...payload, email: existing.email });
  check((await account(actor, 'prepare_provision', { institutionId: tenant, provisionId: existingProvision.id })).provision.state, 'ready');
  check(await scalar('select invite_attempted_at is null as result from platform_account_provisions where id=$1', [existingProvision.id]), true);
  await deny(actor, 'prepare_provision', { institutionId: await newTenant(actor), provisionId: p.id }, /PROVISION_NOT_FOUND/, 'PT404');
  const fresh = await account(actor, 'reserve_provision', { ...payload, email: 'reconcile-only@example.invalid' });
  check((await account(actor, 'reconcile_provision', { institutionId: tenant, provisionId: fresh.id })).provision.state, 'needs_review');
  check(await scalar('select invite_attempted_at is null as result from platform_account_provisions where id=$1', [fresh.id]), true);
  const auditColumns = (await db.query("select column_name from information_schema.columns where table_name='platform_audit_events'")).rows.map(r => r.column_name);
  check(auditColumns.some(c => /email|name|password|token|payload/.test(c)), false);
}

async function responsibility(actor, legacyTenant, legacyAdmin) {
  const designationKey = randomUUID(), designationPayload = { institutionId: legacyTenant, administratorId: legacyAdmin, expectedVersion: 0 };
  const first = await account(actor, 'designate_responsible', designationPayload, designationKey);
  check(first, { institutionId: legacyTenant, responsibleUserId: legacyAdmin, version: 1 });
  await rejected('update app_users set active=false where id=$1', [legacyAdmin], '23514', /RESPONSIBLE_REPLACEMENT_REQUIRED/);
  await rejected("update app_users set role='owner' where id=$1", [legacyAdmin], '23514', /RESPONSIBLE_REPLACEMENT_REQUIRED/);
  await rejected('delete from app_users where id=$1', [legacyAdmin], '23514', /RESPONSIBLE_REPLACEMENT_REQUIRED/);
  await rejected('update app_users set auth_user_id=$2 where id=$1', [legacyAdmin, (await auth()).id], '23514', /RESPONSIBLE_REPLACEMENT_REQUIRED/);
  await deny(actor, 'designate_responsible', designationPayload, /RESPONSIBLE_VERSION_CONFLICT/);
  const tenant2 = await newTenant(actor);
  for (const role of ['owner','coordinator','teacher','student']) {
    const m = await member(tenant2, role);
    await deny(actor, 'designate_responsible', { institutionId: tenant2, administratorId: m.id, expectedVersion: 0 }, /RESPONSIBLE_ACTIVE_ADMIN_REQUIRED/);
  }
  await deny(actor, 'designate_responsible', { institutionId: tenant2, administratorId: legacyAdmin, expectedVersion: 0 }, /RESPONSIBLE_ACTIVE_ADMIN_REQUIRED/);
  const inactive = await member(tenant2, 'admin', false);
  await deny(actor, 'designate_responsible', { institutionId: tenant2, administratorId: inactive.id, expectedVersion: 0 }, /RESPONSIBLE_ACTIVE_ADMIN_REQUIRED/);
  for (const role of ['owner','coordinator','teacher','student']) {
    const m = await member(legacyTenant, role);
    await deny(actor, 'replace_responsible', { institutionId: legacyTenant, email: m.email, name: 'Synthetic', expectedVersion: 1 }, /RESPONSIBLE_TARGET_ROLE_CONFLICT/);
    check(await scalar('select role as result from app_users where id=$1', [m.id]), role);
  }
  await deny(actor, 'replace_responsible', { institutionId: legacyTenant, email: 'missing@example.invalid', name: 'Synthetic', expectedVersion: 1 }, /ACCOUNT_AUTH_REQUIRED/);
  const unconfirmed = await auth(undefined, false);
  await deny(actor, 'replace_responsible', { institutionId: legacyTenant, email: unconfirmed.email, name: 'Synthetic', expectedVersion: 1 }, /ACCOUNT_AUTH_UNCONFIRMED/);
  const nextAuth = await auth(), otherMembership = await member(tenant2, 'student', true, nextAuth);
  const beforeAuth = (await db.query('select * from auth.users order by id')).rows;
  const replaceKey = randomUUID(), replacePayload = { institutionId: legacyTenant, email: nextAuth.email, name: 'New synthetic', expectedVersion: 1 };
  const next = await account(actor, 'replace_responsible', replacePayload, replaceKey);
  check(next.version, 2); check(await scalar('select active as result from app_users where id=$1', [legacyAdmin]), false);
  check((await db.query('select * from auth.users order by id')).rows, beforeAuth);
  check((await db.query('select role,active from app_users where id=$1', [otherMembership.id])).rows[0], { role: 'student', active: true });
  const later = await member(legacyTenant, 'admin', false);
  const final = await account(actor, 'replace_responsible', { institutionId: legacyTenant, email: later.email, name: 'Ignored existing name', expectedVersion: 2 });
  check(final.responsibleUserId, later.id); check(final.version, 3);
  check(await account(actor, 'replace_responsible', replacePayload, replaceKey), next);
  check(await account(actor, 'designate_responsible', designationPayload, designationKey), first);
  check(await account(actor, 'get_responsible', { institutionId: legacyTenant }), final);
  check(await scalar('select active as result from app_users where id=$1', [next.responsibleUserId]), false);
  const audited = (await db.query("select target_user_id,previous_user_id,actor_auth_id from platform_audit_events where tenant_id=$1 and action='responsible_replaced' order by occurred_at", [legacyTenant])).rows;
  check(audited[0], { target_user_id: next.responsibleUserId, previous_user_id: legacyAdmin, actor_auth_id: actor });
  const bootTenant = await newTenant(actor), bootIdentity = await auth(), bootKey = randomUUID();
  const bootPayload = { id: bootTenant, email: bootIdentity.email, name: 'New bootstrap' };
  const boot = await institution(actor, 'bootstrap', bootPayload, bootKey);
  check(await account(actor, 'get_responsible', { institutionId: bootTenant }), { institutionId: bootTenant, responsibleUserId: boot.administrator.id, version: 1 });
  const replacement = await auth();
  const bootNew = await account(actor, 'replace_responsible', { institutionId: bootTenant, email: replacement.email, name: 'Replacement', expectedVersion: 1 });
  const auditCount = await scalar('select count(*)::int as result from platform_audit_events');
  check(await institution(actor, 'bootstrap', bootPayload, bootKey), boot);
  check(await account(actor, 'get_responsible', { institutionId: bootTenant }), bootNew);
  check(await scalar('select count(*)::int as result from platform_audit_events'), auditCount);
  check(await scalar('select operational_version as result from tenants where id=$1', [bootTenant]), 1);
  const suspendedProvision = await account(actor, 'reserve_provision', { institutionId: bootTenant, email: 'before-suspended@example.invalid', name: 'Before suspension' });
  await institution(actor, 'suspend', { id: bootTenant, expectedVersion: 1 });
  check(await account(actor, 'get_responsible', { institutionId: bootTenant }), bootNew);
  await deny(actor, 'replace_responsible', { institutionId: bootTenant, email: bootIdentity.email, name: 'Suspended', expectedVersion: 2 }, /TENANT_SUSPENDED/, 'PT403');
  await deny(actor, 'reserve_provision', { institutionId: bootTenant, email: 'suspended@example.invalid', name: 'Suspended' }, /TENANT_SUSPENDED/, 'PT403');
  for (const operation of ['prepare_provision','reconcile_provision']) await deny(actor, operation, { institutionId: bootTenant, provisionId: suspendedProvision.id }, /TENANT_SUSPENDED/, 'PT403');
}

async function rollbackChecks(actor) {
  const tenant = await newTenant(actor), old = await member(tenant);
  await account(actor, 'designate_responsible', { institutionId: tenant, administratorId: old.id, expectedVersion: 0 });
  const identity = await auth(), key = randomUUID();
  await db.query(`create function public.test_accounts_audit_failure() returns trigger language plpgsql as $$ begin
    if new.action in ('responsible_replaced','account_invite_requested') then raise exception using errcode='P0001',message='SYNTHETIC_AUDIT_FAILURE'; end if; return new; end $$;
    create trigger test_accounts_audit_failure before insert on platform_audit_events for each row execute function public.test_accounts_audit_failure()`);
  await deny(actor, 'replace_responsible', { institutionId: tenant, email: identity.email, name: 'Rollback', expectedVersion: 1 }, /SYNTHETIC_AUDIT_FAILURE/, 'P0001', key);
  check(await scalar('select active as result from app_users where id=$1', [old.id]), true);
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1 and auth_user_id=$2', [tenant, identity.id]), 0);
  check(await scalar('select version as result from institution_responsibles where tenant_id=$1', [tenant]), 1);
  check(await scalar('select count(*)::int as result from platform_account_operations where actor_auth_id=$1 and idempotency_key=$2', [actor, key]), 0);
  const inactiveTarget = await member(tenant, 'admin', false);
  await deny(actor, 'replace_responsible', { institutionId: tenant, email: inactiveTarget.email, name: 'Rollback activation', expectedVersion: 1 }, /SYNTHETIC_AUDIT_FAILURE/, 'P0001');
  check(await scalar('select active as result from app_users where id=$1', [inactiveTarget.id]), false);
  check(await scalar('select active as result from app_users where id=$1', [old.id]), true);
  const p = await account(actor, 'reserve_provision', { institutionId: tenant, email: 'rollback-invite@example.invalid', name: 'Rollback invite' });
  await deny(actor, 'prepare_provision', { institutionId: tenant, provisionId: p.id }, /SYNTHETIC_AUDIT_FAILURE/, 'P0001');
  check(await scalar('select invite_attempted_at is null and state=\'pending\' as result from platform_account_provisions where id=$1', [p.id]), true);
  await db.query('drop trigger test_accounts_audit_failure on platform_audit_events; drop function public.test_accounts_audit_failure()');
  const bootTenant = await newTenant(actor), bootAuth = await auth();
  await db.query(`create function public.test_designation_failure() returns trigger language plpgsql as $$ begin
    if new.action='responsible_designated' then raise exception using errcode='P0001',message='SYNTHETIC_DESIGNATION_FAILURE'; end if; return new; end $$;
    create trigger test_designation_failure before insert on platform_audit_events for each row execute function public.test_designation_failure()`);
  await rejected(institutionSql, [actor, 'bootstrap', randomUUID(), randomUUID(), { id: bootTenant, email: bootAuth.email, name: 'Rollback bootstrap' }], 'P0001');
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1', [bootTenant]), 0);
  check(await scalar('select count(*)::int as result from institution_responsibles where tenant_id=$1', [bootTenant]), 0);
  await db.query('drop trigger test_designation_failure on platform_audit_events; drop function public.test_designation_failure()');
}

async function concurrentChecks(actor) {
  const a = await peer(), b = await peer(), tenant = await newTenant(actor), key = randomUUID();
  const payload = { institutionId: tenant, email: 'race@example.invalid', name: 'Race' };
  await a.query('begin');
  const first = await account(actor, 'reserve_provision', payload, key, a);
  const waiting = account(actor, 'reserve_provision', payload, key, b);
  await waitForLock(b); await a.query('commit'); check(await waiting, first);
  const pp = { institutionId: tenant, provisionId: first.id };
  await a.query('begin');
  check((await account(actor, 'prepare_provision', pp, randomUUID(), a)).inviteRequired, true);
  const claim = account(actor, 'prepare_provision', pp, randomUUID(), b);
  await waitForLock(b); await a.query('commit'); check((await claim).inviteRequired, false);
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='account_invite_requested'", [tenant]), 1);
  const old = await member(tenant);
  await account(actor, 'designate_responsible', { institutionId: tenant, administratorId: old.id, expectedVersion: 0 });
  const next = await auth(), loser = await auth();
  await a.query('begin');
  const replacement = await account(actor, 'replace_responsible', { institutionId: tenant, email: next.email, name: 'Winner', expectedVersion: 1 }, randomUUID(), a);
  const conflict = deny(actor, 'replace_responsible', { institutionId: tenant, email: loser.email, name: 'Loser', expectedVersion: 1 }, /RESPONSIBLE_VERSION_CONFLICT/, 'PT409', randomUUID(), b);
  await waitForLock(b); await a.query('commit'); await conflict;
  check(await scalar('select count(*)::int as result from app_users where tenant_id=$1 and auth_user_id=$2', [tenant, loser.id]), 0);
  await a.query('begin');
  await a.query("update tenants set operational_status='suspended' where id=$1", [tenant]);
  const suspended = deny(actor, 'reserve_provision', { institutionId: tenant, email: 'suspend-race@example.invalid', name: 'Suspended race' }, /TENANT_SUSPENDED/, 'PT403', randomUUID(), b);
  await waitForLock(b); await a.query('commit'); await suspended;
  await db.query("update tenants set operational_status='active' where id=$1", [tenant]);
  const demotionTarget = await member(tenant);
  await a.query('begin');
  await a.query("update app_users set role='student' where id=$1", [demotionTarget.id]);
  const demotion = deny(actor, 'replace_responsible', { institutionId: tenant, email: demotionTarget.email, name: 'Role race', expectedVersion: 2 }, /RESPONSIBLE_TARGET_ROLE_CONFLICT/, 'PT409', randomUUID(), b);
  await waitForLock(b); await a.query('commit'); await demotion;
  check(await account(actor, 'get_responsible', { institutionId: tenant }), replacement);
  const finalMember = await member(tenant, 'admin', false);
  await a.query('begin');
  await account(actor, 'replace_responsible', { institutionId: tenant, email: finalMember.email, name: 'Protected race', expectedVersion: 2 }, randomUUID(), a);
  const deactivate = rejected('update app_users set active=false where id=$1', [finalMember.id], '23514', /RESPONSIBLE_REPLACEMENT_REQUIRED/, b);
  await waitForLock(b); await a.query('commit'); await deactivate;
  const bootTenant = await newTenant(actor), bootAuth = await auth(), bootKey = randomUUID();
  const bootPayload = { id: bootTenant, email: bootAuth.email, name: 'Concurrent bootstrap' };
  await a.query('begin');
  const boot = await institution(actor, 'bootstrap', bootPayload, bootKey, a);
  const bootReplay = institution(actor, 'bootstrap', bootPayload, bootKey, b);
  await waitForLock(b); await a.query('commit'); check(await bootReplay, boot);
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='responsible_designated'", [bootTenant]), 1);
  const replayAuth = await auth(), replayKey = randomUUID();
  const replayPayload = { institutionId: bootTenant, email: replayAuth.email, name: 'Concurrent replacement', expectedVersion: 1 };
  await a.query('begin');
  const result = await account(actor, 'replace_responsible', replayPayload, replayKey, a);
  const resultReplay = account(actor, 'replace_responsible', replayPayload, replayKey, b);
  await waitForLock(b); await a.query('commit'); check(await resultReplay, result);
  check(await scalar("select count(*)::int as result from platform_audit_events where tenant_id=$1 and action='responsible_replaced'", [bootTenant]), 1);
  await a.query('begin');
  const beforeSuspend = await account(actor, 'reserve_provision', { institutionId: bootTenant, email: 'before-suspend-race@example.invalid', name: 'Before suspend race' }, randomUUID(), a);
  const suspendAfter = institution(actor, 'suspend', { id: bootTenant, expectedVersion: 1 }, randomUUID(), b);
  await waitForLock(b); await a.query('commit'); check((await suspendAfter).operationalStatus, 'suspended');
  check(await scalar('select state as result from platform_account_provisions where id=$1', [beforeSuspend.id]), 'pending');
}

async function aclChecks(actor, tenant) {
  for (const role of ['anon','authenticated','service_role']) {
    for (const fn of ['account_provision_dto(public.platform_account_provisions)','guard_responsible_membership()','guard_responsible_target()','platform_manage_institution_pre_p03(uuid,text,uuid,uuid,jsonb)']) {
      check(await scalar('select has_function_privilege($1,$2,\'execute\') as result', [role, `public.${fn}`]), false);
    }
    await db.query(`set role ${role}`);
    await rejected('select * from platform_account_operations', [], '42501');
    await rejected('update platform_account_operations set operation=\'reserve_provision\'', [], '42501');
    await rejected('delete from institution_responsibles', [], '42501');
    await rejected('insert into platform_account_provisions(tenant_id,name,email) values($1,\'Denied\',\'denied@example.invalid\')', [tenant], '42501');
    await rejected('select name,email,auth_user_id from platform_account_provisions', [], '42501');
    if (role === 'service_role') {
      await db.query('select id,tenant_id,state,created_at,updated_at from platform_account_provisions'); checks++;
      check((await account(actor, 'get_responsible', { institutionId: tenant })).institutionId, tenant);
    } else {
      await rejected(rpcSql, [actor, 'get_responsible', randomUUID(), randomUUID(), { institutionId: tenant }], '42501');
      await rejected('select id from platform_account_provisions', [], '42501');
    }
    await db.query('reset role');
  }
  await rejected('update platform_audit_events set previous_user_id=$1', [randomUUID()], '42501');
  await rejected('truncate platform_audit_events', [], '42501');
  check(await scalar("select count(*)::int as result from pg_tables where schemaname='public' and tablename in ('platform_account_provisions','platform_account_operations','institution_responsibles') and rowsecurity"), 3);
  const functions = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.platform_manage_accounts(uuid,text,uuid,uuid,jsonb)'::regprocedure")).rows[0];
  check(functions, { prosecdef: true, proconfig: ['search_path=pg_catalog, public'] });
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(peers.map(client => client.end()));
  if (db) await db.end().catch(() => {});
  if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
    try { docker('rm', '-f', containerId); } catch { console.error(`Remove local test container ${containerName} manually.`); process.exitCode = 1; }
  }
});
