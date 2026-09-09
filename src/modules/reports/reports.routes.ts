import { Request, Router } from 'express';
import { z } from 'zod';

import {
  requireAuthenticatedUser,
  requireTenantUser,
} from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { ReportsService } from './reports.service';

const engagementQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  courseId: z.string().uuid().optional(),
});

const reportsService = new ReportsService();

export const tenantReportsRoutes = Router({ mergeParams: true });
export const globalReportsRoutes = Router();

tenantReportsRoutes.use(requireTenantUser);
globalReportsRoutes.use(requireAuthenticatedUser);

function requireTenantContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'InstituiÃ§Ã£o nÃ£o informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

function requireCurrentUser(request: Request) {
  if (!request.currentUser) {
    throw new HttpError(
      401,
      'AUTH_TOKEN_REQUIRED',
      'Token de autenticaÃ§Ã£o ausente.',
    );
  }

  return request.currentUser;
}

tenantReportsRoutes.get('/summary', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireTenantContext(request);
    const result = await reportsService.summary({
      currentUser,
      tenantId: tenant.id,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

tenantReportsRoutes.get('/engagement', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireTenantContext(request);
    const query = engagementQuerySchema.parse(request.query);
    const result = await reportsService.engagement({
      currentUser,
      tenantId: tenant.id,
      from: query.from,
      to: query.to,
      courseId: query.courseId,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

globalReportsRoutes.get('/reports/global', async (request, response, next) => {
  try {
    const result = await reportsService.global(requireCurrentUser(request));
    response.json(result);
  } catch (error) {
    next(error);
  }
});
