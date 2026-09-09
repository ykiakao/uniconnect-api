import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';

export type ActivityRow = {
  id: string;
  tenant_id: string;
  class_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  type: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityResponse = {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  type: string;
  classId: string;
  createdBy?: string;
};

const activitySelect =
  'id,tenant_id,class_id,title,description,due_date,type,created_by,created_at,updated_at';

export function mapActivity(row: ActivityRow): ActivityResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    dueDate: row.due_date ?? undefined,
    type: row.type,
    classId: row.class_id,
    createdBy: row.created_by ?? undefined,
  };
}

export class ActivitiesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async listByClass(params: {
    tenantId: string;
    classId: string;
    pagination: Pagination;
  }) {
    const { data, error, count } = await this.supabase
      .from('activities')
      .select(activitySelect, { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .eq('class_id', params.classId)
      .order('due_date')
      .range(
        params.pagination.offset,
        params.pagination.offset + params.pagination.limit - 1,
      );

    if (error) {
      throw new HttpError(
        500,
        'ACTIVITIES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar atividades.',
        error.message,
      );
    }

    return {
      activities: (data ?? []).map((row) => mapActivity(row as ActivityRow)),
      total: count,
    };
  }

  async create(params: {
    tenantId: string;
    classId: string;
    title: string;
    description?: string;
    dueDate?: string;
    type: string;
    createdBy: string;
  }) {
    const { data, error } = await this.supabase
      .from('activities')
      .insert({
        tenant_id: params.tenantId,
        class_id: params.classId,
        title: params.title,
        description: params.description,
        due_date: params.dueDate,
        type: params.type,
        created_by: params.createdBy,
      })
      .select(activitySelect)
      .single<ActivityRow>();

    if (error || !data) {
      throw new HttpError(
        500,
        'ACTIVITY_CREATE_FAILED',
        'NÃ£o foi possÃ­vel criar atividade.',
        error?.message,
      );
    }

    return mapActivity(data);
  }

  async findById(params: { tenantId: string; id: string }) {
    const { data, error } = await this.supabase
      .from('activities')
      .select(activitySelect)
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .single<ActivityRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'ACTIVITY_NOT_FOUND',
        'Atividade nÃ£o encontrada.',
        error?.message,
      );
    }

    return mapActivity(data);
  }

  async update(params: {
    tenantId: string;
    id: string;
    title?: string;
    description?: string;
    dueDate?: string;
    type?: string;
  }) {
    const payload: Record<string, string | undefined> = {
      updated_at: new Date().toISOString(),
    };

    if (params.title !== undefined) payload.title = params.title;
    if (params.description !== undefined) payload.description = params.description;
    if (params.dueDate !== undefined) payload.due_date = params.dueDate;
    if (params.type !== undefined) payload.type = params.type;

    const { data, error } = await this.supabase
      .from('activities')
      .update(payload)
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select(activitySelect)
      .single<ActivityRow>();

    if (error || !data) {
      throw new HttpError(
        404,
        'ACTIVITY_NOT_FOUND',
        'Atividade nÃ£o encontrada.',
        error?.message,
      );
    }

    return mapActivity(data);
  }

  async delete(params: { tenantId: string; id: string }) {
    const { error } = await this.supabase
      .from('activities')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

    if (error) {
      throw new HttpError(
        500,
        'ACTIVITY_DELETE_FAILED',
        'NÃ£o foi possÃ­vel remover atividade.',
        error.message,
      );
    }
  }
}
