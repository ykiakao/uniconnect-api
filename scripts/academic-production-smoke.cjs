const assert = require('node:assert/strict');
const { once } = require('node:events');

async function main() {
  Object.assign(process.env, {
    NODE_ENV: 'production', API_VERSION: 'v1', ACADEMIC_PROVIDER: 'demo', ACADEMIC_DEMO_TENANT_SLUG: 'edukmais',
    APP_ORIGIN: 'https://frontend.example.invalid',
    SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
  });
  const localFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  globalThis.fetch = async () => { forbiddenCalls++; throw new Error('Rede externa bloqueada no smoke test.'); };
  const { app } = require('../dist/app.js');
  const { DemoAcademicProvider } = require('../dist/modules/academic/providers/demo-academic.provider.js');
  const { createConfiguredAcademicProvider } = require('../dist/modules/academic/academic.providers.js');
  const { AcademicAssessmentSchema } = require('../dist/modules/academic/academic.contracts.js');
  const context = { userId: 'synthetic-smoke-user', tenant: { id: 'synthetic-smoke-tenant', name: 'Instituição fictícia', slug: 'edukmais' } };
  const demo = new DemoAcademicProvider(context);
  assert.equal((await demo.getOverview()).subjects.length, 5);
  assert.equal((await demo.getHistory()).periods.length, 2);
  await demo.close();
  const native = await createConfiguredAcademicProvider(context, { provider: 'native', demoTenantSlug: 'different-tenant' });
  assert.equal(native.source.providerId, 'native');
  assert.equal(native.source.demonstration, false);
  assert.equal(AcademicAssessmentSchema.parse({ activityId: 'synthetic-task', grade: 0, feedback: 'synthetic' }).grade, 0);
  await native.close();
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = `${base}/api/v1/health`;
    assert.equal((await localFetch(health)).status, 200);
    const browser = await localFetch(health, { headers: { Origin: 'https://frontend.example.invalid' } });
    assert.equal(browser.status, 200);
    assert.equal(browser.headers.get('access-control-allow-origin'), 'https://frontend.example.invalid');
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:54321', 'https://other.example.invalid']) {
      const denied = await localFetch(health, { headers: { Origin: origin } });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    }
    const blocked = await localFetch(`${base}/api/v1/tenants/edukmais/academic/overview`);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.headers.get('cache-control'), 'no-store, private');
    assert.equal(blocked.headers.get('etag'), null);
    for (const resource of ['notices', 'conversations', 'notifications']) {
      const protectedResponse = await localFetch(`${base}/api/v1/tenants/edukmais/${resource}`);
      assert.equal(protectedResponse.status, 401);
      assert.equal(protectedResponse.headers.get('cache-control'), 'no-store, private');
      assert.equal((await protectedResponse.json()).error.requestId, protectedResponse.headers.get('x-request-id'));
    }
    for (const path of ['/auth/platform/me', '/auth/capabilities', '/admin/reports/global', '/platform/institutions']) {
      const response = await localFetch(`${base}/api/v1${path}`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store, private');
      assert.equal((await response.json()).error.requestId, response.headers.get('x-request-id'));
    }
    const invalidPlatformLogin = await localFetch(`${base}/api/v1/auth/platform/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-slug': 'ignored-on-platform' },
      body: JSON.stringify({ email: 'synthetic@example.invalid', password: 'synthetic-only', role: 'owner' }),
    });
    assert.equal(invalidPlatformLogin.status, 400);
    assert.equal((await invalidPlatformLogin.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(forbiddenCalls, 0);
    console.log('Build: health 200; academic/comunicacao auth 401, no-store/requestId; demo 5 disciplinas/2 períodos; native registrado; contrato nota zero; CORS de produção explícito; zero chamadas externas.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = localFetch;
  }
}
main().catch(() => { console.error('Falha no smoke test de produção.'); process.exitCode = 1; });
