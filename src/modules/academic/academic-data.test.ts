import request from 'supertest';

import { app } from '../../app';

const tenantSlug = 'edukmais';

describe('academic data routes', () => {
  it('permite aluno listar turmas do proprio curso', async () => {
    const response = await request(app)
      .get(`/api/v1/tenants/${tenantSlug}/courses/course-existing/classes`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-student-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'class-teacher',
          name: 'Turma Professor',
        }),
      ]),
    );
  });

  it('permite aluno listar notas usando o id publico do app', async () => {
    const response = await request(app)
      .get(`/api/v1/tenants/${tenantSlug}/students/user-student/grades`)
      .set('x-tenant-slug', tenantSlug)
      .set('authorization', 'Bearer valid-student-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({
        activityId: 'activity-existing',
        title: 'Atividade Integrada',
        grade: 8.5,
        feedback: 'Bom trabalho',
      }),
    ]);
  });
});
