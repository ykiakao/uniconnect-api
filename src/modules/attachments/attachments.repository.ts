import { z } from 'zod';
import { createSupabaseAdminClient } from '../../config/supabase';
import { env } from '../../config/env';
import { HttpError } from '../../shared/http-error';
import { checkWorkflowError } from '../activities/activities.workflow.rpc';
import { AppUser } from '../../shared/types';
import { attachmentSchema, Reservation, storedFileSchema, StoredFile } from './attachments.schemas';

export type AttachmentContext = { tenantId: string; user: AppUser };
export type VersionReference = { submissionId: string; version: number };
const versionFilesSchema = z.array(z.object({ submissionId: z.string(), version: z.number().int().positive(), attachments: z.array(attachmentSchema).max(5) })).max(100);

export class AttachmentsRepository {
  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error, status } = await createSupabaseAdminClient().rpc(name, args);
    if (error?.code === '54000') throw new HttpError(409, 'ATTACHMENT_LIMIT_EXCEEDED', 'Limite de anexos ou armazenamento atingido.');
    checkWorkflowError(error, status);
    return data;
  }
  private context(context: AttachmentContext) {
    if (context.user.tenantId !== context.tenantId || context.user.active === false) throw new HttpError(403, 'FORBIDDEN', 'Contexto institucional invalido.');
    return { p_tenant_id: context.tenantId, p_actor_id: context.user.id };
  }
  private file(value: unknown, context: AttachmentContext, owner: boolean): StoredFile {
    const parsed = storedFileSchema.safeParse(value);
    if (!parsed.success || parsed.data.tenant_id !== context.tenantId || (owner && parsed.data.created_by !== context.user.id)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Resposta de arquivo invalida.');
    const file = parsed.data;
    const suffix = `${file.tenant_id}/${file.activity_scope_id}/${file.id}/`;
    if (!file.staging_path.startsWith(`staging/${suffix}`) || file.candidate_paths.some(path => !path.startsWith(`files/${suffix}`)) ||
      (file.candidate_path !== null && !file.candidate_paths.includes(file.candidate_path)) || (file.final_path !== null && !file.candidate_paths.includes(file.final_path)) ||
      file.bucket !== env.ACADEMIC_ATTACHMENTS_BUCKET || [file.staging_path, ...file.candidate_paths].some(path => !/^(staging|files)\/[a-f0-9/-]+(?:\.(?:pdf|docx|png|jpg))?$/.test(path))) {
      throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Escopo de arquivo invalido.');
    }
    return file;
  }
  async reserve(context: AttachmentContext, activityId: string, purpose: 'material'|'submission', request: Reservation, key: string) {
    const file = this.file(await this.rpc('academic_attachment_reserve', { ...this.context(context), p_activity_id: activityId, p_purpose: purpose, p_bucket: env.ACADEMIC_ATTACHMENTS_BUCKET, p_request: { ...request, idempotencyKey: key } }), context, true);
    if (file.activity_scope_id !== activityId || file.purpose !== purpose) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Escopo de reserva invalido.');
    return file;
  }
  async upload(context: AttachmentContext, fileId: string, operation: string, payload: Record<string, unknown> = {}) {
    const file = this.file(await this.rpc('academic_attachment_upload', { ...this.context(context), p_file_id: fileId, p_operation: operation, p_payload: payload }), context, true);
    if (file.id !== fileId) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Identidade de arquivo invalida.');
    return file;
  }
  async materials(context: AttachmentContext, activityId: string) {
    const value = await this.rpc('academic_attachment_material', { ...this.context(context), p_activity_id: activityId, p_operation: 'list', p_file_id: null, p_expected_version: null });
    const parsed = z.array(attachmentSchema).max(5).safeParse(value);
    if (!parsed.success) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Lista de anexos invalida.');
    return parsed.data;
  }
  async material(context: AttachmentContext, activityId: string, fileId: string, revision: number, operation: 'add'|'remove') {
    const value = await this.rpc('academic_attachment_material', { ...this.context(context), p_activity_id: activityId, p_file_id: fileId, p_expected_version: revision, p_operation: operation });
    const parsed = z.object({ id: z.string(), revision: z.number().int().positive(), attachment: attachmentSchema.optional() }).safeParse(value);
    if (!parsed.success || parsed.data.id !== fileId || (operation === 'add' && parsed.data.attachment?.id !== fileId)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Vinculo de anexo invalido.');
    return parsed.data;
  }
  async versions(context: AttachmentContext, versions: VersionReference[]) {
    if (env.ACADEMIC_ATTACHMENTS_MODE === 'disabled' || !versions.length) return [];
    const value = await this.rpc('academic_attachment_versions', { ...this.context(context), p_versions: versions });
    const parsed = versionFilesSchema.safeParse(value);
    if (!parsed.success || parsed.data.length !== versions.length || parsed.data.some((row, index) => row.submissionId !== versions[index].submissionId || row.version !== versions[index].version)) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Anexos das versoes invalidos.');
    return parsed.data;
  }
  async download(context: AttachmentContext, fileId: string) {
    const file = this.file(await this.rpc('academic_attachment_download', { ...this.context(context), p_file_id: fileId }), context, false);
    if (file.id !== fileId || file.state !== 'ready' || !file.final_path) throw new HttpError(502, 'DEPENDENCY_INVALID_RESPONSE', 'Download invalido.');
    return file;
  }
}
