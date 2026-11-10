import { Request, Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { AcademicService } from './academic.service';
import { createAcademicProtection } from './academic.protection';

const empty = z.object({}).strict();
const overviewQuery = z.object({ periodId: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._:-]+$/).optional() }).strict();
const service = new AcademicService();
export const academicRoutes = Router({ mergeParams: true });
academicRoutes.use(requireTenantUser, createAcademicProtection());

function context(request: Request) {
  if (!request.tenant || !request.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada.');
  return { currentUser: request.currentUser, tenant: request.tenant };
}
academicRoutes.get('/periods', async (request, response, next) => {
  try { empty.parse(request.query); response.json(await service.getPeriods(context(request))); }
  catch (error) { next(error); }
});
academicRoutes.get('/overview', async (request, response, next) => {
  try {
    const query = overviewQuery.parse(request.query);
    response.json(await service.getOverview({ ...context(request), periodId: query.periodId }));
  } catch (error) { next(error); }
});
academicRoutes.get('/history', async (request, response, next) => {
  try { empty.parse(request.query); response.json(await service.getHistory(context(request))); }
  catch (error) { next(error); }
});
