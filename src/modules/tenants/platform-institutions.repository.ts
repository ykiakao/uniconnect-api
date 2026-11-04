import { z } from 'zod';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { checkQueryError, requireCount, requireRows } from '../../shared/supabase-errors';
import { bootstrapDto, InstitutionDto, institutionDto, PlatformOperation } from './platform-institutions.schemas';

const columns = 'id,name,slug,operational_status,operational_version,created_at,updated_at';
function check(error: { code?: string; message?: string } | null, status?: number) {
  if (error && ['PGRST202', '42883', '42703', '42P01'].includes(error.code ?? '')) throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de gestao institucional pendente.');
  if (error?.code === 'PT404' || error?.code === 'P0002') throw new HttpError(404, 'TENANT_NOT_FOUND', 'Instituicao nao encontrada.');
  if (error?.code === 'PT409') {
    const code = error.message === 'BOOTSTRAP_AUTH_REQUIRED' || error.message === 'BOOTSTRAP_AUTH_UNCONFIRMED' || error.message === 'BOOTSTRAP_AUTH_AMBIGUOUS' ? error.message : 'PLATFORM_CONFLICT';
    throw new HttpError(409, code, code.startsWith('BOOTSTRAP_AUTH_') ? 'O bootstrap exige uma unica conta Supabase Auth existente e confirmada para o email informado.' : 'A operacao conflita com o estado atual ou a chave de idempotencia. Atualize os dados antes de tentar novamente.');
  }
  if (error?.code === '42501') throw new HttpError(403, 'FORBIDDEN', 'Operacao de plataforma nao autorizada.');
  if (error?.code === '22023') throw new HttpError(400, 'VALIDATION_ERROR', 'Dados da operacao invalidos.');
  checkQueryError(error, status);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta institucional invalida.');
  return result.data;
}
function dto(row: Record<string, unknown>): InstitutionDto {
  return parse(institutionDto, { id: row.id, name: row.name, slug: row.slug, operationalStatus: row.operational_status, version: row.operational_version, createdAt: row.created_at, updatedAt: row.updated_at });
}

export class PlatformInstitutionsRepository {
  private readonly db = createSupabaseAdminClient();
  async list(pagination: Pagination, search?: string, statusFilter?: string) {
    let query = this.db.from('tenants').select(columns, { count: 'exact' }).order('name').order('id');
    if (search) query = query.ilike('name', `%${search.replace(/[%_\\]/g, '\\$&')}%`);
    if (statusFilter) query = query.eq('operational_status', statusFilter);
    const result = await query.range(pagination.offset, pagination.offset + pagination.limit - 1);
    check(result.error, result.status);
    return toPaginated({ data: requireRows(result.data).map(dto), total: requireCount(result.count), page: pagination.page, limit: pagination.limit });
  }
  async find(id: string) {
    const { data, error, status } = await this.db.from('tenants').select(columns).eq('id', id).maybeSingle();
    check(error, status);
    if (!data) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Instituicao nao encontrada.');
    return dto(data);
  }
  async mutate(actor: string, operation: PlatformOperation, key: string, requestId: string, payload: Record<string, unknown>) {
    const { data, error, status } = await this.db.rpc('platform_manage_institution', { p_actor_auth_id: actor, p_operation: operation, p_idempotency_key: key, p_request_id: requestId, p_payload: payload });
    check(error, status);
    const result = operation === 'bootstrap' ? parse(bootstrapDto, data) : parse(institutionDto, data);
    const returnedId = 'institutionId' in result ? result.institutionId : result.id;
    if (payload.id !== undefined && payload.id !== returnedId) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta institucional invalida.');
    return result;
  }
  async audit(id: string, pagination: Pagination) {
    await this.find(id);
    const { data, error, status, count } = await this.db.from('platform_audit_events')
      .select('id,tenant_id,actor_auth_id,action,request_id,target_user_id,from_status,to_status,occurred_at', { count: 'exact' })
      .eq('tenant_id', id).order('occurred_at').order('id').range(pagination.offset, pagination.offset + pagination.limit - 1);
    check(error, status);
    const schema = z.object({ id: z.string(), tenant_id: z.literal(id), actor_auth_id: z.string(), action: z.string(), request_id: z.string(), target_user_id: z.string().nullable(), from_status: z.string().nullable(), to_status: z.string().nullable(), occurred_at: z.string() });
    const rows = requireRows(data).map(row => {
      const e = parse(schema, row);
      return { id: e.id, institutionId: e.tenant_id, actorAuthUserId: e.actor_auth_id, action: e.action, requestId: e.request_id, targetUserId: e.target_user_id, fromStatus: e.from_status, toStatus: e.to_status, occurredAt: e.occurred_at };
    });
    return toPaginated({ data: rows, total: requireCount(count), page: pagination.page, limit: pagination.limit });
  }
}
