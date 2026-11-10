import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';

const tenantId = '11111111-1111-1111-1111-111111111111';
const otherTenant = '29292929-2929-4929-8929-292929292929';
const base = '/api/v1/tenants/edukmais';
const db = createSupabaseAdminClient();
function manage(method: 'post' | 'patch' | 'get', path: string, role = 'coordinator') {
  return request(app)[method](`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
let userId: string; let accessToken: string;
const email = 'management-student@example.invalid';
const password = 'Synthetic123!';
describe('institutional management lifecycle', () => {
  it('creates a student with validated course metadata using the existing login', async () => {
    const courseId = '28282828-2828-4828-8828-282828282828';
    await db.from('courses').insert({ id: courseId, tenant_id: tenantId, name: 'Synthetic course' });
    const response = await manage('post', '/users').send({ name: 'Synthetic Student', email, password, role: 'aluno', courseId });
    expect(response.status).toBe(201); userId = response.body.id;
    expect(response.body.active).toBe(true);
    expect(response.body.courseId).toBe(courseId);
    const login = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email, password });
    expect(login.status).toBe(200); accessToken = login.body.accessToken;
  });
  it('rejects an invalid institution course before creating Auth credentials', async () => {
    expect((await manage('post', '/users').send({ name: 'Invalid', email: 'invalid-course@example.invalid', password, role: 'aluno', courseId: otherTenant })).status).toBe(404);
  });
  it('deactivates only the institutional membership and blocks existing tokens', async () => {
    expect((await manage('patch', `/users/${userId}/status`).send({ active: false })).status).toBe(200);
    const response = await request(app).get(`${base}/courses`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('USER_INACTIVE');
    expect((await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email, password })).status).toBe(403);
    expect((await db.from('app_users').select('id').eq('id', userId).single()).data?.id).toBe(userId);
  });
  it('keeps another institution membership usable with the same Auth account', async () => {
    const { data } = await db.from('app_users').select('auth_user_id').eq('id', userId).single();
    await db.from('tenants').insert({ id: otherTenant, slug: 'synthetic-other', name: 'Synthetic Other', plan: 'starter', status: 'active', active_users: 1 });
    await db.from('app_users').insert({ tenant_id: otherTenant, auth_user_id: data?.auth_user_id, name: 'Synthetic Student', email, role: 'student', active: true });
    expect((await request(app).get('/api/v1/tenants/synthetic-other/courses').set('x-tenant-slug', 'synthetic-other').set('authorization', `Bearer ${accessToken}`)).status).toBe(200);
  });
  it('reactivates membership and preserves legitimate access', async () => {
    expect((await manage('patch', `/users/${userId}/status`).send({ active: true })).status).toBe(200);
    expect((await request(app).get(`${base}/courses`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer ${accessToken}`)).status).toBe(200);
  });
  it('does not allow self, peer, superior or foreign user status management', async () => {
    expect((await manage('patch', '/users/user-coordinator/status').send({ active: false })).status).toBe(403);
    expect((await manage('patch', '/users/user-admin/status').send({ active: false })).status).toBe(403);
    expect((await manage('patch', `/users/${otherTenant}/status`).send({ active: false })).status).toBe(404);
    expect((await manage('patch', `/users/${userId}/status`, 'teacher').send({ active: false })).status).toBe(403);
  });
  it('updates institutional metadata without changing existing academic records', async () => {
    const response = await manage('patch', `/users/${userId}/profile`).send({ name: 'Updated Synthetic', registration: 'SYN-001', semester: 2 });
    expect(response.status).toBe(200); expect(response.body.registration).toBe('SYN-001');
    expect((await db.from('grades').select('id').eq('id', 'grade-existing').single()).data?.id).toBe('grade-existing');
  });
  it('rejects unauthorized and cross-institution registrations', async () => {
    const input = { name: 'Synthetic Forbidden', email: 'forbidden@example.invalid', password, role: 'aluno' };
    expect((await manage('post', '/users', 'student').send(input)).status).toBe(403);
    expect((await request(app).post('/api/v1/tenants/synthetic-other/users').set('x-tenant-slug', 'synthetic-other').set('authorization', 'Bearer valid-coordinator-token').send(input)).status).toBe(403);
    expect((await request(app).post('/api/v1/tenants/synthetic-other/users').set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-coordinator-token').send(input)).status).toBe(404);
  });
  it('rejects duplicate institutional membership without replacing credentials', async () => {
    expect((await manage('post', '/users').send({ name: 'Duplicate', email, password: 'OtherSyntheticPassword!', role: 'aluno' })).status).toBe(409);
    expect((await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email, password })).status).toBe(200);
  });
  it('does not let inactive teachers receive new class assignments', async () => {
    await db.from('app_users').update({ active: false }).eq('id', 'user-teacher');
    try {
      const response = await manage('post', '/courses/course-existing/classes').send({ name: 'Synthetic', teacherId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
      expect(response.status).toBe(409);
    } finally { await db.from('app_users').update({ active: true }).eq('id', 'user-teacher'); }
  });
});
