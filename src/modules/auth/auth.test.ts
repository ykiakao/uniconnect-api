import request from 'supertest';

import { app } from '../../app';

const tenantSlug = 'edukmais';
const baseUrl = '/api/v1/auth';

describe('auth routes', () => {
  it('retorna 200 com accessToken, role e tenantSlug para credenciais validas', async () => {
    const response = await request(app)
      .post(`${baseUrl}/login`)
      .set('x-tenant-slug', tenantSlug)
      .send({
        email: 'aluno@edukmais.edu.br',
        password: 'password123',
      });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBe('valid-student-token');
    expect(response.body.user.role).toBe('aluno');
    expect(response.body.user.tenantSlug).toBe(tenantSlug);
  });

  it('retorna 401 INVALID_CREDENTIALS para credenciais invalidas', async () => {
    const response = await request(app)
      .post(`${baseUrl}/login`)
      .set('x-tenant-slug', tenantSlug)
      .send({
        email: 'aluno@edukmais.edu.br',
        password: 'wrong-password',
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('nao retorna senha na resposta de login', async () => {
    const response = await request(app)
      .post(`${baseUrl}/login`)
      .set('x-tenant-slug', tenantSlug)
      .send({
        email: 'aluno@edukmais.edu.br',
        password: 'password123',
      });

    expect(JSON.stringify(response.body)).not.toContain('password123');
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('retorna 200 com role e tenantSlug para /me com token valido', async () => {
    const response = await request(app)
      .get(`${baseUrl}/me`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-student-token');

    expect(response.status).toBe(200);
    expect(response.body.role).toBe('aluno');
    expect(response.body.tenantSlug).toBe(tenantSlug);
  });

  it('retorna 401 quando /me recebe token ausente', async () => {
    const response = await request(app)
      .get(`${baseUrl}/me`)
      .set('x-tenant-slug', tenantSlug);

    expect(response.status).toBe(401);
  });

  it('retorna 401 quando /me recebe token invalido', async () => {
    const response = await request(app)
      .get(`${baseUrl}/me`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
  });

  it('retorna 204 no logout com token valido', async () => {
    const response = await request(app)
      .post(`${baseUrl}/logout`)
      .set('authorization', 'Bearer valid-student-token');

    expect(response.status).toBe(204);
  });

  it('retorna 204 no logout mesmo com token invalido', async () => {
    const response = await request(app)
      .post(`${baseUrl}/logout`)
      .set('authorization', 'Bearer invalid-token');

    expect(response.status).toBe(204);
  });
});
