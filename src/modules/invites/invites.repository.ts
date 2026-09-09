import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { toApiUserRole } from '../../shared/roles';
import { UserRole } from '../../shared/types';

type InviteRow = {
  id: string;
  tenant_id: string;
  code: string;
  role: UserRole;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
  created_at: string;
};

type TenantRow = {
  id: string;
  name: string;
  slug: string;
};

const inviteSelect =
  'id,tenant_id,code,role,expires_at,used_at,created_by,created_at';

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
  }) {
    const { data, error } = await this.supabase
      .from('invites')
      .insert({
        tenant_id: params.tenantId,
        code: params.code,
        role: params.role,
        expires_at: params.expiresAt,
        created_by: params.createdBy,
      })
      .select(inviteSelect)
      .single<InviteRow>();

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
    const { data, error } = await this.supabase
      .from('invites')
      .select(inviteSelect)
      .eq('code', code)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .single<InviteRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'INVITE_NOT_FOUND',
        'Convite nao encontrado ou expirado.',
        error?.message,
      );
    }

    const tenant = await this.findTenantById(data.tenant_id);

    return {
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      role: toApiUserRole(data.role),
    };
  }

  private async findTenantById(id: string) {
    const { data, error } = await this.supabase
      .from('tenants')
      .select('id,name,slug')
      .eq('id', id)
      .single<TenantRow>();

    if (error || !data) {
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
