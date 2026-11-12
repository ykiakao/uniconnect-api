import { env } from '../../config/env';
import { createSupabaseAdminClient } from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { StoredFile } from './attachments.schemas';
import { FILE_TYPES, MAX_FILE_BYTES } from './attachments.validation';

export type UploadCapability = { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
export interface AttachmentStorage {
  signUpload(file: StoredFile): Promise<UploadCapability>;
  read(file: StoredFile): Promise<Buffer>;
  writeFinal(file: StoredFile, bytes: Buffer, contentType: string): Promise<void>;
  signDownload(file: StoredFile): Promise<{ url: string; expiresAt: string }>;
}
const unavailable = () => new HttpError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'Armazenamento temporariamente indisponivel. Consulte o upload antes de repetir.');

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 15000); })]); }
  finally { clearTimeout(timer); }
}

export class SupabaseAttachmentStorage implements AttachmentStorage {
  private async privateBucket(file: StoredFile) {
    try {
      const client = createSupabaseAdminClient();
      const { data, error } = await deadline(client.storage.getBucket(file.bucket));
      if (error || !data || data.id !== file.bucket || data.public !== false || Number(data.file_size_limit) < MAX_FILE_BYTES ||
        !Array.isArray(data.allowed_mime_types) || new Set(data.allowed_mime_types).size !== 4 || data.allowed_mime_types.some(type => !Object.hasOwn(FILE_TYPES, type))) throw unavailable();
      return client.storage.from(file.bucket);
    } catch { throw unavailable(); }
  }
  private base() {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw unavailable();
    return new URL(env.SUPABASE_URL);
  }
  private objectUrl(file: StoredFile, path: string, authenticated: boolean) {
    return new URL(`/storage/v1/object/${authenticated ? 'authenticated/' : ''}${encodeURIComponent(file.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, this.base()).toString();
  }
  private headers() {
    this.base();
    return { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}` };
  }
  private capability(value: string, file: StoredFile, path: string, kind: 'upload/sign'|'sign', maxSeconds: number) {
    try {
      const url = new URL(value);
      const base = this.base();
      const expectedPath = `/storage/v1/object/${kind}/${file.bucket}/${path}`;
      if (url.origin !== base.origin || decodeURIComponent(url.pathname) !== expectedPath || url.username || url.password || url.hash) throw unavailable();
      const token = url.searchParams.get('token');
      if (!token) throw unavailable();
      const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };
      const clockAllowance = kind === 'sign' ? 1 : 60;
      if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp * 1000 <= Date.now() || exp * 1000 > Date.now() + (maxSeconds + clockAllowance) * 1000) throw unavailable();
      return { url: url.toString(), expiresAt: new Date(exp * 1000).toISOString() };
    } catch { throw unavailable(); }
  }
  async signUpload(file: StoredFile): Promise<UploadCapability> {
    try {
      const bucket = await this.privateBucket(file);
      const { data, error } = await deadline(bucket.createSignedUploadUrl(file.staging_path, { upsert: false }));
      if (error || !data?.signedUrl) throw unavailable();
      const signed = this.capability(data.signedUrl, file, file.staging_path, 'upload/sign', 7200);
      return { ...signed, method: 'PUT', headers: { 'Content-Type': file.declared_type, 'x-upsert': 'false', 'cache-control': 'max-age=0' } };
    } catch { throw unavailable(); }
  }
  async read(file: StoredFile): Promise<Buffer> {
    try {
      await this.privateBucket(file);
      const response = await fetch(this.objectUrl(file, file.staging_path, true), { headers: this.headers(), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (response.status === 404) throw new HttpError(409, 'ATTACHMENT_UPLOAD_NOT_FOUND', 'O arquivo ainda nao foi recebido. Conclua o upload antes de confirmar.');
      if (!response.ok || !response.body) throw unavailable();
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) { void response.body.cancel(); throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', 'O arquivo excede 10.000.000 bytes.'); }
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_FILE_BYTES) { void reader.cancel(); throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', 'O arquivo excede 10.000.000 bytes.'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
  }
  async writeFinal(file: StoredFile, bytes: Buffer, contentType: string) {
    if (!file.candidate_path) throw unavailable();
    try {
      await this.privateBucket(file);
      const response = await fetch(this.objectUrl(file, file.candidate_path, false), {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=0' },
        body: new Uint8Array(bytes), signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      void response.body?.cancel();
      if (!response.ok) throw unavailable();
    } catch { throw unavailable(); }
  }
  async signDownload(file: StoredFile) {
    if (!file.final_path || file.state !== 'ready') throw unavailable();
    try {
      const bucket = await this.privateBucket(file);
      const { data, error } = await deadline(bucket.createSignedUrl(file.final_path, env.ACADEMIC_ATTACHMENT_DOWNLOAD_TTL_SECONDS, { download: file.original_name }));
      if (error || !data?.signedUrl) throw unavailable();
      return this.capability(data.signedUrl, file, file.final_path, 'sign', env.ACADEMIC_ATTACHMENT_DOWNLOAD_TTL_SECONDS);
    } catch { throw unavailable(); }
  }
}
