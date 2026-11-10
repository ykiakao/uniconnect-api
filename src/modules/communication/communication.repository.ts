import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { checkQueryError } from '../../shared/supabase-errors';
import { CommunicationOperation } from './communication.schemas';

export function checkCommunicationError(error: { code?: string } | null, status?: number) {
  if (error?.code === 'PCH01') throw new HttpError(403, 'CHAT_OUTSIDE_SERVICE_HOURS', 'Envio fora da janela institucional de atendimento.');
  if (error && ['PGRST202', '42883', '42703', '42P01'].includes(error.code ?? '')) {
    throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao da comunicacao academica pendente.');
  }
  if (error?.code === 'P0002') throw new HttpError(404, 'COMMUNICATION_NOT_FOUND', 'Recurso de comunicacao nao encontrado.');
  if (error?.code === '42501') throw new HttpError(403, 'FORBIDDEN', 'Operacao de comunicacao nao autorizada.');
  if (error?.code === '22023') throw new HttpError(400, 'VALIDATION_ERROR', 'Dados de comunicacao invalidos.');
  if (error?.code === '54000') throw new HttpError(409, 'COMMUNICATION_LIMIT_EXCEEDED', 'A operacao excede os limites da comunicacao.');
  checkQueryError(error, status);
}

export class CommunicationRepository {
  async execute(tenantId: string, actorId: string, operation: CommunicationOperation, payload: Record<string, unknown>): Promise<unknown> {
    // This wrapper exists only after the DB clock guard and Broadcast SQL are installed.
    // Its BEFORE INSERT guard rejects new sends but preserves idempotent replays after closing.
    const { data, error, status } = await createSupabaseAdminClient().rpc(operation === 'message_send' ? 'academic_chat_send' : 'academic_communication', {
      p_tenant_id: tenantId, p_actor_id: actorId, p_payload: payload,
      ...(operation === 'message_send' ? {} : { p_operation: operation }),
    });
    checkCommunicationError(error, status);
    return data;
  }
}
