import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { HttpError } from '../../shared/http-error';
import { AttachmentContext, AttachmentsRepository } from './attachments.repository';
import { attachmentMetadata, Reservation, StoredFile } from './attachments.schemas';
import { AttachmentStorage, SupabaseAttachmentStorage } from './attachments.storage';
import { inspectAcademicFile, MAX_FILE_BYTES } from './attachments.validation';

const completing = new Set<string>();
export function requireAttachments(write = false) {
  if (env.ACADEMIC_ATTACHMENTS_MODE === 'disabled' || (write && env.ACADEMIC_ATTACHMENTS_MODE !== 'enabled')) {
    throw new HttpError(503, 'ACADEMIC_ATTACHMENTS_UNAVAILABLE', 'Anexos academicos indisponiveis para esta operacao.');
  }
}
function uploadStatus(file: StoredFile) {
  return { id: file.id, state: file.state, expiresAt: file.expires_at,
    ...(file.state === 'ready' ? { attachment: attachmentMetadata(file) } : {}),
    ...(file.state === 'pending' && file.upload_expires_at ? { nextAction: 'upload_or_cancel_and_reserve_again' } : {}) };
}
export class AttachmentsService {
  constructor(private readonly repository = new AttachmentsRepository(), private readonly storage: AttachmentStorage = new SupabaseAttachmentStorage(), private readonly inspect = inspectAcademicFile) {}
  async reserve(context: AttachmentContext, activityId: string, purpose: 'material'|'submission', input: Reservation, key: string) {
    requireAttachments(true);
    if (input.sizeBytes > MAX_FILE_BYTES) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', 'O arquivo excede 10.000.000 bytes.');
    let file = await this.repository.reserve(context, activityId, purpose, input, key);
    if (file.state !== 'pending' || file.upload_expires_at !== null) return { ...uploadStatus(file), maxSizeBytes: MAX_FILE_BYTES };
    file = await this.repository.upload(context, file.id, 'sign');
    return { ...uploadStatus(file), maxSizeBytes: MAX_FILE_BYTES, upload: await this.storage.signUpload(file) };
  }
  async status(context: AttachmentContext, fileId: string) { requireAttachments(); return uploadStatus(await this.repository.upload(context, fileId, 'get')); }
  async cancel(context: AttachmentContext, fileId: string) { requireAttachments(true); await this.repository.upload(context, fileId, 'cancel'); }
  async complete(context: AttachmentContext, fileId: string) {
    requireAttachments(true);
    const before = await this.repository.upload(context, fileId, 'get');
    if (before.state === 'ready') return { status: 200, body: uploadStatus(before) };
    if (!['pending','validating'].includes(before.state)) throw new HttpError(409, 'ATTACHMENT_UPLOAD_INELIGIBLE', 'Esta reserva nao pode ser confirmada.');
    const key = `${context.tenantId}:${context.user.id}`;
    if (completing.has(key) || completing.size >= 2) return { status: 202, body: uploadStatus(before) };
    completing.add(key);
    let claimed: StoredFile | undefined;
    const leaseToken = randomUUID();
    try {
      claimed = await this.repository.upload(context, fileId, 'claim', { leaseToken });
      if (claimed.state === 'ready') return { status: 200, body: uploadStatus(claimed) };
      if (claimed.lease_token !== leaseToken) return { status: 202, body: uploadStatus(claimed) };
      const bytes = await this.storage.read(claimed);
      if (bytes.length !== claimed.declared_size) throw new HttpError(415, 'ATTACHMENT_SIZE_MISMATCH', 'O tamanho recebido difere da reserva.');
      const inspected = await this.inspect(bytes, claimed.declared_type);
      await this.storage.writeFinal(claimed, bytes, inspected.contentType);
      const file = await this.repository.upload(context, fileId, 'finish', { leaseToken, contentType: inspected.contentType, sizeBytes: inspected.sizeBytes, sha256: inspected.sha256 });
      return { status: 200, body: uploadStatus(file) };
    } catch (error) {
      if (claimed?.lease_token === leaseToken) {
        const operation = error instanceof HttpError && [413, 415].includes(error.statusCode) ? 'reject' : 'release';
        await this.repository.upload(context, fileId, operation, { leaseToken }).catch(() => undefined);
      }
      throw error;
    } finally { completing.delete(key); }
  }
  async materials(context: AttachmentContext, activityId: string) { requireAttachments(); return { data: await this.repository.materials(context, activityId) }; }
  async link(context: AttachmentContext, activityId: string, fileId: string, revision: number) {
    requireAttachments(true);
    const result = await this.repository.material(context, activityId, fileId, revision, 'add');
    return { attachment: result.attachment, revision: result.revision };
  }
  async remove(context: AttachmentContext, activityId: string, fileId: string, revision: number) { requireAttachments(true); return this.repository.material(context, activityId, fileId, revision, 'remove'); }
  async version(context: AttachmentContext, submissionId: string, version: number) {
    requireAttachments(); const rows = await this.repository.versions(context, [{ submissionId, version }]);
    return { data: rows[0].attachments };
  }
  async download(context: AttachmentContext, fileId: string) { requireAttachments(); return this.storage.signDownload(await this.repository.download(context, fileId)); }
}
