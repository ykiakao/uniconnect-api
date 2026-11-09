const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { startLocalHarness } = require('./lib/stage9-local.cjs');

async function main() {
  let h, checks = 0, requests = 0, result = 'FAIL', phase = 'startup';
  const check = (value) => { assert.ok(value); checks++; };
  try {
    h = await startLocalHarness();
    const teacher = await h.createAuth('teacher-current@p04.invalid');
    const admin = await h.createAuth('admin-current@p04.invalid');
    const tenant = (await h.db.query("insert into tenants(name,slug,plan,status) values('Synthetic P04','p04-identity','starter','active') returning id")).rows[0];
    await h.db.query("insert into app_users(tenant_id,auth_user_id,name,email,role,active) values($1,$2,'Teacher','teacher-stored@p04.invalid','teacher',true),($1,$3,'Admin','teacher-current@p04.invalid','admin',true)", [tenant.id, teacher.id, admin.id]);
    const api = async (path, body, expected) => {
      requests++;
      const response = await fetch(`${h.apiOrigin}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-slug': 'p04-identity', origin: 'http://localhost:3000' }, body: JSON.stringify(body) });
      const data = await response.json();
      check(response.status === expected);
      check(response.headers.get('cache-control') === 'no-store, private');
      check(Boolean(response.headers.get('x-request-id')));
      check(response.headers.get('access-control-expose-headers').includes('Retry-After'));
      if (expected >= 400) check(data.error.requestId === response.headers.get('x-request-id'));
      return data;
    };
    phase = 'teacher identity cannot borrow administrative email role';
    const denied = await api('/auth/admin/login', { email: teacher.email, password: h.password }, 403);
    check(denied.error.code === 'ADMIN_ACCESS_REQUIRED' && !denied.accessToken && !denied.refreshToken);
    phase = 'legitimate admin identity does not require synchronized membership email';
    const authorized = await api('/auth/admin/login', { email: admin.email, password: h.password }, 200);
    check(authorized.user.role === 'admin' && authorized.accessToken && authorized.refreshToken);
    check((await h.db.query('select auth_user_id from app_users where id=$1', [authorized.user.id])).rows[0].auth_user_id === admin.id);
    phase = 'institutional login remains teacher';
    const normal = await api('/auth/login', { email: teacher.email, password: h.password }, 200);
    check(normal.user.role === 'professor');
    check(h.stats.forbiddenNetwork === 0);
    result = 'PASS';
  } finally {
    if (h) {
      try { await h.close(); } catch { result = 'FAIL'; }
      const evidence = { ...h.evidence, result, checks, httpRequests: requests, phase, transport: h.stats, auth: 'synthetic local Auth; real PostgreSQL membership/email mismatch, SDK and compiled Express' };
      writeFileSync(join(__dirname, '../docs/evidence/p0-4-http-security.json'), JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify({ result, checks, httpRequests: requests, phase, cleanup: evidence.cleanup }));
      if (result !== 'PASS') process.exitCode = 1;
    }
  }
}
main().catch(() => { console.error('P0.4 HTTP identity regression failed; private details withheld.'); process.exitCode = 1; });
