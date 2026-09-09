import request from 'supertest';

import { app } from '../../app';

const tenantSlug = 'edukmais';

describe('user registration routes', () => {
  it('permite gestor cadastrar aluno com senha provisoria e o aluno fazer login', async () => {
    const newStudent = {
      name: 'Aluno Cadastro',
      email: 'aluno.cadastro@edukmais.edu.br',
      password: 'Temp@123456',
      role: 'aluno',
    };

    const createResponse = await request(app)
      .post(`/api/v1/tenants/${tenantSlug}/users`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-coordinator-token')
      .send(newStudent);

    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toEqual(
      expect.objectContaining({
        name: newStudent.name,
        email: newStudent.email,
        role: newStudent.role,
        tenantSlug,
      }),
    );
    expect(JSON.stringify(createResponse.body)).not.toContain(newStudent.password);

    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .set('x-tenant-slug', tenantSlug)
      .send({
        email: newStudent.email,
        password: newStudent.password,
      });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.accessToken).toBeTruthy();
    expect(loginResponse.body.user).toEqual(
      expect.objectContaining({
        email: newStudent.email,
        role: newStudent.role,
        tenantSlug,
      }),
    );
  });
});
