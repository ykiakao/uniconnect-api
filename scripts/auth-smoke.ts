import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { app } from '../src/app';

class SmokeError extends Error {}

const tenantSlug = process.env.AUTH_SMOKE_TENANT_SLUG ?? 'edukmais';
const email = process.env.AUTH_SMOKE_EMAIL ?? 'aluno@edukmais.edu.br';
const password =
  process.env.AUTH_SMOKE_PASSWORD ??
  process.env.DEMO_STUDENT_PASSWORD;

async function readJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function assertStatus(
  response: Response,
  expectedStatus: number,
  label: string,
) {
  if (response.status === expectedStatus) return;

  throw new SmokeError(`${label}: HTTP ${response.status}; esperado ${expectedStatus}.`);
}

async function main() {
  if (!password?.trim()) {
    throw new SmokeError('Defina AUTH_SMOKE_PASSWORD ou DEMO_STUDENT_PASSWORD com senha nao vazia.');
  }

  const server = app.listen(0);

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/${
      process.env.API_VERSION ?? 'v1'
    }`;
    const headers = {
      'Content-Type': 'application/json',
      'x-tenant-slug': tenantSlug,
    };
    const refreshSession = (refreshToken: string) => fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
    });

    const missingToken = await fetch(`${baseUrl}/auth/me`);
    await assertStatus(missingToken, 401, 'token ausente');

    const invalidToken = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        ...headers,
        Authorization: 'Bearer invalid-token',
      },
    });
    await assertStatus(invalidToken, 401, 'token invalido');

    const invalidLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password: randomUUID(),
      }),
    });
    await assertStatus(invalidLogin, 401, 'login invalido');
    const invalidLoginBody = await readJson(invalidLogin);
    assert.equal(invalidLoginBody.error.code, 'INVALID_CREDENTIALS');

    const missingTenantLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    await assertStatus(missingTenantLogin, 400, 'tenant ausente');
    const missingTenantLoginBody = await readJson(missingTenantLogin);
    assert.equal(missingTenantLoginBody.error.code, 'TENANT_REQUIRED');

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });
    await assertStatus(login, 200, 'login valido');
    const loginBody = await readJson(login);
    assert.equal(loginBody.user.email, email.toLowerCase());
    assert.equal(loginBody.user.tenantSlug, tenantSlug);
    assert.ok(loginBody.user.role);
    assert.ok(loginBody.accessToken);
    assert.ok(typeof loginBody.refreshToken === 'string' && loginBody.refreshToken.trim());
    assert.ok(loginBody.expiresAt);

    const refresh = await refreshSession(loginBody.refreshToken);
    await assertStatus(refresh, 200, 'refresh valido');
    const session = await readJson(refresh);
    assert.ok(typeof session.accessToken === 'string' && session.accessToken.trim());
    assert.ok(typeof session.refreshToken === 'string' && session.refreshToken.trim());
    assert.notEqual(session.refreshToken, loginBody.refreshToken);
    assert.ok(typeof session.expiresAt === 'string' && Number.isFinite(Date.parse(session.expiresAt)));
    assert.ok(session.user.id);
    assert.equal(session.user.id, loginBody.user.id);
    assert.equal(session.user.email, email.toLowerCase());
    assert.equal(session.user.tenantSlug, tenantSlug);
    assert.equal(session.tenant.slug, tenantSlug);

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    await assertStatus(me, 200, 'me apos refresh');
    const meBody = await readJson(me);
    assert.equal(meBody.id, session.user.id);
    assert.equal(meBody.email, email.toLowerCase());
    assert.equal(meBody.tenantSlug, tenantSlug);

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    await assertStatus(logout, 204, 'logout valido');

    const revokedRefresh = await refreshSession(session.refreshToken);
    await assertStatus(revokedRefresh, 401, 'refresh apos logout');
    const revokedBody = await readJson(revokedRefresh);
    assert.equal(revokedBody.error.code, 'INVALID_SESSION');
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof SmokeError
      ? error.message
      : 'Falha no auth-smoke.ts; confira configuracao, dados de demonstracao e contratos da API.',
  );
  process.exitCode = 1;
});
