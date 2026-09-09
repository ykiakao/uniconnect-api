import request from 'supertest';

import { app } from '../../app';

describe('tenant lookup routes', () => {
  it('retorna nome e slug do tenant sem autenticacao', async () => {
    const response = await request(app).get(
      '/api/v1/tenants/lookup?slug=edukmais',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: 'EduKMais',
      slug: 'edukmais',
    });
  });

  it('retorna 404 para slug inexistente', async () => {
    const response = await request(app).get(
      '/api/v1/tenants/lookup?slug=tenant-invalido',
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('retorna 400 para slug ausente', async () => {
    const response = await request(app).get('/api/v1/tenants/lookup');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
