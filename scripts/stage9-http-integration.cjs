const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { isAllowedUrl, startLocalHarness } = require('./lib/stage9-local.cjs');

if (process.argv.includes('--self-test')) {
  selfTest().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  main().catch(error => {
    console.error(`Stage9 HTTP integration FAIL: ${error.safeMessage || 'local execution failed; private body, tokens and connection details withheld.'}`);
    if (error.code && /^[A-Z0-9_]{1,40}$/.test(error.code)) console.error(`Diagnostic code: ${error.code}`);
    process.exitCode = 1;
  });
}

async function closeHarness(harness) {
  try { await harness.close(); }
  catch (error) { harness.evidence.result = 'FAIL'; throw error; }
}

async function selfTest() {
  assert.equal(isAllowedUrl('https://example.invalid/'), false, 'External network must be rejected.');
  assert.equal(isAllowedUrl('http://127.0.0.1:1234/', new Set(['http://127.0.0.1:1234'])), true);
  assert.equal(isAllowedUrl('http://127.0.0.1:4321/', new Set(['http://127.0.0.1:1234'])), false);
  assert.equal(isAllowedUrl('http://localhost:1234/', new Set(['http://127.0.0.1:1234'])), false);
  assert.equal(isAllowedUrl('http://user:password@127.0.0.1:1234/', new Set(['http://127.0.0.1:1234'])), false);
  assert.equal(isAllowedUrl('https://127.0.0.1:1234/', new Set(['http://127.0.0.1:1234'])), false);
  const cleanupFailure = new Error('Synthetic cleanup failure');
  const failedCleanup = { evidence: { result: 'PASS' }, close: async () => { throw cleanupFailure; } };
  await assert.rejects(closeHarness(failedCleanup), error => error === cleanupFailure);
  assert.equal(failedCleanup.evidence.result, 'FAIL', 'Failed cleanup must invalidate PASS evidence before output.');
  const passedCleanup = { evidence: { result: 'PASS' }, close: async () => {} };
  await closeHarness(passedCleanup);
  assert.equal(passedCleanup.evidence.result, 'PASS');
  const failedExecution = { evidence: { result: 'FAIL' }, close: async () => {} };
  await closeHarness(failedExecution);
  assert.equal(failedExecution.evidence.result, 'FAIL');
  console.log('Stage9 safety expectations: PASS');
}

async function main() {
  let harness;
  let checks = 0;
  let requests = 0;
  let current = 'bootstrap';
  const phasesStarted = [];
  const failedNegativeExpectations = [];
  function check(value, label) {
    if (!value) { const error = new Error(label); error.safeMessage = `${current}: ${label}`; throw error; }
    checks++;
  }
  function phase(name) { current = name; phasesStarted.push(name); }
  try {
    harness = await startLocalHarness();
    const { db, password } = harness;
    const tenantId = randomUUID(), foreignId = randomUUID();
    const slug = 'stage9-synthetic-a', foreignSlug = 'stage9-synthetic-b';
    const base = `/api/v1/tenants/${slug}`;
    await db.query("insert into tenants(id,name,slug) values($1,'Synthetic A',$2),($3,'Synthetic B',$4)", [tenantId, slug, foreignId, foreignSlug]);
    async function bootstrapMember(role, email, tenant = tenantId) {
      const auth = await harness.createAuth(email);
      const id = randomUUID();
      await db.query('insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) values($1,$2,$3,$4,$5,$6,true)', [id, tenant, auth.id, 'Synthetic bootstrap', email, role]);
      return { id, auth: auth.id, email };
    }
    const manager = await bootstrapMember('admin', 'manager@stage9.invalid');
    const stranger = await bootstrapMember('teacher', 'unassigned@stage9.invalid');
    const outsider = await bootstrapMember('student', 'foreign@stage9.invalid', foreignId);
    async function request(method, path, token, body, expected = 200, tenantSlug = slug) {
      requests++;
      const headers = { 'x-tenant-slug': tenantSlug, 'x-request-id': `stage9-${requests}` };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${harness.apiOrigin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      let value;
      if (response.status !== 204) value = await response.json();
      const expectedStatuses = Array.isArray(expected) ? expected : [expected];
      const statusLabel = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id')} expected ${expectedStatuses.join('/')} received ${response.status}; code=${value?.error?.code || 'none'}`;
      if (!expectedStatuses.includes(response.status) && expectedStatuses.every(status => status >= 400) && response.status >= 400 && process.argv.includes('--collect-negative-failures')) {
        failedNegativeExpectations.push(`${current}: ${statusLabel}`);
      } else check(expectedStatuses.includes(response.status), statusLabel);
      check(/^[0-9a-f-]{36}$/.test(response.headers.get('x-request-id') || ''), 'Server generates request ID');
      check(response.headers.get('cache-control') === 'no-store, private', 'Sensitive response has no-store');
      if (response.status >= 400) check(value?.error?.requestId === response.headers.get('x-request-id'), 'Error correlates with request ID');
      return { status: response.status, value };
    }
    const api = async (method, path, token, body, status = 200) => (await request(method, `${base}${path}`, token, body, status)).value;
    async function login(email, admin = false, tenantSlug = slug) {
      const value = (await request('POST', `/api/v1/auth/${admin ? 'admin/login' : 'login'}`, undefined, { email, password }, 200, tenantSlug)).value;
      check(typeof value.accessToken === 'string' && value.user?.id, 'Login returns session and institutional user');
      return value.accessToken;
    }
    phase('institutional management');
    const managerToken = await login(manager.email, true);
    const teacher = await api('POST', '/users', managerToken, { name: 'Synthetic teacher', email: 'teacher@stage9.invalid', password, role: 'professor' }, 201);
    const student = await api('POST', '/users', managerToken, { name: 'Synthetic student', email: 'student@stage9.invalid', password, role: 'aluno' }, 201);
    check(teacher.id !== student.id, 'Distinct institutional identities');
    const studentAuth = (await db.query('select auth_user_id from app_users where id=$1', [student.id])).rows[0].auth_user_id;
    check(studentAuth !== student.id, 'Auth and institutional UUIDs deliberately differ');
    const teacherAuth = (await db.query('select auth_user_id from app_users where id=$1', [teacher.id])).rows[0].auth_user_id;
    const course = await api('POST', '/courses', managerToken, { name: 'Synthetic course' }, 201);
    const period = await api('POST', '/academic-periods', managerToken, { code: 'SYN-2026', name: 'Synthetic period', status: 'active' }, 201);
    const subject = await api('POST', '/subjects', managerToken, { courseId: course.id, code: 'SYN101', name: 'Synthetic subject' }, 201);
    const offering = await api('POST', '/offerings', managerToken, { courseId: course.id, subjectId: subject.id, periodId: period.id, name: 'Synthetic offering' }, 201);
    const enrollment = await api('POST', '/enrollments', managerToken, { classId: offering.id, studentId: student.id }, 201);
    const assignment = await api('POST', '/teaching-assignments', managerToken, { classId: offering.id, teacherId: teacher.id }, 201);
    check(enrollment.studentId === student.id && assignment.teacherId === teacher.id, 'Enrollment and assignment use institutional identities');
    const teacherToken = await login(teacher.email);
    const studentToken = await login(student.email);
    const strangerToken = await login(stranger.email);
    const foreignToken = await login(outsider.email, false, foreignSlug);
    const teacherOfferings = await api('GET', '/offerings', teacherToken);
    check(teacherOfferings.meta.total === 1 && teacherOfferings.data[0].id === offering.id, 'Teacher sees assigned offering via real count header');
    check((await api('GET', '/offerings', strangerToken)).meta.total === 0, 'Unassigned teacher sees no offerings');
    const overview = await api('GET', '/academic/overview', studentToken);
    check(overview.source.providerId === 'native' && overview.subjects.length === 1 && overview.scope.userId === student.id, 'Student Native overview derives enrollment');

    phase('activity publication and notifications');
    const activity = await api('POST', `/classes/${offering.id}/activities`, teacherToken, { title: 'Synthetic activity', instructions: 'Synthetic instructions' }, 201);
    check(activity.state === 'draft' && activity.createdBy === teacherAuth, 'Draft activity created by teacher Auth identity');
    await api('GET', `/activities/${activity.id}`, studentToken, undefined, 404);
    const published = await api('POST', `/activities/${activity.id}/publish`, teacherToken, { expectedVersion: activity.revision });
    check(published.state === 'published', 'Activity is published');
    await api('POST', `/activities/${activity.id}/publish`, teacherToken, { expectedVersion: activity.revision }, 409);
    check((await db.query("select count(*)::int as n from academic_notifications where user_id=$1 and activity_id=$2 and event_type='activity_published'", [student.id, activity.id])).rows[0].n === 1, 'Activity retry does not duplicate notifications');
    check((await api('GET', `/activities/${activity.id}`, studentToken)).id === activity.id, 'Student reads published activity');
    let notifications = await api('GET', '/notifications', studentToken);
    check(notifications.data.some(row => row.type === 'activity_published' && row.resourceId === activity.id), 'Activity publication reaches enrolled student');
    check((await api('GET', '/academic/overview', studentToken)).subjects[0].activities.some(row => row.activityId === activity.id), 'Native overview includes published activity');

    phase('concurrent submission and private draft review');
    const deliveryPath = `/activities/${activity.id}/submissions`;
    const deliveries = await Promise.all([1, 2].map(() => request('POST', `${base}${deliveryPath}`, studentToken, { expectedVersion: 0, answer: 'Synthetic response' }, [201, 409])));
    check(deliveries.map(row => row.status).sort().join(',') === '201,409', 'Concurrent submissions yield one success and one conflict');
    const delivery = deliveries.find(row => row.status === 201).value;
    check((await db.query('select count(*)::int as n from activity_submissions where activity_id=$1 and student_id=$2', [activity.id, student.id])).rows[0].n === 1, 'Exactly one physical submission');
    check((await db.query('select count(*)::int as n from activity_submission_versions where submission_id=$1', [delivery.id])).rows[0].n === 1, 'Exactly one physical submission version');
    const listed = await api('GET', deliveryPath, teacherToken);
    check(listed.meta.total === 1 && listed.data[0].id === delivery.id, 'Teacher queries actual submission');
    await api('PUT', `/submissions/${delivery.id}/review`, strangerToken, { expectedRevision: 0, submissionVersion: 1, grade: 10 }, 404);
    const review = await api('PUT', `/submissions/${delivery.id}/review`, teacherToken, { expectedRevision: 0, submissionVersion: 1, grade: 0, feedback: 'Synthetic private feedback', publish: false });
    check(review.publicationState === 'draft' && review.grade === 0, 'Zero preserved in draft review');
    check((await api('GET', `/submissions/${delivery.id}`, studentToken)).result === null, 'Draft grade withheld from student receipt');
    check((await api('GET', `/submissions/${delivery.id}/history`, studentToken)).evaluations.length === 0, 'Draft grade withheld from student history');
    check((await api('GET', `/students/${studentAuth}/grades`, studentToken)).data.length === 0, 'Draft grade withheld from legacy grades route');
    const draftAssessment = (await api('GET', '/academic/overview', studentToken)).subjects[0].assessments.find(row => row.activityId === activity.id);
    check(draftAssessment?.grade === null && draftAssessment.feedback === null && draftAssessment.gradedAt === null, 'Draft grade and private feedback withheld from Native provider');
    check((await db.query("select count(*)::int as n from academic_notifications where user_id=$1 and event_type='activity_result_published'", [student.id])).rows[0].n === 0, 'Draft emits no result notification');

    phase('result publication');
    const result = await api('POST', `/submissions/${delivery.id}/review/publish`, teacherToken, { expectedRevision: review.revision });
    check(result.publicationState === 'published' && result.grade === 0, 'Published zero retained');
    await api('POST', `/submissions/${delivery.id}/review/publish`, teacherToken, { expectedRevision: review.revision }, 409);
    check((await db.query("select count(*)::int as n from academic_notifications where user_id=$1 and event_type='activity_result_published'", [student.id])).rows[0].n === 1, 'Result retry does not duplicate notifications');
    const own = await api('GET', `${deliveryPath}/me`, studentToken);
    check(own.result.grade === 0 && own.result.feedback === 'Synthetic private feedback', 'Student sees published zero and feedback');
    const grades = await api('GET', `/students/${studentAuth}/grades`, studentToken);
    check(grades.data.length === 1 && grades.data[0].grade === 0, 'Legacy grade route sees published zero using Auth UUID');
    check((await db.query('select student_id from grades where submission_id=$1', [delivery.id])).rows[0].student_id === studentAuth, 'Stored grades use Auth identity while submissions use institutional identity');
    const assessed = (await api('GET', '/academic/overview', studentToken)).subjects[0].assessments;
    check(assessed.some(row => row.activityId === activity.id && row.grade === 0), 'Native provider exposes published zero');
    notifications = await api('GET', '/notifications', studentToken);
    const resultNotification = notifications.data.find(row => row.type === 'activity_result_published');
    check(Boolean(resultNotification), 'Result notification delivered');
    await api('POST', `/notifications/${resultNotification.id}/read`, studentToken, {});
    check((await api('GET', '/notifications', studentToken)).data.find(row => row.id === resultNotification.id).readAt !== null, 'Result notification read persisted');

    phase('notice publication and read');
    const notice = await api('POST', '/notices', teacherToken, { audienceType: 'class', classId: offering.id, title: 'Synthetic notice', content: 'Synthetic notice body' }, 201);
    await api('GET', `/notices/${notice.id}`, studentToken, undefined, 404);
    const publishedNotice = await api('POST', `/notices/${notice.id}/publish`, teacherToken, { expectedRevision: notice.revision });
    check((await api('GET', '/notices', studentToken)).data.some(row => row.id === notice.id), 'Notice visible after publication');
    const read = await api('POST', `/notices/${notice.id}/read`, studentToken, { expectedRevision: publishedNotice.revision });
    check(read.readRevision === publishedNotice.revision, 'Notice revision read recorded');
    check((await api('GET', `/notices/${notice.id}`, studentToken)).readAt !== null, 'Notice read visible');
    check((await api('GET', '/notifications', studentToken)).data.some(row => row.type === 'notice_published' && row.resourceId === notice.id), 'Notice notification delivered');

    phase('private conversation and idempotent messages');
    const conversation = await api('POST', '/conversations', teacherToken, { classId: offering.id, participantId: student.id }, 201);
    check(conversation.studentId === student.id && conversation.teacherId === teacher.id, 'Conversation participants are institutional identities');
    await api('GET', `/conversations/${conversation.id}`, strangerToken, undefined, 404);
    const messageBody = { content: 'Synthetic confidential message', clientMessageId: randomUUID() };
    const messages = await Promise.all([1, 2].map(() => api('POST', `/conversations/${conversation.id}/messages`, teacherToken, messageBody, 201)));
    check(messages[0].id === messages[1].id && messages[0].sequence === messages[1].sequence, 'Concurrent message retry returns same message');
    const retry = await api('POST', `/conversations/${conversation.id}/messages`, teacherToken, messageBody, 201);
    check(retry.id === messages[0].id, 'Sequential retry returns same message');
    check((await db.query('select count(*)::int as n from messages where conversation_id=$1', [conversation.id])).rows[0].n === 1, 'One physical message after concurrent and sequential retry');
    check((await db.query("select count(*)::int as n from academic_notifications where user_id=$1 and event_type='message_received' and message_id=$2", [student.id, retry.id])).rows[0].n === 1, 'One message notification after retries');
    check((await api('GET', `/conversations/${conversation.id}/messages`, studentToken)).data[0].id === retry.id, 'Student reads authorized message');
    const messageRead = await api('POST', `/conversations/${conversation.id}/read`, studentToken, { upToSequence: retry.sequence });
    check(messageRead.lastReadSequence === retry.sequence, 'Message read watermark persisted');
    check((await api('GET', `/conversations/${conversation.id}/messages`, teacherToken)).data[0].readByRecipient, 'Teacher sees recipient acknowledgement');
    const reply = await api('POST', `/conversations/${conversation.id}/messages`, studentToken, { content: 'Synthetic student reply', clientMessageId: randomUUID() }, 201);
    check(reply.sequence === 2, 'Student can reply to authorized teacher');
    const firstPage = await api('GET', `/conversations/${conversation.id}/messages?limit=1`, studentToken);
    const secondPage = await api('GET', `/conversations/${conversation.id}/messages?limit=1&afterSequence=${firstPage.meta.nextAfterSequence}`, studentToken);
    check(firstPage.meta.hasMore && firstPage.data[0].id !== secondPage.data[0].id && !secondPage.meta.hasMore, 'Stable sequence pagination has no duplicate');

    phase('tenant boundaries and inactive membership');
    await request('GET', `/api/v1/tenants/${foreignSlug}/academic/overview`, studentToken, undefined, 403, foreignSlug);
    await api('GET', `/submissions/${delivery.id}`, foreignToken, undefined, 403);
    await request('GET', `${base}/academic/overview`, studentToken, undefined, 404, foreignSlug);
    await api('GET', `/conversations/${conversation.id}/messages`, strangerToken, undefined, 404);
    const before = await api('GET', '/reports/summary', managerToken);
    await api('PATCH', `/users/${student.id}/status`, managerToken, { active: false });
    const after = await api('GET', '/reports/summary', managerToken);
    check(after.totalUsers === before.totalUsers && after.activeStudents === before.activeStudents - 1, 'Deactivation preserves totalUsers and reduces activeStudents');
    for (const path of ['/academic/overview', '/notifications', `/conversations/${conversation.id}`, `/activities/${activity.id}`, `/submissions/${delivery.id}`]) {
      await api('GET', path, studentToken, undefined, 403);
    }
    await request('POST', '/api/v1/auth/login', undefined, { email: student.email, password }, 403);
    await api('PATCH', `/users/${student.id}/status`, managerToken, { active: true });
    check((await api('GET', '/academic/overview', studentToken)).subjects.length === 1, 'Reactivated member retains academic history');
    await api('PATCH', `/enrollments/${enrollment.id}`, managerToken, { status: 'cancelled' });
    check((await api('GET', `/conversations/${conversation.id}/messages`, studentToken)).data.length === 2, 'Former participant retains authorized conversation history');
    await api('POST', `/conversations/${conversation.id}/messages`, studentToken, { content: 'Synthetic cancelled enrollment attempt', clientMessageId: randomUUID() }, 403);
    check((await db.query('select count(*)::int as n from messages where conversation_id=$1', [conversation.id])).rows[0].n === 2, 'Enrollment change preserves conversation history');
    await api('PATCH', `/enrollments/${enrollment.id}`, managerToken, { status: 'active' });
    await request('POST', '/api/v1/auth/logout', teacherToken, {}, 204);
    await api('GET', '/offerings', teacherToken, undefined, 401);
    check(harness.stats.forbiddenNetwork === 0, 'No external fetch attempted');
    check(harness.stats.restRequests > 0 && harness.stats.rpcRequests > 0 && harness.stats.countHeaders > 0 && harness.stats.rangeRequests > 0 && harness.stats.preferRequests > 0, 'Real SDK requests and PostgREST count/range/prefer observed');
    harness.evidence.databaseRows = (await db.query(`select (select count(*)::int from app_users) as users,(select count(*)::int from activity_submissions) as submissions,
      (select count(*)::int from grades) as grades,(select count(*)::int from messages) as messages,(select count(*)::int from academic_notifications) as notifications`)).rows[0];
    check(failedNegativeExpectations.length === 0, `${failedNegativeExpectations.length} failed negative expectations; see artifact`);
    harness.evidence.result = 'PASS';
  } catch (error) {
    if (!error.safeMessage) error.safeMessage = `${current}: execution failed${error.code ? ` (${error.code})` : ''}; sensitive details withheld`;
    if (harness) harness.evidence.result = 'FAIL';
    throw error;
  } finally {
    if (harness) {
      try { await closeHarness(harness); }
      finally { console.log(JSON.stringify({ ...harness.evidence, checks, httpRequests: requests, phasesStarted, failedNegativeExpectations, transport: harness.stats })); }
    }
  }
}
