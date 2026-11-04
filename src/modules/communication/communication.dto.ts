import { z } from 'zod';
import { HttpError } from '../../shared/http-error';
import { apiDateTime } from '../../shared/validation';

export function parseCommunication<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta de comunicacao invalida.');
  return result.data;
}
const identifier = z.string().min(1);
const timestamp = apiDateTime({ offset: true });
const nullableDate = timestamp.nullable();
const base = { id: identifier, tenant_id: identifier };
const noticeSchema = z.object({
  ...base, author_id: identifier, title: z.string(), content: z.string(), audience_type: z.enum(['institution', 'course', 'class']),
  course_id: identifier.nullable(), class_id: identifier.nullable(), state: z.enum(['draft', 'published', 'archived']),
  priority: z.enum(['low', 'medium', 'high']), revision: z.number().int().positive(),
  expires_at: nullableDate, published_at: nullableDate, created_at: timestamp, updated_at: timestamp,
  read_at: nullableDate.optional(), read_revision: z.number().int().nonnegative().nullable().optional(),
});
const conversationSchema = z.object({
  ...base, class_id: identifier, student_id: identifier, teacher_id: identifier,
  last_sequence: z.number().int().nonnegative(), created_at: timestamp, updated_at: timestamp,
});
const messageSchema = z.object({
  ...base, conversation_id: identifier, sender_id: identifier, content: z.string(), sequence: z.number().int().positive(),
  created_at: timestamp, client_message_id: identifier, read_by_recipient: z.boolean().optional(),
});
const notificationSchema = z.object({
  ...base, recipient_id: identifier,
  event_type: z.enum(['notice_published', 'activity_published', 'activity_result_published', 'message_received', 'activity_due_soon']),
  resource_type: z.enum(['notice', 'activity', 'grade', 'message']), resource_id: identifier, created_at: timestamp, read_at: nullableDate,
});

function checkScope(tenantId: string, actualTenant: string) {
  if (tenantId !== actualTenant) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Escopo de comunicacao invalido.');
}
export function noticeDto(value: unknown, tenantId: string) {
  const row = parseCommunication(noticeSchema, value); checkScope(tenantId, row.tenant_id);
  return { id: row.id, authorId: row.author_id, title: row.title, content: row.content, audienceType: row.audience_type,
    courseId: row.course_id, classId: row.class_id, state: row.state, priority: row.priority, revision: row.revision,
    expiresAt: row.expires_at, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at,
    readAt: row.read_at ?? null, readRevision: row.read_revision ?? 0 };
}
export function conversationDto(value: unknown, tenantId: string, userId: string) {
  const row = parseCommunication(conversationSchema, value); checkScope(tenantId, row.tenant_id);
  if (![row.student_id, row.teacher_id].includes(userId)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Participantes da conversa invalidos.');
  return { id: row.id, classId: row.class_id, studentId: row.student_id, teacherId: row.teacher_id,
    lastSequence: row.last_sequence, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function messageDto(value: unknown, tenantId: string, conversationId: string) {
  const row = parseCommunication(messageSchema, value); checkScope(tenantId, row.tenant_id);
  if (row.conversation_id !== conversationId) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Escopo da mensagem invalido.');
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, content: row.content, sequence: row.sequence,
    clientMessageId: row.client_message_id, createdAt: row.created_at, readByRecipient: row.read_by_recipient ?? false };
}
export function notificationDto(value: unknown, tenantId: string, userId: string) {
  const row = parseCommunication(notificationSchema, value); checkScope(tenantId, row.tenant_id);
  if (row.recipient_id !== userId) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Destinatario da notificacao invalido.');
  return { id: row.id, type: row.event_type, resourceType: row.resource_type, resourceId: row.resource_id, createdAt: row.created_at, readAt: row.read_at };
}
export const listResultSchema = z.object({ data: z.array(z.unknown()), total: z.number().int().nonnegative().safe() });
export const messageResultSchema = z.object({ data: z.array(z.unknown()), has_more: z.boolean(), next_after_sequence: z.number().int().nonnegative() });
export const noticeReadResultSchema = z.object({ notice_id: identifier, read_revision: z.number().int().positive(), read_at: timestamp });
export const messageReadResultSchema = z.object({ conversation_id: identifier, last_read_sequence: z.number().int().nonnegative(), read_at: timestamp });
export const notificationCountSchema = z.object({ unread_count: z.number().int().nonnegative().safe() });
export const noticeHistorySchema = z.object({ notice_id: identifier, revision: z.number().int().positive(), title: z.string(), content: z.string(), state: z.enum(['draft', 'published', 'archived']), changed_by: identifier, changed_at: timestamp });
