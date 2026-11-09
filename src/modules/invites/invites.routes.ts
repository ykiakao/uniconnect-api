import { Request, Router } from 'express';
import { z } from 'zod';

import { requireTenantUser } from '../../middleware/auth-context';
import { HttpError } from '../../shared/http-error';
import { InvitesService } from './invites.service';
import { createRateLimit } from '../../middleware/rate-limit';

const roleSchema = z.enum(['aluno', 'professor', 'gestor', 'admin']);

const createInviteSchema = z.object({
  role: roleSchema,
  expiresIn: z.number().int().min(1).max(30).optional(),
  recipientEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
});

const codeSchema = z.object({
  code: z.string().trim().min(4).max(80).transform((value) => value.toUpperCase()),
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
      recipientEmail: body.recipientEmail,
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

const name = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const acceptSchema = z.object({ name }).strict();
const registerSchema = z.object({ name, email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: z.string().min(8).max(128) }).strict();
const loginSchema = registerSchema.extend({ password: z.string().min(6).max(128) });
publicInvitesRoutes.post('/:code/accept', async (request, response, next) => {
  try {
    const { code } = codeSchema.parse(request.params);
    const input = acceptSchema.parse(request.body);
    const [scheme, token] = request.header('authorization')?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Entre na sua conta para aceitar o convite.');
    response.status(201).json(await invitesService.accept(code, token, input.name, request.tenant?.id, request.requestId));
  } catch (error) { next(error); }
});
publicInvitesRoutes.post('/:code/register', async (request, response, next) => {
  try {
    const { code } = codeSchema.parse(request.params);
    response.status(201).json(await invitesService.register(code, registerSchema.parse(request.body), request.tenant?.id, request.requestId));
  } catch (error) { next(error); }
});
publicInvitesRoutes.post('/:code/login', createRateLimit({ max: 30, windowMs: 15 * 60 * 1000 }), async (request, response, next) => {
  try {
    const { code } = codeSchema.parse(request.params);
    response.status(201).json(await invitesService.loginAndAccept(code, loginSchema.parse(request.body), request.tenant?.id, request.requestId));
  } catch (error) { next(error); }
});
