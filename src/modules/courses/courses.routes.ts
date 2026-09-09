import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { CoursesService } from './courses.service';

const courseSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
});

const coursesService = new CoursesService();

export const coursesRoutes = Router({ mergeParams: true });

coursesRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

coursesRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const search =
      typeof request.query.search === 'string' ? request.query.search : undefined;
    const result = await coursesService.list({
      currentUser,
      tenantId: tenant.id,
      search,
      pagination: parsePagination(request.query),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

coursesRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = courseSchema.parse(request.body);
    const result = await coursesService.create({
      currentUser,
      tenantId: tenant.id,
      name: body.name,
      description: body.description,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

coursesRoutes.get('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await coursesService.findById({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

coursesRoutes.put('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = courseSchema.parse(request.body);
    const result = await coursesService.update({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
      name: body.name,
      description: body.description,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

coursesRoutes.delete('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    await coursesService.delete({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
    });

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});
