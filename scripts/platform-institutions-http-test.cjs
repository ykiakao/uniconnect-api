const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { startLocalHarness } = require('./lib/stage9-local.cjs');

async function main() {
  let harness, checks = 0, requests = 0, phase = 'startup';
  let result = 'FAIL';
  const check = (condition) => { assert.ok(condition); checks++; };
  try {
    harness = await startLocalHarness();
    const api = async (method, path, token, body, status = 200, slug, key) => {
      requests++;
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (slug) headers['x-tenant-slug'] = slug;
      if (key) headers['idempotency-key'] = key;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${harness.apiOrigin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = response.status === 204 ? null : await response.json();
      check(response.status === status);
      check(response.headers.get('cache-control') === 'no-store, private');
      check(Boolean(response.headers.get('x-request-id')));
      if (status >= 400) check(data.error.requestId === response.headers.get('x-request-id'));
      return { data, requestId: response.headers.get('x-request-id') };
    };
    phase = 'independent platform';
    const actor = await harness.createAuth('platform-only@p02.invalid');
    const target = await harness.createAuth('first-admin@p02.invalid');
    require('../dist/config/env.js').env.PLATFORM_ADMIN_AUTH_USER_IDS = [actor.id];
    const globalLogin = await api('POST', '/auth/platform/login', undefined, { email: actor.email, password: harness.password });
    const token = globalLogin.data.accessToken;
    check((await harness.db.query('select count(*)::int as n from app_users where auth_user_id=$1', [actor.id])).rows[0].n === 0);
    await api('GET', '/platform/institutions', undefined, undefined, 401);
    const idempotency = randomUUID();
    const created = await api('POST', '/platform/institutions', token, { name: 'Synthetic P02', slug: 'p02-synthetic' }, 201, 'ignored-tenant', idempotency);
    const item = created.data, base = `/platform/institutions/${item.id}`;
    check(item.operationalStatus === 'active' && item.version === 1);
    const replay = await api('POST', '/platform/institutions', token, { name: 'Synthetic P02', slug: item.slug }, 201, undefined, idempotency);
    check(JSON.stringify(replay.data) === JSON.stringify(item));
    await api('POST', '/platform/institutions', token, { name: 'Different', slug: item.slug }, 409, undefined, idempotency);
    const listed = await api('GET', '/platform/institutions?search=Synthetic&page=1&limit=1', token);
    check(listed.data.meta.total === 1 && listed.data.data[0].id === item.id);
    const edited = await api('PATCH', base, token, { name: 'Updated P02', expectedVersion: 1 }, 200, undefined, randomUUID());
    check(edited.data.version === 2 && edited.data.slug === item.slug);
    await api('PATCH', base, token, { name: 'Stale', expectedVersion: 1 }, 409, undefined, randomUUID());
    phase = 'bootstrap and hierarchy';
    const key = randomUUID(), bootstrapInput = { email: target.email, name: 'First Administrator' };
    const bootstrapped = await api('POST', `${base}/bootstrap-admin`, token, bootstrapInput, 201, undefined, key);
    const bootstrapReplay = await api('POST', `${base}/bootstrap-admin`, token, bootstrapInput, 201, undefined, key);
    check(JSON.stringify(bootstrapped.data) === JSON.stringify(bootstrapReplay.data));
    check(bootstrapped.data.administrator.role === 'admin');
    await api('POST', `${base}/bootstrap-admin`, token, bootstrapInput, 409, undefined, randomUUID());
    const adminLogin = await api('POST', '/auth/admin/login', undefined, { email: target.email, password: harness.password }, 200, item.slug);
    const adminToken = adminLogin.data.accessToken;
    await api('GET', '/platform/institutions', adminToken, undefined, 403);
    await api('GET', `/tenants/${item.slug}/users`, token, undefined, 403, item.slug);
    const manager = await api('POST', `/tenants/${item.slug}/users`, adminToken,
      { name: 'Synthetic Coordinator', email: 'coordinator@p02.invalid', password: harness.password, role: 'gestor' }, 201, item.slug);
    const eventList = await api('GET', `${base}/audit`, token);
    check(eventList.data.data.filter(e => e.action === 'institution_created').length === 1);
    check(eventList.data.data.filter(e => e.action === 'administrator_bootstrapped').length === 1);
    const grant = eventList.data.data.find(e => e.action === 'institutional_administrative_grant');
    check(grant.actorAuthUserId === target.id && grant.requestId === manager.requestId);
    check(!JSON.stringify(eventList.data).includes('@p02.invalid'));
    phase = 'suspension and public invitations';
    const invite = await api('POST', `/tenants/${item.slug}/invites`, adminToken,
      { role: 'aluno', recipientEmail: 'invited@p02.invalid' }, 201, item.slug);
    const statusKey = randomUUID();
    const suspended = await api('POST', `${base}/suspend`, token, { expectedVersion: 2 }, 200, item.slug, statusKey);
    check(suspended.data.operationalStatus === 'suspended');
    await api('GET', '/auth/me', adminToken, undefined, 403, item.slug);
    await api('POST', '/auth/admin/login', undefined, { email: target.email, password: harness.password }, 403, item.slug);
    await api('GET', `/invites/${invite.data.code}`, undefined, undefined, 403);
    await api('POST', `/invites/${invite.data.code}/register`, undefined,
      { name: 'Blocked', email: 'invited@p02.invalid', password: harness.password }, 403);
    check((await harness.db.query('select count(*)::int as n from auth.users where email=$1', ['invited@p02.invalid'])).rows[0].n === 0);
    await api('GET', '/auth/platform/me', token, undefined, 200, item.slug);
    await api('GET', base, token, undefined, 200, item.slug);
    const reactivated = await api('POST', `${base}/reactivate`, token, { expectedVersion: 3 }, 200, undefined, randomUUID());
    check(reactivated.data.operationalStatus === 'active');
    const oldReplay = await api('POST', `${base}/suspend`, token, { expectedVersion: 2 }, 200, undefined, statusKey);
    check(oldReplay.data.operationalStatus === 'suspended');
    check((await api('GET', base, token)).data.operationalStatus === 'active');
    await api('GET', '/auth/me', adminToken, undefined, 200, item.slug);
    await api('GET', `/invites/${invite.data.code}`, undefined);
    const audit = (await api('GET', `${base}/audit`, token)).data;
    check(audit.data.filter(e => e.action === 'institution_suspended').length === 1);
    check(audit.data.filter(e => e.action === 'institution_reactivated').length === 1);
    check(harness.stats.forbiddenNetwork === 0);
    result = 'PASS';
  } catch (error) {
    throw new Error(`Local P0.2 HTTP failed at ${phase}; private details withheld.`);
  } finally {
    if (harness) {
      try { await harness.close(); } catch { result = 'FAIL'; }
      const evidence = { ...harness.evidence, stage: 'P0.2', result, checks, httpRequests: requests, phase, transport: harness.stats, auth: 'synthetic local Auth; real Express/SDK/PostgREST/PostgreSQL; no remote Supabase' };
      writeFileSync(join(__dirname, '../docs/evidence', process.argv.includes('--p0-4-regression') ? 'p0-4-p02-http.json' : process.argv.includes('--p0-3-regression') ? 'p0-3-p02-http.json' : 'p0-2-http.json'), JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify({ result, checks, httpRequests: requests, phase, cleanup: evidence.cleanup, forbiddenNetwork: harness.stats.forbiddenNetwork }));
      if (result !== 'PASS') process.exitCode = 1;
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
