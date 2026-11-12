import { z } from 'zod';

export const fileMimeSchema = z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg']);
export const reservationSchema = z.object({
  fileName: z.string().trim().min(1).max(180).regex(/^[^\x00-\x1f\x7f/\\"\u202a-\u202e\u2066-\u2069]+$/u).transform(value => value.normalize('NFC')),
  sizeBytes: z.number().int().positive().max(2147483647),
  contentType: fileMimeSchema,
}).strict().refine(value => {
  const extension = value.fileName.split('.').at(-1)?.toLowerCase();
  return ({ 'application/pdf': ['pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'] }[value.contentType]).includes(extension ?? '');
}, 'O nome e o formato declarado devem corresponder.');
export const studentReservationSchema = reservationSchema.safeExtend({ expectedVersion: z.number().int().min(0).max(2147483646) });
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const fileIdSchema = z.guid();
export const linkMaterialSchema = z.object({ fileId: fileIdSchema, expectedVersion: z.number().int().positive().max(2147483646) }).strict();
export const removalQuerySchema = z.object({ expectedVersion: z.coerce.number().int().positive().max(2147483646) }).strict();
export const emptyBodySchema = z.object({}).strict();
export const versionSchema = z.coerce.number().int().positive().max(2147483647);
export const attachmentSchema = z.object({ id: fileIdSchema, name: z.string(), contentType: fileMimeSchema, sizeBytes: z.number().int().positive().max(10000000), createdAt: z.string() });
export type Attachment = z.infer<typeof attachmentSchema>;
export type Reservation = z.infer<typeof reservationSchema> & { expectedVersion?: number };
export const storedFileSchema = z.object({
  id: fileIdSchema, tenant_id: fileIdSchema, activity_id: fileIdSchema.nullable(), activity_scope_id: fileIdSchema,
  created_by: z.string().min(1), purpose: z.enum(['material', 'submission']),
  original_name: z.string(), declared_type: fileMimeSchema, declared_size: z.number().int().positive().max(10000000),
  bucket: z.string(), staging_path: z.string(), candidate_path: z.string().nullable(), final_path: z.string().nullable(),
  candidate_paths: z.array(z.string()).max(10), content_type: fileMimeSchema.nullable(), size_bytes: z.number().int().nullable(), sha256: z.string().nullable(),
  state: z.enum(['pending','validating','ready','rejected','cancelled','expired','deleting','deleted']),
  expires_at: z.string(), upload_expires_at: z.string().nullable(), created_at: z.string(),
  lease_token: fileIdSchema.nullable(), lease_until: z.string().nullable(),
});
export type StoredFile = z.infer<typeof storedFileSchema>;
export function attachmentMetadata(file: StoredFile): Attachment {
  return attachmentSchema.parse({ id: file.id, name: file.original_name, contentType: file.content_type, sizeBytes: file.size_bytes, createdAt: file.created_at });
}
