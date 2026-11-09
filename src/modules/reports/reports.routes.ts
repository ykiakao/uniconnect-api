import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { requirePlatformUser } from '../../middleware/platform-context';
import { HttpError } from '../../shared/http-error';
import { ReportsService } from './reports.service';
import { apiDateTime } from '../../shared/validation';

const engagementQuerySchema = z.object({
  from: apiDateTime().optional(),
  to: apiDateTime().optional(),
  courseId: z.guid().optional(),
});

const reportsService = new ReportsService();

export const tenantReportsRoutes = Router({ mergeParams: true });
export const globalReportsRoutes = Router();

tenantReportsRoutes.use(requireTenantUser);
globalReportsRoutes.use(requirePlatformUser);

function requireTenantContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'InstituiÃ§Ã£o nÃ£o informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

function requirePlatformPrincipal(request: Request) {
  if (!request.platformPrincipal) {
    throw new HttpError(
      401,
      'AUTH_TOKEN_REQUIRED',
      'Token de autenticaÃ§Ã£o ausente.',
    );
  }

  return request.platformPrincipal;
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
    const result = await reportsService.global(requirePlatformPrincipal(request));
    response.json(result);
  } catch (error) {
    next(error);
  }
});
