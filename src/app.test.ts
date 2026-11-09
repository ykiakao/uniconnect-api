import request from 'supertest';

import { app } from './app';
import * as supabase from './config/supabase';
import { routeRegistry } from './routes';

describe('health check', () => {
  afterEach(() => jest.restoreAllMocks());

  it('confirma conexao com o banco em /health/ready', async () => {
    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.database.status).toBe('ok');
    expect(response.body.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it.each(['query error', 'rejected request'])('returns 503 without dependency details on %s', async (failure) => {
    const original = supabase.createSupabaseAdminClient();
    const privateDetail = 'synthetic-private-dependency-detail';
    const select = failure === 'query error'
      ? jest.fn().mockResolvedValue({ error: { message: privateDetail } })
      : jest.fn().mockRejectedValue(new Error(privateDetail));
    const from = jest.fn().mockReturnValue({ select });
    jest.spyOn(supabase, 'createSupabaseAdminClient').mockReturnValue({ ...original, from } as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);

    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'error', database: { status: 'error' } });
    expect(JSON.stringify(response.body)).not.toContain(privateDetail);
    expect(from).toHaveBeenCalledWith('tenants');
    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(response.headers['cache-control']).toBe('no-store, private');
  });

  it('keeps liveness independent of the database and registers readiness for observability', async () => {
    const database = jest.spyOn(supabase, 'createSupabaseAdminClient').mockImplementation(() => { throw new Error('synthetic dependency unavailable'); });
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
    expect(database).not.toHaveBeenCalled();
    expect(routeRegistry.resolve('GET', '/api/v1/health/ready')).toBe('/api/v1/health/ready');
  });
});

describe('cors configuration', () => {
  it('permite origem local do painel web', async () => {
    const response = await request(app)
      .get('/api/v1/health')
      .set('origin', 'http://localhost:3000');

    expect(response.status).toBe(200);
    expect(response.header['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
  });

  it('permite origem Vite local do painel web', async () => {
    const response = await request(app)
      .get('/api/v1/health')
      .set('origin', 'http://127.0.0.1:5173');

    expect(response.status).toBe(200);
    expect(response.header['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5173',
    );
  });

  it('rejeita valor de origem com caminho mesmo no host local', async () => {
    const response = await request(app)
      .get('/api/v1/health')
      .set('origin', 'http://localhost:3000/not-an-origin');

    expect(response.status).toBe(403);
    expect(response.header['access-control-allow-origin']).toBeUndefined();
  });

  it('permite preflight do Flutter web em porta local dinamica', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('origin', 'http://localhost:54321')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type,x-tenant-slug');

    expect(response.status).toBe(204);
    expect(response.header['access-control-allow-origin']).toBe(
      'http://localhost:54321',
    );
  });
});
