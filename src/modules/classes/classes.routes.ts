import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { ClassesService } from './classes.service';

const classSchema = z.object({
  name: z.string().trim().min(1),
  teacherId: z.string().uuid().optional(),
});

const classesService = new ClassesService();

export const courseClassesRoutes = Router({ mergeParams: true });
export const classesRoutes = Router({ mergeParams: true });

courseClassesRoutes.use(requireTenantUser);
classesRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

function getParam(request: Request, key: string) {
  return (request.params as Record<string, string>)[key];
}

courseClassesRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await classesService.listByCourse({
      currentUser,
      tenantId: tenant.id,
      courseId: getParam(request, 'courseId'),
      pagination: parsePagination(request.query),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

courseClassesRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = classSchema.parse(request.body);
    const result = await classesService.create({
      currentUser,
      tenantId: tenant.id,
      courseId: getParam(request, 'courseId'),
      name: body.name,
      teacherId: body.teacherId,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

classesRoutes.get('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await classesService.findById({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

classesRoutes.put('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = classSchema.parse(request.body);
    const result = await classesService.update({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
      name: body.name,
      teacherId: body.teacherId,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

classesRoutes.delete('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    await classesService.delete({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});
