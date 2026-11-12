import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient, createSupabaseAnonClient } from '../../config/supabase';
import { SessionService } from './session.service';
import { AuthOperationClientFactory } from './session.client';

const db = createSupabaseAdminClient();
const originalRefresh = SessionService.prototype.refreshInstitution;

const refreshClient: AuthOperationClientFactory = () => {
  const auth = createSupabaseAnonClient().auth;
  const unexpected = async () => { throw new Error('Unexpected Auth operation in academic profile test'); };
  return { auth: {
    getUser: auth.getUser.bind(auth),
    resetPasswordForEmail: unexpected,
    verifyOtp: unexpected,
    updateUser: unexpected,
    signOut: unexpected,
    async refreshSession(currentSession) {
      if (!currentSession) throw new Error('Synthetic refresh proof required');
      const token = currentSession.refresh_token.replace(/^refresh-/, '');
      const { data, error } = await auth.getUser(token);
      if (error || !data.user) throw new Error('Synthetic Auth identity missing');
      return { data: { user: data.user, session: {
        access_token: token, refresh_token: `rotated-${token}`,
        expires_at: 2000000000, expires_in: 3600, token_type: 'bearer', user: data.user,
      } }, error: null };
    },
  } };
};

beforeEach(async () => {
  await db.from('app_users').update({ registration: 'SYN-2026-001', semester: 4 }).eq('id', 'user-student');
  await db.from('app_users').update({ registration: null, semester: null }).eq('id', 'user-teacher');
  await db.from('app_users').update({ registration: null, semester: null }).eq('id', 'user-coordinator');
  jest.spyOn(SessionService.prototype, 'refreshInstitution').mockImplementation(function (params) {
    return originalRefresh.call(new SessionService(refreshClient), params);
  });
});

afterEach(() => jest.restoreAllMocks());

async function lifecycle(role: 'student' | 'teacher' | 'coordinator') {
  const administrative = role === 'coordinator';
  const base = `/api/v1/auth${administrative ? '/admin' : ''}`;
  const email = { student: 'aluno', teacher: 'professor', coordinator: 'coordenador' }[role];
  const login = await request(app).post(`${base}/login`).set('x-tenant-slug', 'edukmais')
    .send({ email: `${email}@edukmais.edu.br`, password: 'password123' });
  expect(login.status).toBe(200);
  const restored = await request(app).get(`${base}/me`).set('x-tenant-slug', 'edukmais')
    .set('authorization', `Bearer ${login.body.accessToken}`);
  expect(restored.status).toBe(200);
  const refreshed = await request(app).post(`${base}/refresh`).set('x-tenant-slug', 'edukmais')
    .send({ refreshToken: login.body.refreshToken });
  expect(refreshed.status).toBe(200);
  const { tenant, ...restoredUser } = restored.body;
  expect(tenant.slug).toBe('edukmais');
  expect(restoredUser).toEqual(login.body.user);
  expect(refreshed.body.user).toEqual(login.body.user);
  expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
  expect(Object.keys(login.body).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken', 'tenant', 'user']);
  for (const user of [login.body.user, restoredUser, refreshed.body.user]) {
    expect(user).not.toHaveProperty('authUserId');
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('courseId');
  }
  return { login, restored, refreshed };
}

describe('academic fields in institutional Auth responses', () => {
  it('preserves the student profile through login, session restoration and refresh', async () => {
    const { login } = await lifecycle('student');
    expect(login.body.user).toMatchObject({
      role: 'aluno', course: 'Curso Existente', registration: 'SYN-2026-001', semester: 4,
    });
  });

  it.each(['teacher', 'coordinator'] as const)('does not invent student fields for %s in any Auth response', async (role) => {
    const { login } = await lifecycle(role);
    expect(login.body.user).not.toHaveProperty('registration');
    expect(login.body.user).not.toHaveProperty('semester');
    expect(login.body.user.role).toBe(role === 'teacher' ? 'professor' : 'gestor');
  });

  it('keeps absent student fields optional without fallback values', async () => {
    await db.from('app_users').update({ registration: null, semester: null }).eq('id', 'user-student');
    const { login } = await lifecycle('student');
    expect(login.body.user).not.toHaveProperty('registration');
    expect(login.body.user).not.toHaveProperty('semester');
  });

  it('restores and refreshes current academic data rather than a stale login snapshot', async () => {
    const login = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais')
      .send({ email: 'aluno@edukmais.edu.br', password: 'password123' });
    expect(login.status).toBe(200);
    await db.from('app_users').update({ registration: 'SYN-UPDATED', semester: 5 }).eq('id', 'user-student');
    const restored = await request(app).get('/api/v1/auth/me').set('x-tenant-slug', 'edukmais')
      .set('authorization', `Bearer ${login.body.accessToken}`);
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('x-tenant-slug', 'edukmais')
      .send({ refreshToken: login.body.refreshToken });
    expect(restored.status).toBe(200);
    expect(refreshed.status).toBe(200);
    expect(restored.body).toMatchObject({ registration: 'SYN-UPDATED', semester: 5 });
    expect(refreshed.body.user).toMatchObject({ registration: 'SYN-UPDATED', semester: 5 });
  });
});
