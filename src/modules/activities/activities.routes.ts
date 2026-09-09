import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { ActivitiesService } from './activities.service';

const activityCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  dueDate: z.string().datetime().optional(),
  type: z.string().trim().min(1).default('assignment'),
});

const activityUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    dueDate: z.string().datetime().optional(),
    type: z.string().trim().min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

const activitiesService = new ActivitiesService();

export const classActivitiesRoutes = Router({ mergeParams: true });
export const activitiesRoutes = Router({ mergeParams: true });

classActivitiesRoutes.use(requireTenantUser);
activitiesRoutes.use(requireTenantUser);

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

classActivitiesRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await activitiesService.listByClass({
      currentUser,
      tenantId: tenant.id,
      classId: getParam(request, 'classId'),
      pagination: parsePagination(request.query),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

classActivitiesRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = activityCreateSchema.parse(request.body);
    const result = await activitiesService.create({
      currentUser,
      tenantId: tenant.id,
      classId: getParam(request, 'classId'),
      title: body.title,
      description: body.description,
      dueDate: body.dueDate,
      type: body.type,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.get('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await activitiesService.findById({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.put('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = activityUpdateSchema.parse(request.body);
    const result = await activitiesService.update({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
      title: body.title,
      description: body.description,
      dueDate: body.dueDate,
      type: body.type,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

activitiesRoutes.delete('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    await activitiesService.delete({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});
