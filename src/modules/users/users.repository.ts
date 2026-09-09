import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';
import { toApiUserRole } from '../../shared/roles';
import { ApiUserRole, AppUser, UserRole } from '../../shared/types';

type AppUserRow = {
  id: string;
  tenant_id: string;
  auth_user_id: string;
  name: string;
  email: string;
  role: UserRole;
  course: string | null;
  registration: string | null;
  semester: number | null;
};

export type UserResponse = {
  id: string;
  name: string;
  email: string;
  role: ApiUserRole;
  tenantSlug: string;
};

function mapUser(row: AppUserRow): AppUser {
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

export function toUserResponse(params: {
  user: AppUser;
  tenantSlug: string;
}): UserResponse {
  return {
    id: params.user.id,
    name: params.user.name,
    email: params.user.email,
    role: toApiUserRole(params.user.role),
    tenantSlug: params.tenantSlug,
  };
}

export class UsersRepository {
  private readonly supabase = createSupabaseAdminClient();

  async list(params: {
    tenantId: string;
    role?: UserRole;
    search?: string;
    pagination: Pagination;
  }) {
    let query = this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,registration,semester',
        { count: 'exact' },
      )
      .eq('tenant_id', params.tenantId)
      .order('name');

    if (params.role) query = query.eq('role', params.role);

    if (params.search) {
      const search = params.search.replaceAll('%', '').trim();
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, error, count } = await query.range(
      params.pagination.offset,
      params.pagination.offset + params.pagination.limit - 1,
    );

    if (error) {
      throw new HttpError(
        500,
        'USERS_LIST_FAILED',
        'Não foi possível listar usuários.',
        error.message,
      );
    }

    return {
      users: (data ?? []).map((row) => mapUser(row as AppUserRow)),
      total: count,
    };
  }

  async findById(params: {
    tenantId: string;
    id: string;
  }): Promise<AppUser> {
    const { data, error } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,registration,semester',
      )
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .single<AppUserRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'USER_NOT_FOUND',
        'Usuário não encontrado.',
        error?.message,
      );
    }

    return mapUser(data);
  }

  async create(params: {
    tenantId: string;
    authUserId: string;
    name: string;
    email: string;
    role: UserRole;
  }) {
    const { data, error } = await this.supabase
      .from('app_users')
      .insert({
        tenant_id: params.tenantId,
        auth_user_id: params.authUserId,
        name: params.name,
        email: params.email,
        role: params.role,
      })
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,registration,semester',
      )
      .single<AppUserRow>();

    if (error || !data) {
      throw new HttpError(
        error?.code === '23505' ? 409 : 500,
        error?.code === '23505' ? 'USER_ALREADY_EXISTS' : 'USER_CREATE_FAILED',
        error?.code === '23505'
          ? 'Usuário já vinculado à instituição.'
          : 'Não foi possível criar usuário.',
        error?.message,
      );
    }

    return mapUser(data);
  }

  async updateRole(params: {
    tenantId: string;
    id: string;
    role: UserRole;
  }) {
    const { data, error } = await this.supabase
      .from('app_users')
      .update({ role: params.role })
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,registration,semester',
      )
      .single<AppUserRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'USER_NOT_FOUND',
        'Usuário não encontrado.',
        error?.message,
      );
    }

    return mapUser(data);
  }
}
