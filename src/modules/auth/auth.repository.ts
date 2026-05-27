import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { AppUser } from '../../shared/types';

type AppUserRow = {
  id: string;
  tenant_id: string;
  auth_user_id: string;
  name: string;
  email: string;
  role: AppUser['role'];
  course: string | null;
  registration: string | null;
  semester: number | null;
};

function mapAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    authUserId: row.auth_user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    course: row.course ?? undefined,
    registration: row.registration ?? undefined,
    semester: row.semester ?? undefined,
  };
}

export class AuthRepository {
  private readonly supabase = createSupabaseAdminClient();

  async findUserByAuthId(params: {
    authUserId: string;
    tenantId: string;
  }): Promise<AppUser> {
    const { data, error } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,registration,semester',
      )
      .eq('auth_user_id', params.authUserId)
      .eq('tenant_id', params.tenantId)
      .single<AppUserRow>();

    if (error || !data) {
      throw new HttpError(
        403,
        'Usuário não vinculado à instituição.',
        error?.message,
      );
    }

    return mapAppUser(data);
  }
}
