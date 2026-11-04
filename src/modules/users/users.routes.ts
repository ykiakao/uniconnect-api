import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { parsePagination } from '../../shared/pagination';
import { UsersService } from './users.service';

const apiRoleSchema = z.enum(['aluno', 'professor', 'gestor', 'admin']);

const createUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
  role: apiRoleSchema,
  courseId: z.guid().optional(),
  registration: z.string().trim().max(50).optional(),
  semester: z.number().int().min(1).max(30).optional(),
});

const updateRoleSchema = z.object({
  role: apiRoleSchema,
});

const usersService = new UsersService();

export const usersRoutes = Router({ mergeParams: true });

usersRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

usersRoutes.get('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const role = request.query.role
      ? apiRoleSchema.parse(request.query.role)
      : undefined;
    const search =
      typeof request.query.search === 'string' ? request.query.search : undefined;

    const result = await usersService.list({
      currentUser,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      role,
      search,
      pagination: parsePagination(request.query),
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

usersRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = createUserSchema.parse(request.body);
    const result = await usersService.create({
      currentUser,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      name: body.name,
      email: body.email,
      password: body.password,
      role: body.role,
      courseId: body.courseId,
      registration: body.registration,
      semester: body.semester,
      requestId: request.requestId,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

usersRoutes.get('/:id', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const result = await usersService.findById({
      currentUser,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      id: request.params.id,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

usersRoutes.patch('/:id/role', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = updateRoleSchema.parse(request.body);
    const result = await usersService.updateRole({
      currentUser,
      tenantId: tenant.id,
      id: request.params.id,
      role: body.role,
      requestId: request.requestId,
    });

    response.json(result);
  } catch (error) {
    next(error);
  }
});

for (const resource of ['status', 'profile'] as const) usersRoutes.patch(`/:id/${resource}`, async (req, res, next) => {
  try {
    const { tenant, currentUser } = requireContext(req);
    const schema = resource === 'status' ? z.object({ active: z.boolean() }).strict() : z.object({
      name: z.string().trim().min(1).max(200).optional(), courseId: z.guid().nullable().optional(),
      registration: z.string().trim().max(50).nullable().optional(), semester: z.number().int().min(1).max(30).nullable().optional(),
    }).strict();
    const input = schema.parse(req.body);
    if (!Object.keys(input).length) throw new HttpError(400, 'VALIDATION_ERROR', 'Informe uma alteracao.');
    res.json(await usersService.updateProfile({ currentUser, tenantId: tenant.id, tenantSlug: tenant.slug, id: req.params.id, input }));
  } catch (error) { next(error); }
});
