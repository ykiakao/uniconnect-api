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
    const { data, error } = await this.supabase
      .from('tenants')
      .select('id,name,slug,plan,status,active_users')
      .eq('slug', slug)
      .single<TenantRow>();

    if (error || !data) {
      throw new HttpError(404, 'Instituição não encontrada.', error?.message);
    }

    return mapTenant(data);
  }
}
