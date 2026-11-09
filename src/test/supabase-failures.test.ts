import * as supabase from '../config/supabase';
import { TenantRepository } from '../modules/tenants/tenant.repository';
import { AuthRepository } from '../modules/auth/auth.repository';
import { AuthService } from '../modules/auth/auth.service';
import { UsersRepository } from '../modules/users/users.repository';
import { UsersService } from '../modules/users/users.service';
import { CoursesRepository } from '../modules/courses/courses.repository';
import { ClassesRepository } from '../modules/classes/classes.repository';
import { ActivitiesRepository } from '../modules/activities/activities.repository';
import { InvitesRepository } from '../modules/invites/invites.repository';
import { ReportsRepository } from '../modules/reports/reports.repository';
import { GradesRepository } from '../modules/grades/grades.repository';
import { AppUser } from '../shared/types';
import request from 'supertest';
import { app } from '../app';
import { createClient } from '@supabase/supabase-js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const actor: AppUser = { id: 'user-coordinator', authUserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', tenantId, name: 'Synthetic', email: 'x@example.invalid', role: 'coordinator' };
const pagination = { page: 1, limit: 20, offset: 0 };
type Result = { data: unknown; error: unknown; count?: number | null };
interface RetryableSelection {
  retry(enabled: boolean): RetryableSelection;
}
type RetryableSelect = {
  select(columns?: string, options?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' }): RetryableSelection;
};

function database(result: Result) {
  const query = {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(), gt: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(), delete: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result), maybeSingle: jest.fn().mockResolvedValue(result),
    range: jest.fn().mockResolvedValue(result), then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
  };
  const original = supabase.createSupabaseAdminClient();
  jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ ...original, from: () => query, rpc: async () => result } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
  return query;
}

afterEach(() => jest.restoreAllMocks());

const lookups: Array<[string, () => Promise<unknown>, string]> = [
  ['tenant', () => new TenantRepository().findBySlug('synthetic'), 'TENANT_NOT_FOUND'],
  ['user', () => new UsersRepository().findById({ tenantId, id: 'synthetic' }), 'USER_NOT_FOUND'],
  ['course', () => new CoursesRepository().findById({ tenantId, id: 'synthetic' }), 'COURSE_NOT_FOUND'],
  ['class', () => new ClassesRepository().findById({ tenantId, id: 'synthetic' }), 'CLASS_NOT_FOUND'],
  ['activity', () => new ActivitiesRepository().findById({ tenantId, id: 'synthetic' }), 'ACTIVITY_NOT_FOUND'],
  ['invite', () => new InvitesRepository().findActiveByCode('SYNTHETIC'), 'INVITE_NOT_FOUND'],
];

describe('missing rows versus failed queries', () => {
  it.each([502, 503, 504])('handles a real SDK non-JSON HTTP %s response as unavailable', async (status) => {
    const fetch = jest.fn().mockImplementation(async () => new Response('private proxy details', { status }));
    const client = createClient('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    });
    const from = client.from.bind(client);
    jest.spyOn(client, 'from').mockImplementation((table: string) => {
      const query = from(table);
      const retryableQuery = query as unknown as RetryableSelect;
      const select = retryableQuery.select.bind(retryableQuery);
      jest.spyOn(retryableQuery, 'select').mockImplementation((columns, options) => select(columns, options).retry(false));
      return query;
    });
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue(client);
    await expect(new CoursesRepository().findById({ tenantId, id: 'synthetic' })).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(lookups)('preserves legitimate absence for %s', async (_label, run, code) => {
    database({ data: null, error: null });
    await expect(run()).rejects.toMatchObject({ statusCode: 404, code });
  });
  it.each(lookups)('does not disguise a failed %s query as absence', async (_label, run) => {
    database({ data: null, error: { code: '42P01', message: 'private SQL table' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 500 });
  });
  it.each(lookups)('reports upstream unavailability for %s', async (_label, run) => {
    database({ data: null, error: { code: 'PGRST002', message: 'private connection details' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 503 });
  });
  it.each(['PGRST116', '42501'])('does not treat multiple rows or permission errors (%s) as no rows', async (code) => {
    database({ data: null, error: { code, message: 'private details' } });
    await expect(new CoursesRepository().findById({ tenantId, id: 'synthetic' })).rejects.toMatchObject({ statusCode: 500 });
  });
  it.each([
    ['tenant binding', () => new AuthRepository().findUserByAuthId({ tenantId, authUserId: 'synthetic' })],
    ['email binding', () => new AuthRepository().findUserByEmail({ tenantId, email: 'x@example.invalid' })],
    ['global binding', () => new AuthRepository().findAnyUserByAuthId('synthetic')],
  ] as const)('does not turn failed %s queries into forbidden', async (_label, run) => {
    database({ data: null, error: { code: '08006', message: 'private details' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('collections, counts and mutations', () => {
  it.each([
    ['course creation', () => new CoursesRepository().create({ tenantId, name: 'Synthetic' })],
    ['class creation', () => new ClassesRepository().create({ tenantId, courseId: 'course', name: 'Synthetic' })],
    ['activity creation', () => new ActivitiesRepository().create({ tenantId, classId: 'class', title: 'Synthetic', type: 'assignment', createdBy: actor.authUserId })],
    ['invite creation', () => new InvitesRepository().create({ tenantId, code: 'SYNTHETIC', role: 'student', expiresAt: '2030-01-01T00:00:00Z', createdBy: actor.authUserId, recipientEmail: 'synthetic@example.invalid' })],
    ['course deletion', () => new CoursesRepository().delete({ tenantId, id: 'synthetic' })],
  ] as const)('reports a database conflict on %s', async (_label, run) => {
    database({ data: null, error: { code: '23503', message: 'private FK details' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each([
    ['courses', () => new CoursesRepository().list({ tenantId, pagination })],
    ['classes', () => new ClassesRepository().listByCourse({ tenantId, courseId: 'course', pagination })],
    ['users', () => new UsersRepository().list({ tenantId, pagination })],
    ['activities', () => new ActivitiesRepository().listByClass({ tenantId, classId: 'class', pagination })],
    ['grades', () => new GradesRepository().listByActivity({ tenantId, activityId: 'activity' })],
    ['engagement', () => new ReportsRepository().engagement({ tenantId })],
  ] as const)('does not turn null %s into an empty successful collection', async (_label, run) => {
    database({ data: null, error: null, count: null });
    await expect(run()).rejects.toMatchObject({ statusCode: 502 });
  });
  it('preserves an explicitly empty collection and zero count', async () => {
    database({ data: [], error: null, count: 0 });
    await expect(new CoursesRepository().list({ tenantId, pagination })).resolves.toMatchObject({ courses: [], total: 0 });
    await expect(new ReportsRepository().global()).resolves.toMatchObject({ totalTenants: 0 });
  });
  it('does not turn a missing count into zero', async () => {
    database({ data: [], error: null, count: null });
    await expect(new ReportsRepository().global()).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    ['course', () => new CoursesRepository().update({ tenantId, id: 'id', name: 'Synthetic' })],
    ['class', () => new ClassesRepository().update({ tenantId, id: 'id', name: 'Synthetic' })],
    ['activity', () => new ActivitiesRepository().update({ tenantId, id: 'id', title: 'Synthetic' })],
    ['role', () => new UsersRepository().updateRole({ tenantId, id: 'id', role: 'student', expectedRole: 'teacher', actorAuthId: actor.authUserId })],
    ['delete', () => new CoursesRepository().delete({ tenantId, id: 'id' })],
  ] as const)('does not disguise failed %s mutations as missing or success', async (_label, run) => {
    database({ data: null, error: { code: '08006', message: 'private connection' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('authentication and administrative account failures', () => {
  it('returns a correlated service error through the protected HTTP boundary during an Auth outage', async () => {
    const client = supabase.createSupabaseAnonClient();
    jest.spyOn(client.auth, 'getUser').mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'private details' } } as never);
    const response = await request(app).get('/api/v1/tenants/edukmais/courses')
      .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-student-token');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', requestId: response.headers['x-request-id'] });
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it('returns a failure through HTTP when logout revocation fails', async () => {
    const client = supabase.createSupabaseAdminClient();
    jest.spyOn(client.auth.admin, 'signOut').mockResolvedValue({ error: { status: 503, message: 'private details' } } as never);
    const response = await request(app).post('/api/v1/auth/logout').set('authorization', 'Bearer valid-student-token');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });
  it('reuses an existing Auth account only on a known duplicate error', async () => {
    const client = supabase.createSupabaseAdminClient();
    const list = jest.spyOn(client.auth.admin, 'listUsers');
    const secondTenantId = '77777777-7777-7777-7777-777777777777';
    await client.from('tenants').insert({ id: secondTenantId, name: 'Synthetic second', slug: 'synthetic-second' });
    await client.from('app_users').insert({ id: 'second-manager', tenant_id: secondTenantId, auth_user_id: actor.authUserId, role: 'coordinator', active: true, name: 'Synthetic', email: actor.email });
    const result = await new UsersService().create({ currentUser: { ...actor, id: 'second-manager', tenantId: secondTenantId }, tenantId: secondTenantId, tenantSlug: 'synthetic', name: 'Synthetic', email: 'aluno@edukmais.edu.br', password: 'Synthetic123!', role: 'aluno' });
    expect(result.role).toBe('aluno');
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('does not turn authentication outages into invalid credentials', async () => {
    const client = supabase.createSupabaseAnonClient();
    jest.spyOn(client.auth, 'signInWithPassword').mockResolvedValue({ data: { user: null, session: null }, error: { status: 503, message: 'private details' } } as never);
    await expect(new AuthService().login({ tenantId, tenantSlug: 'edukmais', email: 'x@example.invalid', password: 'private-password' })).rejects.toMatchObject({ statusCode: 503 });
  });
  it('does not turn token verification outages into invalid sessions', async () => {
    const client = supabase.createSupabaseAnonClient();
    jest.spyOn(client.auth, 'getUser').mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'private details' } } as never);
    await expect(new AuthService().findUserByAccessToken({ tenantId, tenantSlug: 'edukmais', accessToken: 'private-token' })).rejects.toMatchObject({ statusCode: 503 });
  });
  it('does not swallow failed logout revocation', async () => {
    const client = supabase.createSupabaseAdminClient();
    jest.spyOn(client.auth.admin, 'signOut').mockResolvedValue({ error: { status: 503, message: 'private details' } } as never);
    await expect(new AuthService().logout('private-token')).rejects.toMatchObject({ statusCode: 503 });
  });
  it('never reuses an existing account after an unrelated create failure', async () => {
    const client = supabase.createSupabaseAdminClient();
    jest.spyOn(client.auth.admin, 'createUser').mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'private details' } } as never);
    const list = jest.spyOn(client.auth.admin, 'listUsers');
    await expect(new UsersService().create({ currentUser: actor, tenantId, tenantSlug: 'edukmais', name: 'Synthetic', email: 'aluno@edukmais.edu.br', password: 'Synthetic123!', role: 'aluno' })).rejects.toMatchObject({ statusCode: 503 });
    expect(list).not.toHaveBeenCalled();
  });
});
