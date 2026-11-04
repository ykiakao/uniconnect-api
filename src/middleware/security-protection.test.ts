import express from 'express';
import request from 'supertest';
import { createRateLimit } from './rate-limit';
import { errorHandler } from './error-handler';
import { buildAdminDatabaseConfig } from '../config/admin-database';
import { app } from '../app';
import { Client } from 'pg';

describe('bounded request admission', () => {
  it('limits repeated requests, ignores forged forwarding headers and expires the window', async () => {
    let time = 0;
    const local = express();
    local.use(createRateLimit({ max: 2, windowMs: 1000, now: () => time }));
    local.get('/', (_req, res) => { res.json({ ok: true }); });
    local.use(errorHandler);
    expect((await request(local).get('/')).status).toBe(200);
    expect((await request(local).get('/').set('x-forwarded-for', '198.51.100.1')).status).toBe(200);
    const blocked = await request(local).get('/').set('x-forwarded-for', '198.51.100.2');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    time = 1001;
    expect((await request(local).get('/')).status).toBe(200);
  });

  it('fails closed when the bounded key store is full', async () => {
    const local = express();
    local.set('trust proxy', 'loopback');
    local.use(createRateLimit({ max: 5, windowMs: 1000, maxKeys: 1 }));
    local.get('/', (_req, res) => { res.sendStatus(200); });
    local.use(errorHandler);
    expect((await request(local).get('/').set('x-forwarded-for', '198.51.100.1')).status).toBe(200);
    expect((await request(local).get('/').set('x-forwarded-for', '198.51.100.2')).status).toBe(429);
    expect((await request(local).get('/').set('x-forwarded-for', '198.51.100.1')).status).toBe(200);
  });

  it.each(['/api/v1/auth/login', '/api/v1/auth/admin/login', '/api/v1/invites/INVALID'])('enforces admission on %s', async (path) => {
    let last;
    for (let count = 0; count < 65; count++) {
      last = path.includes('/auth/') ? await request(app).post(path).send({}) : await request(app).get(path);
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers['retry-after']).toBeDefined();
    expect(last?.headers['cache-control']).toContain('no-store');
  });

  it('limits institutional invite creation', async () => {
    let last;
    for (let count = 0; count < 35; count++) {
      last = await request(app).post('/api/v1/tenants/edukmais/invites')
        .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-coordinator-token').send({ role: 'aluno' });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
  });
});

describe('administrative database TLS', () => {
  it('verifies certificates by default and upgrades URL sslmode=require', () => {
    const options = buildAdminDatabaseConfig('postgres://user:password@db.example.invalid/db?sslmode=require');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.connectionString).not.toContain('sslmode');
  });
  it.each(['disable', 'no-verify', 'prefer', 'allow'])('rejects insecure URL sslmode=%s', (mode) => {
    expect(() => buildAdminDatabaseConfig(`postgres://user:password@db.example.invalid/db?sslmode=${mode}`)).toThrow();
  });
  it('allows plaintext only for explicitly configured loopback connections', () => {
    expect(buildAdminDatabaseConfig('postgres://user:password@127.0.0.1/db', { mode: 'disable' }).ssl).toBe(false);
    expect(() => buildAdminDatabaseConfig('postgres://user:password@db.example.invalid/db', { mode: 'disable' })).toThrow();
  });
  it.each(['host', 'hostaddr'])('rejects a URL query %s overriding the verified host', (key) => {
    expect(() => new Client(buildAdminDatabaseConfig(
      `postgres://user:password@localhost/db?${key}=db.example.invalid`, { mode: 'disable' },
    ))).toThrow();
  });
  it('does not allow URL certificate settings to override server TLS configuration', () => {
    expect(() => buildAdminDatabaseConfig('postgres://user:password@db.example.invalid/db?sslrootcert=unsafe')).toThrow();
  });
  it('uses an explicit CA without disabling verification', () => {
    const options = buildAdminDatabaseConfig('postgres://user:password@db.example.invalid/db', { ca: 'synthetic-ca' });
    expect(options.ssl).toEqual({ rejectUnauthorized: true, ca: 'synthetic-ca' });
  });
});
