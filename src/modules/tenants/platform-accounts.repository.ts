import { z } from 'zod';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { checkQueryError, requireCount, requireRows } from '../../shared/supabase-errors';
import { PlatformInstitutionsRepository } from './platform-institutions.repository';
import { AccountOperation, provisionDto } from './platform-accounts.schemas';

const conflicts = new Set(['IDEMPOTENCY_CONFLICT', 'PROVISION_IDENTITY_CONFLICT', 'PROVISION_IDENTITY_CHANGED',
  'ACCOUNT_AUTH_REQUIRED', 'ACCOUNT_AUTH_AMBIGUOUS', 'ACCOUNT_AUTH_UNCONFIRMED', 'RESPONSIBLE_REQUIRED',
  'RESPONSIBLE_VERSION_CONFLICT', 'RESPONSIBLE_ACTIVE_ADMIN_REQUIRED', 'RESPONSIBLE_TARGET_ROLE_CONFLICT',
  'RESPONSIBLE_TARGET_IDENTITY_CONFLICT', 'RESPONSIBLE_ALREADY_CURRENT', 'RESPONSIBLE_REPLACEMENT_REQUIRED']);
function check(error: { code?: string; message?: string } | null, status?: number) {
  if (error && ['PGRST202', '42883', '42703', '42P01'].includes(error.code ?? '')) throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de contas administrativas pendente.');
  if (error?.code === 'PT404') throw new HttpError(404, error.message === 'PROVISION_NOT_FOUND' ? 'PROVISION_NOT_FOUND' : 'TENANT_NOT_FOUND', 'Recurso administrativo nao encontrado.');
  if (error?.code === 'PT409') throw new HttpError(409, conflicts.has(error.message ?? '') ? error.message! : 'PLATFORM_CONFLICT', 'A operacao conflita com o estado atual. Consulte o recurso e verifique a identidade e a versao antes de tentar novamente.');
  if (error?.code === '42501') throw new HttpError(403, 'FORBIDDEN', 'Operacao de plataforma nao autorizada.');
  if (error?.code === '22023') throw new HttpError(400, 'VALIDATION_ERROR', 'Dados da operacao invalidos.');
  checkQueryError(error, status);
}
export function parseAccountResult<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta administrativa invalida.');
  return parsed.data;
}
function provisionRow(row: Record<string, unknown>) {
  return parseAccountResult(provisionDto, { id: row.id, institutionId: row.tenant_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at });
}
export class PlatformAccountsRepository {
  private readonly db = createSupabaseAdminClient();
  async call(actor: string, operation: AccountOperation, key: string, requestId: string, payload: Record<string, unknown>): Promise<unknown> {
    const result = await this.db.rpc('platform_manage_accounts', { p_actor_auth_id: actor, p_operation: operation, p_idempotency_key: key, p_request_id: requestId, p_payload: payload });
    check(result.error, result.status);
    return result.data;
  }
  async list(institutionId: string, pagination: Pagination) {
    await new PlatformInstitutionsRepository().find(institutionId);
    const result = await this.db.from('platform_account_provisions').select('id,tenant_id,state,created_at,updated_at', { count: 'exact' })
      .eq('tenant_id', institutionId).order('created_at').order('id').range(pagination.offset, pagination.offset + pagination.limit - 1);
    check(result.error, result.status);
    const data = requireRows(result.data).map(provisionRow);
    if (data.some(item => item.institutionId !== institutionId)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta administrativa invalida.');
    return toPaginated({ data, total: requireCount(result.count), page: pagination.page, limit: pagination.limit });
  }
  async find(institutionId: string, id: string) {
    const result = await this.db.from('platform_account_provisions').select('id,tenant_id,state,created_at,updated_at').eq('tenant_id', institutionId).eq('id', id).maybeSingle();
    check(result.error, result.status);
    if (!result.data) throw new HttpError(404, 'PROVISION_NOT_FOUND', 'Provisionamento nao encontrado.');
    const item = provisionRow(result.data);
    if (item.institutionId !== institutionId || item.id !== id) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta administrativa invalida.');
    return item;
  }
  async history(institutionId: string, pagination: Pagination) {
    await new PlatformInstitutionsRepository().find(institutionId);
    const result = await this.db.from('platform_audit_events').select('id,tenant_id,actor_auth_id,action,request_id,target_user_id,previous_user_id,occurred_at', { count: 'exact' })
      .eq('tenant_id', institutionId).in('action', ['responsible_designated', 'responsible_replaced']).order('occurred_at').order('id').range(pagination.offset, pagination.offset + pagination.limit - 1);
    check(result.error, result.status);
    const schema = z.object({ id: z.string(), tenant_id: z.literal(institutionId), actor_auth_id: z.string(), action: z.enum(['responsible_designated', 'responsible_replaced']), request_id: z.string(), target_user_id: z.string(), previous_user_id: z.string().nullable(), occurred_at: z.string() });
    const data = requireRows(result.data).map(row => {
      const e = parseAccountResult(schema, row);
      return { id: e.id, institutionId: e.tenant_id, actorAuthUserId: e.actor_auth_id, action: e.action, requestId: e.request_id, targetUserId: e.target_user_id, previousUserId: e.previous_user_id, occurredAt: e.occurred_at };
    });
    return toPaginated({ data, total: requireCount(result.count), page: pagination.page, limit: pagination.limit });
  }
}
