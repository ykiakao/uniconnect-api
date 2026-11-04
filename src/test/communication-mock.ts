import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
type Result = { data: unknown; error: { code: string; message: string } | null; status: number };
class Rejected { constructor(readonly code: string) {} }
function reject(code = '23514'): never { throw new Rejected(code); }
const tables = ['academic_notices', 'academic_notice_revisions', 'academic_notice_recipients', 'academic_conversations', 'academic_conversation_reads', 'academic_notifications', 'messages'];
function initialize(db: Store) { for (const table of tables) db[table] ??= []; }
function now() { return new Date(Date.now()).toISOString(); }
function active(user: Row) { return user.active !== false; }

function notify(db: Store, tenant: unknown, user: Row, type: string, resourceType: string, resourceId: unknown, key: string) {
  if (!active(user) || db.academic_notifications.some(row => row.tenant_id === tenant && row.recipient_id === user.id && row.event_key === key)) return;
  db.academic_notifications.push({ id: randomUUID(), tenant_id: tenant, recipient_id: user.id, event_type: type, resource_type: resourceType,
    resource_id: resourceId, event_key: key, created_at: now(), read_at: null });
}
function classRecipients(db: Store, tenant: unknown, classId: unknown) {
  return db.app_users.filter(user => user.tenant_id === tenant && active(user) && (
    user.role === 'student' && db.enrollments.some(link => link.tenant_id === tenant && link.class_id === classId && link.student_id === user.id && link.status === 'active') ||
    user.role === 'teacher' && db.teaching_assignments.some(link => link.tenant_id === tenant && link.class_id === classId && link.teacher_id === user.id && link.status === 'active')));
}

export function notifyWorkflowEvent(db: Store, name: string, args: Row, value: unknown) {
  initialize(db);
  if (!value || typeof value !== 'object') return;
  const row = value as Row, tenant = row.tenant_id;
  if (name === 'manage_academic_activity' && args.p_operation === 'publish' && row.state === 'published') {
    for (const user of classRecipients(db, tenant, row.class_id).filter(user => user.role === 'student')) {
      notify(db, tenant, user, 'activity_published', 'activity', row.id, `activity:${String(row.id)}:published`);
    }
  }
  if (['review_activity_submission', 'publish_activity_review', 'record_activity_grade'].includes(name) && row.publication_state === 'published') {
    const user = db.app_users.find(user => user.tenant_id === tenant && user.auth_user_id === row.student_id && user.role === 'student');
    if (user) notify(db, tenant, user, 'activity_result_published', 'grade', row.id, `grade:${String(row.id)}:published:${String(row.revision)}`);
  }
}

export function mockCommunicationRpc(name: string, args: Row, db: Store): Result | undefined {
  if (name !== 'academic_communication') return undefined;
  initialize(db);
  const tenant = args.p_tenant_id;
  const scoped = (table: string) => (db[table] ?? []).filter(row => row.tenant_id === tenant);
  const input = args.p_payload as Row;
  const operation = String(args.p_operation);
  const result = (value: unknown): Result => ({ data: structuredClone(value), error: null, status: 200 });
  try {
    const actor = scoped('app_users').find(user => user.id === args.p_actor_id && active(user)) ?? reject('42501');
    const manager = ['owner', 'admin', 'coordinator'].includes(String(actor.role));
    const assigned = (classId: unknown) => actor.role === 'teacher' && scoped('teaching_assignments').some(link => link.class_id === classId && link.teacher_id === actor.id && link.status === 'active');
    const canManage = (notice: Row) => manager || notice.audience_type === 'class' && assigned(notice.class_id);
    const notice = () => scoped('academic_notices').find(row => row.id === input.id) ?? reject('P0002');
    const receipt = (row: Row) => scoped('academic_notice_recipients').find(recipient => recipient.notice_id === row.id && recipient.user_id === actor.id);
    const noticeResult = (row: Row) => ({ ...row, read_at: receipt(row)?.read_at ?? null, read_revision: receipt(row)?.read_revision ?? 0 });
    const canRead = (row: Row) => canManage(row) || row.state !== 'draft' && !!receipt(row);
    const audit = (row: Row) => db.academic_notice_revisions.push({ ...structuredClone(row), notice_id: row.id, changed_by: actor.id, changed_at: now() });
    const page = (rows: Row[]) => ({ data: rows.slice(Number(input.offset), Number(input.offset) + Number(input.limit)), total: rows.length });
    const offering = (id: unknown) => scoped('classes').find(row => row.id === id) ?? reject('P0002');
    const eligibleOffering = (row: Row) => {
      if (row.academic_status !== 'active' || !scoped('academic_periods').some(period => period.id === row.academic_period_id && period.status === 'active') ||
          !scoped('subjects').some(subject => subject.id === row.subject_id && subject.status === 'active')) reject();
    };
    const conversation = () => scoped('academic_conversations').find(row => row.id === input.id && [row.student_id, row.teacher_id].includes(actor.id)) ?? reject('P0002');
    const validatePair = (classId: unknown, studentId: unknown, teacherId: unknown) => {
      eligibleOffering(offering(classId));
      if (!scoped('app_users').some(user => user.id === studentId && user.role === 'student' && active(user)) ||
          !scoped('app_users').some(user => user.id === teacherId && user.role === 'teacher' && active(user)) ||
          !scoped('enrollments').some(link => link.class_id === classId && link.student_id === studentId && link.status === 'active') ||
          !scoped('teaching_assignments').some(link => link.class_id === classId && link.teacher_id === teacherId && link.status === 'active')) reject('42501');
    };

    if (operation === 'notice_create') {
      if (!manager && !(input.audienceType === 'class' && assigned(input.classId))) reject('42501');
      if (input.audienceType === 'course' && !scoped('courses').some(row => row.id === input.courseId)) reject('P0002');
      if (input.audienceType === 'class') offering(input.classId);
      const row = { id: randomUUID(), tenant_id: tenant, author_id: actor.id, title: input.title, content: input.content,
        audience_type: input.audienceType, course_id: input.courseId ?? null, class_id: input.classId ?? null, priority: input.priority,
        expires_at: input.expiresAt ?? null, state: 'draft', revision: 1, created_at: now(), updated_at: now(), published_at: null };
      db.academic_notices.push(row); audit(row); return result(noticeResult(row));
    }
    if (['notice_update', 'notice_publish', 'notice_archive'].includes(operation)) {
      const row = notice();
      if (!canManage(row)) reject('42501');
      if (row.revision !== input.expectedRevision || row.state === 'archived') reject();
      if (operation === 'notice_update') {
        for (const field of ['title', 'content', 'priority', 'expiresAt']) if (input[field] !== undefined) row[field === 'expiresAt' ? 'expires_at' : field] = input[field];
      } else if (operation === 'notice_publish') {
        if (row.state !== 'draft' || row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) reject();
        if (row.audience_type === 'class') eligibleOffering(offering(row.class_id));
        row.state = 'published'; row.published_at = now();
        let recipients: Row[];
        if (row.audience_type === 'institution') recipients = scoped('app_users').filter(active);
        else if (row.audience_type === 'class') recipients = classRecipients(db, tenant, row.class_id);
        else {
          const classes = scoped('classes').filter(value => value.course_id === row.course_id);
          const ids = new Set(classes.flatMap(value => classRecipients(db, tenant, value.id)).map(user => user.id));
          recipients = scoped('app_users').filter(user => ids.has(user.id) && active(user));
        }
        for (const user of recipients) {
          db.academic_notice_recipients.push({ tenant_id: tenant, notice_id: row.id, user_id: user.id, read_at: null, read_revision: 0 });
          notify(db, tenant, user, 'notice_published', 'notice', row.id, `notice:${String(row.id)}:published`);
        }
      } else {
        if (row.state !== 'published') reject();
        row.state = 'archived';
      }
      row.revision = Number(row.revision) + 1; row.updated_at = now(); audit(row); return result(noticeResult(row));
    }
    if (operation === 'notice_get') {
      const row = notice(); if (!canRead(row)) reject('P0002'); return result(noticeResult(row));
    }
    if (operation === 'notice_list') {
      if (input.view === 'managed' && !manager && actor.role !== 'teacher') reject('42501');
      const rows = scoped('academic_notices').filter(row => input.view === 'managed' ? canManage(row)
        : !!receipt(row) && row.state !== 'draft' && (input.view === 'history' || row.state === 'published' && (!row.expires_at || Date.parse(String(row.expires_at)) > Date.now())));
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
      return result(page(rows.map(noticeResult)));
    }
    if (operation === 'notice_history') {
      const row = notice(); if (!canManage(row)) reject('42501');
      return result(page(scoped('academic_notice_revisions').filter(revision => revision.notice_id === row.id).sort((a,b) => Number(a.revision) - Number(b.revision))));
    }
    if (operation === 'notice_read') {
      const row = notice(), recipient = receipt(row);
      if (!recipient || row.state === 'draft') reject('P0002');
      if (row.revision !== input.expectedRevision) reject();
      if (recipient.read_revision !== row.revision) Object.assign(recipient, { read_at: now(), read_revision: row.revision });
      return result({ notice_id: row.id, read_revision: recipient.read_revision, read_at: recipient.read_at });
    }
    if (operation === 'conversation_create') {
      const target = scoped('app_users').find(user => user.id === input.participantId) ?? reject('P0002');
      const student = actor.role === 'student' ? actor : target, teacher = actor.role === 'teacher' ? actor : target;
      if (actor.id === target.id || !['student', 'teacher'].includes(String(actor.role))) reject('42501');
      validatePair(input.classId, student.id, teacher.id);
      let row = scoped('academic_conversations').find(value => value.class_id === input.classId && value.student_id === student.id && value.teacher_id === teacher.id);
      if (!row) { row = { id: randomUUID(), tenant_id: tenant, class_id: input.classId, student_id: student.id, teacher_id: teacher.id, last_sequence: 0, created_at: now(), updated_at: now() }; db.academic_conversations.push(row); }
      return result(row);
    }
    if (operation === 'conversation_get') return result(conversation());
    if (operation === 'conversation_list') {
      const rows = scoped('academic_conversations').filter(row => [row.student_id, row.teacher_id].includes(actor.id));
      rows.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
      return result(page(rows));
    }
    if (operation === 'message_send') {
      const row = conversation(); validatePair(row.class_id, row.student_id, row.teacher_id);
      const duplicate = scoped('messages').find(message => message.conversation_id === row.id && message.sender_id === actor.id && message.client_message_id === input.clientMessageId);
      if (duplicate) { if (duplicate.content !== input.content) reject(); return result(duplicate); }
      const message = { id: randomUUID(), tenant_id: tenant, class_id: row.class_id, conversation_id: row.id, sender_id: actor.id, content: input.content,
        client_message_id: input.clientMessageId, sequence: Number(row.last_sequence) + 1, created_at: now() };
      row.last_sequence = message.sequence; row.updated_at = message.created_at; db.messages.push(message);
      const other = scoped('app_users').find(user => user.id === (actor.id === row.student_id ? row.teacher_id : row.student_id));
      if (other) notify(db, tenant, other, 'message_received', 'message', message.id, `message:${message.id}`);
      return result(message);
    }
    if (operation === 'message_list') {
      const row = conversation();
      const rows = scoped('messages').filter(message => message.conversation_id === row.id && Number(message.sequence) > Number(input.afterSequence)).sort((a,b) => Number(a.sequence) - Number(b.sequence));
      const data: Row[] = rows.slice(0, Number(input.limit)).map(message => {
        const peer = message.sender_id === row.student_id ? row.teacher_id : row.student_id;
        const watermark = scoped('academic_conversation_reads').find(read => read.conversation_id === row.id && read.user_id === peer);
        return { ...message, read_by_recipient: Number(watermark?.last_read_sequence ?? 0) >= Number(message.sequence) };
      });
      return result({ data, has_more: rows.length > Number(input.limit), next_after_sequence: data[data.length - 1]?.sequence ?? input.afterSequence });
    }
    if (operation === 'message_read') {
      const row = conversation(); if (Number(input.upToSequence) > Number(row.last_sequence)) reject();
      let watermark = scoped('academic_conversation_reads').find(read => read.conversation_id === row.id && read.user_id === actor.id);
      if (!watermark) { watermark = { tenant_id: tenant, conversation_id: row.id, user_id: actor.id, last_read_sequence: input.upToSequence, read_at: now() }; db.academic_conversation_reads.push(watermark); }
      else if (Number(input.upToSequence) > Number(watermark.last_read_sequence)) Object.assign(watermark, { last_read_sequence: input.upToSequence, read_at: now() });
      return result(watermark);
    }
    if (operation === 'notification_list') {
      const rows = scoped('academic_notifications').filter(row => row.recipient_id === actor.id && (!input.unreadOnly || !row.read_at));
      rows.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id)));
      return result(page(rows));
    }
    if (operation === 'notification_count') return result({ unread_count: scoped('academic_notifications').filter(row => row.recipient_id === actor.id && !row.read_at).length });
    if (operation === 'notification_read') {
      const row = scoped('academic_notifications').find(row => row.id === input.id && row.recipient_id === actor.id) ?? reject('P0002');
      row.read_at ??= now(); return result(row);
    }
    reject('22023');
  } catch (error) {
    if (error instanceof Rejected) return { data: null, error: { code: error.code, message: 'Synthetic communication rejection' }, status: 400 };
    throw error;
  }
}
