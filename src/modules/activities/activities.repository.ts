import { checkMutationConflict, checkSupabaseAvailability, checkQueryError, requireRows, requireCount } from '../../shared/supabase-errors';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';
import type { AssessmentStage, AssessmentCategory } from '../grades/academic-grade-calculator';
import { activityRpc } from './activities.workflow.rpc';
import { z } from 'zod';

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
  state?: 'draft'|'published'|'closed';
  instructions?: string|null;
  evaluation_criteria?: string|null;
  priority?: 'low'|'medium'|'high';
  allow_late?: boolean;
  revision?: number;
  workflow_enabled?: boolean;
  published_at?: string|null;
  closed_at?: string|null;
  assessment_stage?: AssessmentStage | null;
  assessment_category?: AssessmentCategory | null;
  assessment_max_points?: number | null;
  exam_grading_opened_at?: string | null;
};

export type ActivityResponse = {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  type: string;
  classId: string;
  createdBy?: string;
  state: 'draft'|'published'|'closed';
  instructions?: string;
  evaluationCriteria?: string;
  priority: 'low'|'medium'|'high';
  allowLate: boolean;
  revision: number;
  workflowEnabled: boolean;
  publishedAt?: string;
  closedAt?: string;
  assessment?: { stage: AssessmentStage; category: AssessmentCategory; maxPoints: string };
  examGradingOpenedAt?: string;
};

const activitySelect =
  'id,tenant_id,class_id,title,description,due_date,type,created_by,created_at,updated_at,state,instructions,evaluation_criteria,priority,allow_late,revision,workflow_enabled,published_at,closed_at,assessment_stage,assessment_category,assessment_max_points,exam_grading_opened_at';

const activityRpcSchema = z.object({
  id: z.string().min(1), tenant_id: z.string().min(1), class_id: z.string().min(1),
  title: z.string(), type: z.string(), description: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(), created_by: z.string().nullable().optional(),
  state: z.enum(['draft', 'published', 'closed']), instructions: z.string().nullable().optional(),
  evaluation_criteria: z.string().nullable().optional(), priority: z.enum(['low', 'medium', 'high']).optional(),
  allow_late: z.boolean().optional(), revision: z.number().int().positive().optional(),
  workflow_enabled: z.boolean().optional(), published_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  assessment_stage: z.enum(['N1', 'N2']).nullish(),
  assessment_category: z.enum(['exam', 'activity']).nullish(),
  assessment_max_points: z.number().min(0).max(7).nullish(),
  exam_grading_opened_at: z.string().nullish(),
}).passthrough();

function parseActivityRpc(value: unknown, tenantId: string, classId?: string, activityId?: string): ActivityRow {
  const result = activityRpcSchema.safeParse(value);
  if (!result.success || result.data.tenant_id !== tenantId ||
      (classId !== undefined && result.data.class_id !== classId) ||
      (activityId !== undefined && result.data.id !== activityId)) {
    throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta da atividade invalida.');
  }
  return result.data as ActivityRow;
}

export function mapActivity(row: ActivityRow): ActivityResponse {
  const { assessment_stage: stage, assessment_category: category, assessment_max_points: maxPoints } = row;
  const assessment = stage && category && maxPoints != null
    ? { stage, category, maxPoints: maxPoints.toFixed(2) }
    : undefined;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    dueDate: row.due_date ?? undefined,
    type: row.type,
    classId: row.class_id,
    createdBy: row.created_by ?? undefined,
    state: row.state ?? 'published', instructions: row.instructions ?? undefined, evaluationCriteria: row.evaluation_criteria ?? undefined,
    priority: row.priority ?? 'medium', allowLate: row.allow_late ?? false, revision: row.revision ?? 1,
    workflowEnabled: row.workflow_enabled ?? false, publishedAt: row.published_at ?? undefined, closedAt: row.closed_at ?? undefined,
    ...(assessment && { assessment }),
    ...(row.exam_grading_opened_at && { examGradingOpenedAt: row.exam_grading_opened_at }),
  };
}

export class ActivitiesRepository {
  private readonly supabase = createSupabaseAdminClient();

  async manage(tenantId:string,actorId:string,operation:string,options:{id?:string;classId?:string;payload?:Record<string,unknown>}) {
    const data=await activityRpc('manage_academic_activity',{p_tenant_id:tenantId,p_actor_id:actorId,p_operation:operation,p_activity_id:options.id??null,p_class_id:options.classId??null,p_payload:options.payload??{}});
    return mapActivity(parseActivityRpc(data,tenantId,options.classId,options.id));
  }

  async visibleToStudent(tenantId:string,actorId:string,classId:string,pagination:Pagination,activityId?:string) {
    const result=await activityRpc('list_academic_activities',{p_tenant_id:tenantId,p_actor_id:actorId,p_class_id:classId,p_offset:pagination.offset,p_limit:pagination.limit,p_activity_id:activityId??null});
    if (!result||typeof result!=='object'||!('activities' in result)||!('total' in result)||!Array.isArray(result.activities)||typeof result.total!=='number') throw new HttpError(502,'DEPENDENCY_INVALID_RESPONSE','Lista de atividades invalida.');
    const rows=result.activities.map(row=>parseActivityRpc(row,tenantId,classId,activityId));
    if (rows.some(row=>row.tenant_id!==tenantId||row.class_id!==classId||!['published','closed'].includes(row.state??''))) throw new HttpError(502,'DEPENDENCY_INVALID_RESPONSE','Escopo de atividades invalido.');
    return {activities:rows.map(mapActivity),total:requireCount(result.total)};
  }

  async listByClass(params: {
    tenantId: string;
    classId: string;
    pagination: Pagination;
    studentId?: string;
  }) {
    if (params.studentId) return this.visibleToStudent(params.tenantId,params.studentId,params.classId,params.pagination);
    const { data, error, count, status } = await this.supabase
      .from('activities')
      .select(activitySelect, { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .eq('class_id', params.classId)
      .order('due_date')
      .order('id')
      .range(
        params.pagination.offset,
        params.pagination.offset + params.pagination.limit - 1,
      );

    checkSupabaseAvailability(error, status);
    if (error) {
      throw new HttpError(
        500,
        'ACTIVITIES_LIST_FAILED',
        'NÃ£o foi possÃ­vel listar atividades.',
        error.message,
      );
    }

    return {
      activities: requireRows(data).map((row) => mapActivity(row as ActivityRow)),
      total: requireCount(count),
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
    const { data, error, status } = await this.supabase
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

    checkSupabaseAvailability(error, status);
    checkMutationConflict(error);
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
    const { data, error, status } = await this.supabase
      .from('activities')
      .select(activitySelect)
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .maybeSingle<ActivityRow>();

    checkQueryError(error, status);
    if (!data) {
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

    const { data, error, status } = await this.supabase
      .from('activities')
      .update(payload)
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id)
      .select(activitySelect)
      .maybeSingle<ActivityRow>();

    checkQueryError(error, status);
    if (!data) {
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
    const { error, status } = await this.supabase
      .from('activities')
      .delete()
      .eq('tenant_id', params.tenantId)
      .eq('id', params.id);

    checkSupabaseAvailability(error, status);
    checkMutationConflict(error);
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
