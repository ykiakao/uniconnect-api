import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { checkQueryError } from '../../shared/supabase-errors';

export function checkWorkflowError(error: { code?: string } | null, status?: number) {
  if (error && ['PGRST202','42883','42703','42P01'].includes(error.code ?? '')) throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao do fluxo de atividades pendente.');
  if (error?.code === 'P0002') throw new HttpError(404, 'ACTIVITY_RECORD_NOT_FOUND', 'Atividade ou entrega nao encontrada.');
  if (error?.code === '42501') throw new HttpError(403, 'FORBIDDEN', 'Operacao academica nao autorizada.');
  if (error?.code === '22023') throw new HttpError(400, 'VALIDATION_ERROR', 'Dados da operacao invalidos.');
  if (error?.code === '54000') throw new HttpError(409, 'COMMUNICATION_LIMIT_EXCEEDED', 'A operacao excede os limites da comunicacao.');
  checkQueryError(error, status);
}
export async function activityRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error, status } = await createSupabaseAdminClient().rpc(name, args);
  checkWorkflowError(error, status);
  if (!data || typeof data !== 'object') throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta academica invalida.');
  return data;
}
