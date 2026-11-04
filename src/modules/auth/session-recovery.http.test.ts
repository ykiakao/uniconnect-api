import request from 'supertest';
import { app } from '../../app';
import { SessionService } from './session.service';
import { RecoveryService } from './recovery.service';
import { HttpError } from '../../shared/http-error';
import { logger } from '../../observability/logger';
import { TenantRepository } from '../tenants/tenant.repository';

afterEach(() => jest.restoreAllMocks());

describe('P0.3 public JSON boundaries', () => {
  it.each(['/auth/refresh', '/auth/admin/refresh'])('requires tenant context for %s', async path => {
    const response = await request(app).post(`/api/v1${path}`).send({ refreshToken: 'synthetic-refresh' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TENANT_REQUIRED');
  });
  it.each(['/auth/refresh', '/auth/admin/refresh', '/auth/platform/refresh'])('rejects client authority and query tokens on %s', async path => {
    for (const extra of [{ role: 'owner' }, { tenantId: 'arbitrary' }, { authUserId: 'arbitrary' }]) {
      const response = await request(app).post(`/api/v1${path}`).set('x-tenant-slug', 'edukmais')
        .send({ refreshToken: 'synthetic-refresh', ...extra });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const response = await request(app).post(`/api/v1${path}?refreshToken=synthetic-query-token`)
      .set('x-tenant-slug', 'edukmais').send({ refreshToken: 'synthetic-refresh' });
    expect(response.status).toBe(400);
  });
  it.each(['/auth/password/reset', '/auth/accounts/activate'])('rejects JWT and arbitrary proof types on %s without tenant context', async path => {
    const response = await request(app).post(`/api/v1${path}`).send({ accessToken: 'synthetic-jwt', newPassword: 'Synthetic123!', type: 'recovery' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });
  it('does not accept a client recovery redirect', async () => {
    const response = await request(app).post('/api/v1/auth/password/recovery')
      .send({ email: 'synthetic@example.invalid', redirectTo: 'https://attacker.invalid' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
  it.each(['/auth/refresh', '/auth/admin/refresh', '/auth/platform/refresh'])('rejects refresh proof in headers on %s', async path => {
    const response = await request(app).post(`/api/v1${path}`).set('x-tenant-slug', 'edukmais')
      .set('authorization', 'Bearer synthetic-refresh').send({ refreshToken: 'synthetic-refresh' });
    expect(response.status).toBe(400);
  });
  it.each(['/auth/password/reset', '/auth/accounts/activate'])('rejects short and oversized new passwords on %s', async path => {
    for (const newPassword of ['short', 'a'.repeat(129)]) {
      const response = await request(app).post(`/api/v1${path}`).send({ tokenHash: 'synthetic-proof', newPassword });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
  it.each([['/auth/refresh', false], ['/auth/admin/refresh', true]] as const)('preserves login JSON for %s and uses only resolved tenant', async (path, administrative) => {
    const refreshed = { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresAt: '2033-05-18T03:33:20.000Z', user: { id: 'synthetic', role: 'admin' } };
    const rotate = jest.spyOn(SessionService.prototype, 'refreshInstitution').mockResolvedValue(refreshed as never);
    const response = await request(app).post(`/api/v1${path}`).set('x-tenant-slug', 'edukmais').send({ refreshToken: 'synthetic-old-refresh' });
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken', 'tenant', 'user']);
    expect(rotate).toHaveBeenCalledWith({ refreshToken: 'synthetic-old-refresh', administrative, tenant: expect.objectContaining({ slug: 'edukmais' }) });
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it('refreshes platform without resolving an invalid client tenant header', async () => {
    const refreshed = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: '2033-05-18T03:33:20.000Z', authorization: { scope: 'platform' } };
    jest.spyOn(SessionService.prototype, 'refreshPlatform').mockResolvedValue(refreshed as never);
    const response = await request(app).post('/api/v1/auth/platform/refresh').set('x-tenant-slug', 'unknown-client-tenant').send({ refreshToken: 'synthetic-old' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(refreshed);
    expect(response.body.tenant).toBeUndefined();
  });
  it('keeps successful recovery body identical for known and unknown accounts and logs no input proof', async () => {
    const send = jest.spyOn(RecoveryService.prototype, 'requestRecovery').mockResolvedValue(undefined);
    const log = jest.spyOn(logger, 'request').mockImplementation(() => {});
    const known = await request(app).post('/api/v1/auth/password/recovery').send({ email: 'known-synthetic@example.invalid' });
    const unknown = await request(app).post('/api/v1/auth/password/recovery').send({ email: 'unknown-synthetic@example.invalid' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/known-synthetic|unknown-synthetic/);
  });
  it.each([['/auth/password/reset', 'recovery'], ['/auth/accounts/activate', 'invite']] as const)('finishes %s with fixed proof type, no tenant lookup and no returned session', async (path, type) => {
    const change = jest.spyOn(RecoveryService.prototype, 'changePassword').mockResolvedValue(undefined);
    const log = jest.spyOn(logger, 'request').mockImplementation(() => {});
    const response = await request(app).post(`/api/v1${path}`).set('x-tenant-slug', 'unknown-tenant')
      .send({ tokenHash: 'synthetic-secret-proof', newPassword: 'SyntheticSecret123!' });
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(change).toHaveBeenCalledWith({ tokenHash: 'synthetic-secret-proof', newPassword: 'SyntheticSecret123!' }, type);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-secret-proof|SyntheticSecret/);
  });
  it('does not expose returned session tokens or provider details on denied refresh', async () => {
    jest.spyOn(SessionService.prototype, 'refreshPlatform').mockRejectedValue(new HttpError(401, 'INVALID_SESSION', 'Sessao invalida ou expirada.'));
    const response = await request(app).post('/api/v1/auth/platform/refresh').send({ refreshToken: 'synthetic-private-refresh' });
    expect(response.status).toBe(401);
    expect(response.body.accessToken).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private-refresh');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
  it('rejects an already suspended institution before invoking rotation', async () => {
    jest.spyOn(TenantRepository.prototype, 'findBySlug').mockRejectedValueOnce(new HttpError(403, 'TENANT_SUSPENDED', 'A instituicao esta suspensa.'));
    const rotate = jest.spyOn(SessionService.prototype, 'refreshInstitution');
    const response = await request(app).post('/api/v1/auth/refresh').set('x-tenant-slug', 'edukmais').send({ refreshToken: 'synthetic-private-refresh' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('TENANT_SUSPENDED');
    expect(rotate).not.toHaveBeenCalled();
  });
  it('reports configured recovery unavailability without disclosing account identity', async () => {
    jest.spyOn(RecoveryService.prototype, 'requestRecovery').mockRejectedValue(new HttpError(503, 'AUTH_RECOVERY_NOT_CONFIGURED', 'Recuperacao de senha indisponivel.'));
    const response = await request(app).post('/api/v1/auth/password/recovery').send({ email: 'synthetic-private@example.invalid' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('AUTH_RECOVERY_NOT_CONFIGURED');
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
  });
  it('enforces uniform recovery rate limits by IP with a 429 envelope', async () => {
    jest.spyOn(RecoveryService.prototype, 'requestRecovery').mockResolvedValue(undefined);
    let response;
    for (let i = 0; i < 11; i++) response = await request(app).post('/api/v1/auth/password/recovery').send({ email: `synthetic${i}@example.invalid` });
    expect(response!.status).toBe(429);
    expect(response!.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(response!.headers['retry-after']).toBeDefined();
  });
});
