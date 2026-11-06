import { z } from 'zod';
import { apiDateTime } from '../../shared/validation';

export const communicationId = z.guid();
const revision = z.number().int().min(1).max(2147483646);
const text = z.string().trim().min(1).max(10000);
const expiresAt = apiDateTime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Data de expiracao invalida.')
  .transform(value => new Date(value).toISOString()).nullable();
const noticeFields = {
  title: z.string().trim().min(1).max(200), content: text,
  priority: z.enum(['low', 'medium', 'high']).default('medium'), expiresAt: expiresAt.optional(),
};
export const noticeCreateSchema = z.object({
  ...noticeFields, audienceType: z.enum(['institution', 'course', 'class']),
  courseId: communicationId.optional(), classId: communicationId.optional(),
}).strict().superRefine((value, context) => {
  const valid = value.audienceType === 'institution' ? !value.courseId && !value.classId
    : value.audienceType === 'course' ? !!value.courseId && !value.classId : !!value.classId && !value.courseId;
  if (!valid) context.addIssue({ code: 'custom', message: 'Publico-alvo e referencia incompativeis.', path: ['audienceType'] });
});
export const noticeUpdateSchema = z.object(noticeFields).partial().extend({
  priority: noticeFields.priority.removeDefault().optional(), expectedRevision: revision,
}).strict()
  .refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), 'Informe uma alteracao.');
export const noticeRevisionSchema = z.object({ expectedRevision: revision }).strict();
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const noticeListSchema = pageSchema.extend({ view: z.enum(['active', 'history', 'managed']).default('active') });
export const notificationListSchema = pageSchema.extend({
  unreadOnly: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
});
export const conversationCreateSchema = z.object({ classId: communicationId, participantId: communicationId }).strict();
export const messageSendSchema = z.object({ content: text, clientMessageId: communicationId }).strict();
export const messageListSchema = z.object({
  afterSequence: z.coerce.number().int().min(0).max(2147483646).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export const messageReadSchema = z.object({ upToSequence: z.number().int().min(0).max(2147483646) }).strict();
export const emptySchema = z.object({}).strict();

export type CommunicationOperation =
  | 'notice_create' | 'notice_update' | 'notice_publish' | 'notice_archive'
  | 'notice_list' | 'notice_get' | 'notice_read' | 'notice_history'
  | 'conversation_create' | 'conversation_list' | 'conversation_get'
  | 'message_send' | 'message_list' | 'message_read'
  | 'notification_list' | 'notification_count' | 'notification_read';

export type CommunicationEvent =
  | { type: 'message.created'; tenantId: string; conversationId: string; messageId: string; sequence: number }
  | { type: 'conversation.read'; tenantId: string; conversationId: string; readerId: string; upToSequence: number }
  | { type: 'notification.created'; tenantId: string; userId: string; notificationId: string };

export function communicationPage<T extends { page: number; limit: number }>(value: T) {
  const { page, ...rest } = value;
  return { ...rest, offset: (page - 1) * value.limit };
}
