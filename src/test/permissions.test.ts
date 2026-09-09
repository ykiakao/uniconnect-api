import request from 'supertest';

import { app } from '../app';

const tenantSlug = 'edukmais';

describe('permission rules', () => {
  it('bloqueia aluno tentando criar curso', async () => {
    const response = await request(app)
      .post(`/api/v1/tenants/${tenantSlug}/courses`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-student-token')
      .send({ name: 'Curso Aluno' });

    expect(response.status).toBe(403);
  });

  it('bloqueia professor tentando listar usuarios do tenant', async () => {
    const response = await request(app)
      .get(`/api/v1/tenants/${tenantSlug}/users`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-teacher-token');

    expect(response.status).toBe(403);
  });

  it('permite gestor criar curso', async () => {
    const response = await request(app)
      .post(`/api/v1/tenants/${tenantSlug}/courses`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-coordinator-token')
      .send({ name: 'Curso Gestor' });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Curso Gestor');
  });

  it('permite admin acessar relatorio global', async () => {
    const response = await request(app)
      .get('/api/v1/admin/reports/global')
      .set('authorization', 'Bearer valid-admin-token');

    expect(response.status).toBe(200);
  });

  it('bloqueia gestor tentando acessar relatorio global', async () => {
    const response = await request(app)
      .get('/api/v1/admin/reports/global')
      .set('authorization', 'Bearer valid-coordinator-token');

    expect(response.status).toBe(403);
  });

  it('retorna 401 em rota protegida sem token', async () => {
    const response = await request(app)
      .get(`/api/v1/tenants/${tenantSlug}/courses`)
      .set('x-tenant-slug', tenantSlug);

    expect(response.status).toBe(401);
  });

  it('retorna 400 em rota de tenant sem x-tenant-slug', async () => {
    const response = await request(app)
      .get(`/api/v1/tenants/${tenantSlug}/courses`)
      .set('authorization', 'Bearer valid-admin-token');

    expect(response.status).toBe(400);
  });

  it('retorna 404 para slug de tenant invalido', async () => {
    const response = await request(app)
      .get('/api/v1/tenants/tenant-invalido/courses')
      .set('x-tenant-slug', 'tenant-invalido')
      .set('authorization', 'Bearer valid-admin-token');

    expect(response.status).toBe(404);
  });
});
