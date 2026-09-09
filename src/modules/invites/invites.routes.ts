import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { InvitesService } from './invites.service';

const roleSchema = z.enum(['aluno', 'professor', 'gestor', 'admin']);

const createInviteSchema = z.object({
  role: roleSchema,
  expiresIn: z.number().int().min(1).max(30).optional(),
});

const codeSchema = z.object({
  code: z.string().trim().min(4).max(32).transform((value) => value.toUpperCase()),
});

const invitesService = new InvitesService();

export const tenantInvitesRoutes = Router({ mergeParams: true });
export const publicInvitesRoutes = Router();

tenantInvitesRoutes.use(requireTenantUser);

function requireContext(request: Request) {
  if (!request.tenant || !request.currentUser) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao nao informada');
  }

  return {
    tenant: request.tenant,
    currentUser: request.currentUser,
  };
}

tenantInvitesRoutes.post('/', async (request, response, next) => {
  try {
    const { tenant, currentUser } = requireContext(request);
    const body = createInviteSchema.parse(request.body);
    const result = await invitesService.create({
      currentUser,
      tenantSlug: tenant.slug,
      tenantId: tenant.id,
      role: body.role,
      expiresIn: body.expiresIn,
    });

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

publicInvitesRoutes.get('/:code', async (request, response, next) => {
  try {
    const params = codeSchema.parse(request.params);
    const result = await invitesService.resolve(params.code);

    response.json(result);
  } catch (error) {
    next(error);
  }
});
