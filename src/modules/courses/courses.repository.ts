import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';

export type CourseRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type CourseResponse = {
  id: string;
  name: string;
  description?: string;
  tenantId: string;
};

export type CourseDetailResponse = CourseResponse & {
  classes: Array<{
    id: string;
    name: string;
    courseId: string;
    teacherId?: string;
  }>;
};

function mapCourse(row: CourseRow): CourseResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    tenantId: row.tenant_id,
  };
}

export class CoursesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async list(params: {
    tenantId: string;
    search?: string;
    pagination: Pagination;
  }) {
    let query = this.supabase
      .from('courses')
      .select('id,tenant_id,name,description,created_at,updated_at', {
        count: 'exact',
      })
      .eq('tenant_id', params.tenantId)
      .order('name');

    if (params.search) {
      const search = params.search.replaceAll('%', '').trim();
      query = query.ilike('name', `%${search}%`);
    }

    const { data, error, count } = await query.range(
      params.pagination.offset,
      params.pagination.offset + params.pagination.limit - 1,
    );

    if (error) {
      throw new HttpError(
        500,
        'COURSES_LIST_FAILED',
        'Não foi possível listar cursos.',
        error.message,
      );
    }

    return {
      courses: (data ?? []).map((row) => mapCourse(row as CourseRow)),
      total: count,
    };
  }

  async create(params: {
    tenantId: string;
    name: string;
    description?: string;
  }) {
    const { data, error } = await this.supabase
      .from('courses')
      .insert({
        tenant_id: params.tenantId,
        name: params.name,
        description: params.description,
      })
      .select('id,tenant_id,name,description,created_at,updated_at')
      .single<CourseRow>();

    if (error || !data) {
      throw new HttpError(
        500,
        'COURSE_CREATE_FAILED',
        'Não foi possível criar curso.',
        error?.message,
      );
    }

    return mapCourse(data);
  }

  async findById(params: {
    tenantId: string;
    id: string;
  }): Promise<CourseResponse> {
    const { data, error } = await this.supabase
      .from('courses')
      .select('id,tenant_id,name,description,created_at,updated_at')
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .single<CourseRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'COURSE_NOT_FOUND',
        'Curso não encontrado.',
        error?.message,
      );
    }

    return mapCourse(data);
  }

  async findByIdWithClasses(params: {
    tenantId: string;
    id: string;
  }): Promise<CourseDetailResponse> {
    const course = await this.findById(params);
    const { data, error } = await this.supabase
      .from('classes')
      .select('id,name,course_id,teacher_id')
      .eq('tenant_id', params.tenantId)
      .eq('course_id', params.id)
      .order('name');

    if (error) {
      throw new HttpError(
        500,
        'COURSE_CLASSES_LIST_FAILED',
        'Não foi possível listar turmas do curso.',
        error.message,
      );
    }

    return {
      ...course,
      classes: (data ?? []).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        courseId: row.course_id as string,
        teacherId: (row.teacher_id as string | null) ?? undefined,
      })),
    };
  }

  async update(params: {
    tenantId: string;
    id: string;
    name: string;
    description?: string;
  }) {
    const { data, error } = await this.supabase
      .from('courses')
      .update({
        name: params.name,
        description: params.description,
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select('id,tenant_id,name,description,created_at,updated_at')
      .single<CourseRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'COURSE_NOT_FOUND',
        'Curso não encontrado.',
        error?.message,
      );
    }

    return mapCourse(data);
  }

  async delete(params: { tenantId: string; id: string }) {
    const { error } = await this.supabase
      .from('courses')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

    if (error) {
      throw new HttpError(
        500,
        'COURSE_DELETE_FAILED',
        'Não foi possível remover curso.',
        error.message,
      );
    }
  }
}
