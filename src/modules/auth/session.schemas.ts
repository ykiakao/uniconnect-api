import { Request } from 'express';
import { z } from 'zod';
import { HttpError } from '../../shared/http-error';

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(8192) }).strict();
export const passwordProofSchema = z.object({ tokenHash: z.string().min(1).max(2048), newPassword: z.string().min(8).max(128) }).strict();
export const recoveryEmailSchema = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()) }).strict();

export function requireJsonAuthProof(request: Request) {
  z.object({}).strict().parse(request.query);
  if (request.header('authorization') || request.header('refresh-token') || request.header('x-refresh-token')) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Envie a prova de autenticacao somente no corpo JSON.');
  }
}
