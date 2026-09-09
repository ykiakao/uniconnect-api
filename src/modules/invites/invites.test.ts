import request from 'supertest';

import { app } from '../../app';

const tenantSlug = 'edukmais';

describe('institution invites', () => {
  it('permite gestor criar convite institucional', async () => {
    const response = await request(app)
      .post(`/api/v1/tenants/${tenantSlug}/invites`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-coordinator-token')
      .send({ role: 'aluno', expiresIn: 3 });

    expect(response.status).toBe(201);
    expect(response.body.code).toMatch(/^EDU-[A-Z0-9]{8}$/);
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('bloqueia professor criando convite institucional', async () => {
    const response = await request(app)
      .post(`/api/v1/tenants/${tenantSlug}/invites`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-teacher-token')
      .send({ role: 'aluno' });

    expect(response.status).toBe(403);
  });

  it('resolve convite valido sem autenticacao', async () => {
    const response = await request(app).get('/api/v1/invites/EDU-VALID1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tenantSlug,
      tenantName: 'EduKMais',
      role: 'aluno',
    });
  });

  it('retorna 404 para convite expirado', async () => {
    const response = await request(app).get('/api/v1/invites/EDU-OLD01');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INVITE_NOT_FOUND');
  });

  it('retorna 404 para convite ja utilizado', async () => {
    const response = await request(app).get('/api/v1/invites/EDU-USED1');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INVITE_NOT_FOUND');
  });
});
