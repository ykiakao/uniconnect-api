import { Request, Router } from 'express';
import { z } from 'zod';
import { requirePlatformUser } from '../../middleware/platform-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { institutionId } from './platform-institutions.schemas';
import { designateInput, provisionInput, replaceInput } from './platform-accounts.schemas';
import { PlatformAccountsService } from './platform-accounts.service';

export const platformAccountsRoutes = Router({ mergeParams: true });
const service = new PlatformAccountsService();
platformAccountsRoutes.use(['/admin-provisioning', '/responsible'], requirePlatformUser);
const limit = createRateLimit({ max: 30, windowMs: 60000 });
const empty = z.object({}).strict();
const pagination = z.object({ page: z.string().optional(), limit: z.string().optional() }).strict();
function context(req: Request) {
  if (!req.platformPrincipal) throw new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Token de autenticacao ausente.');
  return { principal: req.platformPrincipal, id: institutionId.parse(req.params.institutionId), requestId: institutionId.parse(req.requestId) };
}
platformAccountsRoutes.get('/admin-provisioning', async (req, res, next) => {
  try { const c = context(req); res.json(await service.list(c.principal, c.id, parsePagination(pagination.parse(req.query)))); } catch (error) { next(error); }
});
platformAccountsRoutes.get('/admin-provisioning/:provisionId', async (req, res, next) => {
  try { const c = context(req); empty.parse(req.query); res.json(await service.find(c.principal, c.id, institutionId.parse(req.params.provisionId))); } catch (error) { next(error); }
});
platformAccountsRoutes.post('/admin-provisioning', limit, async (req, res, next) => {
  try { const c = context(req); empty.parse(req.query); const input = provisionInput.parse(req.body); const key = institutionId.parse(req.header('Idempotency-Key')); res.status(202).json(await service.provision(c.principal, c.id, input, key, c.requestId)); } catch (error) { next(error); }
});
platformAccountsRoutes.post('/admin-provisioning/:provisionId/resume', limit, async (req, res, next) => {
  try { const c = context(req); empty.parse(req.query); empty.parse(req.body); res.status(202).json(await service.resume(c.principal, c.id, institutionId.parse(req.params.provisionId), c.requestId)); } catch (error) { next(error); }
});
platformAccountsRoutes.get('/responsible', async (req, res, next) => {
  try { const c = context(req); empty.parse(req.query); res.json(await service.responsible(c.principal, c.id, c.requestId)); } catch (error) { next(error); }
});
platformAccountsRoutes.get('/responsible/history', async (req, res, next) => {
  try { const c = context(req); res.json(await service.history(c.principal, c.id, parsePagination(pagination.parse(req.query)))); } catch (error) { next(error); }
});
for (const operation of ['designate', 'replace'] as const) platformAccountsRoutes.post(`/responsible/${operation}`, limit, async (req, res, next) => {
  try { const c = context(req); empty.parse(req.query); const input = (operation === 'designate' ? designateInput : replaceInput).parse(req.body); const key = institutionId.parse(req.header('Idempotency-Key')); res.json(await service.changeResponsible(c.principal, c.id, `${operation}_responsible`, input, key, c.requestId)); } catch (error) { next(error); }
});
