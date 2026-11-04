import { Request, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { CommunicationService } from './communication.service';
import { CommunicationOperation, communicationId, communicationPage, conversationCreateSchema, emptySchema,
  messageListSchema, messageReadSchema, messageSendSchema, noticeCreateSchema, noticeListSchema, noticeRevisionSchema,
  noticeUpdateSchema, notificationListSchema, pageSchema } from './communication.schemas';

const service = new CommunicationService();
export const noticesRoutes = Router({ mergeParams: true });
export const conversationsRoutes = Router({ mergeParams: true });
export const notificationsRoutes = Router({ mergeParams: true });
for (const router of [noticesRoutes, conversationsRoutes, notificationsRoutes]) router.use(requireTenantUser);

function handler(operation: CommunicationOperation, options: { schema?: z.ZodType; query?: boolean; paginated?: boolean; id?: boolean; status?: number } = {}): RequestHandler {
  return async (request: Request, response, next) => {
    try {
      if (!request.currentUser || !request.tenant) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao nao informada.');
      const schema = options.schema ?? emptySchema;
      const payload = schema.parse(options.query ? request.query : request.body ?? {}) as Record<string, unknown>;
      const input: Record<string, unknown> = options.paginated ? communicationPage(payload as { page: number; limit: number }) : payload;
      if (options.id) input.id = communicationId.parse(request.params.id);
      response.status(options.status ?? 200).json(await service.execute(request.currentUser, request.tenant.id, operation, input));
    } catch (error) { next(error); }
  };
}
function mutation() { return createRateLimit({ max: 60, windowMs: 60000 }); }

noticesRoutes.post('/', mutation(), handler('notice_create', { schema: noticeCreateSchema, status: 201 }));
noticesRoutes.get('/', handler('notice_list', { schema: noticeListSchema, query: true, paginated: true }));
noticesRoutes.get('/:id/history', handler('notice_history', { schema: pageSchema, query: true, paginated: true, id: true }));
noticesRoutes.get('/:id', handler('notice_get', { query: true, id: true }));
noticesRoutes.put('/:id', mutation(), handler('notice_update', { schema: noticeUpdateSchema, id: true }));
for (const operation of ['publish', 'archive', 'read'] as const) {
  noticesRoutes.post(`/:id/${operation}`, mutation(), handler(`notice_${operation}`, { schema: noticeRevisionSchema, id: true }));
}
conversationsRoutes.post('/', mutation(), handler('conversation_create', { schema: conversationCreateSchema, status: 201 }));
conversationsRoutes.get('/', handler('conversation_list', { schema: pageSchema, query: true, paginated: true }));
conversationsRoutes.get('/:id', handler('conversation_get', { query: true, id: true }));
conversationsRoutes.post('/:id/messages', mutation(), handler('message_send', { schema: messageSendSchema, status: 201, id: true }));
conversationsRoutes.get('/:id/messages', handler('message_list', { schema: messageListSchema, query: true, id: true }));
conversationsRoutes.post('/:id/read', mutation(), handler('message_read', { schema: messageReadSchema, id: true }));
notificationsRoutes.get('/unread-count', handler('notification_count', { query: true }));
notificationsRoutes.get('/', handler('notification_list', { schema: notificationListSchema, query: true, paginated: true }));
notificationsRoutes.post('/:id/read', mutation(), handler('notification_read', { id: true }));
