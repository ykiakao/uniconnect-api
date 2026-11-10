import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { z } from 'zod';

import { app } from '../src/app';

class SmokeError extends Error {}

const tenantSlug = process.env.INVITE_SMOKE_TENANT_SLUG ?? 'edukmais';
const email =
  process.env.INVITE_SMOKE_EMAIL ?? 'coordenador@edukmais.edu.br';
const password =
  process.env.INVITE_SMOKE_PASSWORD ??
  process.env.DEMO_COORDINATOR_PASSWORD;
const recipientEmail = process.env.INVITE_SMOKE_RECIPIENT_EMAIL?.trim().toLowerCase();

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
    throw new SmokeError('Defina INVITE_SMOKE_PASSWORD ou DEMO_COORDINATOR_PASSWORD com senha nao vazia.');
  }
  if (!recipientEmail?.endsWith('.invalid') || !z.string().email().max(254).safeParse(recipientEmail).success) {
    throw new SmokeError('Defina INVITE_SMOKE_RECIPIENT_EMAIL com endereco sintetico em dominio .invalid.');
  }

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
      body: JSON.stringify({ role: 'aluno', expiresIn: 7, recipientEmail }),
    });
    await assertStatus(createInvite, 201, 'criar convite');
    const inviteBody = await readJson(createInvite);
    const prefix = tenantSlug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'U');
    const { code } = inviteBody;
    assert.ok(typeof code === 'string' && code.length === 52
      && code.startsWith(`${prefix}-`) && /^[0-9A-F]{48}$/.test(code.slice(4)));
    assert.equal(inviteBody.role, 'aluno');
    assert.ok(typeof inviteBody.expiresAt === 'string' && Number.isFinite(Date.parse(inviteBody.expiresAt)));

    const resolveInvite = await fetch(`${baseUrl}/invites/${code}`);
    await assertStatus(resolveInvite, 200, 'resolver convite');
    const resolveBody = await readJson(resolveInvite);
    assert.equal(resolveBody.tenantSlug, tenantSlug);
    assert.equal(resolveBody.role, 'aluno');
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof SmokeError
      ? error.message
      : 'Falha no invite-smoke.ts; confira configuracao, dados de demonstracao e contratos da API.',
  );
  process.exitCode = 1;
});
