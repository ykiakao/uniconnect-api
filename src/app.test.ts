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
});
