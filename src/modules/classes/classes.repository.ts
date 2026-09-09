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
  }) {
    let query = this.supabase
      .from('classes')
      .select(
        'id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at',
        { count: 'exact' },
      )
      .eq('tenant_id', params.tenantId)
      .eq('course_id', params.courseId)
      .order('name');

    if (params.teacherAuthUserId) {
      query = query.eq('teacher_id', params.teacherAuthUserId);
    }

    const { data, error, count } = await query.range(
      params.pagination.offset,
      params.pagination.offset + params.pagination.limit - 1,
    );

    if (error) {
      throw new HttpError(
        500,
        'CLASSES_LIST_FAILED',
        'Não foi possível listar turmas.',
        error.message,
      );
    }

    return {
      classes: (data ?? []).map((row) => mapClass(row as ClassRow)),
      total: count,
    };
  }

  async create(params: {
    tenantId: string;
    courseId: string;
    name: string;
    teacherId?: string;
  }) {
    const { data, error } = await this.supabase
      .from('classes')
      .insert({
        tenant_id: params.tenantId,
        course_id: params.courseId,
        name: params.name,
        teacher_id: params.teacherId,
      })
      .select('id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at')
      .single<ClassRow>();

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

    const { data, error } = await query.single<ClassRow>();

    if (error || !data) {
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
    const { data, error } = await this.supabase
      .from('classes')
      .update({
        name: params.name,
        teacher_id: params.teacherId,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select('id,tenant_id,course_id,name,teacher_id,semester,created_at,updated_at')
      .single<ClassRow>();

    if (error || !data) {
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
    const { error } = await this.supabase
      .from('classes')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

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
