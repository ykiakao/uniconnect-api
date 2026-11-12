import { z } from 'zod';
import { env } from '../../config/env';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { Pagination } from '../../shared/pagination';
import { requireCount, requireRows } from '../../shared/supabase-errors';
import { activityRpc, checkWorkflowError } from './activities.workflow.rpc';

const submissionSchema = z.object({ id: z.string().min(1), tenant_id: z.string(), activity_id: z.string(), class_id: z.string(), student_id: z.string(), current_version: z.number().int().positive(), answer: z.string(), submitted_at: z.string(), is_late: z.boolean() });
const gradeSchema = z.object({ id: z.string(), tenant_id: z.string(), activity_id: z.string(), student_id: z.string(), grade: z.number().nullable(), feedback: z.string().nullable(), graded_at: z.string().nullable(), graded_by: z.string().nullable(), publication_state: z.enum(['draft','published']), revision: z.number().int().positive(), submission_id: z.string().nullable(), submission_version: z.number().int().nullable() });
export type Submission = z.infer<typeof submissionSchema>;
export type Review = z.infer<typeof gradeSchema>;
const submissionColumns = 'id,tenant_id,activity_id,class_id,student_id,current_version,answer,submitted_at,is_late';
const gradeColumns = 'id,tenant_id,activity_id,student_id,grade,feedback,graded_at,graded_by,publication_state,revision,submission_id,submission_version';
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta academica invalida.');
  return result.data;
}
export class SubmissionsRepository {
  private readonly db = createSupabaseAdminClient();
  async find(tenantId: string, id: string): Promise<Submission> {
    const { data,error,status } = await this.db.from('activity_submissions').select(submissionColumns).eq('tenant_id',tenantId).eq('id',id).maybeSingle();
    checkWorkflowError(error,status);
    if (!data) throw new HttpError(404,'SUBMISSION_NOT_FOUND','Entrega nao encontrada.');
    return parse(submissionSchema,data);
  }
  async own(tenantId: string, activityId: string, studentId: string): Promise<Submission | null> {
    const { data,error,status } = await this.db.from('activity_submissions').select(submissionColumns).eq('tenant_id',tenantId).eq('activity_id',activityId).eq('student_id',studentId).maybeSingle();
    checkWorkflowError(error,status); return data ? parse(submissionSchema,data) : null;
  }
  async list(tenantId: string, activityId: string, pagination: Pagination) {
    const {data,error,status,count} = await this.db.from('activity_submissions').select(submissionColumns,{count:'exact'}).eq('tenant_id',tenantId).eq('activity_id',activityId).order('submitted_at').order('id').range(pagination.offset,pagination.offset+pagination.limit-1);
    checkWorkflowError(error,status); return { data:requireRows(data).map(row => parse(submissionSchema,row)), total:requireCount(count) };
  }
  async reviews(tenantId: string, submissionIds: string[]) {
    if (!submissionIds.length) return [];
    const {data,error,status} = await this.db.from('grades').select(gradeColumns).eq('tenant_id',tenantId).in('submission_id',submissionIds);
    checkWorkflowError(error,status); return requireRows(data).map(row => parse(gradeSchema,row));
  }
  async submit(tenantId: string, actorId: string, activityId: string, version: number, answer: string, attachmentIds: string[] = []) {
    if (attachmentIds.length && env.ACADEMIC_ATTACHMENTS_MODE !== 'enabled') throw new HttpError(503,'ACADEMIC_ATTACHMENTS_UNAVAILABLE','Novos anexos estao indisponiveis.');
    const enabled = env.ACADEMIC_ATTACHMENTS_MODE === 'enabled';
    return parse(submissionSchema,await activityRpc(enabled ? 'submit_activity_answer_with_attachments' : 'submit_activity_answer',{
      p_tenant_id:tenantId,p_actor_id:actorId,p_activity_id:activityId,p_expected_version:version,p_answer:answer,...(enabled ? {p_attachment_ids:attachmentIds} : {}),
    }));
  }
  async review(tenantId: string, actorId: string, submissionId: string, input: {expectedRevision:number;submissionVersion:number;grade:number|null;feedback:string|null;publish:boolean}) {
    return parse(gradeSchema,await activityRpc('review_activity_submission',{p_tenant_id:tenantId,p_actor_id:actorId,p_submission_id:submissionId,p_expected_revision:input.expectedRevision,p_submission_version:input.submissionVersion,p_grade:input.grade,p_feedback:input.feedback,p_publish:input.publish}));
  }
  async publish(tenantId: string, actorId: string, submissionId: string, expectedRevision: number) {
    return parse(gradeSchema,await activityRpc('publish_activity_review',{p_tenant_id:tenantId,p_actor_id:actorId,p_submission_id:submissionId,p_expected_revision:expectedRevision}));
  }
  async recordManual(tenantId:string,actorId:string,activityId:string,studentId:string,grade:number,feedback:string|null) {
    return parse(gradeSchema,await activityRpc('record_activity_grade',{p_tenant_id:tenantId,p_actor_id:actorId,p_activity_id:activityId,p_student_id:studentId,p_grade:grade,p_feedback:feedback}));
  }
  async history(tenantId:string, submissionId:string, publishedOnly:boolean, pagination:Pagination) {
    const versions = await this.db.from('activity_submission_versions').select('submission_id,version,answer,submitted_at,is_late',{count:'exact'}).eq('tenant_id',tenantId).eq('submission_id',submissionId).order('version').range(pagination.offset,pagination.offset+pagination.limit-1);
    checkWorkflowError(versions.error,versions.status);
    let query = this.db.from('grade_revisions').select('grade,feedback,graded_at,publication_state,revision,submission_version',{count:'exact'}).eq('tenant_id',tenantId).eq('submission_id',submissionId);
    if (publishedOnly) query = query.eq('publication_state','published');
    const evaluations = await query.order('revision').range(pagination.offset,pagination.offset+pagination.limit-1);
    checkWorkflowError(evaluations.error,evaluations.status);
    return { versions:requireRows(versions.data).map(row => ({version:row.version,answer:row.answer,submittedAt:row.submitted_at,isLate:row.is_late})),
      evaluations:requireRows(evaluations.data).map(row => ({grade:row.grade,feedback:row.feedback,gradedAt:row.graded_at,publicationState:row.publication_state,revision:row.revision,submissionVersion:row.submission_version})),
      meta:{page:pagination.page,limit:pagination.limit,versionsTotal:requireCount(versions.count),evaluationsTotal:requireCount(evaluations.count)} };
  }
}
