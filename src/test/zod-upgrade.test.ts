import { readFileSync } from 'node:fs';
import request from 'supertest';
import { z } from 'zod';
import { app } from '../app';
import { PeriodSchema, SubjectSchema, EnrollmentSchema } from '../modules/academic-structure/academic-structure.schemas';
import { activityCreateSchema, activityUpdateSchema, reviewSchema } from '../modules/activities/activities.workflow.schemas';
import { AcademicSubjectSchema, AcademicIdSchema } from '../modules/academic/academic.contracts';
import { messageSendSchema, noticeCreateSchema, noticeUpdateSchema, notificationListSchema } from '../modules/communication/communication.schemas';
import { messageDto } from '../modules/communication/communication.dto';

const id = '11111111-1111-1111-1111-111111111111';
const course = '44444444-4444-4444-8444-444444444444';
const base = '/api/v1/tenants/edukmais';

describe('Zod security upgrade', () => {
  it('runs the patched major without importing the vulnerable v3 runtime', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('zod/package.json'), 'utf8')) as { version: string };
    const [major, minor, patch] = pkg.version.split('.').map(Number);
    expect(major === 4 && (minor > 6 || minor === 6 && patch >= 6)).toBe(true);
  });
  it('rejects an oversized constrained array before validating every element', () => {
    let visits = 0;
    const schema = z.array(z.string().refine(() => { visits++; return false; })).max(3);
    const result = schema.safeParse(Array.from({ length: 128 }, () => 'synthetic'));
    expect(result.success).toBe(false);
    expect(visits).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });
});

describe('Zod HTTP and schema compatibility', () => {
  it.each(['2030-01-01T12:00:00-0500', '2030-01-01T12:00:00+0130', '2030-01-01T12:00Z', '2030-01-01T12:00-0500'])('preserves accepted timestamp format %s', date => {
    expect(activityCreateSchema.parse({ title: 'Task', dueDate: date }).dueDate).toBe(new Date(date).toISOString());
    expect(noticeCreateSchema.parse({ title: 'Notice', content: 'Text', audienceType: 'institution', expiresAt: date }).expiresAt).toBe(new Date(date).toISOString());
    const message = messageDto({ id: 'message', tenant_id: id, conversation_id: 'conversation', sender_id: 'sender',
      content: 'Synthetic', sequence: 1, created_at: date, client_message_id: 'client' }, id, 'conversation');
    expect(message.createdAt).toBe(date);
  });
  it('accepts minute-precision UTC report bounds', async () => {
    const response = await request(app).get(`${base}/reports/engagement`).query({ from: '2030-01-01T12:00Z', to: '2031-01-01T12:00Z' })
      .set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-admin-token');
    expect(response.status).toBe(200);
  });
  const valid: Array<[string, z.ZodType, unknown]> = [
    ['required strings', PeriodSchema, { code: '2027.1', name: 'Synthetic' }],
    ['optional dates omitted', PeriodSchema, { code: 'P', name: 'Period' }],
    ['nullable dates', PeriodSchema, { code: 'P', name: 'Period', startDate: null, endDate: null }],
    ['leap date', PeriodSchema, { code: 'P', name: 'Period', startDate: '2028-02-29' }],
    ['legacy UUID format', SubjectSchema, { courseId: id, code: 'S', name: 'Subject' }],
    ['RFC UUID', SubjectSchema, { courseId: course, code: 'S', name: 'Subject' }],
    ['nil UUID', SubjectSchema, { courseId: '00000000-0000-0000-0000-000000000000', code: 'S', name: 'Subject' }],
    ['zero grade', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: 0 }],
    ['null grade', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: null }],
    ['grade upper limit', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: 10 }],
    ['nullable feedback', reviewSchema, { expectedRevision: 0, submissionVersion: 1, feedback: null }],
    ['empty feedback', reviewSchema, { expectedRevision: 0, submissionVersion: 1, feedback: '' }],
    ['valid offset', activityCreateSchema, { title: 'Task', dueDate: '2030-01-01T12:00:00-05:00' }],
    ['enum', EnrollmentSchema, { classId: id, studentId: id, status: 'completed' }],
    ['nested nulls', AcademicSubjectSchema, { id: 'S', attendance: { absences: null, absencePercentage: null } }],
    ['nested zero', AcademicSubjectSchema, { id: 1, attendance: { absences: 0, absencePercentage: 0 }, assessments: [{ activityId: 'A', grade: 0 }] }],
    ['institution notice', noticeCreateSchema, { title: 'Notice', content: 'Synthetic', audienceType: 'institution' }],
    ['message', messageSendSchema, { content: 'Synthetic', clientMessageId: id }],
    ['numeric academic id', AcademicIdSchema, 1],
  ];
  const invalid: Array<[string, z.ZodType, unknown]> = [
    ['missing required', PeriodSchema, { name: 'Period' }],
    ['null required', PeriodSchema, { code: null, name: 'Period' }],
    ['empty string', PeriodSchema, { code: '', name: 'Period' }],
    ['whitespace string', activityCreateSchema, { title: '   ' }],
    ['invalid date', PeriodSchema, { code: 'P', name: 'Period', startDate: '2026-02-29' }],
    ['invalid UUID', SubjectSchema, { courseId: 'not-a-uuid', code: 'S', name: 'Subject' }],
    ['missing UUID', SubjectSchema, { code: 'S', name: 'Subject' }],
    ['negative grade', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: -1 }],
    ['excess grade', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: 11 }],
    ['not finite', reviewSchema, { expectedRevision: 0, submissionVersion: 1, grade: Infinity }],
    ['fractional version', reviewSchema, { expectedRevision: 0.5, submissionVersion: 1 }],
    ['null optional deadline', activityCreateSchema, { title: 'Task', dueDate: null }],
    ['invalid offset', activityCreateSchema, { title: 'Task', dueDate: '2030-01-01T12:00:00+99:99' }],
    ['invalid enum', EnrollmentSchema, { classId: id, studentId: id, status: 'invented' }],
    ['nested negative attendance', AcademicSubjectSchema, { id: 'S', attendance: { absences: -1 } }],
    ['strict extra property', noticeCreateSchema, { title: 'Notice', content: 'Text', audienceType: 'institution', tenantId: id }],
    ['mismatching audience', noticeCreateSchema, { title: 'Notice', content: 'Text', audienceType: 'class' }],
    ['unknown filter', notificationListSchema, { tenantId: id }],
    ['array academic id', AcademicIdSchema, []],
  ];
  it.each(valid)('accepts %s', (_name, schema, value) => { expect(schema.safeParse(value).success).toBe(true); });
  it.each(invalid)('rejects %s', (_name, schema, value) => { expect(schema.safeParse(value).success).toBe(false); });

  it('preserves create defaults, enum normalization and explicit booleans', () => {
    expect(activityCreateSchema.parse({ title: '  Task  ' })).toMatchObject({ title: 'Task', type: 'assignment', priority: 'medium', allowLate: false });
    expect(PeriodSchema.parse({ code: '  p.1  ', name: ' Period ' })).toMatchObject({ code: 'P.1', name: 'Period', status: 'planned' });
    expect(notificationListSchema.parse({ unreadOnly: 'false' }).unreadOnly).toBe(false);
    expect(notificationListSchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
  });
  it('does not insert create defaults into a partial activity edit', () => {
    expect(activityUpdateSchema.parse({ title: 'Updated', expectedVersion: 2 })).toEqual({ title: 'Updated', expectedVersion: 2 });
  });
  it('does not invent a priority in a partial notice edit', () => {
    expect(noticeUpdateSchema.parse({ title: 'Updated', expectedRevision: 2 })).toEqual({ title: 'Updated', expectedRevision: 2 });
    expect(noticeUpdateSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
  });
  it('preserves period status when patching only its name', async () => {
    const post = await request(app).post(`${base}/academic-periods`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-admin-token')
      .send({ code: 'ZOD-COMPAT', name: 'Synthetic', status: 'closed' });
    expect(post.status).toBe(201);
    const patch = await request(app).patch(`${base}/academic-periods/${post.body.id}`).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-admin-token').send({ name: 'Renamed' });
    expect(patch.status).toBe(200); expect(patch.body.status).toBe('closed');
  });
  it.each([
    ['post', '/api/v1/auth/login', { email: 'invalid', password: 'synthetic' }],
    ['post', `${base}/users`, { name: 'Synthetic', email: '', password: 'synthetic', role: 'aluno' }],
    ['get', `${base}/subjects/not-a-uuid`, undefined],
    ['get', `${base}/subjects?page=1.5`, undefined],
    ['get', `${base}/subjects?limit=101`, undefined],
    ['get', `${base}/courses?page=Infinity`, undefined],
    ['get', `${base}/notifications?unreadOnly=yes`, undefined],
  ] as const)('retains sanitized validation400 for %s %s', async (method, path, body) => {
    const call = request(app)[method](path).set('x-tenant-slug', 'edukmais').set('authorization', 'Bearer valid-admin-token');
    const result = await (body ? call.send(body) : call);
    expect(result.status).toBe(400);
    expect(Object.keys(result.body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(result.body.error.requestId).toBe(result.headers['x-request-id']);
    expect(result.headers['cache-control']).toBe('no-store, private');
  });
});
