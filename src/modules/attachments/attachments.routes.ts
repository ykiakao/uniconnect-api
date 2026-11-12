import { Request, RequestHandler, Router } from 'express';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { AttachmentsService } from './attachments.service';
import { emptyBodySchema, fileIdSchema, idempotencyKeySchema, linkMaterialSchema, removalQuerySchema, reservationSchema, studentReservationSchema, versionSchema } from './attachments.schemas';

const service = new AttachmentsService();
export const academicAttachmentsRoutes = Router({ mergeParams: true });
const userWindows = new Map<string, { count: number; until: number }>();
const perActor: RequestHandler = (req, res, next) => {
  const now = Date.now();
  for (const [key, value] of userWindows) if (value.until <= now) userWindows.delete(key);
  const key = `${req.tenant?.id}:${req.currentUser?.id}`;
  const window = userWindows.get(key) ?? { count: 0, until: now + 60000 };
  if (window.count >= 30 || (!userWindows.has(key) && userWindows.size >= 10000)) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((window.until - now) / 1000))));
    return next(new HttpError(429, 'ATTACHMENT_RATE_LIMIT', 'Limite de operacoes de anexos atingido.'));
  }
  window.count++; userWindows.set(key, window); next();
};
const authorize = [requireTenantUser, createRateLimit({ max: 120, windowMs: 60000 }), perActor];
function context(req: Request) {
  if (!req.tenant || !req.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao nao informada.');
  return { tenantId: req.tenant.id, user: req.currentUser };
}
function param(req: Request, name: string) { return fileIdSchema.parse(req.params[name]); }
const wrap = (handler: (req: Request, res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler => (req, res, next) => { void handler(req, res).catch(next); };
academicAttachmentsRoutes.post('/activities/:activityId/attachment-uploads', ...authorize, wrap(async (req, res) => {
  res.status(201).json(await service.reserve(context(req), param(req, 'activityId'), 'material', reservationSchema.parse(req.body), idempotencyKeySchema.parse(req.header('Idempotency-Key'))));
}));
academicAttachmentsRoutes.post('/activities/:activityId/submissions/attachment-uploads', ...authorize, wrap(async (req, res) => {
  res.status(201).json(await service.reserve(context(req), param(req, 'activityId'), 'submission', studentReservationSchema.parse(req.body), idempotencyKeySchema.parse(req.header('Idempotency-Key'))));
}));
academicAttachmentsRoutes.get('/attachment-uploads/:fileId', ...authorize, wrap(async (req, res) => { res.json(await service.status(context(req), param(req, 'fileId'))); }));
academicAttachmentsRoutes.delete('/attachment-uploads/:fileId', ...authorize, wrap(async (req, res) => { await service.cancel(context(req), param(req, 'fileId')); res.status(204).send(); }));
academicAttachmentsRoutes.post('/attachment-uploads/:fileId/complete', ...authorize, wrap(async (req, res) => {
  emptyBodySchema.parse(req.body); const result = await service.complete(context(req), param(req, 'fileId'));
  if (result.status === 202) res.set('Retry-After', '2');
  res.status(result.status).json(result.body);
}));
academicAttachmentsRoutes.get('/activities/:activityId/attachments', ...authorize, wrap(async (req, res) => { res.json(await service.materials(context(req), param(req, 'activityId'))); }));
academicAttachmentsRoutes.post('/activities/:activityId/attachments', ...authorize, wrap(async (req, res) => {
  const input = linkMaterialSchema.parse(req.body); res.status(201).json(await service.link(context(req), param(req, 'activityId'), input.fileId, input.expectedVersion));
}));
academicAttachmentsRoutes.delete('/activities/:activityId/attachments/:fileId', ...authorize, wrap(async (req, res) => {
  const query = removalQuerySchema.parse(req.query); res.json(await service.remove(context(req), param(req, 'activityId'), param(req, 'fileId'), query.expectedVersion));
}));
academicAttachmentsRoutes.get('/submissions/:submissionId/versions/:version/attachments', ...authorize, wrap(async (req, res) => { res.json(await service.version(context(req), param(req, 'submissionId'), versionSchema.parse(req.params.version))); }));
academicAttachmentsRoutes.post('/attachments/:fileId/download-url', ...authorize, wrap(async (req, res) => { emptyBodySchema.parse(req.body); res.json(await service.download(context(req), param(req, 'fileId'))); }));
