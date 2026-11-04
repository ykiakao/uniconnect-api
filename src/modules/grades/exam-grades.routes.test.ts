import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';
import * as workflow from '../activities/activities.workflow.rpc';

const tenantId = '11111111-1111-1111-1111-111111111111';
const examId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = '/api/v1/tenants/edukmais';
const exam = `${base}/activities/${examId}/exam`;
const when = '2026-11-03T19:00:00.000Z';
const saved = { points: '5.50', unit: 'exam_points', publicationState: 'draft', revision: 1, gradedAt: when };

function call(method: 'get' | 'put' | 'post', path: string, role = 'teacher') {
  return request(app)[method](path)
    .set('x-tenant-slug', 'edukmais')
    .set('authorization', `Bearer valid-${role}-token`);
}

afterEach(() => jest.restoreAllMocks());

it('opens exam grading explicitly using the authenticated institutional actor', async () => {
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValue({ examId, revision: 2, gradingOpenedAt: when });
  const res = await call('post', `${exam}/activate`).send({ expectedVersion: 1 });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ examId, revision: 2, gradingOpenedAt: when });
  expect(rpc).toHaveBeenCalledWith('write_exam_grade', {
    p_tenant_id: tenantId, p_actor_id: 'user-teacher', p_exam_id: examId,
    p_action: 'activate', p_expected: 1, p_student_id: null, p_points: null,
  });
});

it('returns roster pagination and distinguishes absent scores from drafts', async () => {
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValue({
    examId, stage: 'N2', maxPoints: '7.00', gradingOpenedAt: when, revision: 2, total: 21,
    data: [{ studentId, studentName: 'Aluno', result: null }],
  });
  const res = await call('get', `${exam}/grades?page=2&limit=20`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ data: [{ studentId, result: null }], meta: { page: 2, limit: 20, total: 21 } });
  expect(rpc).toHaveBeenCalledWith('read_exam_grades', expect.objectContaining({ p_student_view: false, p_offset: 20, p_limit: 20 }));
});

it('sends decimal points and revisions through distinct draft and publication operations', async () => {
  const published = { ...saved, publicationState: 'published', revision: 2 };
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValueOnce(saved).mockResolvedValueOnce(published);
  const draft = await call('put', `${exam}/grades/${studentId}`).send({ points: '5.50', expectedRevision: 0 });
  expect(draft.status).toBe(200);
  expect(draft.body).toEqual(saved);
  const result = await call('post', `${exam}/grades/${studentId}/publish`).send({ expectedRevision: 1 });
  expect(result.status).toBe(200);
  expect(result.body).toEqual(published);
  expect(rpc).toHaveBeenNthCalledWith(1, 'write_exam_grade', expect.objectContaining({
    p_action: 'save', p_expected: 0, p_student_id: studentId, p_points: '5.50',
  }));
  expect(rpc).toHaveBeenNthCalledWith(2, 'write_exam_grade', expect.objectContaining({
    p_action: 'publish', p_expected: 1, p_student_id: studentId, p_points: null,
  }));
});

it.each(['-0.01', '0.001', '1e0', 5.5, null])('rejects invalid direct points %j before calling the database', async points => {
  const rpc = jest.spyOn(workflow, 'activityRpc');
  const res = await call('put', `${exam}/grades/${studentId}`).send({ points, expectedRevision: 0 });
  expect(res.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});

it('returns only the authenticated student’s published result and fails closed on an unexpected draft', async () => {
  const metadata = { examId, stage: 'N1', maxPoints: '7.00' };
  const zero = { ...saved, points: '0.00', publicationState: 'published', revision: 2 };
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValueOnce({ ...metadata, result: null })
    .mockResolvedValueOnce({ ...metadata, result: zero }).mockResolvedValueOnce({ ...metadata, result: saved });
  const missing = await call('get', `${exam}/grades/me`, 'student');
  expect(missing.status).toBe(200);
  expect(missing.body).toEqual({ ...metadata, result: null });
  const published = await call('get', `${exam}/grades/me`, 'student');
  expect(published.status).toBe(200);
  expect(published.body).toEqual({ ...metadata, result: zero });
  const bad = await call('get', `${exam}/grades/me`, 'student');
  expect(bad.status).toBe(502);
  expect(bad.text).not.toContain('5.50');
  expect((await call('get', `${exam}/grades/me?studentId=${studentId}`, 'student')).status).toBe(400);
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenCalledWith('read_exam_grades', {
    p_tenant_id: tenantId, p_actor_id: 'user-student', p_exam_id: examId,
    p_student_view: true, p_offset: 0, p_limit: 1,
  });
});

it('keeps direct points out of the legacy student list, even when the activity has legacy visibility', async () => {
  const db = createSupabaseAdminClient();
  const membership = await db.from('app_users').select('auth_user_id').eq('id', 'user-student').single();
  await db.from('activities').insert({
    id: examId, tenant_id: tenantId, class_id: 'class-teacher', title: 'Exam fixture', state: 'published',
  });
  await db.from('grades').insert({
    tenant_id: tenantId, activity_id: examId, student_id: membership.data?.auth_user_id,
    grade: 5.5, grade_unit: 'exam_points',
  });
  const result = await call('get', `${base}/students/user-student/grades`, 'student');
  expect(result.status).toBe(200);
  expect(result.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ grade: 8.5 })]));
  expect(result.body.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ activityId: examId })]));
});
