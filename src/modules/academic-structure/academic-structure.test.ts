import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';

const base = '/api/v1/tenants/edukmais';
const tenant = '11111111-1111-1111-1111-111111111111';
const course = '44444444-4444-4444-8444-444444444444';
const student = '55555555-5555-4555-8555-555555555555';
const teacher = '66666666-6666-4666-8666-666666666666';
const other = '77777777-7777-4777-8777-777777777777';
const db = createSupabaseAdminClient();
function call(method: 'get' | 'post' | 'patch' | 'delete', path: string, role = 'coordinator') {
  return request(app)[method](`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
let period: string; let subject: string; let offering: string; let enrollment: string;
beforeAll(async () => {
  await db.from('courses').insert({ id: course, tenant_id: tenant, name: 'Curso Sintetico' });
  await db.from('app_users').insert([
    { id: student, tenant_id: tenant, auth_user_id: '85858585-8585-4585-8585-858585858585', name: 'Synthetic Student', email: 'student@example.invalid', role: 'student' },
    { id: teacher, tenant_id: tenant, auth_user_id: '86868686-8686-4686-8686-868686868686', name: 'Synthetic Teacher', email: 'teacher@example.invalid', role: 'teacher' },
    { id: other, tenant_id: other, auth_user_id: '87878787-8787-4787-8787-878787878787', name: 'Other Student', email: 'other@example.invalid', role: 'student' },
  ]);
});
describe('formal academic structure', () => {
  it('creates a tenant period and rejects reversed dates', async () => {
    expect((await call('post', '/academic-periods').send({ code: '2027.1', name: 'Periodo', startDate: '2027-07-01', endDate: '2027-01-01' })).status).toBe(400);
    const result = await call('post', '/academic-periods').send({ code: '2027.1', name: 'Periodo', startDate: '2027-01-01', endDate: '2027-06-30', status: 'active' });
    expect(result.status).toBe(201); period = result.body.id;
    expect((await call('get', '/academic-periods')).body.data.some((row: { id: string }) => row.id === period)).toBe(true);
  });
  it('rejects a duplicate period within the institution', async () => {
    expect((await call('post', '/academic-periods').send({ code: '2027.1', name: 'Duplicate' })).status).toBe(409);
  });
  it('rejects student management', async () => {
    expect((await call('post', '/academic-periods', 'student').send({ code: 'NEW', name: 'Periodo' })).status).toBe(403);
  });
  it('creates a discipline attached to a course', async () => {
    const result = await call('post', '/subjects').send({ courseId: course, code: 'ALG', name: 'Algoritmos' });
    expect(result.status).toBe(201); subject = result.body.id;
    expect((await call('get', `/subjects/${subject}`)).body.courseId).toBe(course);
  });
  it('rejects a discipline referencing a different tenant course', async () => {
    expect((await call('post', '/subjects').send({ courseId: other, code: 'OTHER', name: 'Disciplina' })).status).toBe(404);
  });
  it('creates an offering using the existing classes entity', async () => {
    const result = await call('post', '/offerings').send({ courseId: course, subjectId: subject, periodId: period, name: 'Turma A' });
    expect(result.status).toBe(201); offering = result.body.id;
    expect((await db.from('classes').select('id').eq('id', offering).single()).data?.id).toBe(offering);
  });
  it('requires UUIDs at new API boundaries', async () => {
    expect((await call('get', '/subjects/not-a-uuid')).status).toBe(400);
  });
  it('rejects enrolling teachers or foreign institution users', async () => {
    for (const studentId of [teacher, other]) expect((await call('post', '/enrollments').send({ classId: offering, studentId })).status).toBe(404);
  });
  it('creates a formal student enrollment and rejects duplicates', async () => {
    const result = await call('post', '/enrollments').send({ classId: offering, studentId: student });
    expect(result.status).toBe(201); enrollment = result.body.id;
    expect((await call('post', '/enrollments').send({ classId: offering, studentId: student })).status).toBe(409);
  });
  it('denies another student enrollment and unassigned offering', async () => {
    expect((await call('get', `/enrollments/${enrollment}`, 'student')).status).toBe(404);
    expect((await call('get', `/offerings/${offering}`, 'student')).status).toBe(404);
    expect((await call('get', '/enrollments?studentId=' + student, 'student')).status).toBe(403);
  });
  it('assigns teachers and rejects students as teachers', async () => {
    expect((await call('post', '/teaching-assignments').send({ classId: offering, teacherId: student })).status).toBe(404);
    const result = await call('post', '/teaching-assignments').send({ classId: offering, teacherId: teacher });
    expect(result.status).toBe(201);
  });
  it('changes enrollment status without removing the record', async () => {
    const result = await call('patch', `/enrollments/${enrollment}`).send({ status: 'completed' });
    expect(result.status).toBe(200);
    expect((await call('get', `/enrollments/${enrollment}`)).body.status).toBe('completed');
  });
  it('removes course-name-only authorization from existing class routes', async () => {
    await db.from('classes').insert({ id: 'class-without-enrollment', tenant_id: tenant, course_id: 'course-existing', name: 'No enrollment' });
    expect((await call('get', '/classes/class-without-enrollment', 'student')).status).toBe(404);
  });
  it('grants co-teacher access through formal assignments, not only the legacy primary field', async () => {
    await db.from('teaching_assignments').insert({ tenant_id: tenant, class_id: offering, teacher_id: 'user-teacher', status: 'active', is_primary: false });
    expect((await call('get', `/offerings/${offering}`, 'teacher')).status).toBe(200);
    expect((await call('get', `/classes/${offering}`, 'teacher')).status).toBe(200);
  });
  it('limits co-teacher grade reads to active formal assignments', async () => {
    await db.from('activities').insert({ id: 'co-activity', tenant_id: tenant, class_id: offering, title: 'Co-teaching assessment' });
    await db.from('grades').insert({ tenant_id: tenant, activity_id: 'co-activity', student_id: '85858585-8585-4585-8585-858585858585', grade: 0 });
    const visible = await call('get', `/students/${student}/grades`, 'teacher');
    expect(visible.body.data.some((row: { activityId: string }) => row.activityId === 'co-activity')).toBe(true);
    await db.from('teaching_assignments').update({ status: 'inactive' }).eq('class_id', offering).eq('teacher_id', 'user-teacher');
    const hidden = await call('get', `/students/${student}/grades`, 'teacher');
    expect(hidden.body.data).toEqual([]);
  });
  it('prevents removing activities, classes or courses with academic records', async () => {
    expect((await call('delete', '/activities/activity-existing')).status).toBe(409);
    expect((await call('delete', '/classes/class-teacher')).status).toBe(409);
    expect((await call('delete', '/courses/course-existing')).status).toBe(409);
    expect((await db.from('grades').select('id').eq('id', 'grade-existing').single()).data?.id).toBe('grade-existing');
  });
  it('rejects a grade for an institutional student enrolled only in another offering', async () => {
    expect((await request(app).put(`${base}/activities/activity-existing/grades/${student}`)
      .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-teacher-token').send({ grade: 8 })).status).toBe(409);
  });
  it('preserves a student access to their own cancelled enrollment record', async () => {
    const id = '89898989-8989-4989-8989-898989898989';
    await db.from('enrollments').insert({ id, tenant_id: tenant, class_id: offering, student_id: 'user-student', status: 'cancelled' });
    const result = await call('get', `/enrollments/${id}`, 'student');
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('cancelled');
  });
});
