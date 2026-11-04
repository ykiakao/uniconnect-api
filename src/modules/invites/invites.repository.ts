import { checkMutationConflict, checkSupabaseAvailability, checkQueryError } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { toApiUserRole } from '../../shared/roles';
import { UserRole } from '../../shared/types';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { TenantRepository } from '../tenants/tenant.repository';

type InviteRow = {
  id: string;
  tenant_id: string;
  code: string;
  role: UserRole;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
  created_at: string;
  recipient_email: string | null;
};

type TenantRow = {
  id: string;
  name: string;
  slug: string;
};

const inviteSelect =
  'id,tenant_id,code,role,expires_at,used_at,created_by,created_at,recipient_email';

function mapInvite(row: InviteRow) {
  return {
    code: row.code,
    role: toApiUserRole(row.role),
    expiresAt: row.expires_at,
  };
}

export class InvitesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async create(params: {
    tenantId: string;
    code: string;
    role: UserRole;
    expiresAt: string;
    createdBy: string;
    recipientEmail: string;
  }) {
    const { data, error, status } = await this.supabase
      .from('invites')
      .insert({
        tenant_id: params.tenantId,
        code: params.code,
        role: params.role,
        expires_at: params.expiresAt,
        created_by: params.createdBy,
        recipient_email: params.recipientEmail,
        used_at: null,
      })
      .select(inviteSelect)
      .single<InviteRow>();

    checkSupabaseAvailability(error, status);
    checkMutationConflict(error);
    if (error || !data) {
      throw new HttpError(
        500,
        'INVITE_CREATE_FAILED',
        'Nao foi possivel criar convite.',
        error?.message,
      );
    }

    return mapInvite(data);
  }

  async findActiveByCode(code: string) {
    const data = await this.findConsumable(code);
    const tenant = await this.findTenantById(data.tenant_id);
    return { tenantSlug: tenant.slug, tenantName: tenant.name, role: toApiUserRole(data.role) };
  }

  async findConsumable(code: string) {
    const { data, error, status } = await this.supabase
      .from('invites')
      .select(inviteSelect)
      .eq('code', code)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle<InviteRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        404,
        'INVITE_NOT_FOUND',
        'Convite nao encontrado ou expirado.',
        error?.message,
      );
    }

    await new TenantRepository().requireOperationalById(data.tenant_id);
    return data;
  }

  async accept(code: string, identity: { id: string; email: string }, name: string, tenantId: string, requestId: string = randomUUID()) {
    const { data, error, status } = await this.supabase.rpc('accept_institution_invite', {
      p_code: code, p_auth_user_id: identity.id, p_email: identity.email, p_name: name, p_request_id: requestId,
    });
    if (error?.code === 'P0002') throw new HttpError(404, 'INVITE_NOT_FOUND', 'Convite nao encontrado ou expirado.');
    if (error?.code === '42501') throw new HttpError(403, 'INVITE_FORBIDDEN', 'Convite nao autorizado.');
    if (error?.code === '23505') throw new HttpError(409, 'USER_ALREADY_LINKED', 'Ja existe um vinculo com esta instituicao.');
    if (error?.code === 'PGRST202' || error?.code === '42883') throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao institucional do banco pendente.');
    checkQueryError(error, status);
    const parsed = z.object({ id: z.string().min(1), tenant_id: z.literal(tenantId), auth_user_id: z.literal(identity.id),
      name: z.string(), email: z.string().email(), role: z.enum(['student','teacher','coordinator','admin','owner']), active: z.literal(true) }).safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'UPSTREAM_INVALID_RESPONSE', 'Resposta institucional invalida.');
    const tenant = await this.findTenantById(tenantId);
    const user = parsed.data;
    return { id: user.id, name: user.name, email: user.email, role: toApiUserRole(user.role), active: user.active, tenantSlug: tenant.slug };
  }

  private async findTenantById(id: string) {
    const { data, error, status } = await this.supabase
      .from('tenants')
      .select('id,name,slug')
      .eq('id', id)
      .maybeSingle<TenantRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        404,
        'TENANT_NOT_FOUND',
        'Instituicao nao encontrada',
        error?.message,
      );
    }

    return data;
  }
}
