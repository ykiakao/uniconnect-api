import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination, toPaginated } from '../../shared/pagination';
import { canManageTenant, ensureCanAssignRole, toUserRole } from '../../shared/roles';
import { ApiUserRole, AppUser } from '../../shared/types';
import { checkSupabaseAvailability, invalidAuthResponse, isExistingAuthUser } from '../../shared/supabase-errors';
import { CoursesRepository } from '../courses/courses.repository';
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
    courseId?: string;
    registration?: string;
    semester?: number;
    requestId?: string;
  }) {
    this.ensureCanManageUsers(params.currentUser);
    ensureCanAssignRole(params.currentUser.role, toUserRole(params.role));
    if (params.courseId) await new CoursesRepository().findById({ tenantId: params.tenantId, id: params.courseId });

    const authUser = await this.ensureAuthUser(params.email, params.password);
    const user = await this.repository.create({
      tenantId: params.tenantId,
      authUserId: authUser.id,
      actorAuthId: params.currentUser.authUserId,
      requestId: params.requestId,
      name: params.name,
      email: params.email,
      role: toUserRole(params.role),
      courseId: params.courseId,
      registration: params.registration,
      semester: params.semester,
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
    requestId?: string;
  }) {
    this.ensureCanManageUsers(params.currentUser);
    const target = await this.repository.findById({ tenantId: params.tenantId, id: params.id });
    if (target.authUserId === params.currentUser.authUserId) {
      throw new HttpError(403, 'ROLE_CHANGE_FORBIDDEN', 'Nao e permitido alterar o proprio papel.');
    }
    ensureCanAssignRole(params.currentUser.role, toUserRole(params.role), target.role);
    const user = await this.repository.updateRole({
      tenantId: params.tenantId,
      id: params.id,
      role: toUserRole(params.role),
      expectedRole: target.role,
      actorAuthId: params.currentUser.authUserId,
      requestId: params.requestId,
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
  async updateProfile(params: { currentUser: AppUser; tenantId: string; tenantSlug: string; id: string;
    input: { name?: string; active?: boolean; courseId?: string | null; registration?: string | null; semester?: number | null } }) {
    this.ensureCanManageUsers(params.currentUser);
    const target = await this.repository.findById({ tenantId: params.tenantId, id: params.id });
    if (target.authUserId === params.currentUser.authUserId) throw new HttpError(403, 'SELF_CHANGE_FORBIDDEN', 'Nao altere o proprio vinculo administrativo.');
    ensureCanAssignRole(params.currentUser.role, target.role, target.role);
    if (params.input.courseId) await new CoursesRepository().findById({ tenantId: params.tenantId, id: params.input.courseId });
    const user = await this.repository.updateProfile(params.tenantId, params.id, target.role, params.input);
    return toUserResponse({ user, tenantSlug: params.tenantSlug });
  }

  private async ensureAuthUser(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await this.supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
    });

    if (!error && data.user) return data.user;
    if (!error) invalidAuthResponse();
    checkSupabaseAvailability(error);
    if (isExistingAuthUser(error)) {
      const existing = await this.findAuthUserByEmail(normalizedEmail);
      if (existing) return existing;
    }

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

      checkSupabaseAvailability(error);
      if (error) {
        throw new HttpError(
          500,
          'AUTH_USER_LOOKUP_FAILED',
          'Não foi possível verificar usuário de autenticação.',
          error.message,
        );
      }

      if (!Array.isArray(data?.users)) invalidAuthResponse();
      const user = data.users.find(
        (candidate) => candidate.email?.toLowerCase() === email,
      );
      if (user) return user;
      if (data.users.length < perPage) return null;
      page += 1;
    }
  }
}
