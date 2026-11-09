import { Router, Request } from 'express';
import { z } from 'zod';
import { requirePlatformUser } from '../../middleware/platform-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { institutionBootstrap, institutionCreate, institutionId, institutionUpdate, institutionVersion, operationalStatus, PlatformOperation } from './platform-institutions.schemas';
import { PlatformInstitutionsService } from './platform-institutions.service';

const service = new PlatformInstitutionsService();
export const platformInstitutionsRoutes = Router();
platformInstitutionsRoutes.use(requirePlatformUser);
const rateLimit = createRateLimit({ max: 60, windowMs: 60000 });
function principal(req: Request) {
  if (!req.platformPrincipal) throw new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Token de autenticacao ausente.');
  return req.platformPrincipal;
}
platformInstitutionsRoutes.get('/', async (req, res, next) => {
  try {
    const query = z.object({ page: z.string().optional(), limit: z.string().optional(), search: z.string().trim().min(1).max(100).optional(), operationalStatus: operationalStatus.optional() }).strict().parse(req.query);
    res.json(await service.list(principal(req), parsePagination(query), query.search, query.operationalStatus));
  } catch (error) { next(error); }
});
platformInstitutionsRoutes.get('/:id/audit', async (req, res, next) => {
  try { const query = z.object({ page: z.string().optional(), limit: z.string().optional() }).strict().parse(req.query); res.json(await service.audit(principal(req), institutionId.parse(req.params.id), parsePagination(query))); }
  catch (error) { next(error); }
});
platformInstitutionsRoutes.get('/:id', async (req, res, next) => {
  try { z.object({}).strict().parse(req.query); res.json(await service.find(principal(req), institutionId.parse(req.params.id))); }
  catch (error) { next(error); }
});
const operations: Array<{ operation: PlatformOperation; path: string; method: 'post' | 'patch'; schema: z.ZodType; status: number }> = [
  { operation: 'create', path: '/', method: 'post', schema: institutionCreate, status: 201 },
  { operation: 'update', path: '/:id', method: 'patch', schema: institutionUpdate, status: 200 },
  { operation: 'suspend', path: '/:id/suspend', method: 'post', schema: institutionVersion, status: 200 },
  { operation: 'reactivate', path: '/:id/reactivate', method: 'post', schema: institutionVersion, status: 200 },
  { operation: 'bootstrap', path: '/:id/bootstrap-admin', method: 'post', schema: institutionBootstrap, status: 201 },
];
for (const op of operations) platformInstitutionsRoutes[op.method](op.path, rateLimit, async (req, res, next) => {
  try {
    z.object({}).strict().parse(req.query);
    const key = institutionId.parse(req.header('Idempotency-Key'));
    const requestId = institutionId.parse(req.requestId);
    const input = op.schema.parse(req.body) as Record<string, unknown>;
    const payload = op.operation === 'create' ? input : { ...input, id: institutionId.parse(req.params.id) };
    res.status(op.status).json(await service.mutate(principal(req), op.operation, key, requestId, payload));
  } catch (error) { next(error); }
});
