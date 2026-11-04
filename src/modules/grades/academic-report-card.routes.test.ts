import request from 'supertest';
import { app } from '../../app';
import { HttpError } from '../../shared/http-error';
import * as workflow from '../activities/activities.workflow.rpc';

const tenantId = '11111111-1111-1111-1111-111111111111';
const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const studentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const closedBy = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const base = `/api/v1/tenants/edukmais/classes/${classId}/report-card`;
const when = '2026-11-03T19:00:00.000Z';
const itemId = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;

function item(n: number, stage: 'N1' | 'N2', category: 'exam' | 'activity', maxPoints: string, publishedValue: string | null, available = true) {
  return { id: itemId(n), stage, category, maxPoints, publishedValue, available };
}

function cards(items: ReturnType<typeof item>[], n1 = false, n2 = false, id = 'user-student') {
  return {
    classId, closedAt: { N1: n1 ? when : null, N2: n2 ? when : null }, total: 1,
    data: [{ studentId: id, studentName: 'Aluno', eligible: true, closedStages: { N1: n1, N2: n2 }, items }],
  };
}

function call(method: 'get' | 'post', path: string, role = 'teacher') {
  return request(app)[method](`${base}${path}`)
    .set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}

afterEach(() => jest.restoreAllMocks());

it('consolidates direct exam points and weighted activities in both closed stages', async () => {
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValue(cards([
    item(1, 'N1', 'exam', '7.00', '5.50'), item(2, 'N1', 'activity', '1.50', '8.00'),
    item(3, 'N2', 'exam', '7.00', '6.75'), item(4, 'N2', 'activity', '2.00', '9.00'),
  ], true, true));
  const res = await call('get', '/me', 'student');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    studentId: 'user-student', average: '7.625', status: 'approved',
    stages: {
      N1: { examPoints: '5.50', activityPoints: '1.20', total: '6.70', status: 'definitive' },
      N2: { examPoints: '6.75', activityPoints: '1.80', total: '8.55', status: 'definitive' },
    },
  });
  expect(rpc).toHaveBeenCalledWith('read_academic_report_cards', {
    p_tenant_id: tenantId, p_actor_id: 'user-student', p_class_id: classId,
    p_student_id: null, p_self: true, p_offset: 0, p_limit: 1,
  });
});

it.each([
  ['4.99', 'below_minimum'], ['5.00', 'final_exam_eligible'],
  ['6.99', 'final_exam_eligible'], ['7.00', 'approved'],
])('returns the exact academic classification for %s', async (value, status) => {
  jest.spyOn(workflow, 'activityRpc').mockResolvedValue(cards([
    item(1, 'N1', 'exam', '7.00', value), item(2, 'N2', 'exam', '7.00', value),
  ], true, true));
  const res = await call('get', '/me', 'student');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ average: value, status });
});

it('shows published zero, omits draft values and unpublished item IDs, and stays partial until both stages close', async () => {
  const withUnexpectedDraftValue = { ...item(3, 'N2', 'activity', '1.00', null), draftValue: '9.87' };
  jest.spyOn(workflow, 'activityRpc').mockResolvedValue(cards([
    item(1, 'N1', 'exam', '7.00', '7.00'),
    item(2, 'N2', 'exam', '7.00', '0.00'),
    withUnexpectedDraftValue,
    item(4, 'N2', 'activity', '1.00', null, false),
  ], true));
  const res = await call('get', '/me', 'student');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    average: null, status: 'partial',
    stages: {
      N1: { total: '7.00', closure: { state: 'closed' }, status: 'definitive' },
      N2: { total: '0.00', activityPoints: null, status: 'partial', pendingCount: 2, pendingItemIds: [itemId(3)] },
    },
  });
  expect(res.text).not.toContain(itemId(4));
  expect(res.text).not.toContain('9.87');
});

it('does not issue an academic classification to a student outside the frozen roster', async () => {
  const payload = cards([]);
  payload.closedAt = { N1: when, N2: when };
  jest.spyOn(workflow, 'activityRpc').mockResolvedValue(payload);
  const res = await call('get', '/me', 'student');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    average: null, status: 'partial',
    stages: { N1: { applies: false, closure: { state: 'closed' } }, N2: { applies: false, closure: { state: 'closed' } } },
  });
});

it('rejects another student selector and fails closed if the database returns the wrong student', async () => {
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValue(cards([], false, false, studentId));
  expect((await call('get', `/students/${studentId}`, 'student')).status).toBe(403);
  expect((await call('get', `/me?studentId=${studentId}`, 'student')).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
  expect((await call('get', '/me', 'student')).status).toBe(502);
});

it('scopes teacher reads and paginates the offering summary', async () => {
  const value = cards([], false, false, studentId);
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValueOnce(value).mockResolvedValueOnce({ ...value, total: 21 });
  const detail = await call('get', `/students/${studentId}`);
  expect(detail.status).toBe(200);
  expect(rpc).toHaveBeenNthCalledWith(1, 'read_academic_report_cards', expect.objectContaining({ p_self: false, p_student_id: studentId }));
  const summary = await call('get', '?page=2&limit=20');
  expect(summary.status).toBe(200);
  expect(summary.body).toMatchObject({ data: [{ studentId }], meta: { page: 2, limit: 20, total: 21 } });
  expect(summary.body.data[0].stages.N1).not.toHaveProperty('publishedItems');
  expect(rpc).toHaveBeenNthCalledWith(2, 'read_academic_report_cards', expect.objectContaining({ p_student_id: null, p_offset: 20, p_limit: 20 }));
});

it('reports stage blockers, requires an explicit close and returns the resulting audit metadata', async () => {
  const rpc = jest.spyOn(workflow, 'activityRpc').mockResolvedValueOnce({
    classId, stage: 'N1', closedAt: null, closedBy: null, eligibleCount: 1, assessmentCount: 1,
    blockers: ['pending_assessments'], total: 1, data: [{ itemId: itemId(1), studentId, title: 'Prova', reason: 'draft_grade' }],
  }).mockRejectedValueOnce(new HttpError(409, 'DATA_CONFLICT', 'Etapa com pendências.'))
    .mockResolvedValueOnce({
      classId, stage: 'N1', closedAt: when, closedBy, eligibleCount: 1, assessmentCount: 1,
      blockers: [], total: 0, data: [],
    });
  const open = await call('get', '/stages/N1');
  expect(open.status).toBe(200);
  expect(open.body).toMatchObject({ closure: { state: 'open' }, blockers: ['pending_assessments'], data: [{ reason: 'draft_grade' }] });
  expect((await call('post', '/stages/N1/close').send({})).status).toBe(409);
  const close = await call('post', '/stages/N1/close').send({});
  expect(close.status).toBe(200);
  expect(close.body).toMatchObject({ closure: { state: 'closed', closedAt: when, closedBy }, blockers: [] });
  expect(rpc).toHaveBeenNthCalledWith(1, 'manage_academic_stage', expect.objectContaining({ p_close: false }));
  expect(rpc).toHaveBeenNthCalledWith(3, 'manage_academic_stage', expect.objectContaining({ p_close: true }));
});
