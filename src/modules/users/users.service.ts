import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant, toUserRole } from '../../shared/roles';
import { ApiUserRole, AppUser } from '../../shared/types';
import {
  toUserResponse,
  UserResponse,
  UsersRepository,
} from './users.repository';

export class UsersService {
  private readonly supabase = createSupabaseAdminClient();
  private readonly repository = new UsersRepository();

  async list(params: {
    currentUser: AppUser;
    tenantId: string;
    tenantSlug: string;
    role?: ApiUserRole;
    search?: string;
    pagination: Pagination;
  }) {
    this.ensureCanManageUsers(params.currentUser);

    const { users, total } = await this.repository.list({
      tenantId: params.tenantId,
      role: params.role ? toUserRole(params.role) : undefined,
      search: params.search,
      pagination: params.pagination,
    });

    return toPaginated<UserResponse>({
      data: users.map((user) =>
        toUserResponse({
          user,
          tenantSlug: params.tenantSlug,
        }),
      ),
      total,
      page: params.pagination.page,
      limit: params.pagination.limit,
    });
  }

  async create(params: {
    currentUser: AppUser;
    tenantId: string;
    tenantSlug: string;
    name: string;
    email: string;
    password: string;
    role: ApiUserRole;
  }) {
    this.ensureCanManageUsers(params.currentUser);

    const authUser = await this.ensureAuthUser(params.email, params.password);
    const user = await this.repository.create({
      tenantId: params.tenantId,
      authUserId: authUser.id,
      name: params.name,
      email: params.email,
      role: toUserRole(params.role),
    });

    return toUserResponse({
      user,
      tenantSlug: params.tenantSlug,
    });
  }

  async findById(params: {
    currentUser: AppUser;
    tenantId: string;
    tenantSlug: string;
    id: string;
  }) {
    this.ensureCanManageUsers(params.currentUser);
    const user = await this.repository.findById({
      tenantId: params.tenantId,
      id: params.id,
    });

    return toUserResponse({
      user,
      tenantSlug: params.tenantSlug,
    });
  }

  async updateRole(params: {
    currentUser: AppUser;
    tenantId: string;
    id: string;
    role: ApiUserRole;
  }) {
    this.ensureCanManageUsers(params.currentUser);
    const user = await this.repository.updateRole({
      tenantId: params.tenantId,
      id: params.id,
      role: toUserRole(params.role),
    });

    return {
      id: user.id,
      role: params.role,
    };
  }

  private ensureCanManageUsers(user: AppUser) {
    if (!canManageTenant(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Acesso não permitido');
    }
  }

  private async ensureAuthUser(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await this.supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
    });

    if (!error && data.user) return data.user;

    const existing = await this.findAuthUserByEmail(normalizedEmail);
    if (existing) return existing;

    throw new HttpError(
      500,
      'AUTH_USER_CREATE_FAILED',
      'Não foi possível criar usuário de autenticação.',
      error?.message,
    );
  }

  private async findAuthUserByEmail(email: string) {
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data, error } = await this.supabase.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        throw new HttpError(
          500,
          'AUTH_USER_LOOKUP_FAILED',
          'Não foi possível verificar usuário de autenticação.',
          error.message,
        );
      }

      const user = data.users.find(
        (candidate) => candidate.email?.toLowerCase() === email,
      );
      if (user) return user;
      if (data.users.length < perPage) return null;
      page += 1;
    }
  }
}
