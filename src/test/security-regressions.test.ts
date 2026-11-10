import request from 'supertest';
import { app } from '../app';
import { createSupabaseAdminClient } from '../config/supabase';
import { env } from '../config/env';
import { GradesRepository } from '../modules/grades/grades.repository';

const tenantId = '11111111-1111-1111-1111-111111111111';
const otherTenantId = '22222222-2222-2222-2222-222222222222';
const studentAuthId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const teacherAuthId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const foreignAuthId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const base = '/api/v1/tenants/edukmais';
const db = createSupabaseAdminClient();
function authenticated(method: 'get' | 'post' | 'put' | 'patch', path: string, role = 'coordinator') {
  return request(app)[method](path).set('x-tenant-slug', 'edukmais')
    .set('authorization', `Bearer valid-${role}-token`);
}

beforeEach(async () => {
  await db.from('app_users').update({ role: 'coordinator' }).eq('id', 'user-coordinator');
  await db.from('app_users').update({ role: 'admin' }).eq('id', 'institutional-admin');
});

beforeAll(async () => {
  await db.from('tenants').insert({ id: otherTenantId, name: 'Instituicao Sintetica', slug: 'synthetic' });
  await db.from('app_users').insert([
    { id: 'foreign-student', tenant_id: otherTenantId, auth_user_id: foreignAuthId, role: 'student', name: 'Aluno Sintetico', email: 'student@example.invalid' },
    { id: 'institutional-admin', tenant_id: tenantId, auth_user_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', role: 'admin', recipientEmail: 'synthetic@example.invalid', name: 'Admin Institucional', email: 'admin@example.invalid' },
    { id: 'new-student', tenant_id: tenantId, auth_user_id: 'abababab-abab-abab-abab-abababababab', role: 'student', name: 'Novo Aluno', email: 'new-student@example.invalid' },
  ]);
  await db.from('courses').insert({ id: 'restricted-course', tenant_id: tenantId, name: 'Curso Restrito' });
  await db.from('classes').insert([
    { id: 'restricted-class', tenant_id: tenantId, course_id: 'restricted-course', teacher_id: foreignAuthId, name: 'Turma Restrita' },
    { id: 'other-teacher-class', tenant_id: tenantId, course_id: 'course-existing', teacher_id: foreignAuthId, name: 'Outra Turma' },
  ]);
});

describe('institutional permissions and global authority', () => {
  it('rejects coordinator self promotion without changing the role', async () => {
    const response = await authenticated('patch', `${base}/users/user-coordinator/role`).send({ role: 'admin' });
    expect(response.status).toBe(403);
    const { data } = await db.from('app_users').select('role').eq('id', 'user-coordinator').single();
    expect(data?.role).toBe('coordinator');
  });

  it.each(['users', 'invites'])('rejects coordinator granting admin through %s', async (resource) => {
    const response = await authenticated('post', `${base}/${resource}`).send({
      role: 'admin', recipientEmail: 'synthetic@example.invalid', name: 'Admin Sintetico', email: 'new-admin@example.invalid', password: 'Synthetic123!',
    });
    expect(response.status).toBe(403);
  });

  it('does not allow a coordinator to change an existing admin', async () => {
    expect((await authenticated('patch', `${base}/users/institutional-admin/role`).send({ role: 'aluno' })).status).toBe(403);
  });

  it('preserves admin management of lower institutional roles', async () => {
    const result = await authenticated('post', `${base}/users`, 'admin').send({
      role: 'gestor', name: 'Gestor Sintetico', email: 'manager@example.invalid', password: 'Synthetic123!',
    });
    expect(result.status).toBe(201);
    expect((await authenticated('patch', `${base}/users/${result.body.id}/role`, 'admin').send({ role: 'professor' })).status).toBe(200);
  });

  it('denies global reports for institutional roles', async () => {
    expect((await authenticated('get', '/api/v1/admin/reports/global')).status).toBe(403);
  });

  it('requires server authority even when an institutional user has role admin', async () => {
    const old = env.PLATFORM_ADMIN_AUTH_USER_IDS;
    env.PLATFORM_ADMIN_AUTH_USER_IDS = [];
    try {
      expect((await authenticated('get', '/api/v1/admin/reports/global', 'admin')).status).toBe(403);
    } finally { env.PLATFORM_ADMIN_AUTH_USER_IDS = old; }
  });

  it('preserves explicit server authorization for an existing administrator', async () => {
    expect((await authenticated('get', '/api/v1/admin/reports/global', 'admin')).status).toBe(200);
  });
});

describe('academic record integrity', () => {
  it('rejects identifiers ambiguously matching different institutional students', async () => {
    await db.from('app_users').insert({
      id: studentAuthId, tenant_id: tenantId, auth_user_id: 'acacacac-acac-acac-acac-acacacacacac',
      role: 'student', name: 'Aluno Sintetico', email: 'ambiguous@example.invalid',
    });
    try {
      expect((await authenticated('put', `${base}/activities/activity-existing/grades/${studentAuthId}`, 'teacher').send({ grade: 7 })).status).toBe(404);
    } finally { await db.from('app_users').delete().eq('id', studentAuthId); }
  });
  it('keeps one grade under simultaneous writes', async () => {
    const repository = new GradesRepository();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.upsert({
      tenantId, activityId: 'activity-existing', studentId: 'new-student', grade: index, gradedBy: teacherAuthId,
    })));
    expect(results).toHaveLength(8);
    const { data } = await db.from('grades').select('id').eq('student_id', 'abababab-abab-abab-abab-abababababab');
    expect(data).toHaveLength(1);
  });
  it.each([teacherAuthId, 'user-teacher', foreignAuthId, 'foreign-student', 'unknown-user'])('rejects invalid grade recipient %s', async (id) => {
    expect((await authenticated('put', `${base}/activities/activity-existing/grades/${id}`, 'teacher').send({ grade: 7 })).status).toBe(404);
  });

  it.each(['user-student', studentAuthId])('accepts a verified institutional student using %s', async (id) => {
    const result = await authenticated('put', `${base}/activities/activity-existing/grades/${id}`, 'teacher').send({ grade: 0 });
    expect(result.status).toBe(200);
    expect(result.body.studentId).toBe(studentAuthId);
    expect(result.body.grade).toBe(0);
  });

  it.each([studentAuthId, foreignAuthId])('rejects invalid teacher on creation and update: %s', async (teacherId) => {
    expect((await authenticated('post', `${base}/courses/course-existing/classes`).send({ name: 'Turma Sintetica', teacherId })).status).toBe(404);
    expect((await authenticated('put', `${base}/classes/class-teacher`).send({ name: 'Turma Sintetica', teacherId })).status).toBe(404);
  });

  it('accepts a teacher linked to this institution', async () => {
    expect((await authenticated('post', `${base}/courses/course-existing/classes`).send({ name: 'Turma Valida', teacherId: teacherAuthId })).status).toBe(201);
  });

  it('preserves the verified teacher when a class update omits teacherId', async () => {
    const result = await authenticated('put', `${base}/classes/class-teacher`).send({ name: 'Turma Renomeada' });
    expect(result.status).toBe(200);
    expect(result.body.teacherId).toBe(teacherAuthId);
  });

  it('revalidates the existing teacher on updates without teacherId', async () => {
    const result = await authenticated('put', `${base}/classes/restricted-class`).send({ name: 'Turma Renomeada' });
    expect(result.status).toBe(404);
  });
});

describe('consistent class visibility', () => {
  it('does not expose restricted classes indirectly to students', async () => {
    expect((await authenticated('get', `${base}/classes/restricted-class`, 'student')).status).toBe(404);
    const detail = await authenticated('get', `${base}/courses/restricted-course`, 'student');
    expect(detail.status).toBe(200);
    expect(detail.body.classes).toEqual([]);
  });

  it('does not expose other teacher classes through a course', async () => {
    expect((await authenticated('get', `${base}/classes/other-teacher-class`, 'teacher')).status).toBe(404);
    const detail = await authenticated('get', `${base}/courses/course-existing`, 'teacher');
    expect(detail.status).toBe(200);
    expect(detail.body.classes.some((item: { id: string }) => item.id === 'other-teacher-class')).toBe(false);
    expect(detail.body.classes.some((item: { id: string }) => item.id === 'class-teacher')).toBe(true);
  });

  it('preserves institutional management visibility', async () => {
    expect((await authenticated('get', `${base}/courses/restricted-course`)).body.classes).toHaveLength(1);
  });
});

describe('sensitive HTTP responses', () => {
  it('returns 400 for malformed JSON without echoing the payload', async () => {
    const response = await request(app).post('/api/v1/auth/login').set('content-type', 'application/json').send('{"secret":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it.each([`${base}/students/user-student/grades`, `${base}/courses/course-existing`, '/api/v1/auth/me'])('prevents caching and conditional responses at %s', async (path) => {
    const response = await authenticated('get', path, 'student').set('if-none-match', '*');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.etag).toBeUndefined();
  });
});
