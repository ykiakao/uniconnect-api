import request from 'supertest';

import { app } from './app';

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
