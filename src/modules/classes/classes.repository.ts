import { checkMutationConflict, checkSupabaseAvailability, checkQueryError, requireRows, requireCount } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';

export type ClassRow = {
  id: string;
  tenant_id: string;
  course_id: string;
  name: string;
  teacher_id: string | null;
  semester: number | null;
  created_at: string;
  updated_at: string;
};

export type ClassResponse = {
  id: string;
  name: string;
  courseId: string;
  teacherId?: string;
};

function mapClass(row: ClassRow): ClassResponse {
  return {
    id: row.id,
    name: row.name,
    courseId: row.course_id,
    teacherId: row.teacher_id ?? undefined,
  };
}

export class ClassesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async listByCourse(params: {
    tenantId: string;
    courseId: string;
    teacherAuthUserId?: string;
    pagination: Pagination;
    classIds?: string[];
  }) {
    let query = this.supabase
      .from('classes')
      .select(
        'id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at',
        { count: 'exact' },
      )
      .eq('tenant_id', params.tenantId)
      .eq('course_id', params.courseId)
      .order('name')
      .order('id');

    if (params.classIds) query = query.in('id', params.classIds);
    if (params.teacherAuthUserId) {
      query = query.eq('teacher_id', params.teacherAuthUserId);
    }

    const { data, error, count, status } = await query.range(
      params.pagination.offset,
      params.pagination.offset + params.pagination.limit - 1,
    );

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'CLASSES_LIST_FAILED',
        'Não foi possível listar turmas.',
        error.message,
      );
    }

    return {
      classes: requireRows(data).map((row) => mapClass(row as ClassRow)),
      total: requireCount(count),
    };
  }

  async create(params: {
    tenantId: string;
    courseId: string;
    name: string;
    teacherId?: string;
  }) {
    const { data, error, status } = await this.supabase
      .from('classes')
      .insert({
        tenant_id: params.tenantId,
        course_id: params.courseId,
        name: params.name,
        teacher_id: params.teacherId,
      })
      .select('id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at')
      .single<ClassRow>();

    checkSupabaseAvailability(error, status);
    checkMutationConflict(error);
    if (error || !data) {
      throw new HttpError(
        500,
        'CLASS_CREATE_FAILED',
        'Não foi possível criar turma.',
        error?.message,
      );
    }

    return mapClass(data);
  }

  async findById(params: {
    tenantId: string;
    id: string;
    teacherAuthUserId?: string;
  }) {
    let query = this.supabase
      .from('classes')
      .select('id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at')
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

    if (params.teacherAuthUserId) {
      query = query.eq('teacher_id', params.teacherAuthUserId);
    }

    const { data, error, status } = await query.maybeSingle<ClassRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        404,
        'CLASS_NOT_FOUND',
        'Turma não encontrada.',
        error?.message,
      );
    }

    return mapClass(data);
  }

  async update(params: {
    tenantId: string;
    id: string;
    name: string;
    teacherId?: string;
  }) {
    const { data, error, status } = await this.supabase
      .from('classes')
      .update({
        name: params.name,
        teacher_id: params.teacherId,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select('id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at')
      .maybeSingle<ClassRow>();

    checkQueryError(error, status);
    if (!data) {
      throw new HttpError(
        404,
        'CLASS_NOT_FOUND',
        'Turma não encontrada.',
        error?.message,
      );
    }

    return mapClass(data);
  }

  async delete(params: { tenantId: string; id: string }) {
    const { error, status } = await this.supabase
      .from('classes')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

    checkSupabaseAvailability(error, status);
    checkMutationConflict(error);
    if (error) {
      throw new HttpError(
        500,
        'CLASS_DELETE_FAILED',
        'Não foi possível remover turma.',
        error.message,
      );
    }
  }
}
