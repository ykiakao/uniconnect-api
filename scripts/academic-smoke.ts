import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';

import { app } from '../src/app';

class SmokeError extends Error {}

const tenantSlug = process.env.ACADEMIC_SMOKE_TENANT_SLUG ?? 'edukmais';
const coordinatorEmail =
  process.env.ACADEMIC_SMOKE_COORDINATOR_EMAIL ?? 'coordenador@edukmais.edu.br';
const coordinatorPassword =
  process.env.ACADEMIC_SMOKE_COORDINATOR_PASSWORD ??
  process.env.DEMO_COORDINATOR_PASSWORD;
const studentEmail =
  process.env.ACADEMIC_SMOKE_STUDENT_EMAIL ?? 'aluno@edukmais.edu.br';
const studentPassword =
  process.env.ACADEMIC_SMOKE_STUDENT_PASSWORD ??
  process.env.DEMO_STUDENT_PASSWORD;

async function readJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function assertStatus(
  response: Response,
  expectedStatus: number,
  label: string,
) {
  if (response.status === expectedStatus) return;

  throw new SmokeError(`${label}: HTTP ${response.status}; esperado ${expectedStatus}.`);
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-slug': tenantSlug,
    },
    body: JSON.stringify({ email, password }),
  });
  await assertStatus(response, 200, 'login');

  const body = await readJson(response);
  assert.ok(body.accessToken);
  return body.accessToken as string;
}

async function main() {
  if (!coordinatorPassword?.trim()) {
    throw new SmokeError('Defina ACADEMIC_SMOKE_COORDINATOR_PASSWORD ou DEMO_COORDINATOR_PASSWORD com senha nao vazia.');
  }
  if (!studentPassword?.trim()) {
    throw new SmokeError('Defina ACADEMIC_SMOKE_STUDENT_PASSWORD ou DEMO_STUDENT_PASSWORD com senha nao vazia.');
  }

  const server = app.listen(0);

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/${
      process.env.API_VERSION ?? 'v1'
    }`;
    const coordinatorToken = await login(
      baseUrl,
      coordinatorEmail,
      coordinatorPassword,
    );
    const studentToken = await login(baseUrl, studentEmail, studentPassword);

    const coordinatorHeaders = {
      Authorization: `Bearer ${coordinatorToken}`,
      'x-tenant-slug': tenantSlug,
    };
    const studentHeaders = {
      Authorization: `Bearer ${studentToken}`,
      'x-tenant-slug': tenantSlug,
    };

    const users = await fetch(`${baseUrl}/tenants/${tenantSlug}/users`, {
      headers: coordinatorHeaders,
    });
    await assertStatus(users, 200, 'listar usuarios');
    const usersBody = await readJson(users);
    assert.ok(Array.isArray(usersBody.data));
    assert.ok(usersBody.meta);

    const courses = await fetch(`${baseUrl}/tenants/${tenantSlug}/courses`, {
      headers: studentHeaders,
    });
    await assertStatus(courses, 200, 'listar cursos como aluno');
    const coursesBody = await readJson(courses);
    assert.ok(Array.isArray(coursesBody.data));
    assert.ok(coursesBody.meta);

    const forbiddenCourse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/courses`,
      {
        method: 'POST',
        headers: {
          ...studentHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Teste aluno sem permissao' }),
      },
    );
    await assertStatus(forbiddenCourse, 403, 'aluno criando curso');
    const forbiddenBody = await readJson(forbiddenCourse);
    assert.equal(forbiddenBody.error.code, 'FORBIDDEN');

    const courseName = `Smoke ${Date.now()}`;
    const createdCourse = await fetch(`${baseUrl}/tenants/${tenantSlug}/courses`, {
      method: 'POST',
      headers: {
        ...coordinatorHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: courseName,
        description: 'Curso criado pelo smoke academico.',
      }),
    });
    await assertStatus(createdCourse, 201, 'gestor criando curso');
    const createdCourseBody = await readJson(createdCourse);
    assert.equal(createdCourseBody.name, courseName);

    const createdClass = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/courses/${createdCourseBody.id}/classes`,
      {
        method: 'POST',
        headers: {
          ...coordinatorHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Turma Smoke' }),
      },
    );
    await assertStatus(createdClass, 201, 'gestor criando turma');
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof SmokeError
      ? error.message
      : 'Falha no academic-smoke.ts; confira configuracao, dados de demonstracao e contratos da API.',
  );
  process.exitCode = 1;
});
