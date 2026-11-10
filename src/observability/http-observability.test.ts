import express from 'express';
import request from 'supertest';
import { createLogger } from './logger';
import { createHttpObservability } from './http-observability';
import { RouteRegistry } from './route-registry';
import { errorHandler } from '../middleware/error-handler';
import { HttpError } from '../shared/http-error';
import { app } from '../app';
import { once } from 'node:events';
import { get, ClientRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { logger } from './logger';

function fixture(environment: 'development' | 'production' = 'production') {
  const output: string[] = [];
  const registry = new RouteRegistry();
  registry.register('GET', '/students/:studentId');
  registry.register('POST', '/login');
  registry.register('GET', '/unexpected');
  registry.register('GET', '/forbidden');
  const local = express();
  local.use(createHttpObservability({ logger: createLogger({ environment, write: (line) => output.push(line) }), resolveRoute: (method, path) => registry.resolve(method, path) }));
  local.use(express.json());
  local.get('/students/:studentId', (req, res) => {
    req.tenant = { id: '11111111-1111-1111-1111-111111111111', slug: 'secret-slug', name: 'private tenant', plan: 'starter', status: 'active', activeUsers: 1 };
    req.currentUser = { id: 'private-student', authUserId: 'private-auth', tenantId: req.tenant.id, role: 'student', name: 'private-name', email: 'private@example.invalid' };
    res.json({ grade: 7 });
  });
  local.post('/login', (_req, _res, next) => next(new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos', { password: 'secret-password' })));
  local.get('/unexpected', (_req, _res, next) => next(new Error('SQL private-table password=secret-password')));
  local.get('/forbidden', (_req, _res, next) => next(new HttpError(403, 'FORBIDDEN', 'Acesso nao permitido')));
  local.use(errorHandler);
  return { local, output };
}

describe('HTTP observability and privacy', () => {
  it('logs an interrupted HTTP response exactly once as 499 with the original request ID', async () => {
    const output: string[] = [];
    let observed!: () => void;
    const completion = new Promise<void>((resolve) => { observed = resolve; });
    const registry = new RouteRegistry();
    registry.register('GET', '/stream/:id');
    const local = express();
    local.use(createHttpObservability({
      logger: createLogger({ environment: 'production', write: (line) => { output.push(line); observed(); } }),
      resolveRoute: (method, path) => registry.resolve(method, path),
    }));
    local.get('/stream/:id', (_req, res) => { res.type('text').write('private-response-fragment'); });
    const server = local.listen(0, '127.0.0.1');
    let client: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const response = new Promise<{ requestId: string | undefined; status: number | undefined }>((resolve, reject) => {
        client = get(`http://127.0.0.1:${port}/stream/private-id?token=private-query`, (incoming) => {
          incoming.once('error', reject);
          incoming.once('data', () => {
            const requestId = incoming.headers['x-request-id'];
            resolve({ requestId: typeof requestId === 'string' ? requestId : undefined, status: incoming.statusCode });
            incoming.destroy();
            client?.destroy();
          });
        });
        client.once('error', reject);
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Interrupted HTTP response was not observed.')), 2500);
      });
      const [received] = await Promise.race([Promise.all([response, completion]), deadline]);
      expect(received.status).toBe(200);
      expect(received.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(output).toHaveLength(1);
      const record = JSON.parse(output[0]);
      expect(record).toMatchObject({ event: 'http_request', level: 'warn', method: 'GET', route: '/stream/:id',
        status: 499, errorCategory: 'request_aborted', requestId: received.requestId });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(output.join('')).not.toMatch(/private-response|private-id|private-query/);
    } finally {
      if (timer) clearTimeout(timer);
      client?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps the HTTP response successful when a synchronous log sink fails', async () => {
    const local = express();
    local.use(createHttpObservability({
      logger: createLogger({ environment: 'production', write: () => { throw new Error('sink unavailable'); } }),
      resolveRoute: () => '/health',
    }));
    local.get('/health', (_req, res) => { res.json({ ok: true }); });
    expect((await request(local).get('/health')).body).toEqual({ ok: true });
  });

  it('does not write default test-environment logs', () => {
    const write = jest.fn();
    const testLogger = createLogger({ environment: 'test', write });
    testLogger.startup();
    testLogger.request({ requestId: 'synthetic', method: 'GET', route: '/health', status: 200, durationMs: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it('correlates CORS rejections before routing without reflecting the rejected origin', async () => {
    const response = await request(app).get('/api/v1/health').set('origin', 'https://private-origin.example.invalid');
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'CORS_ORIGIN_FORBIDDEN', requestId: response.headers['x-request-id'] });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(response.body)).not.toContain('private-origin');
  });

  it('exposes the request ID header in allowed CORS responses', async () => {
    const response = await request(app).get('/api/v1/health').set('origin', 'http://localhost:3000');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('uses the real mounted route template without logging an institutional invite code', async () => {
    const log = jest.spyOn(logger, 'request').mockImplementation(() => {});
    try {
      const response = await request(app).get('/api/v1/invites/PRIVATE-CODE-123?token=PRIVATE-TOKEN');
      expect(response.status).toBe(404);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatchObject({ route: '/api/v1/invites/:code', errorCategory: 'not_found' });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE-CODE|PRIVATE-TOKEN/);
    } finally { log.mockRestore(); }
  });
  it('logs one structured completion with safe route, status, duration and authenticated tenant', async () => {
    const { local, output } = fixture();
    const response = await request(local).get('/students/private-id?token=secret-query').set('authorization', 'Bearer secret-token').set('cookie', 'session=secret-cookie');
    expect(response.status).toBe(200);
    expect(output).toHaveLength(1);
    const log = JSON.parse(output[0]);
    expect(log).toMatchObject({ event: 'http_request', level: 'info', method: 'GET', route: '/students/:studentId', status: 200, tenantId: '11111111-1111-1111-1111-111111111111' });
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.requestId).toBe(response.headers['x-request-id']);
    for (const secret of ['private-id', 'secret-query', 'secret-token', 'secret-cookie', 'private-name', 'private@example.invalid', 'secret-slug', 'grade']) expect(output.join('')).not.toContain(secret);
  });

  it('does not trust an incoming request ID and logs failures without bodies or error details', async () => {
    const { local, output } = fixture();
    const response = await request(local).post('/login').set('x-request-id', 'secret-client-value').send({ email: 'private@example.invalid', password: 'secret-password' });
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha incorretos', requestId: response.headers['x-request-id'] });
    expect(JSON.parse(output[0])).toMatchObject({ level: 'warn', errorCategory: 'authentication', errorCode: 'INVALID_CREDENTIALS' });
    expect(JSON.parse(output[0]).tenantId).toBeUndefined();
    for (const secret of ['secret-client-value', 'secret-password', 'private@example.invalid']) expect(output.join('') + JSON.stringify(response.body)).not.toContain(secret);
  });

  it('does not log unknown paths or unvalidated tenant headers', async () => {
    const { local, output } = fixture();
    await request(local).get('/private-name/private@example.invalid?password=secret-query').set('x-tenant-slug', 'other-institution');
    expect(JSON.parse(output[0]).route).toBe('unmatched');
    expect(JSON.parse(output[0]).tenantId).toBeUndefined();
    expect(output.join('')).not.toMatch(/private-name|private@example|secret-query|other-institution/);
  });

  it('normalizes unexpected errors without SQL or stacks in responses or logs', async () => {
    const { local, output } = fixture();
    const response = await request(local).get('/unexpected');
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', requestId: response.headers['x-request-id'] });
    expect(JSON.parse(output[0])).toMatchObject({ level: 'error', errorCategory: 'internal', errorCode: 'INTERNAL_ERROR' });
    expect(JSON.stringify(response.body) + output.join('')).not.toMatch(/SQL|private-table|secret-password|stack/);
  });

  it('correlates malformed JSON and authorization failures', async () => {
    const { local, output } = fixture();
    const malformed = await request(local).post('/login').set('content-type', 'application/json').send('{"password":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.requestId).toBe(malformed.headers['x-request-id']);
    expect(JSON.parse(output[0])).toMatchObject({ route: '/login', errorCategory: 'validation', errorCode: 'INVALID_JSON' });
    const forbidden = await request(local).get('/forbidden');
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(output[1])).toMatchObject({ errorCategory: 'authorization' });
  });

  it('uses separate request IDs for concurrent requests', async () => {
    const { local, output } = fixture();
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(local).get('/students/id')));
    expect(new Set(responses.map((res) => res.headers['x-request-id'])).size).toBe(8);
    expect(output).toHaveLength(8);
  });

  it('formats development logs readably and production as JSON lines', async () => {
    for (const environment of ['development', 'production'] as const) {
      const { local, output } = fixture(environment);
      await request(local).get('/forbidden');
      expect(JSON.parse(output[0]).environment).toBe(environment);
      expect(output[0].includes('\n  ')).toBe(environment === 'development');
    }
  });

  it.each([
    ['/api/v1/auth/refresh', 400, 'TENANT_REQUIRED'],
    ['/api/v1/missing-private-path', 404, 'NOT_FOUND'],
  ])('preserves the error envelope and adds correlation for %s', async (path, status, code) => {
    const response = path.includes('refresh') ? await request(app).post(path) : await request(app).get(path);
    expect(response.status).toBe(status);
    expect(response.body.error).toMatchObject({ code, message: expect.any(String), requestId: response.headers['x-request-id'] });
    expect(response.body.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('adds correlation to existing input validation errors without changing the code', async () => {
    const response = await request(app).post('/api/v1/auth/login').set('x-tenant-slug', 'edukmais').send({ email: 'invalid', password: 'short' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: response.headers['x-request-id'] });
  });
});
