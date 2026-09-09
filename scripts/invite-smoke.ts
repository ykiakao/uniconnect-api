import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';

import { app } from '../src/app';

const tenantSlug = process.env.INVITE_SMOKE_TENANT_SLUG ?? 'edukmais';
const email =
  process.env.INVITE_SMOKE_EMAIL ?? 'coordenador@edukmais.edu.br';
const password =
  process.env.INVITE_SMOKE_PASSWORD ??
  process.env.DEMO_COORDINATOR_PASSWORD ??
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

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-slug': tenantSlug,
      },
      body: JSON.stringify({ email, password }),
    });
    await assertStatus(login, 200, 'login gestor para convite');
    const loginBody = await readJson(login);
    assert.ok(loginBody.accessToken);

    const createInvite = await fetch(`${baseUrl}/tenants/${tenantSlug}/invites`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.accessToken}`,
        'Content-Type': 'application/json',
        'x-tenant-slug': tenantSlug,
      },
      body: JSON.stringify({ role: 'aluno', expiresIn: 7 }),
    });
    await assertStatus(createInvite, 201, 'criar convite');
    const inviteBody = await readJson(createInvite);
    assert.match(inviteBody.code, /^EDU-[A-Z0-9]{8}$/);
    assert.ok(inviteBody.expiresAt);

    const resolveInvite = await fetch(`${baseUrl}/invites/${inviteBody.code}`);
    await assertStatus(resolveInvite, 200, 'resolver convite');
    const resolveBody = await readJson(resolveInvite);
    assert.equal(resolveBody.tenantSlug, tenantSlug);
    assert.equal(resolveBody.role, 'aluno');
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
