import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';

import { app } from '../src/app';

const tenantSlug = process.env.SEED_DEMO_TENANT_SLUG ?? 'edukmais';
const demoPassword =
  process.env.SEED_DEMO_PASSWORD ??
  process.env.DEMO_UNIVERSITY_PASSWORD ??
  'Demo@2026';

const demoUsers = {
  student: 'aluno01@edukmais.edu.br',
  teacher: 'professor.eng@edukmais.edu.br',
  manager: 'gestor@edukmais.edu.br',
};

type LoginBody = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantSlug: string;
  };
};

type Paginated<T> = {
  data: T[];
  meta: {
    total: number;
  };
};

type Course = {
  id: string;
  name: string;
};

type ClassItem = {
  id: string;
  name: string;
};

type Activity = {
  id: string;
  title: string;
};

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

  const body = await readJson(response);
  assert.equal(
    response.status,
    expectedStatus,
    `${label}: ${JSON.stringify(body)}`,
  );
}

async function login(baseUrl: string, email: string): Promise<LoginBody> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-slug': tenantSlug,
    },
    body: JSON.stringify({
      email,
      password: demoPassword,
    }),
  });

  await assertStatus(response, 200, `login ${email}`);
  const body = (await readJson(response)) as LoginBody;

  assert.ok(body.accessToken, `token ausente para ${email}`);
  assert.equal(body.user.email, email);
  assert.equal(body.user.tenantSlug, tenantSlug);

  return body;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-tenant-slug': tenantSlug,
  };
}

async function main() {
  const server = app.listen(0);

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/${
      process.env.API_VERSION ?? 'v1'
    }`;

    const student = await login(baseUrl, demoUsers.student);
    assert.equal(student.user.role, 'aluno');

    const teacher = await login(baseUrl, demoUsers.teacher);
    assert.equal(teacher.user.role, 'professor');

    const manager = await login(baseUrl, demoUsers.manager);
    assert.equal(manager.user.role, 'admin');

    const managerAdminLogin = await fetch(`${baseUrl}/auth/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-slug': tenantSlug,
      },
      body: JSON.stringify({
        email: demoUsers.manager,
        password: demoPassword,
      }),
    });
    await assertStatus(managerAdminLogin, 200, 'login administrativo gestor');

    const coursesResponse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/courses`,
      {
        headers: authHeaders(manager.accessToken),
      },
    );
    await assertStatus(coursesResponse, 200, 'listar cursos seed');
    const courses = (await readJson(coursesResponse)) as Paginated<Course>;
    const courseNames = courses.data.map((course) => course.name);
    assert.ok(courseNames.includes('Engenharia de Software'));
    assert.ok(courseNames.includes('Ciencia da Computacao'));
    assert.ok(courseNames.includes('Sistemas de Informacao'));

    const summaryResponse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/reports/summary`,
      {
        headers: authHeaders(manager.accessToken),
      },
    );
    await assertStatus(summaryResponse, 200, 'relatorio summary');
    const summary = await readJson(summaryResponse);
    assert.ok(summary.totalUsers >= 11);
    assert.ok(summary.totalCourses >= 3);
    assert.ok(summary.totalClasses >= 4);
    assert.ok(summary.activeStudents >= 5);

    const softwareCourse = courses.data.find(
      (course) => course.name === 'Engenharia de Software',
    );
    assert.ok(softwareCourse, 'curso Engenharia de Software ausente');

    const classesResponse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/courses/${softwareCourse.id}/classes`,
      {
        headers: authHeaders(teacher.accessToken),
      },
    );
    await assertStatus(classesResponse, 200, 'listar turmas professor');
    const classes = (await readJson(classesResponse)) as Paginated<ClassItem>;
    const softwareClass = classes.data.find((classItem) =>
      classItem.name.includes('Engenharia de Software II'),
    );
    assert.ok(softwareClass, 'turma Engenharia de Software II ausente');

    const activitiesResponse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/classes/${softwareClass.id}/activities`,
      {
        headers: authHeaders(teacher.accessToken),
      },
    );
    await assertStatus(activitiesResponse, 200, 'listar atividades seed');
    const activities = (await readJson(activitiesResponse)) as Paginated<Activity>;
    const requirementsActivity = activities.data.find(
      (activity) => activity.title === 'Documento de requisitos',
    );
    assert.ok(requirementsActivity, 'atividade Documento de requisitos ausente');

    const gradesResponse = await fetch(
      `${baseUrl}/tenants/${tenantSlug}/activities/${requirementsActivity.id}/grades`,
      {
        headers: authHeaders(teacher.accessToken),
      },
    );
    await assertStatus(gradesResponse, 200, 'listar notas seed');
    const grades = await readJson(gradesResponse);
    assert.ok(Array.isArray(grades.data));
    assert.ok(grades.data.length >= 2);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
