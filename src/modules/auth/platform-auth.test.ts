import request from 'supertest';
import { AuthApiError } from '@supabase/supabase-js';
import { app } from '../../app';
import { env } from '../../config/env';
import { createSupabaseAdminClient, createSupabaseAnonClient } from '../../config/supabase';
import { AuthRepository } from './auth.repository';
import { TenantRepository } from '../tenants/tenant.repository';
import { logger } from '../../observability/logger';

const platformPath = '/api/v1/auth/platform';
const reportPath = '/api/v1/admin/reports/global';
const capabilitiesPath = '/api/v1/auth/capabilities';
const tenantId = '11111111-1111-1111-1111-111111111111';
const existingAdminId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const credentials = { email: 'platform-only@example.invalid', password: 'Synthetic123!' };
const otherCredentials = { email: 'unlisted-platform@example.invalid', password: 'Synthetic123!' };
const originalAllowlist = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];
const db = createSupabaseAdminClient();
let platformId: string;
let platformToken: string;
let otherToken: string;

function get(path: string, token = platformToken, tenant?: string) {
  const req = request(app).get(path).set('Authorization', `Bearer ${token}`);
  return tenant ? req.set('x-tenant-slug', tenant) : req;
}

beforeAll(async () => {
  for (const input of [credentials, otherCredentials]) {
    const account = await db.auth.admin.createUser({ ...input, email_confirm: true });
    if (account.error || !account.data.user) throw new Error('Synthetic account setup failed');
    const session = await createSupabaseAnonClient().auth.signInWithPassword(input);
    if (session.error || !session.data.session) throw new Error('Synthetic session setup failed');
    if (input === credentials) {
      platformId = account.data.user.id;
      platformToken = session.data.session.access_token;
    } else otherToken = session.data.session.access_token;
  }
});

beforeEach(async () => {
  env.PLATFORM_ADMIN_AUTH_USER_IDS = [existingAdminId, platformId];
  await db.from('app_users').update({ role: 'admin', active: true }).eq('id', 'user-admin');
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { env.PLATFORM_ADMIN_AUTH_USER_IDS = originalAllowlist; });

describe('independent platform authorization', () => {
  it('allows an allowlisted Auth identity without any institutional membership to access the existing report', async () => {
    const membership = await db.from('app_users').select('id').eq('auth_user_id', platformId);
    expect(membership.data).toEqual([]);
    const anyMembership = jest.spyOn(AuthRepository.prototype, 'findAnyUserByAuthId');
    const tenantMembership = jest.spyOn(AuthRepository.prototype, 'findUserByAuthId');
    const result = await get(reportPath);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ totalTenants: 1, totalUsers: 4, activeTenants: 1 });
    expect(anyMembership).not.toHaveBeenCalled();
    expect(tenantMembership).not.toHaveBeenCalled();
  });

  it('logs in without tenant and returns only platform authorization and the existing session fields', async () => {
    const response = await request(app).post(`${platformPath}/login`).send(credentials);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'authorization', 'expiresAt', 'refreshToken']);
    expect(response.body.accessToken).toBe(platformToken);
    expect(Number.isFinite(Date.parse(response.body.expiresAt))).toBe(true);
    expect(response.body.authorization).toEqual({
      scope: 'platform', profile: 'platform_superadmin', authUserId: platformId,
      capabilities: ['platform.reports.read', 'platform.institutions.read', 'platform.institutions.manage', 'platform.institutions.bootstrap', 'platform.audit.read', 'platform.accounts.provision', 'platform.institutions.responsible.manage'],
    });
    expect(JSON.stringify(response.body)).not.toContain(credentials.password);
  });

  it('returns minimal platform context with no institutional capabilities, tenant or personal profile', async () => {
    const response = await get(`${platformPath}/me`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authorization: {
      scope: 'platform', profile: 'platform_superadmin', authUserId: platformId,
      capabilities: ['platform.reports.read', 'platform.institutions.read', 'platform.institutions.manage', 'platform.institutions.bootstrap', 'platform.audit.read', 'platform.accounts.provision', 'platform.institutions.responsible.manage'],
    } });
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers.etag).toBeUndefined();
  });

  it('logs in with an irrelevant invalid tenant header without consulting institutional repositories', async () => {
    const lookup = jest.spyOn(TenantRepository.prototype, 'findBySlug');
    const anyMembership = jest.spyOn(AuthRepository.prototype, 'findAnyUserByAuthId');
    const tenantMembership = jest.spyOn(AuthRepository.prototype, 'findUserByAuthId');
    const response = await request(app).post(`${platformPath}/login`)
      .set('x-tenant-slug', 'unknown-client-tenant').send(credentials);
    expect(response.status).toBe(200);
    expect(response.body.authorization.authUserId).toBe(platformId);
    expect(lookup).not.toHaveBeenCalled();
    expect(anyMembership).not.toHaveBeenCalled();
    expect(tenantMembership).not.toHaveBeenCalled();
  });

  it.each([`${platformPath}/me`, reportPath])('does not resolve client tenant headers for global resource %s', async path => {
    const lookup = jest.spyOn(TenantRepository.prototype, 'findBySlug');
    const log = jest.spyOn(logger, 'request');
    expect((await get(path, platformToken, 'unknown-client-tenant')).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: 200, tenantId: undefined }));
  });

  it('preserves global access for an identity that also has an institutional membership', async () => {
    const report = await get(reportPath, 'valid-admin-token');
    const context = await get(capabilitiesPath, 'valid-admin-token', 'edukmais');
    expect(report.status).toBe(200);
    expect(context.status).toBe(200);
    expect(context.body.authorization.profile).toBe('institution_admin');
    expect(context.body.authorization.capabilities).not.toContain('platform.reports.read');
  });

  it('does not use an inactive institutional membership to deny independent platform access', async () => {
    await db.from('app_users').update({ active: false }).eq('id', 'user-admin');
    expect((await get(reportPath, 'valid-admin-token')).status).toBe(200);
    const context = await get(capabilitiesPath, 'valid-admin-token', 'edukmais');
    expect(context.status).toBe(403);
    expect(context.body.error.code).toBe('USER_INACTIVE');
  });

  it.each(['student', 'teacher', 'coordinator', 'admin'])('denies global access for an unlisted institutional %s', async role => {
    env.PLATFORM_ADMIN_AUTH_USER_IDS = [platformId];
    const response = await get(reportPath, `valid-${role}-token`, 'edukmais');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('does not treat institutional owner as platform superadmin', async () => {
    env.PLATFORM_ADMIN_AUTH_USER_IDS = [platformId];
    await db.from('app_users').update({ role: 'owner' }).eq('id', 'user-admin');
    expect((await get(reportPath, 'valid-admin-token')).status).toBe(403);
  });

  it.each([`${platformPath}/me`, reportPath])('denies an authenticated but unlisted and unlinked UUID on %s', async path => {
    expect((await get(path, otherToken)).status).toBe(403);
  });

  it('does not return session credentials from platform login for an unlisted account', async () => {
    const response = await request(app).post(`${platformPath}/login`).send(otherCredentials);
    expect(response.status).toBe(403);
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
  });

  it('rechecks the server allowlist instead of trusting a previously returned capability', async () => {
    expect((await get(`${platformPath}/me`)).status).toBe(200);
    env.PLATFORM_ADMIN_AUTH_USER_IDS = [];
    expect((await get(reportPath)).status).toBe(403);
  });

  it.each([`${platformPath}/me`, reportPath])('requires a valid token on %s', async path => {
    expect((await request(app).get(path)).status).toBe(401);
    expect((await get(path, 'invalid-token')).status).toBe(401);
  });

  it('rejects fabricated token claims and client assertions of platform authority', async () => {
    const forgedToken = `header.${Buffer.from(JSON.stringify({ sub: platformId, role: 'service_role' })).toString('base64url')}.signature`;
    expect((await get(reportPath, forgedToken)).status).toBe(401);
    const response = await get(reportPath, otherToken)
      .set('x-user-id', platformId).set('x-role', 'platform_superadmin')
      .query({ authUserId: platformId, role: 'owner', capabilities: 'platform.reports.read' });
    expect(response.status).toBe(403);
  });

  it('does not trust administrator claims inside authenticated user metadata', async () => {
    const original = await createSupabaseAnonClient().auth.getUser(otherToken);
    if (!original.data.user) throw new Error('Synthetic identity missing');
    jest.spyOn(createSupabaseAnonClient().auth, 'getUser').mockResolvedValueOnce({
      error: null, data: { user: { ...original.data.user, user_metadata: { role: 'platform_superadmin' }, app_metadata: { role: 'owner' } } },
    });
    expect((await get(reportPath, otherToken)).status).toBe(403);
  });

  it('keeps authentication dependency failures unavailable and sanitized', async () => {
    jest.spyOn(createSupabaseAnonClient().auth, 'getUser').mockResolvedValueOnce({
      data: { user: null }, error: new AuthApiError('private synthetic database detail', 503, 'unexpected_failure'),
    });
    const response = await get(`${platformPath}/me`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private synthetic');
  });
});

describe('institutional capabilities and compatibility', () => {
  it.each([
    ['owner', ['student', 'teacher', 'coordinator', 'admin']],
    ['admin', ['student', 'teacher', 'coordinator']],
    ['coordinator', ['student', 'teacher']],
  ])('projects %s as institutional administration while preserving assignment hierarchy', async (role, assignableRoles) => {
    await db.from('app_users').update({ role }).eq('id', 'user-admin');
    const response = await get(capabilitiesPath, 'valid-admin-token', 'edukmais');
    expect(response.status).toBe(200);
    expect(response.body.authorization).toMatchObject({
      scope: 'institution', profile: 'institution_admin', userId: 'user-admin',
      institutionalRole: role, tenant: { id: tenantId, slug: 'edukmais' }, academicScope: 'institution', assignableRoles,
    });
    expect(response.body.authorization.capabilities).toContain('institution.users.manage');
    expect(response.body.authorization.capabilities).not.toContain('academic.activities.publish');
    expect(response.body.authorization.capabilities).not.toContain('academic.submissions.review');
    expect(response.body.authorization.capabilities).not.toContain('platform.reports.read');
  });

  it.each([
    ['teacher', 'assigned_classes', 'academic.activities.publish'],
    ['student', 'own_records', 'academic.submissions.submit'],
  ])('returns the actual %s profile and scoped capabilities', async (role, academicScope, capability) => {
    const response = await get(capabilitiesPath, `valid-${role}-token`, 'edukmais');
    expect(response.status).toBe(200);
    expect(response.body.authorization).toMatchObject({
      scope: 'institution', profile: role, institutionalRole: role, academicScope, assignableRoles: [],
    });
    expect(response.body.authorization.capabilities).toContain(capability);
    expect(response.body.authorization.capabilities).toContain('academic.grades.read');
    expect(response.body.authorization.capabilities).not.toContain('institution.users.manage');
    expect(response.body.authorization.capabilities).not.toContain('platform.reports.read');
  });

  it.each([capabilitiesPath, '/api/v1/auth/me', '/api/v1/tenants/edukmais/users'])('requires tenant context for institutional resource %s', async path => {
    const response = await get(path, 'valid-admin-token');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TENANT_REQUIRED');
  });

  it('rejects unknown and mismatched tenant contexts', async () => {
    expect((await get(capabilitiesPath, 'valid-student-token', 'unknown')).status).toBe(404);
    expect((await get('/api/v1/tenants/other/users', 'valid-admin-token', 'edukmais')).status).toBe(404);
  });

  it('does not grant institutional data or capabilities to an unlinked platform identity', async () => {
    for (const path of [capabilitiesPath, '/api/v1/auth/me', '/api/v1/tenants/edukmais/academic/overview', '/api/v1/tenants/edukmais/users']) {
      const response = await get(path, platformToken, 'edukmais');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('USER_NOT_LINKED_TO_TENANT');
    }
  });

  it('retains only teacher capabilities institutionally even when the teacher has global authority', async () => {
    env.PLATFORM_ADMIN_AUTH_USER_IDS.push('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect((await get(reportPath, 'valid-teacher-token')).status).toBe(200);
    const response = await get(capabilitiesPath, 'valid-teacher-token', 'edukmais');
    expect(response.body.authorization.profile).toBe('teacher');
    expect(response.body.authorization.capabilities).not.toContain('institution.users.manage');
    expect(response.body.authorization.capabilities).not.toContain('platform.reports.read');
    expect((await get('/api/v1/tenants/edukmais/users', 'valid-teacher-token', 'edukmais')).status).toBe(403);
  });

  it.each([capabilitiesPath, `${platformPath}/me`])('rejects client-supplied context selection on %s', async path => {
    const response = await get(path, path === capabilitiesPath ? 'valid-student-token' : platformToken, 'edukmais')
      .query({ role: 'owner', authUserId: platformId });
    expect(response.status).toBe(400);
  });

  it('ignores role headers when projecting institutional capabilities', async () => {
    const response = await get(capabilitiesPath, 'valid-student-token', 'edukmais').set('x-role', 'owner');
    expect(response.status).toBe(200);
    expect(response.body.authorization.profile).toBe('student');
    expect(response.body.authorization.assignableRoles).toEqual([]);
  });

  it('preserves the existing institutional login and me response shapes', async () => {
    const login = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais')
      .send({ email: 'aluno@edukmais.edu.br', password: 'password123' });
    expect(login.status).toBe(200);
    expect(Object.keys(login.body).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken', 'tenant', 'user']);
    const me = await get('/api/v1/auth/me', 'valid-student-token', 'edukmais');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ ...login.body.user, tenant: login.body.tenant });
  });

  it('preserves the institutional administrative login and role', async () => {
    const response = await request(app).post('/api/v1/auth/admin/login').set('x-tenant-slug', 'edukmais')
      .send({ email: 'admin@edukmais.edu.br', password: 'password123' });
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('admin');
    expect(response.body.authorization).toBeUndefined();
  });

  it('does not interpret a capability header as authorization for institutional mutation', async () => {
    const response = await request(app).post('/api/v1/tenants/edukmais/users')
      .set('x-tenant-slug', 'edukmais').set('Authorization', 'Bearer valid-student-token')
      .set('x-capabilities', 'institution.users.manage').send({
        name: 'Synthetic', email: 'forbidden@example.invalid', password: 'Synthetic123!', role: 'admin',
      });
    expect(response.status).toBe(403);
  });
});

describe('platform login boundary', () => {
  it('rejects extra authority fields before authentication', async () => {
    const response = await request(app).post(`${platformPath}/login`)
      .send({ ...credentials, role: 'platform_superadmin', authUserId: platformId });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects wrong passwords without returning session tokens', async () => {
    const response = await request(app).post(`${platformPath}/login`).send({ ...credentials, password: 'incorrect-password' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(response.body.accessToken).toBeUndefined();
  });

  it('handles malformed JSON with the existing safe error envelope', async () => {
    const response = await request(app).post(`${platformPath}/login`).set('Content-Type', 'application/json').send('{"password":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('rate limits the new credential endpoint', async () => {
    let status = 0;
    for (let i = 0; i < 31; i++) status = (await request(app).post(`${platformPath}/login`)
      .send({ ...credentials, password: 'incorrect-password' })).status;
    expect(status).toBe(429);
  });
});
