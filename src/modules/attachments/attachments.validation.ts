import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { HttpError } from '../../shared/http-error';

export const MAX_FILE_BYTES = 10_000_000;
export const FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;
export type FileMime = keyof typeof FILE_TYPES;
export type InspectedFile = { contentType: FileMime; extension: string; sizeBytes: number; sha256: string };
let workers = 0;

export async function inspectAcademicFile(bytes: Buffer, declaredType: string): Promise<InspectedFile> {
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', 'O arquivo excede 10.000.000 bytes.');
  if (!bytes.length || !Object.hasOwn(FILE_TYPES, declaredType)) throw new HttpError(415, 'ATTACHMENT_FORMAT_REJECTED', 'Formato de arquivo nao permitido.');
  if (workers >= 2) throw new HttpError(429, 'ATTACHMENT_PROCESSING_LIMIT', 'Aguarde para validar outro arquivo.');
  workers++;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const worker = new Worker(resolve(__dirname, '../../../scripts/lib/academic-file-validation.cjs'), {
        workerData: { bytes, contentType: declaredType },
        resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
        stdout: true, stderr: true,
      });
      worker.stdout.resume(); worker.stderr.resume();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); void worker.terminate();
        if (error) reject(error); else resolvePromise();
      };
      const invalid = () => new HttpError(415, 'ATTACHMENT_FORMAT_REJECTED', 'Arquivo invalido, protegido ou com recursos nao permitidos.');
      const timer = setTimeout(() => finish(invalid()), 8000);
      worker.once('message', message => finish(message === 'valid' ? undefined : invalid()));
      worker.once('error', () => finish(invalid()));
      worker.once('exit', () => finish(invalid()));
    });
    return { contentType: declaredType as FileMime, extension: FILE_TYPES[declaredType as FileMime], sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { workers--; }
}
