import { checkQueryError, requireRows } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { AppUser } from '../../shared/types';
import { canAccessPlatform } from '../../shared/roles';

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
  active: boolean;
  course_id: string | null;
};

function mapAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    authUserId: row.auth_user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active !== false,
    courseId: row.course_id ?? undefined,
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
    const { data, error, status } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active',
      )
      .eq('auth_user_id', params.authUserId)
      .eq('tenant_id', params.tenantId)
      .maybeSingle<AppUserRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        403,
        'USER_NOT_LINKED_TO_TENANT',
        'Usuário não vinculado à instituição.',
        error?.message,
      );
    }

    if (data.active === false) throw new HttpError(403, 'USER_INACTIVE', 'Vinculo institucional desativado.');
    return mapAppUser(data);
  }

  async findAnyUserByAuthId(authUserId: string): Promise<AppUser> {
    const { data, error, status } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active',
      )
      .eq('auth_user_id', authUserId);

    checkQueryError(error, status);
    requireRows(data);
    if (!data?.length) {
      throw new HttpError(
        403,
        'USER_NOT_LINKED_TO_TENANT',
        'UsuÃ¡rio nÃ£o vinculado a uma instituiÃ§Ã£o.',
        error?.message,
      );
    }

    const rows = data as AppUserRow[];
    const activeRows = rows.filter(row => row.active !== false);
    const eligible = activeRows.length ? activeRows : canAccessPlatform(authUserId) ? rows : [];
    if (!eligible.length) throw new HttpError(403, 'USER_INACTIVE', 'Vinculo institucional desativado.');
    const user =
      eligible.find((row) =>
        ['admin', 'owner'].includes(row.role),
      ) ?? eligible[0];

    return mapAppUser(user);
  }

  async findUserByEmail(params: {
    email: string;
    tenantId: string;
  }): Promise<AppUser> {
    const { data, error, status } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active',
      )
      .eq('email', params.email)
      .eq('tenant_id', params.tenantId)
      .maybeSingle<AppUserRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        403,
        'USER_NOT_LINKED_TO_TENANT',
        'Usuário não vinculado à instituição.',
        error?.message,
      );
    }

    if (data.active === false) throw new HttpError(403, 'USER_INACTIVE', 'Vinculo institucional desativado.');
    return mapAppUser(data);
  }
}
