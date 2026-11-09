import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../app';
import { env } from '../../config/env';
import { createSupabaseAdminClient, createSupabaseAnonClient } from '../../config/supabase';
import { PlatformInstitutionsRepository } from './platform-institutions.repository';
import { HttpError } from '../../shared/http-error';

const base = '/api/v1/platform/institutions';
const tenantId = '11111111-1111-1111-1111-111111111111';
const db = createSupabaseAdminClient();
const originalAllowlist = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];
let platformId: string;
let platformToken: string;
const target = { email: 'bootstrap-target@example.invalid', password: 'Synthetic123!' };

beforeAll(async () => {
  const created = await db.auth.admin.createUser({ email: 'platform-institutions@example.invalid', password: 'Synthetic123!', email_confirm: true });
  if (!created.data.user) throw new Error('Missing synthetic identity');
  platformId = created.data.user.id;
  const login = await createSupabaseAnonClient().auth.signInWithPassword({ email: 'platform-institutions@example.invalid', password: 'Synthetic123!' });
  if (!login.data.session) throw new Error('Missing synthetic session');
  platformToken = login.data.session.access_token;
  await db.auth.admin.createUser({ ...target, email_confirm: true });
});
beforeEach(async () => {
  env.PLATFORM_ADMIN_AUTH_USER_IDS = [platformId];
  await db.from('tenants').update({ operational_status: 'active' }).eq('id', tenantId);
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { env.PLATFORM_ADMIN_AUTH_USER_IDS = originalAllowlist; });

function get(path = base, token = platformToken) { return request(app).get(path).set('Authorization', `Bearer ${token}`); }
function mutate(path: string, payload: object, key = randomUUID(), method: 'post' | 'patch' = 'post') {
  return request(app)[method](path).set('Authorization', `Bearer ${platformToken}`).set('Idempotency-Key', key).send(payload);
}
async function institution() {
  const result = await mutate(base, { name: 'Synthetic Institution', slug: `syn-${randomUUID().slice(0, 8)}` });
  expect(result.status).toBe(201);
  return result.body as { id: string; version: number; slug: string };
}

describe('platform institution authorization and contracts', () => {
  it('lists institutions for an allowlisted Auth identity without app_users', async () => {
    expect((await db.from('app_users').select('id').eq('auth_user_id', platformId)).data).toEqual([]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual(expect.objectContaining({ page: 1, limit: 20 }));
    expect(response.body.data[0]).toEqual(expect.objectContaining({ id: tenantId, operationalStatus: 'active', version: 1 }));
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it.each(['student', 'teacher', 'coordinator', 'admin'])('rejects institutional %s on reads and mutations', async role => {
    expect((await get(base, `valid-${role}-token`)).status).toBe(403);
    const response = await request(app).post(base).set('Authorization', `Bearer valid-${role}-token`)
      .set('Idempotency-Key', randomUUID()).send({ name: 'Forbidden', slug: 'forbidden' });
    expect(response.status).toBe(403);
  });

  it('requires valid authentication and does not trust client authority', async () => {
    expect((await request(app).get(base)).status).toBe(401);
    expect((await get(base, 'invalid-token')).status).toBe(401);
    expect((await get(base, 'valid-admin-token').set('x-role', 'platform_superadmin').set('x-user-id', platformId)).status).toBe(403);
  });

  it('exposes additive platform capabilities without changing institutional profiles', async () => {
    const global = await get('/api/v1/auth/platform/me');
    expect(global.body.authorization.capabilities).toEqual(expect.arrayContaining([
      'platform.reports.read', 'platform.institutions.read', 'platform.institutions.manage', 'platform.institutions.bootstrap', 'platform.audit.read',
    ]));
    const institutional = await get('/api/v1/auth/capabilities', 'valid-teacher-token').set('x-tenant-slug', 'edukmais');
    expect(institutional.body.authorization.profile).toBe('teacher');
    expect(institutional.body.authorization.capabilities.some((c: string) => c.startsWith('platform.'))).toBe(false);
  });

  it('creates idempotently and binds the key to actor, payload and operation', async () => {
    const key = randomUUID(), input = { name: 'Idempotent Institution', slug: `id-${key.slice(0, 8)}` };
    const first = await mutate(base, input, key);
    const replay = await mutate(base, input, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect((await mutate(base, { ...input, name: 'Different' }, key)).status).toBe(409);
    const audit = await get(`${base}/${first.body.id}/audit`);
    expect(audit.body.data.filter((e: { action: string }) => e.action === 'institution_created')).toHaveLength(1);
    expect(audit.body.data[0].actorAuthUserId).toBe(platformId);
    expect(audit.body.data[0].requestId).toBe(first.headers['x-request-id']);
  });

  it('requires idempotency and refuses privileged or billing fields', async () => {
    expect((await request(app).post(base).set('Authorization', `Bearer ${platformToken}`).send({ name: 'X', slug: 'synthetic-x' })).status).toBe(400);
    expect((await mutate(base, { name: 'X', slug: 'synthetic-x', plan: 'enterprise', role: 'owner', actorAuthId: platformId })).status).toBe(400);
    expect((await mutate(base, { name: 'X', slug: '../../invalid' })).status).toBe(400);
    expect((await get().query({ page: '1.5' })).status).toBe(400);
  });

  it('recovers a committed operation whose HTTP response was lost without duplicating data or audit', async () => {
    const key = randomUUID(), input = { name: 'Recovered Institution', slug: `retry-${key.slice(0, 8)}` };
    const original = PlatformInstitutionsRepository.prototype.mutate;
    jest.spyOn(PlatformInstitutionsRepository.prototype, 'mutate').mockImplementationOnce(async function (this: PlatformInstitutionsRepository, ...args: Parameters<typeof original>) {
      await original.apply(this, args);
      throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'Synthetic response lost after commit.');
    });
    expect((await mutate(base, input, key)).status).toBe(503);
    const retry = await mutate(base, input, key);
    expect(retry.status).toBe(201);
    expect((await get().query({ search: input.name })).body.meta.total).toBe(1);
    expect((await get(`${base}/${retry.body.id}/audit`)).body.data).toHaveLength(1);
  });

  it('edits metadata with version control and preserves slug', async () => {
    const item = await institution();
    const response = await mutate(`${base}/${item.id}`, { name: 'Updated', expectedVersion: item.version }, randomUUID(), 'patch');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'Updated', slug: item.slug, version: 2 });
    expect((await mutate(`${base}/${item.id}`, { name: 'Stale', expectedVersion: item.version }, randomUUID(), 'patch')).status).toBe(409);
    expect((await mutate(`${base}/${item.id}`, { slug: 'replacement', expectedVersion: 2 }, randomUUID(), 'patch')).status).toBe(400);
  });

  it('returns not found and rejects malformed identifiers', async () => {
    expect((await get(`${base}/${randomUUID()}`)).status).toBe(404);
    expect((await get(`${base}/invalid`)).status).toBe(400);
  });

  it('preserves data and permits global management while suspended', async () => {
    const item = await institution();
    const suspended = await mutate(`${base}/${item.id}/suspend`, { expectedVersion: 1 });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ operationalStatus: 'suspended', version: 2 });
    expect((await get(`${base}/${item.id}`).set('x-tenant-slug', item.slug)).status).toBe(200);
    expect((await mutate(`${base}/${item.id}/reactivate`, { expectedVersion: 2 })).body).toMatchObject({ operationalStatus: 'active', version: 3 });
  });
});

describe('safe first administrator bootstrap', () => {
  it('links an existing confirmed Auth account once, with atomic audit and no credential mutation', async () => {
    const item = await institution(), key = randomUUID();
    const createAuth = jest.spyOn(db.auth.admin, 'createUser');
    const first = await mutate(`${base}/${item.id}/bootstrap-admin`, { name: 'Initial Administrator', email: target.email }, key);
    const replay = await mutate(`${base}/${item.id}/bootstrap-admin`, { name: 'Initial Administrator', email: target.email }, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ institutionId: item.id, administrator: { role: 'admin', active: true } });
    expect(replay.body).toEqual(first.body);
    expect(createAuth).not.toHaveBeenCalled();
    expect((await mutate(`${base}/${item.id}/bootstrap-admin`, { name: 'Another', email: target.email })).status).toBe(409);
    expect((await get(`${base}/${item.id}/audit`)).body.data.filter((e: { action: string }) => e.action === 'administrator_bootstrapped')).toHaveLength(1);
  });

  it('does not fabricate Auth identities and permits retry after a missing dependency is resolved', async () => {
    const item = await institution(), key = randomUUID(), email = `missing-${key}@example.invalid`;
    const input = { name: 'Pending Administrator', email };
    const failed = await mutate(`${base}/${item.id}/bootstrap-admin`, input, key);
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('BOOTSTRAP_AUTH_REQUIRED');
    expect((await db.from('app_users').select('id').eq('tenant_id', item.id)).data).toHaveLength(0);
    await db.auth.admin.createUser({ email, password: 'Synthetic123!', email_confirm: true });
    expect((await mutate(`${base}/${item.id}/bootstrap-admin`, input, key)).status).toBe(201);
  });

  it('does not override existing institutional management or accept arbitrary roles', async () => {
    expect((await mutate(`${base}/${tenantId}/bootstrap-admin`, { name: 'Replacement', email: target.email })).status).toBe(409);
    const item = await institution();
    expect((await mutate(`${base}/${item.id}/bootstrap-admin`, { name: 'Owner', email: target.email, role: 'owner' })).status).toBe(400);
    await mutate(`${base}/${item.id}/suspend`, { expectedVersion: 1 });
    expect((await mutate(`${base}/${item.id}/bootstrap-admin`, { name: 'Blocked', email: target.email })).status).toBe(403);
  });
});

describe('operational suspension enforcement', () => {
  it('preserves another institution membership for the same Auth identity', async () => {
    const item = await institution();
    await db.from('app_users').insert({ id: randomUUID(), tenant_id: item.id, auth_user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Synthetic Student', email: 'student-second@example.invalid', role: 'student', active: true });
    await db.from('tenants').update({ operational_status: 'suspended' }).eq('id', tenantId);
    expect((await get('/api/v1/auth/me', 'valid-student-token').set('x-tenant-slug', 'edukmais')).status).toBe(403);
    expect((await get('/api/v1/auth/me', 'valid-student-token').set('x-tenant-slug', item.slug)).status).toBe(200);
  });

  it.each(['x'.repeat(201), 'Synthetic\nLegacy\tName'])('preserves institutional creation text accepted by the existing contract', async name => {
    const response = await request(app).post('/api/v1/tenants/edukmais/users')
      .set('x-tenant-slug', 'edukmais').set('Authorization', 'Bearer valid-admin-token')
      .send({ name, email: `legacy-${randomUUID()}@example.invalid`, password: 'Synthetic123!', role: 'aluno' });
    expect(response.status).toBe(201);
    expect(response.body.name).toBe(name);
  });

  it.each(['/api/v1/auth/me', '/api/v1/auth/capabilities', '/api/v1/tenants/edukmais/academic/overview'])('blocks existing institutional sessions on %s', async path => {
    await db.from('tenants').update({ operational_status: 'suspended' }).eq('id', tenantId);
    const result = await get(path, 'valid-student-token').set('x-tenant-slug', 'edukmais');
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('TENANT_SUSPENDED');
    expect(result.body.error.requestId).toBe(result.headers['x-request-id']);
    expect((await get('/api/v1/auth/platform/me').set('x-tenant-slug', 'edukmais')).status).toBe(200);
  });

  it('blocks institutional login while preserving platform login', async () => {
    await db.from('tenants').update({ operational_status: 'suspended' }).eq('id', tenantId);
    expect((await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email: 'aluno@edukmais.edu.br', password: 'password123' })).status).toBe(403);
  });

  it('blocks public invitation resolution and registration without a tenant header before creating Auth', async () => {
    const code = `P02-${randomUUID()}`.toUpperCase();
    await db.from('invites').insert({ code, tenant_id: tenantId, role: 'student', created_by: 'cccccccc-cccc-cccc-cccc-cccccccccccc', recipient_email: 'blocked@example.invalid', used_at: null, expires_at: new Date(Date.now() + 3600000).toISOString() });
    await db.from('tenants').update({ operational_status: 'suspended' }).eq('id', tenantId);
    const create = jest.spyOn(db.auth.admin, 'createUser');
    expect((await request(app).get(`/api/v1/invites/${code}`)).status).toBe(403);
    expect((await request(app).post(`/api/v1/invites/${code}/register`).send({ name: 'Blocked', email: 'blocked@example.invalid', password: 'Synthetic123!' })).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
