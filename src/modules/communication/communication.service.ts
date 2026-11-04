import { AppUser } from '../../shared/types';
import { HttpError } from '../../shared/http-error';
import { CommunicationRepository } from './communication.repository';
import { CommunicationOperation } from './communication.schemas';
import { conversationDto, listResultSchema, messageDto, messageReadResultSchema, messageResultSchema, noticeDto,
  noticeHistorySchema, noticeReadResultSchema, notificationCountSchema, notificationDto, parseCommunication } from './communication.dto';

export class CommunicationService {
  constructor(private readonly repository = new CommunicationRepository()) {}

  async execute(user: AppUser, tenantId: string, operation: CommunicationOperation, input: Record<string, unknown>) {
    if (user.tenantId !== tenantId || user.active === false) throw new HttpError(403, 'FORBIDDEN', 'Vinculo institucional invalido.');
    const value = await this.repository.execute(tenantId, user.id, operation, input);
    const id = String(input.id ?? '');
    if (operation === 'notice_read') {
      const row = parseCommunication(noticeReadResultSchema, value);
      this.sameId(id, row.notice_id);
      return { noticeId: row.notice_id, readRevision: row.read_revision, readAt: row.read_at };
    }
    if (operation === 'message_read') {
      const row = parseCommunication(messageReadResultSchema, value);
      this.sameId(id, row.conversation_id);
      return { conversationId: row.conversation_id, lastReadSequence: row.last_read_sequence, readAt: row.read_at };
    }
    if (operation === 'notification_count') return { unreadCount: parseCommunication(notificationCountSchema, value).unread_count };
    if (operation === 'message_send') return messageDto(value, tenantId, id);
    if (operation === 'message_list') {
      const result = parseCommunication(messageResultSchema, value);
      const limit = Number(input.limit), afterSequence = Number(input.afterSequence);
      if (result.data.length > limit) this.invalid();
      const data = result.data.map(row => messageDto(row, tenantId, id));
      if (data.some((row, index) => row.sequence <= (data[index - 1]?.sequence ?? afterSequence)) ||
          result.next_after_sequence !== (data[data.length - 1]?.sequence ?? afterSequence)) this.invalid();
      return { data, meta: { limit, afterSequence, hasMore: result.has_more, nextAfterSequence: result.next_after_sequence } };
    }
    if (operation.endsWith('_list') || operation === 'notice_history') {
      const result = parseCommunication(listResultSchema, value);
      const limit = Number(input.limit), offset = Number(input.offset);
      if (result.data.length > limit) this.invalid();
      const data = result.data.map(row => {
        if (operation === 'notice_list') return noticeDto(row, tenantId);
        if (operation === 'conversation_list') return conversationDto(row, tenantId, user.id);
        if (operation === 'notification_list') return notificationDto(row, tenantId, user.id);
        const revision = parseCommunication(noticeHistorySchema, row);
        this.sameId(id, revision.notice_id);
        return { noticeId: revision.notice_id, revision: revision.revision, title: revision.title, content: revision.content,
          state: revision.state, changedBy: revision.changed_by, changedAt: revision.changed_at };
      });
      return { data, meta: { page: offset / limit + 1, limit, total: result.total } };
    }
    const result = operation.startsWith('notice_') ? noticeDto(value, tenantId)
      : operation.startsWith('conversation_') ? conversationDto(value, tenantId, user.id) : notificationDto(value, tenantId, user.id);
    if (id) this.sameId(id, result.id);
    return result;
  }

  private sameId(expected: string, actual: string) { if (expected !== actual) this.invalid(); }
  private invalid(): never { throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta de comunicacao invalida.'); }
}
