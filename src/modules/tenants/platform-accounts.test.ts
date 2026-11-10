import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../app';
import { env } from '../../config/env';
import { PlatformAccountsRepository } from './platform-accounts.repository';

const base = '/api/v1/platform/institutions/11111111-1111-1111-1111-111111111111';
const original = [...env.PLATFORM_ADMIN_AUTH_USER_IDS];
const headers = { Authorization: 'Bearer valid-admin-token' };
function post(path: string, body: object, key = randomUUID()) { return request(app).post(base + path).set(headers).set('Idempotency-Key', key).send(body); }

beforeEach(() => { env.PLATFORM_ADMIN_AUTH_USER_IDS = ['dddddddd-dddd-dddd-dddd-dddddddddddd']; env.AUTH_INVITE_REDIRECT_URL = 'http://127.0.0.1:3000/auth/activate'; });
afterEach(() => { jest.restoreAllMocks(); env.PLATFORM_ADMIN_AUTH_USER_IDS = [...original]; });

describe('administrative account preparation and responsibility', () => {
  it('requires global Auth authority, never institutional roles or client assertions', async () => {
    expect((await request(app).get(base + '/admin-provisioning')).status).toBe(401);
    expect((await request(app).post(base + '/admin-provisioning').set('Authorization', 'Bearer valid-teacher-token').set('x-role', 'platform_superadmin').send({ name: 'Synthetic', email: 'synthetic@example.invalid' })).status).toBe(403);
  });

  it('does not send an invitation if redirect configuration is absent', async () => {
    env.AUTH_INVITE_REDIRECT_URL = undefined;
    const response = await post('/admin-provisioning', { name: 'Synthetic', email: `missing-${randomUUID()}@example.invalid` });
    expect(response.status).toBe(503);
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['cache-control']).toBe('no-store, private');
  });

  it('rejects role, password, client redirect and actor input before provisioning', async () => {
    const response = await post('/admin-provisioning', { name: 'Synthetic', email: 'synthetic@example.invalid', role: 'owner', password: 'NotAllowed123!', redirectTo: 'https://evil.invalid', actorAuthId: randomUUID() });
    expect(response.status).toBe(400);
  });

  it('does not infer a responsible administrator for legacy institutions', async () => {
    jest.spyOn(PlatformAccountsRepository.prototype, 'call').mockResolvedValue(null);
    const response = await request(app).get(base + '/responsible').set(headers);
    expect(response.status).toBe(404);
  });

  it('preserves new endpoint pagination and UUID validation', async () => {
    expect((await request(app).get(base + '/admin-provisioning?page=1.5').set(headers)).status).toBe(400);
    expect((await request(app).get(base + '/admin-provisioning/invalid').set(headers)).status).toBe(400);
  });
});
