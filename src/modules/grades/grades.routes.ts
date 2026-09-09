import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { GradesService } from './grades.service';

const gradeSchema = z.object({
  grade: z.number().min(0).max(10),
  feedback: z.string().trim().optional(),
});

const gradesService = new GradesService();

export const activityGradesRoutes = Router({ mergeParams: true });
export const studentGradesRoutes = Router({ mergeParams: true });

activityGradesRoutes.use(requireTenantUser);
studentGradesRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'InstituiÃ§Ã£o nÃ£o informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

function getParam(request: Request, key: string) {
  return (request.params as Record<string, string>)[key];
}

activityGradesRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await gradesService.listByActivity({
      currentUser,
      tenantId: tenant.id,
      activityId: getParam(request, 'activityId'),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

activityGradesRoutes.put('/:studentId', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = gradeSchema.parse(request.body);
    const result = await gradesService.upsert({
      currentUser,
      tenantId: tenant.id,
      activityId: getParam(request, 'activityId'),
      studentId: request.params.studentId,
      grade: body.grade,
      feedback: body.feedback,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

studentGradesRoutes.get('/:studentId/grades', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await gradesService.listByStudent({
      currentUser,
      tenantId: tenant.id,
      studentId: request.params.studentId,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});
