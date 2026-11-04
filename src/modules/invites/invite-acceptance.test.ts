import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient, createSupabaseAnonClient } from '../../config/supabase';
import { InvitesRepository } from './invites.repository';
import { HttpError } from '../../shared/http-error';

const db = createSupabaseAdminClient();
const base = '/api/v1';
const password = 'Synthetic123!';
async function invite(email: string) {
  const response = await request(app).post(`${base}/tenants/edukmais/invites`).set('x-tenant-slug', 'edukmais')
    .set('authorization', 'Bearer valid-coordinator-token').send({ role: 'aluno', recipientEmail: email });
  expect(response.status).toBe(201); return response.body.code as string;
}
describe('targeted one-time invitations', () => {
  it('registers first access from a targeted secret without exposing credentials', async () => {
    const code = await invite('first-access@example.invalid');
    expect(code.length).toBeGreaterThan(40);
    const response = await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic First Access', email: 'first-access@example.invalid', password });
    expect(response.status).toBe(201); expect(response.body.role).toBe('aluno');
    expect(JSON.stringify(response.body)).not.toContain(password);
    const login = await request(app).post(`${base}/auth/login`).set('x-tenant-slug', 'edukmais').send({ email: 'first-access@example.invalid', password });
    expect(login.status).toBe(200);
    expect((await request(app).post(`${base}/invites/${code}/accept`).set('authorization', `Bearer ${login.body.accessToken}`).send({ name: 'Synthetic' })).status).toBe(404);
  });
  it('rejects wrong recipients without consuming the invitation', async () => {
    const code = await invite('intended@example.invalid');
    expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Wrong', email: 'wrong@example.invalid', password })).status).toBe(403);
    expect((await request(app).get(`${base}/invites/${code}`)).status).toBe(200);
  });
  it('requires an existing account to authenticate, never replacing its password', async () => {
    const code = await invite('aluno@edukmais.edu.br');
    expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Existing', email: 'aluno@edukmais.edu.br', password })).status).toBe(409);
    const login = await request(app).post(`${base}/auth/login`).set('x-tenant-slug', 'edukmais').send({ email: 'aluno@edukmais.edu.br', password: 'password123' });
    expect(login.status).toBe(200);
    expect((await request(app).post(`${base}/invites/${code}/accept`).set('authorization', 'Bearer valid-student-token').send({ name: 'Existing' })).status).toBe(409);
  });
  it('rejects expired and undirected legacy invitations for acceptance', async () => {
    for (const code of ['EDU-OLD01', 'EDU-VALID1']) expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic', email: 'first-access@example.invalid', password })).status).toBeGreaterThanOrEqual(400);
  });
  it('revalidates issuer privileges after invitation issuance', async () => {
    const code = await invite('issuer-changed@example.invalid');
    await db.from('app_users').update({ role: 'student' }).eq('id', 'user-coordinator');
    try {
      expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic', email: 'issuer-changed@example.invalid', password })).status).toBe(403);
    } finally { await db.from('app_users').update({ role: 'coordinator' }).eq('id', 'user-coordinator'); }
  });
  it('does not grant a client-selected institutional role during acceptance', async () => {
    const code = await invite('no-promotion@example.invalid');
    expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic', email: 'no-promotion@example.invalid', password, role: 'admin' })).status).toBe(400);
  });
  it('requires authentication for existing-account acceptance', async () => {
    const code = await invite('aluno@edukmais.edu.br');
    expect((await request(app).post(`${base}/invites/${code}/accept`).send({ name: 'Synthetic' })).status).toBe(401);
    expect((await request(app).post(`${base}/invites/${code}/accept`).set('authorization', 'Bearer invalid').send({ name: 'Synthetic' })).status).toBe(401);
  });
  it('requires a confirmed Auth email', async () => {
    const code = await invite('aluno@edukmais.edu.br');
    const auth = createSupabaseAnonClient().auth;
    const spy = jest.spyOn(auth, 'getUser').mockResolvedValueOnce({ data: { user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'aluno@edukmais.edu.br', email_confirmed_at: '' } }, error: null } as unknown as Awaited<ReturnType<typeof auth.getUser>>);
    try { expect((await request(app).post(`${base}/invites/${code}/accept`).set('authorization', 'Bearer valid-student-token').send({ name: 'Synthetic' })).status).toBe(403); }
    finally { spy.mockRestore(); }
  });
  it('adds a confirmed existing Auth account to another institution without changing its password', async () => {
    const tenantId = '45454545-4545-4545-8545-454545454545';
    await db.from('tenants').insert({ id: tenantId, slug: 'invite-other', name: 'Synthetic Other', plan: 'starter', status: 'active', active_users: 1 });
    await db.from('app_users').insert({ tenant_id: tenantId, auth_user_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Synthetic Issuer', email: 'coordenador@edukmais.edu.br', role: 'coordinator', active: true });
    const issued = await request(app).post(`${base}/tenants/invite-other/invites`).set('x-tenant-slug', 'invite-other')
      .set('authorization', 'Bearer valid-coordinator-token').send({ role: 'aluno', recipientEmail: 'aluno@edukmais.edu.br' });
    expect(issued.status).toBe(201);
    const code = issued.body.code;
    expect((await request(app).post(`${base}/invites/${code}/accept`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token').send({ name: 'Synthetic' })).status).toBe(404);
    const accepted = await request(app).post(`${base}/invites/${code}/accept`).set('authorization', 'Bearer valid-student-token').send({ name: 'Synthetic' });
    expect(accepted.status).toBe(201); expect(accepted.body.tenantSlug).toBe('invite-other');
    expect((await request(app).post(`${base}/auth/login`).set('x-tenant-slug', 'invite-other').send({ email: 'aluno@edukmais.edu.br', password: 'password123' })).status).toBe(200);
  });
  it('does not consume a code when its issuer is inactive', async () => {
    const code = await invite('inactive-issuer@example.invalid');
    await db.from('app_users').update({ active: false }).eq('id', 'user-coordinator');
    try {
      expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic', email: 'inactive-issuer@example.invalid', password })).status).toBe(403);
      expect((await request(app).get(`${base}/invites/${code}`)).status).toBe(200);
    } finally { await db.from('app_users').update({ active: true }).eq('id', 'user-coordinator'); }
  });
  it('allows only one successful acceptance when the code is reused concurrently', async () => {
    const email = 'concurrent@example.invalid', code = await invite(email);
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const session = await createSupabaseAnonClient().auth.signInWithPassword({ email, password });
    const responses = await Promise.all([1, 2].map(() => request(app).post(`${base}/invites/${code}/accept`).set('authorization', `Bearer ${session.data.session?.access_token}`).send({ name: 'Synthetic Concurrent' })));
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    expect(responses.filter(response => response.status === 404)).toHaveLength(1);
  });
  it('recovers Auth creation followed by RPC failure through authenticated invite login', async () => {
    const email = 'recover-first-access@example.invalid', code = await invite(email);
    const spy = jest.spyOn(InvitesRepository.prototype, 'accept').mockRejectedValueOnce(new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'Synthetic outage'));
    try { expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic Recovery', email, password })).status).toBe(503); }
    finally { spy.mockRestore(); }
    expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic Recovery', email, password })).status).toBe(409);
    expect((await request(app).post(`${base}/invites/${code}/login`).send({ name: 'Synthetic Recovery', email, password: 'WrongPassword!' })).status).toBe(401);
    const recovery = await request(app).post(`${base}/invites/${code}/login`).send({ name: 'Synthetic Recovery', email, password });
    expect(recovery.status).toBe(201); expect(recovery.body.accessToken).toBeTruthy(); expect(recovery.body.user.role).toBe('aluno');
    expect((await request(app).get(`${base}/tenants/edukmais/courses`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer ${recovery.body.accessToken}`)).status).toBe(200);
  });
  it('accepts existing six-character passwords without weakening new-account password validation', async () => {
    const email = 'legacy-password@example.invalid', code = await invite(email);
    await db.auth.admin.createUser({ email, password: 'Synt01', email_confirm: true });
    expect((await request(app).post(`${base}/invites/${code}/register`).send({ name: 'Synthetic Legacy', email, password: 'Synt01' })).status).toBe(400);
    expect((await request(app).post(`${base}/invites/${code}/login`).send({ name: 'Synthetic Legacy', email, password: 'Synt01' })).status).toBe(201);
  });
});
