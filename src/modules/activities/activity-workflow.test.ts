import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';
import { env } from '../../config/env';
import { SubmissionsRepository } from './activities.submissions.repository';
import { HttpError } from '../../shared/http-error';
import { logger } from '../../observability/logger';

const db = createSupabaseAdminClient();
const tenantId = '11111111-1111-1111-1111-111111111111';
const base = '/api/v1/tenants/edukmais';
const future = () => new Date(Date.now() + 86400000).toISOString();
function call(method: 'get'|'post'|'put'|'delete', path: string, role = 'teacher') {
  return request(app)[method](`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
async function published(options: Record<string, unknown> = {}) {
  const created = await call('post', '/classes/class-teacher/activities').send({ title: 'Synthetic task', instructions: 'Respond with synthetic text', evaluationCriteria: 'Reasoning', dueDate: future(), priority: 'high', ...options });
  expect(created.status).toBe(201);
  const result = await call('post', `/activities/${created.body.id}/publish`).send({ expectedVersion: created.body.revision });
  expect(result.status).toBe(200);
  return result.body as { id: string; revision: number };
}
async function submit(id: string, answer = 'Synthetic answer', expectedVersion = 0) {
  return call('post', `/activities/${id}/submissions`, 'student').send({ answer, expectedVersion });
}
async function delivery() {
  const activity = await published();
  const response = await submit(activity.id);
  expect(response.status).toBe(201);
  return { activity, submission: response.body as { id: string; version: number } };
}

afterEach(async () => {
  jest.restoreAllMocks();
  await db.from('app_users').update({ active: true }).eq('id', 'user-student');
  await db.from('enrollments').update({ status: 'active' }).eq('id', 'enrollment-existing');
  await db.from('teaching_assignments').update({ status: 'active' }).eq('id', 'assignment-existing');
  await db.from('academic_periods').update({ status: 'active' }).eq('id', 'period-existing');
});

describe('academic activity lifecycle', () => {
  it('preserves deletion of an authorized activity without grades or submissions', async () => {
    const created = await call('post', '/classes/class-teacher/activities').send({ title: 'Synthetic disposable draft' });
    expect(created.status).toBe(201);
    expect((await call('delete', `/activities/${created.body.id}`)).status).toBe(204);
    expect((await call('get', `/activities/${created.body.id}`)).status).toBe(404);
  });
  it('rejects creation in a closed academic period', async () => {
    await db.from('academic_periods').update({ status: 'closed' }).eq('id', 'period-existing');
    expect((await call('post', '/classes/class-teacher/activities').send({ title: 'Synthetic closed period' })).status).toBe(409);
  });

  it('logs safe route templates and correlation without submission content or credentials', async () => {
    const activity = await published();
    const logs = jest.spyOn(logger, 'request');
    const response = await submit(activity.id, 'PRIVATE synthetic academic response');
    expect(response.status).toBe(201);
    const record = logs.mock.calls.find(([entry]) => entry.requestId === response.headers['x-request-id'])?.[0];
    expect(record).toMatchObject({ method: 'POST', status: 201, route: '/api/v1/tenants/:slug/activities/:activityId/submissions', tenantId });
    const serialized = JSON.stringify(logs.mock.calls);
    for (const secret of ['PRIVATE synthetic academic response', 'valid-student-token', activity.id, 'edukmais']) {
      expect(serialized).not.toContain(secret);
    }
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it('creates a draft for its assigned teacher and hides it from students', async () => {
    const response = await call('post', '/classes/class-teacher/activities').send({ title: 'Synthetic draft', instructions: 'Private draft', priority: 'high' });
    expect(response.status).toBe(201); expect(response.body.state).toBe('draft');
    expect(response.body.priority).toBe('high');
    expect((await call('get', `/activities/${response.body.id}`, 'student')).status).toBe(404);
    const list = await call('get', '/classes/class-teacher/activities', 'student');
    expect(list.status).toBe(200); expect(list.body.data.some((item: { id: string }) => item.id === response.body.id)).toBe(false);
  });
  it('rejects student creation and publication selected in the create body', async () => {
    expect((await call('post', '/classes/class-teacher/activities', 'student').send({ title: 'Forbidden' })).status).toBe(403);
    expect((await call('post', '/classes/class-teacher/activities').send({ title: 'Forbidden state', state: 'published' })).status).toBe(400);
  });
  it('rejects a teacher outside the offering and an unlinked student', async () => {
    const classId = '71717171-7171-4171-8171-717171717171';
    await db.from('classes').insert({ id: classId, tenant_id: tenantId, course_id: 'course-existing', subject_id: 'subject-existing', academic_period_id: 'period-existing', academic_status: 'active', name: 'Unassigned synthetic' });
    expect([403,404]).toContain((await call('post', `/classes/${classId}/activities`).send({ title: 'Forbidden' })).status);
    const activity = await published();
    await db.from('enrollments').update({ status: 'cancelled' }).eq('id', 'enrollment-existing');
    expect((await call('get', `/activities/${activity.id}`, 'student')).status).toBe(404);
  });
  it('publishes to enrolled students and restricts publication to an assigned teacher', async () => {
    const created = await call('post', '/classes/class-teacher/activities', 'coordinator').send({ title: 'Institution draft' });
    expect(created.status).toBe(201);
    expect((await call('post', `/activities/${created.body.id}/publish`, 'coordinator').send({ expectedVersion: 1 })).status).toBe(403);
    const published = await call('post', `/activities/${created.body.id}/publish`).send({ expectedVersion: 1 });
    expect(published.status).toBe(200); expect(published.body.state).toBe('published');
    const student = await call('get', `/activities/${created.body.id}`, 'student');
    expect(student.status).toBe(200); expect(student.headers['cache-control']).toContain('no-store');
  });
  it('requires a current version and freezes content after delivery while allowing deadline extension', async () => {
    const { activity } = await delivery();
    expect((await call('put', `/activities/${activity.id}`).send({ title: 'Changed' })).status).toBe(409);
    expect((await call('put', `/activities/${activity.id}`).send({ title: 'Changed', expectedVersion: activity.revision })).status).toBe(409);
    expect((await call('put', `/activities/${activity.id}`).send({ dueDate: new Date(Date.now() + 172800000).toISOString(), expectedVersion: activity.revision })).status).toBe(200);
    expect((await call('put', `/activities/${activity.id}`).send({ dueDate: future(), expectedVersion: activity.revision + 1 })).status).toBe(409);
  });
  it('protects activities with deliveries from deletion', async () => {
    const { activity } = await delivery();
    expect((await call('delete', `/activities/${activity.id}`)).status).toBe(409);
  });
  it('does not expose an unpublished draft through the close transition', async () => {
    const created=await call('post','/classes/class-teacher/activities').send({title:'Still private'});
    expect((await call('post',`/activities/${created.body.id}/close`).send({expectedVersion:1})).status).toBe(409);
    expect((await call('get',`/activities/${created.body.id}`,'student')).status).toBe(404);
  });
  it('keeps closed activity content immutable', async () => {
    const activity=await published();
    const closed=await call('post',`/activities/${activity.id}/close`).send({expectedVersion:activity.revision});
    expect(closed.status).toBe(200);
    expect((await call('put',`/activities/${activity.id}`).send({title:'Changed after closing',expectedVersion:closed.body.revision})).status).toBe(409);
  });
  it('preserves the legacy manual-grade endpoint for published activities without a delivery', async () => {
    const activity=await published();
    const response=await call('put',`/activities/${activity.id}/grades/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).send({grade:0,feedback:'Manual synthetic result'});
    expect(response.status).toBe(200);expect(response.body.grade).toBe(0);
    const own=await call('get','/students/user-student/grades','student');
    expect(own.body.data.find((grade:{activityId:string})=>grade.activityId===activity.id).feedback).toBe('Manual synthetic result');
    expect((await submit(activity.id)).status).toBe(409);
  });
});

describe('assessment metadata on existing activity routes', () => {
  it('omits metadata for legacy clients and accepts complete N1 activity metadata', async () => {
    const legacy = await call('post', '/classes/class-teacher/activities').send({ title: 'Legacy request' });
    expect(legacy.status).toBe(201);
    expect(legacy.body).not.toHaveProperty('assessment');

    const assessment = { stage: 'N1', category: 'activity', maxPoints: '1.50' };
    const created = await call('post', '/classes/class-teacher/activities').send({ title: 'Weighted task', assessment });
    expect(created.status).toBe(201);
    expect(created.body.assessment).toEqual(assessment);
    expect((await call('get', `/activities/${created.body.id}`)).body.assessment).toEqual(assessment);
  });

  it('accepts N2 exams as drafts and refuses legacy publication and student writes', async () => {
    const assessment = { stage: 'N2', category: 'exam', maxPoints: '7.00' };
    const created = await call('post', '/classes/class-teacher/activities').send({ title: 'Exam draft', assessment });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'draft', assessment });
    const path = `/activities/${created.body.id}`;
    expect((await call('post', `${path}/publish`).send({ expectedVersion: 1 })).status).toBe(409);
    expect((await call('get', path, 'student')).status).toBe(404);
    expect((await submit(created.body.id)).status).toBe(409);
    expect((await call('put', `${path}/grades/user-student`).send({ grade: 5 })).status).toBe(409);
  });

  it.each([
    { stage: 'N1', category: 'activity' },
    { stage: 'N3', category: 'activity', maxPoints: '1.00' },
    { stage: 'N1', category: 'project', maxPoints: '1.00' },
    { stage: 'N1', category: 'activity', maxPoints: '-0.01' },
    { stage: 'N1', category: 'activity', maxPoints: '3.01' },
    { stage: 'N2', category: 'exam', maxPoints: '7.01' },
    { stage: 'N2', category: 'exam', maxPoints: '1.005' },
  ])('rejects invalid metadata %j', async assessment => {
    const response = await call('post', '/classes/class-teacher/activities').send({ title: 'Invalid', assessment });
    expect(response.status).toBe(400);
  });

  it('allows changing or detaching a draft and freezes metadata after publication', async () => {
    const assessment = { stage: 'N1', category: 'activity', maxPoints: '1.25' };
    const created = await call('post', '/classes/class-teacher/activities').send({ title: 'Mutable draft' });
    expect(created.status).toBe(201);
    const path = `/activities/${created.body.id}`;
    const edited = await call('put', path).send({ expectedVersion: 1, assessment });
    expect(edited.status).toBe(200);
    expect(edited.body.assessment).toEqual(assessment);
    const detached = await call('put', path).send({ expectedVersion: 2, assessment: null });
    expect(detached.status).toBe(200);
    expect(detached.body).not.toHaveProperty('assessment');
    expect((await call('put', path).send({ expectedVersion: 3, assessment })).status).toBe(200);
    expect((await call('post', `${path}/publish`).send({ expectedVersion: 4 })).status).toBe(200);
    expect((await call('put', path).send({ expectedVersion: 5, assessment: { ...assessment, stage: 'N2' } })).status).toBe(409);
    const renamed = await call('put', path).send({ expectedVersion: 5, title: 'Corrected title' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Corrected title', assessment });
    expect((await call('delete', path)).status).toBe(409);
  });
});

describe('student submissions and teacher reviews', () => {
  it('records authenticated student identity and server timestamps without trusting body identity', async () => {
    const activity = await published();
    expect((await call('get', `/activities/${activity.id}/submissions/me`, 'student')).body.status).toBe('not_submitted');
    expect((await call('post', `/activities/${activity.id}/submissions`, 'student').send({ answer: 'Impersonated', expectedVersion: 0, studentId: 'other' })).status).toBe(400);
    const response = await submit(activity.id);
    expect(response.status).toBe(201); expect(response.body.version).toBe(1);
    expect(response.body.studentId).toBe('user-student'); expect(response.body.isLate).toBe(false);
    expect(Date.parse(response.body.submittedAt)).toBeLessThanOrEqual(Date.now());
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('rejects duplicate/stale submissions and preserves prior versions on resubmission', async () => {
    const { activity, submission } = await delivery();
    expect((await submit(activity.id, 'Duplicate')).status).toBe(409);
    const revised = await submit(activity.id, 'Revised synthetic answer', 1);
    expect(revised.status).toBe(201); expect(revised.body.version).toBe(2);
    const history = await call('get', `/submissions/${submission.id}/history`, 'student');
    expect(history.status).toBe(200);
    expect(history.body.versions.map((item: { answer: string }) => item.answer)).toEqual(['Synthetic answer', 'Revised synthetic answer']);
  });
  it('does not let concurrent first submissions create two records', async () => {
    const activity = await published();
    const responses = await Promise.all([submit(activity.id, 'A'), submit(activity.id, 'B')]);
    expect(responses.map(response => response.status).sort()).toEqual([201,409]);
  });
  it('rejects deadlines by default and records allowed late delivery explicitly', async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const blocked = await published({ dueDate: past });
    expect((await submit(blocked.id)).status).toBe(409);
    const allowed = await published({ dueDate: past, allowLate: true });
    const response = await submit(allowed.id);
    expect(response.status).toBe(201); expect(response.body.isLate).toBe(true); expect(response.body.status).toBe('late');
  });
  it('rejects closed or draft activities', async () => {
    const draft = await call('post', '/classes/class-teacher/activities').send({ title: 'Synthetic draft' });
    expect((await submit(draft.body.id)).status).toBe(409);
    const activity = await published();
    expect((await call('post', `/activities/${activity.id}/close`).send({ expectedVersion: activity.revision })).status).toBe(200);
    expect((await submit(activity.id)).status).toBe(409);
  });
  it.each(['completed','cancelled','suspended'])('rejects new submissions for %s enrollments', async status => {
    const activity = await published();
    await db.from('enrollments').update({ status }).eq('id', 'enrollment-existing');
    expect((await submit(activity.id)).status).toBe(403);
  });
  it('preserves own receipts for cancelled enrollment without exposing new class activities', async () => {
    const { activity, submission } = await delivery();
    const unseen = await published();
    await db.from('enrollments').update({ status: 'cancelled' }).eq('id', 'enrollment-existing');
    expect((await call('get', `/submissions/${submission.id}`, 'student')).status).toBe(200);
    expect((await call('get', `/activities/${activity.id}`, 'student')).status).toBe(200);
    expect((await call('get', `/activities/${unseen.id}`, 'student')).status).toBe(404);
  });
  it('allows authorized teacher listings, forbids a student list and hides other student submissions', async () => {
    const { activity, submission } = await delivery();
    expect((await call('get', `/activities/${activity.id}/submissions`)).body.data).toHaveLength(1);
    expect((await call('get', `/activities/${activity.id}/submissions`, 'student')).status).toBe(403);
    await db.from('activity_submissions').update({ student_id: 'different-student' }).eq('id', submission.id);
    expect((await call('get', `/submissions/${submission.id}`, 'student')).status).toBe(404);
  });
  it('denies teacher access after assignment revocation', async () => {
    const { submission } = await delivery();
    await db.from('teaching_assignments').update({ status: 'inactive' }).eq('id', 'assignment-existing');
    expect([403,404]).toContain((await call('get', `/submissions/${submission.id}`)).status);
  });
  it('keeps draft assessment private and publishes zero consistently to existing grades and native overview', async () => {
    const { activity, submission } = await delivery();
    expect((await call('put', `/submissions/${submission.id}/review`, 'student').send({ expectedRevision: 0, submissionVersion: 1, grade: 10 })).status).toBe(403);
    const draft = await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 0, submissionVersion: 1, grade: 0, feedback: 'Private synthetic feedback' });
    expect(draft.status).toBe(200); expect(draft.body.publicationState).toBe('draft');
    const own = await call('get', `/activities/${activity.id}/submissions/me`, 'student');
    expect(own.body.status).toBe('corrected'); expect(own.body.result).toBeNull();
    expect(JSON.stringify(own.body)).not.toContain('Private synthetic feedback');
    const oldGrades = await call('get', '/students/user-student/grades', 'student');
    expect(oldGrades.body.data.some((grade: { activityId: string }) => grade.activityId === activity.id)).toBe(false);
    const original = env.ACADEMIC_PROVIDER; env.ACADEMIC_PROVIDER = 'native';
    try {
      const overview = await call('get', '/academic/overview', 'student');
      expect(JSON.stringify(overview.body)).not.toContain('Private synthetic feedback');
      const pub = await call('post', `/submissions/${submission.id}/review/publish`).send({ expectedRevision: 1 });
      expect(pub.status).toBe(200); expect(pub.body.grade).toBe(0);
      const now = await call('get', `/activities/${activity.id}/submissions/me`, 'student');
      expect(now.body.status).toBe('result_published'); expect(now.body.result.grade).toBe(0);
      const grades = await call('get', '/students/user-student/grades', 'student');
      expect(grades.body.data.find((grade: { activityId: string }) => grade.activityId === activity.id).grade).toBe(0);
      expect(JSON.stringify((await call('get', '/academic/overview', 'student')).body)).toContain('Private synthetic feedback');
    } finally { env.ACADEMIC_PROVIDER = original; }
  });
  it('rejects stale review versions, resubmission after review and legacy-grade bypass', async () => {
    const { activity, submission } = await delivery();
    expect((await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 0, submissionVersion: 2, grade: 7 })).status).toBe(409);
    expect((await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 0, submissionVersion: 1, grade: null, feedback: 'Review started' })).status).toBe(200);
    expect((await submit(activity.id, 'Overwrite', 1)).status).toBe(409);
    expect((await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 0, submissionVersion: 1, grade: 8 })).status).toBe(409);
    expect((await call('put', `/activities/${activity.id}/grades/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`).send({ grade: 10 })).status).toBe(409);
  });
  it('preserves absent grades and evaluation history without making draft results public', async () => {
    const { submission } = await delivery();
    const draft = await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 0, submissionVersion: 1, grade: null });
    expect(draft.status).toBe(200); expect(draft.body.grade).toBeNull();
    const revised = await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 1, submissionVersion: 1, grade: 8, feedback: 'Published synthetic', publish: true });
    expect(revised.status).toBe(200);
    expect((await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 2, submissionVersion: 1, grade: 9, publish: true })).status).toBe(200);
    const studentHistory = await call('get', `/submissions/${submission.id}/history`, 'student');
    expect(studentHistory.body.evaluations.map((grade: { grade: number }) => grade.grade)).toEqual([8,9]);
    expect((await call('put', `/submissions/${submission.id}/review`).send({ expectedRevision: 3, submissionVersion: 1, grade: 7 })).status).toBe(409);
  });
  it('rejects inactive institutional users and invalid or forged identifiers', async () => {
    const activity = await published();
    await db.from('app_users').update({ active: false }).eq('id', 'user-student');
    expect((await submit(activity.id)).status).toBe(403);
    expect((await call('get', '/submissions/not-a-uuid')).status).toBe(400);
    expect((await call('get', '/submissions/99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });
  it('does not expose a submission stored in another institution', async () => {
    const id='72727272-7272-4272-8272-727272727272';
    await db.from('activity_submissions').insert({id,tenant_id:'22222222-2222-2222-2222-222222222222',activity_id:'foreign',class_id:'foreign',student_id:'foreign',current_version:1,answer:'Foreign private answer',submitted_at:new Date().toISOString(),is_late:false});
    for(const role of ['teacher','student','coordinator']) {
      const response=await call('get',`/submissions/${id}`,role);
      expect(response.status).toBe(404);expect(JSON.stringify(response.body)).not.toContain('Foreign private answer');
    }
  });
  it('does not expose draft evaluations through history and preserves authorized correction after withdrawal', async () => {
    const {submission}=await delivery();
    const draft=await call('put',`/submissions/${submission.id}/review`).send({expectedRevision:0,submissionVersion:1,grade:3,feedback:'Hidden review'});
    expect(draft.status).toBe(200);
    expect((await call('get',`/submissions/${submission.id}/history`,'student')).body.evaluations).toEqual([]);
    expect((await call('get',`/submissions/${submission.id}/history`)).body.evaluations[0].feedback).toBe('Hidden review');
    await db.from('enrollments').update({status:'cancelled'}).eq('id','enrollment-existing');
    expect((await call('post',`/submissions/${submission.id}/review/publish`).send({expectedRevision:1})).status).toBe(200);
    expect((await call('get',`/submissions/${submission.id}`,'student')).body.result.grade).toBe(3);
  });
  it('rejects unsafe attachments, invalid grades and invalid deadline input', async () => {
    const {activity,submission}=await delivery();
    expect((await call('post',`/activities/${activity.id}/submissions`,'student').send({answer:'Unsafe',expectedVersion:1,attachments:[{path:'../../private'}]})).status).toBe(400);
    expect((await call('put',`/submissions/${submission.id}/review`).send({expectedRevision:0,submissionVersion:1,grade:11})).status).toBe(400);
    expect((await call('post','/classes/class-teacher/activities').send({title:'Bad date',dueDate:'invalid'})).status).toBe(400);
    expect((await call('get',`/activities/${activity.id}/submissions?page=NaN`)).status).toBe(400);
  });
  it('preserves dependency failures and sanitizes unexpected errors with request correlation', async () => {
    const activity=await published();
    const unavailable=jest.spyOn(SubmissionsRepository.prototype,'submit').mockRejectedValueOnce(new HttpError(503,'DEPENDENCY_UNAVAILABLE','Servico indisponivel.'));
    const response=await submit(activity.id);
    expect(response.status).toBe(503);expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    unavailable.mockRejectedValueOnce(new Error('Private SQL answer token'));
    const internal=await submit(activity.id);
    expect(internal.status).toBe(500);expect(JSON.stringify(internal.body)).not.toContain('Private SQL');
  });
});
