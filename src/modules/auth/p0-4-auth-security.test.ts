import request from 'supertest';
import { app } from '../../app';
import { AuthRepository } from './auth.repository';
import { RecoveryService } from './recovery.service';

const tenantId = '11111111-1111-1111-1111-111111111111';
afterEach(() => jest.restoreAllMocks());

describe('administrative identity and browser retry contract', () => {
  it('denies a teacher even when the login email resolves to a different administrative membership', async () => {
    jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue({ id: 'different-admin', authUserId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', tenantId, name: 'Synthetic Admin', email: 'professor@edukmais.edu.br', role: 'admin', active: true });
    const response = await request(app).post('/api/v1/auth/admin/login').set('x-tenant-slug', 'edukmais').send({ email: 'professor@edukmais.edu.br', password: 'password123' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_ACCESS_REQUIRED');
    expect(response.body.accessToken).toBeUndefined();
    expect(response.body.refreshToken).toBeUndefined();
  });

  it('authorizes a valid administrative Auth membership despite a stale email lookup', async () => {
    const byEmail = jest.spyOn(AuthRepository.prototype, 'findUserByEmail').mockResolvedValue({ id: 'different-teacher', authUserId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', tenantId, name: 'Synthetic Teacher', email: 'admin@edukmais.edu.br', role: 'teacher', active: true });
    const response = await request(app).post('/api/v1/auth/admin/login').set('x-tenant-slug', 'edukmais').send({ email: 'admin@edukmais.edu.br', password: 'password123' });
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe('user-admin');
    expect(response.body.user.role).toBe('admin');
    expect(byEmail).not.toHaveBeenCalled();
  });

  it('preserves the coordinator login and public gestor role', async () => {
    const response = await request(app).post('/api/v1/auth/admin/login').set('x-tenant-slug', 'edukmais').send({ email: 'coordenador@edukmais.edu.br', password: 'password123' });
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('gestor');
  });

  it('makes Retry-After readable to allowed cross-origin browser clients', async () => {
    jest.spyOn(RecoveryService.prototype, 'requestRecovery').mockResolvedValue(undefined);
    let response = await request(app).post('/api/v1/auth/password/recovery').set('Origin', 'http://localhost:3000').send({ email: 'synthetic@example.invalid' });
    for (let attempt = 1; attempt <= 10; attempt++) response = await request(app).post('/api/v1/auth/password/recovery').set('Origin', 'http://localhost:3000').send({ email: 'synthetic@example.invalid' });
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.headers['access-control-expose-headers']).toContain('Retry-After');
    expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
});
