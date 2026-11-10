import { checkMutationConflict, checkSupabaseAvailability, checkQueryError, requireRows, requireCount } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
  active: boolean;
  course_id: string | null;
};

export type UserResponse = {
  id: string;
  name: string;
  email: string;
  role: ApiUserRole;
  tenantSlug: string;
  active: boolean;
  courseId?: string;
  registration?: string;
  semester?: number;
};

function mapUser(row: AppUserRow): AppUser {
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
    active: params.user.active !== false,
    courseId: params.user.courseId,
    registration: params.user.registration,
    semester: params.user.semester,
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
        'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active',
        { count: 'exact' },
      )
      .eq('tenant_id', params.tenantId)
      .order('name')
      .order('id');

    if (params.role) query = query.eq('role', params.role);

    if (params.search) {
      const search = params.search.replaceAll('%', '').trim();
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, error, count, status } = await query.range(
      params.pagination.offset,
      params.pagination.offset + params.pagination.limit - 1,
    );

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'USERS_LIST_FAILED',
        'Não foi possível listar usuários.',
        error.message,
      );
    }

    return {
      users: requireRows(data).map((row) => mapUser(row as AppUserRow)),
      total: requireCount(count),
    };
  }

  async findById(params: {
    tenantId: string;
    id: string;
  }): Promise<AppUser> {
    const { data, error, status } = await this.supabase
      .from('app_users')
      .select(
        'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active',
      )
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .maybeSingle<AppUserRow>();

    checkQueryError(error, status);
    if (!data) {
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
    tenantId: string; authUserId: string; actorAuthId: string; requestId?: string;
    name: string; email: string; role: UserRole; courseId?: string; registration?: string; semester?: number;
  }) {
    const { data, error, status } = await this.supabase.rpc('manage_institutional_membership', {
      p_tenant_id: params.tenantId, p_actor_auth_id: params.actorAuthId, p_operation: 'create', p_request_id: params.requestId ?? randomUUID(),
      p_payload: { auth_user_id: params.authUserId, name: params.name, email: params.email, role: params.role,
        course_id: params.courseId ?? null, registration: params.registration ?? null, semester: params.semester ?? null },
    });
    if (error?.code === '23505') throw new HttpError(409, 'USER_ALREADY_EXISTS', 'Usuario ja vinculado a instituicao.');
    this.checkMembershipError(error, status);
    return this.parseMember(data, params.tenantId);
  }

  async updateRole(params: { tenantId: string; id: string; role: UserRole; expectedRole: UserRole; actorAuthId: string; requestId?: string }) {
    const { data, error, status } = await this.supabase.rpc('manage_institutional_membership', {
      p_tenant_id: params.tenantId, p_actor_auth_id: params.actorAuthId, p_operation: 'updateRole', p_request_id: params.requestId ?? randomUUID(),
      p_payload: { id: params.id, role: params.role, expected_role: params.expectedRole },
    });
    if (error && ['23514', '23503'].includes(error.code)) throw new HttpError(409, 'ROLE_INTEGRITY_CONFLICT', 'O papel esta vinculado a registros academicos e nao pode ser alterado.');
    this.checkMembershipError(error, status);
    return this.parseMember(data, params.tenantId);
  }

  private checkMembershipError(error: { code?: string } | null, status?: number) {
    if (error?.code === '22023') throw new HttpError(400, 'VALIDATION_ERROR', 'Dados institucionais invalidos.');
    if (error && ['PGRST202', '42883', '42703', '42P01'].includes(error.code ?? '')) throw new HttpError(503, 'DATABASE_MIGRATION_REQUIRED', 'Atualizacao de gestao institucional pendente.');
    if (error?.code === '42501') throw new HttpError(403, 'ROLE_CHANGE_FORBIDDEN', 'Alteracao de papel nao permitida.');
    if (error?.code === 'P0002') throw new HttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    if (error?.code === 'PT409') throw new HttpError(409, 'ROLE_CHANGE_CONFLICT', 'O vinculo foi alterado. Atualize os dados.');
    checkQueryError(error, status);
  }

  private parseMember(data: unknown, tenantId: string) {
    const parsed = z.object({ id: z.string().min(1), tenant_id: z.literal(tenantId), auth_user_id: z.string().min(1), name: z.string(), email: z.string(), role: z.enum(['owner','admin','coordinator','teacher','student']), active: z.boolean() }).passthrough().safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta institucional invalida.');
    return mapUser(parsed.data as AppUserRow);
  }

  async findAcademicMember(params: { tenantId: string; identifier: string; role: 'student' | 'teacher' }): Promise<AppUser> {
    const columns = 'id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active';
    const matches = new Map<string, AppUser>();
    for (const field of ['id', 'auth_user_id']) {
      const { data, error, status } = await this.supabase.from('app_users').select(columns)
        .eq('tenant_id', params.tenantId).eq('role', params.role).eq(field, params.identifier);
      if (error?.code === '22P02') break;
      checkSupabaseAvailability(error, status);
      if (error) throw new HttpError(500, 'MEMBERSHIP_LOOKUP_FAILED', 'Nao foi possivel validar o vinculo institucional.');
      for (const row of requireRows(data)) {
        const member = mapUser(row as AppUserRow);
        matches.set(member.authUserId, member);
      }
    }
    if (matches.size === 1) return matches.values().next().value!;
    throw new HttpError(404, params.role === 'student' ? 'STUDENT_NOT_FOUND' : 'TEACHER_NOT_FOUND', 'Vinculo institucional autorizado nao encontrado.');
  }
  async updateProfile(tenantId: string, id: string, expectedRole: UserRole, input: { name?: string; active?: boolean; courseId?: string | null; registration?: string | null; semester?: number | null }) {
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(input)) if (value !== undefined) values[key === 'courseId' ? 'course_id' : key] = value;
    const { data, error, status } = await this.supabase.from('app_users').update(values).eq('tenant_id', tenantId).eq('id', id).eq('role', expectedRole)
      .select('id,tenant_id,auth_user_id,name,email,role,course,course_id,registration,semester,active').maybeSingle<AppUserRow>();
    checkQueryError(error, status);
    if (!data) throw new HttpError(404, 'USER_NOT_FOUND', 'Usuario nao encontrado.');
    return mapUser(data);
  }
}
