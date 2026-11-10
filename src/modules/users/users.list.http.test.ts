import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';

const db = createSupabaseAdminClient();
const tenantId = '11111111-1111-1111-1111-111111111111';
const foreignTenantId = '22222222-2222-2222-2222-222222222222';
const path = '/api/v1/tenants/edukmais/users';
const list = (query = 'role=aluno', role = 'coordinator') => request(app).get(`${path}?${query}`)
  .set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);

beforeAll(async () => {
  await db.from('tenants').insert({ id: foreignTenantId, slug: 'synthetic-list-other', name: 'Synthetic Other', operational_status: 'active' });
  await db.from('app_users').insert([
    { id: 'list-bruna', tenant_id: tenantId, auth_user_id: '12121212-1212-4212-8212-121212121212', name: 'Bruna Synthetic', email: 'bruna@example.invalid', role: 'student', active: true },
    { id: 'list-carla', tenant_id: tenantId, auth_user_id: '13131313-1313-4313-8313-131313131313', name: 'Carla Synthetic', email: 'carla@example.invalid', role: 'student', active: false },
    { id: 'list-foreign', tenant_id: foreignTenantId, auth_user_id: '14141414-1414-4414-8414-141414141414', name: 'Foreign Synthetic', email: 'foreign@example.invalid', role: 'student', active: true },
  ]);
});

beforeEach(async () => {
  await db.from('app_users').update({ role: 'admin', active: true }).eq('id', 'user-admin');
  await db.from('app_users').update({ active: true }).eq('id', 'user-coordinator');
});

describe('administrative student listing', () => {
  it.each(['coordinator', 'admin', 'owner'])('allows %s and returns only tenant students with the panel contract', async (role) => {
    if (role === 'owner') await db.from('app_users').update({ role }).eq('id', 'user-admin');
    const response = await list('role=aluno', role === 'owner' ? 'admin' : role);
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    expect(response.body.data.map((user: { id: string }) => user.id)).toEqual(['user-student', 'list-bruna', 'list-carla']);
    for (const user of response.body.data) {
      expect(user).toMatchObject({ role: 'aluno', tenantSlug: 'edukmais', id: expect.any(String), name: expect.any(String), email: expect.any(String), active: expect.any(Boolean) });
      expect(user).not.toHaveProperty('auth_user_id');
      expect(user).not.toHaveProperty('authUserId');
      expect(user).not.toHaveProperty('password');
    }
    expect(response.headers['cache-control']).toBe('no-store, private');
  });

  it.each(['teacher', 'student'])('denies the institutional directory to %s', async (role) => {
    expect((await list('role=aluno', role)).status).toBe(403);
  });

  it('paginates without repeating rows and keeps the filtered total', async () => {
    const pages = await Promise.all([1, 2, 3].map(page => list(`role=aluno&page=${page}&limit=1`)));
    expect(pages.map(page => page.status)).toEqual([200, 200, 200]);
    expect(pages.map(page => page.body.meta.total)).toEqual([3, 3, 3]);
    expect(new Set(pages.flatMap(page => page.body.data.map((user: { id: string }) => user.id))).size).toBe(3);
    const empty = await list('role=aluno&page=4&limit=1');
    expect(empty.body).toEqual({ data: [], meta: { page: 4, limit: 1, total: 3 } });
    expect((await list('role=aluno&limit=999')).body.meta.limit).toBe(100);
  });

  it.each(['role=student', 'role=aluno&page=0', 'role=aluno&limit=1.5'])('rejects invalid filters or pagination: %s', async (query) => {
    expect((await list(query)).status).toBe(400);
  });

  it('requires a valid Bearer and tenant context', async () => {
    expect((await request(app).get(path).set('x-tenant-slug', 'edukmais')).status).toBe(401);
    expect((await request(app).get(path).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer invalid-synthetic-token')).status).toBe(401);
    expect((await request(app).get(path).set('authorization', 'Bearer valid-coordinator-token')).status).toBe(400);
  });

  it('denies a mismatched slug and a foreign institution without membership', async () => {
    const foreignPath = '/api/v1/tenants/synthetic-list-other/users?role=aluno';
    expect((await request(app).get(foreignPath).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-coordinator-token')).status).toBe(404);
    expect((await request(app).get(foreignPath).set('x-tenant-slug', 'synthetic-list-other').set('authorization', 'Bearer valid-coordinator-token')).status).toBe(403);
  });

  it('rejects inactive institutional membership', async () => {
    await db.from('app_users').update({ active: false }).eq('id', 'user-coordinator');
    const response = await list();
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('USER_INACTIVE');
  });
});
