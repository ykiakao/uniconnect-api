import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';

import { app } from '../src/app';

const tenantSlug = process.env.AUTH_SMOKE_TENANT_SLUG ?? 'universidade-norte';
const email = process.env.AUTH_SMOKE_EMAIL ?? 'aluno@uni.com';
const password =
  process.env.AUTH_SMOKE_PASSWORD ??
  process.env.DEMO_STUDENT_PASSWORD ??
  '123456';

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

  const body = await readJson(response);
  assert.equal(
    response.status,
    expectedStatus,
    `${label}: ${JSON.stringify(body)}`,
  );
}

async function main() {
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
        password: 'senha-incorreta',
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
    assert.ok(loginBody.refreshToken);
    assert.ok(loginBody.expiresAt);

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
    });
    await assertStatus(me, 200, 'me valido');
    const meBody = await readJson(me);
    assert.equal(meBody.email, email.toLowerCase());
    assert.equal(meBody.tenantSlug, tenantSlug);

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
    });
    await assertStatus(logout, 204, 'logout valido');

    const refresh = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
    });
    await assertStatus(refresh, 501, 'refresh stub');
    const refreshBody = await readJson(refresh);
    assert.equal(refreshBody.error.code, 'NOT_IMPLEMENTED');
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
