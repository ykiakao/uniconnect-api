import { checkQueryError } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Tenant } from '../../shared/types';

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  plan: Tenant['plan'];
  status: Tenant['status'];
  active_users: number;
  operational_status: string;
};

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    activeUsers: row.active_users,
  };
}

export class TenantRepository {
  private readonly supabase = createSupabaseAdminClient();

  async findBySlug(slug: string): Promise<Tenant> {
    const { data, error, status } = await this.supabase
      .from('tenants')
      .select('id,name,slug,plan,status,active_users,operational_status')
      .eq('slug', slug)
      .maybeSingle<TenantRow>();

    this.checkError(error, status);
    if (!data) {
      throw new HttpError(
        404,
        'TENANT_NOT_FOUND',
        'Instituição não encontrada',
        error?.message,
      );
    }

    this.ensureOperational(data.operational_status);
    return mapTenant(data);
  }

  async requireOperationalById(id: string) {
    const { data, error, status } = await this.supabase.from('tenants').select('id,operational_status').eq('id', id).maybeSingle<{ id: string; operational_status: string }>();
    this.checkError(error, status);
    if (!data) throw new HttpError(404, 'TENANT_NOT_FOUND', 'Instituicao nao encontrada.');
    this.ensureOperational(data.operational_status);
  }
  private ensureOperational(value: string) {
    if (value === 'suspended') throw new HttpError(403, 'TENANT_SUSPENDED', 'A instituicao esta suspensa.');
    if (value !== 'active') throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de gestao institucional pendente.');
  }
  private checkError(error: { code?: string } | null, status?: number) {
    if (error?.code === '42703') throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de gestao institucional pendente.');
    checkQueryError(error, status);
  }
}
