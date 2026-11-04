import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../app';
import { createSupabaseAdminClient } from '../../config/supabase';
import { logger } from '../../observability/logger';
import { CommunicationRepository } from './communication.repository';

const db = createSupabaseAdminClient();
const tenantId = '11111111-1111-1111-1111-111111111111';
const studentId = '20000000-0000-4000-8000-000000000001';
const teacherId = '20000000-0000-4000-8000-000000000002';
const classId = '20000000-0000-4000-8000-000000000003';
const courseId = '20000000-0000-4000-8000-000000000004';
const periodId = '20000000-0000-4000-8000-000000000005';
const subjectId = '20000000-0000-4000-8000-000000000006';
const otherTenantId = '20000000-0000-4000-8000-000000000007';
const foreignTeacher = '20000000-0000-4000-8000-000000000008';
const base = '/api/v1/tenants/edukmais';
function call(method: 'get'|'post'|'put', path: string, role = 'teacher') {
  return request(app)[method](`${base}${path}`).set('x-tenant-slug', 'edukmais').set('authorization', `Bearer valid-${role}-token`);
}
function foreignGet(path: string) {
  return request(app).get(`/api/v1/tenants/other${path}`).set('x-tenant-slug', 'other').set('authorization', 'Bearer valid-teacher-token');
}
async function draft(overrides: Record<string, unknown> = {}, role = 'admin') {
  const result = await call('post', '/notices', role).send({ title: 'Synthetic notice', content: 'Synthetic communication', audienceType: 'institution', priority: 'medium', ...overrides });
  expect(result.status).toBe(201);
  return result.body as {id:string;revision:number;state:string};
}
async function publishNotice(overrides: Record<string, unknown> = {}, role = 'admin') {
  const notice = await draft(overrides, role);
  const result = await call('post', `/notices/${notice.id}/publish`, role).send({ expectedRevision:notice.revision });
  expect(result.status).toBe(200);
  return result.body as {id:string;revision:number};
}
async function conversation() {
  const response = await call('post', '/conversations', 'student').send({ classId, participantId:teacherId });
  expect(response.status).toBe(201);
  return response.body as {id:string;lastSequence:number};
}
async function notificationFor(resourceId: string, role = 'student') {
  const response = await call('get', '/notifications?limit=100', role);
  expect(response.status).toBe(200);
  return response.body.data.filter((entry: {resourceId:string}) => entry.resourceId === resourceId) as Array<{id:string;type:string;resourceId:string;readAt:string|null}>;
}

beforeAll(async () => {
  await db.from('app_users').update({id:studentId,active:true}).eq('id','user-student');
  await db.from('app_users').update({id:teacherId,active:true}).eq('id','user-teacher');
  await db.from('courses').insert({id:courseId,tenant_id:tenantId,name:'Synthetic course'});
  await db.from('academic_periods').insert({id:periodId,tenant_id:tenantId,code:'SYN',name:'Synthetic',status:'active'});
  await db.from('subjects').insert({id:subjectId,tenant_id:tenantId,course_id:courseId,code:'SYN',name:'Synthetic',status:'active'});
  await db.from('classes').insert({id:classId,tenant_id:tenantId,course_id:courseId,subject_id:subjectId,academic_period_id:periodId,academic_status:'active',name:'Synthetic communication offering'});
  await db.from('enrollments').insert({id:'communication-enrollment',tenant_id:tenantId,class_id:classId,student_id:studentId,status:'active'});
  await db.from('teaching_assignments').insert({id:'communication-assignment',tenant_id:tenantId,class_id:classId,teacher_id:teacherId,status:'active'});
  await db.from('tenants').insert({id:otherTenantId,slug:'other',name:'Synthetic other',plan:'starter',status:'active'});
  await db.from('app_users').insert({id:foreignTeacher,tenant_id:otherTenantId,auth_user_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',role:'teacher',name:'Synthetic foreign',email:'foreign@example.invalid',active:true});
});
afterEach(async () => {
  jest.restoreAllMocks();
  await db.from('app_users').update({active:true}).eq('tenant_id',tenantId);
  await db.from('enrollments').update({status:'active'}).eq('id','communication-enrollment');
  await db.from('teaching_assignments').update({status:'active'}).eq('id','communication-assignment');
  await db.from('academic_periods').update({status:'active'}).eq('id',periodId);
});

describe('academic notices', () => {
  it.each(['2026-10-26T12:00:00+99:99','2026-10-26T12:00:00+24:00','2026-10-26T12:00:00+00:99'])('rejects an invalid timezone offset as validation: %s', async expiresAt => {
    const response = await call('post','/notices','admin').send({title:'Synthetic invalid offset',content:'Synthetic',audienceType:'institution',expiresAt});
    expect(response.status).toBe(400);
  });
  it('allows an institution administrator to publish and notify its recipients', async () => {
    const notice = await publishNotice();
    const detail = await call('get',`/notices/${notice.id}`,'student');
    expect(detail.status).toBe(200); expect(detail.body.title).toBe('Synthetic notice');
    expect(await notificationFor(notice.id)).toHaveLength(1);
  });
  it('allows an assigned teacher to publish to its offering', async () => {
    const notice = await publishNotice({audienceType:'class',classId},'teacher');
    expect((await call('get',`/notices/${notice.id}`,'student')).status).toBe(200);
  });
  it('rejects students, institutional teacher publication and unassigned offerings', async () => {
    expect((await call('post','/notices','student').send({title:'Forbidden',content:'No',audienceType:'institution'})).status).toBe(403);
    expect((await call('post','/notices').send({title:'Forbidden',content:'No',audienceType:'institution'})).status).toBe(403);
    await db.from('teaching_assignments').update({status:'inactive'}).eq('id','communication-assignment');
    expect((await call('post','/notices').send({title:'Forbidden',content:'No',audienceType:'class',classId})).status).toBe(403);
  });
  it('protects drafts and rejects cross-tenant resources', async () => {
    const notice = await draft();
    expect((await call('get',`/notices/${notice.id}`,'student')).status).toBe(404);
    expect((await foreignGet(`/notices/${notice.id}`)).status).toBe(404);
    expect(await notificationFor(notice.id)).toHaveLength(0);
  });
  it('resolves course recipients from formal links rather than a textual course', async () => {
    const notice = await publishNotice({audienceType:'course',courseId});
    expect((await call('get',`/notices/${notice.id}`,'student')).status).toBe(200);
  });
  it('materializes recipients and preserves historical access after cancellation', async () => {
    const first = await publishNotice({audienceType:'class',classId},'teacher');
    await db.from('enrollments').update({status:'cancelled'}).eq('id','communication-enrollment');
    expect((await call('get',`/notices/${first.id}`,'student')).status).toBe(200);
    const next = await publishNotice({audienceType:'class',classId},'teacher');
    expect((await call('get',`/notices/${next.id}`,'student')).status).toBe(404);
    expect(await notificationFor(next.id)).toHaveLength(0);
  });
  it('confirms only its own read idempotently and requires the revision seen', async () => {
    const notice = await publishNotice();
    const first = await call('post',`/notices/${notice.id}/read`,'student').send({expectedRevision:notice.revision});
    const repeat = await call('post',`/notices/${notice.id}/read`,'student').send({expectedRevision:notice.revision});
    expect(first.status).toBe(200); expect(repeat.body).toEqual(first.body);
    expect((await call('post',`/notices/${notice.id}/read`,'student').send({expectedRevision:notice.revision,userId:teacherId})).status).toBe(400);
    expect((await call('post',`/notices/${notice.id}/read`,'student').send({expectedRevision:1})).status).toBe(409);
    expect((await call('get',`/notices/${notice.id}`)).body.readAt).toBeNull();
  });
  it('protects audience and stale updates, retains revisions and avoids repeated publication notifications', async () => {
    const notice = await publishNotice();
    expect((await call('put',`/notices/${notice.id}`,'admin').send({expectedRevision:notice.revision,audienceType:'course',courseId})).status).toBe(400);
    const edited = await call('put',`/notices/${notice.id}`,'admin').send({expectedRevision:notice.revision,content:'Revised synthetic content'});
    expect(edited.status).toBe(200); expect(edited.body.revision).toBe(notice.revision+1);
    expect((await call('put',`/notices/${notice.id}`,'admin').send({expectedRevision:notice.revision,title:'Stale'})).status).toBe(409);
    expect((await call('get',`/notices/${notice.id}/history`,'admin')).body.data.length).toBeGreaterThanOrEqual(3);
    expect((await call('get',`/notices/${notice.id}/history`,'student')).status).toBe(403);
    expect(await notificationFor(notice.id)).toHaveLength(1);
  });
  it('keeps expired and archived notices in history without showing them as active', async () => {
    const expiresAt = new Date(Date.now()+60000).toISOString();
    const notice = await publishNotice({expiresAt});
    jest.spyOn(Date,'now').mockReturnValue(Date.parse(expiresAt)+1);
    expect((await call('get','/notices?view=active&limit=100','student')).body.data.some((row:{id:string})=>row.id===notice.id)).toBe(false);
    expect((await call('get','/notices?view=history&limit=100','student')).body.data.some((row:{id:string})=>row.id===notice.id)).toBe(true);
    const archived = await call('post',`/notices/${notice.id}/archive`,'admin').send({expectedRevision:notice.revision});
    expect(archived.status).toBe(200); expect(archived.body.state).toBe('archived');
  });
});

describe('persistent academic conversations', () => {
  it('distinguishes a closed academic period conflict from a missing academic relationship', async () => {
    const item = await conversation();
    const notice = await draft({audienceType:'class',classId},'teacher');
    await db.from('academic_periods').update({status:'closed'}).eq('id',periodId);
    expect((await call('post',`/conversations/${item.id}/messages`).send({content:'Synthetic closed period',clientMessageId:randomUUID()})).status).toBe(409);
    expect((await call('post',`/notices/${notice.id}/publish`).send({expectedRevision:notice.revision})).status).toBe(409);
  });
  it('creates a legitimate individual conversation idempotently in either direction', async () => {
    const first = await conversation();
    const other = await call('post','/conversations').send({classId,participantId:studentId});
    expect(other.status).toBe(201); expect(other.body.id).toBe(first.id);
    expect((await call('get',`/conversations/${first.id}`,'student')).status).toBe(200);
  });
  it('rejects participants without a current formal link or from another tenant', async () => {
    expect((await call('post','/conversations','student').send({classId,participantId:foreignTeacher})).status).toBe(404);
    await db.from('teaching_assignments').update({status:'inactive'}).eq('id','communication-assignment');
    expect((await call('post','/conversations','student').send({classId,participantId:teacherId})).status).toBe(403);
  });
  it('does not grant administrators or foreign tenants access to private conversations', async () => {
    const item = await conversation();
    expect((await call('get',`/conversations/${item.id}`,'admin')).status).toBe(404);
    expect((await call('get',`/conversations/${item.id}/messages`,'coordinator')).status).toBe(404);
    expect((await foreignGet(`/conversations/${item.id}`)).status).toBe(404);
  });
  it('persists messages, protects sender identity and bounds content', async () => {
    const item = await conversation();
    const result = await call('post',`/conversations/${item.id}/messages`).send({content:'Synthetic private message',clientMessageId:randomUUID()});
    expect(result.status).toBe(201); expect(result.body.senderId).toBe(teacherId);
    expect((await call('get',`/conversations/${item.id}/messages?afterSequence=${result.body.sequence-1}`,'student')).body.data[0].content).toBe('Synthetic private message');
    for (const content of ['', ' '.repeat(2), 'x'.repeat(10001)]) expect((await call('post',`/conversations/${item.id}/messages`).send({content,clientMessageId:randomUUID()})).status).toBe(400);
    expect((await call('post',`/conversations/${item.id}/messages`).send({content:'Spoofed',clientMessageId:randomUUID(),senderId:studentId})).status).toBe(400);
  });
  it('handles retries and competing requests without duplicate messages or notifications', async () => {
    const item = await conversation(), payload={content:'Idempotent synthetic message',clientMessageId:randomUUID()};
    const [first,second] = await Promise.all([call('post',`/conversations/${item.id}/messages`).send(payload),call('post',`/conversations/${item.id}/messages`).send(payload)]);
    expect(first.status).toBe(201);expect(second.status).toBe(201);expect(first.body.id).toBe(second.body.id);
    expect((await call('post',`/conversations/${item.id}/messages`).send({...payload,content:'Different content'})).status).toBe(409);
    expect(await notificationFor(first.body.id)).toHaveLength(1);
    expect(await notificationFor(first.body.id,'teacher')).toHaveLength(0);
  });
  it('paginates by monotonic sequence and confirms reads without changing another user', async () => {
    const item = await conversation();
    const sent=[];
    for (let i=0;i<3;i++) sent.push((await call('post',`/conversations/${item.id}/messages`).send({content:`Synthetic ${i}`,clientMessageId:randomUUID()})).body);
    const page=await call('get',`/conversations/${item.id}/messages?afterSequence=${sent[0].sequence-1}&limit=1`,'student');
    expect(page.status).toBe(200);expect(page.body.data[0].id).toBe(sent[0].id);expect(page.body.meta.hasMore).toBe(true);
    const next=await call('get',`/conversations/${item.id}/messages?afterSequence=${page.body.meta.nextAfterSequence}&limit=1`,'student');
    expect(next.body.data[0].id).toBe(sent[1].id);
    const read=await call('post',`/conversations/${item.id}/read`,'student').send({upToSequence:sent[2].sequence});
    expect(read.status).toBe(200);
    expect((await call('post',`/conversations/${item.id}/read`,'student').send({upToSequence:sent[1].sequence})).body).toEqual(read.body);
    const history=await call('get',`/conversations/${item.id}/messages?afterSequence=${sent[0].sequence-1}`);
    expect(history.body.data.every((row:{readByRecipient:boolean})=>row.readByRecipient)).toBe(true);
    expect((await call('post',`/conversations/${item.id}/read`,'student').send({upToSequence:2147483646})).status).toBe(409);
  });
  it('preserves history after cancellation but refuses new messages', async () => {
    const item=await conversation();
    await db.from('enrollments').update({status:'cancelled'}).eq('id','communication-enrollment');
    expect((await call('get',`/conversations/${item.id}/messages`,'student')).status).toBe(200);
    expect((await call('post',`/conversations/${item.id}/messages`,'student').send({content:'Forbidden new message',clientMessageId:randomUUID()})).status).toBe(403);
  });
});

describe('internal academic notifications and HTTP protections', () => {
  it('sanitizes unexpected service failures and preserves request correlation', async () => {
    jest.spyOn(CommunicationRepository.prototype,'execute').mockRejectedValueOnce(new Error('PRIVATE SQL credential message'));
    const response = await call('get','/notifications','student');
    expect(response.status).toBe(500);expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE SQL');
  });
  it('notifies eligible students only after activity publication', async () => {
    const created=await call('post',`/classes/${classId}/activities`).send({title:'Synthetic notified activity'});
    expect(created.status).toBe(201);expect(await notificationFor(created.body.id)).toHaveLength(0);
    expect((await call('post',`/activities/${created.body.id}/publish`).send({expectedVersion:created.body.revision})).status).toBe(200);
    expect((await notificationFor(created.body.id))[0].type).toBe('activity_published');
  });
  it('notifies a result only after publication and preserves zero without embedding it in notifications', async () => {
    const activity=await call('post',`/classes/${classId}/activities`).send({title:'Synthetic graded activity'});
    await call('post',`/activities/${activity.body.id}/publish`).send({expectedVersion:activity.body.revision});
    const submission=await call('post',`/activities/${activity.body.id}/submissions`,'student').send({answer:'Synthetic answer',expectedVersion:0});
    expect(submission.status).toBe(201);
    const draftResult=await call('put',`/submissions/${submission.body.id}/review`).send({expectedRevision:0,submissionVersion:1,grade:0,feedback:'PRIVATE feedback'});
    expect(draftResult.status).toBe(200);
    expect((await call('get','/notifications?limit=100','student')).body.data.some((row:{type:string})=>row.type==='activity_result_published')).toBe(false);
    const published=await call('post',`/submissions/${submission.body.id}/review/publish`).send({expectedRevision:draftResult.body.revision});
    expect(published.status).toBe(200);expect(published.body.grade).toBe(0);
    const result=(await call('get','/notifications?limit=100','student')).body.data.find((row:{type:string})=>row.type==='activity_result_published');
    expect(result).toBeDefined();expect(JSON.stringify(result)).not.toContain('PRIVATE feedback');expect(result.grade).toBeUndefined();
  });
  it('isolates reads/count and rejects notifications belonging to another recipient', async () => {
    const notice=await publishNotice({audienceType:'class',classId},'teacher');
    const notification=(await notificationFor(notice.id))[0];
    const before=await call('get','/notifications/unread-count','student');
    const first=await call('post',`/notifications/${notification.id}/read`,'student').send({});
    expect(first.status).toBe(200);expect((await call('post',`/notifications/${notification.id}/read`,'student').send({})).body).toEqual(first.body);
    expect((await call('get','/notifications/unread-count','student')).body.unreadCount).toBe(before.body.unreadCount-1);
    expect((await call('post',`/notifications/${notification.id}/read`,'admin').send({})).status).toBe(404);
    expect((await call('get','/notifications?recipientId=forbidden','student')).status).toBe(400);
  });
  it('blocks inactive accounts and avoids notifying them as active recipients', async () => {
    await db.from('app_users').update({active:false}).eq('id',studentId);
    const notice=await publishNotice();
    expect((await call('get','/notifications','student')).status).toBe(403);
    await db.from('app_users').update({active:true}).eq('id',studentId);
    expect(await notificationFor(notice.id)).toHaveLength(0);
  });
  it('keeps private content and dynamic identifiers out of logs and preserves no-store', async () => {
    const item=await conversation();
    const logs=jest.spyOn(logger,'request');
    const response=await call('post',`/conversations/${item.id}/messages`).send({content:'PRIVATE MESSAGE CONTENT',clientMessageId:randomUUID()});
    expect(response.status).toBe(201);expect(response.headers['cache-control']).toContain('no-store');
    const serialized=JSON.stringify(logs.mock.calls);
    for(const secret of ['PRIVATE MESSAGE CONTENT','valid-teacher-token',item.id,'edukmais'])expect(serialized).not.toContain(secret);
    expect(logs.mock.calls[0][0].route).toContain('/conversations/:id/messages');
  });
  it('keeps existing error correlation and validates malformed JSON, identifiers and query parameters', async () => {
    const bad=await call('post','/notices','admin').set('content-type','application/json').send('{');
    expect(bad.status).toBe(400);expect(bad.body.error.requestId).toBe(bad.headers['x-request-id']);
    expect((await call('get','/notices/not-a-uuid')).status).toBe(400);
    expect((await call('get','/conversations?page=0')).status).toBe(400);
    expect((await call('get','/notifications?unreadOnly=invalid')).status).toBe(400);
    expect((await request(app).get(`${base}/notifications`)).status).toBe(401);
  });
});
