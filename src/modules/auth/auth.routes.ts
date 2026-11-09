import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../../shared/http-error';
import { AuthService } from './auth.service';
import { requireTenantUser } from '../../middleware/auth-context';
import { institutionalAuthorization } from '../../shared/authorization';
import { SessionService } from './session.service';
import { refreshSchema, requireJsonAuthProof } from './session.schemas';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const authService = new AuthService();

export const authRoutes = Router();

authRoutes.get('/capabilities', requireTenantUser, (request, response, next) => {
  try {
    z.object({}).strict().parse(request.query);
    z.object({}).strict().parse(request.body ?? {});
    if (!request.tenant || !request.currentUser) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao nao informada.');
    response.json({ authorization: institutionalAuthorization(request.currentUser, request.tenant) });
  } catch (error) { next(error); }
});

function getBearerToken(authorizationHeader?: string) {
  const [scheme, token] = authorizationHeader?.split(' ') ?? [];

  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(
      401,
      'AUTH_TOKEN_REQUIRED',
      'Token de autenticação ausente.',
    );
  }

  return token;
}

authRoutes.post('/login', async (request, response, next) => {
  try {
    if (!request.tenant) {
      throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
    }

    const credentials = loginSchema.parse(request.body);
    const session = await authService.login({
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
      tenantId: request.tenant.id,
      tenantSlug: request.tenant.slug,
    });

    response.json({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      user: session.user,
      tenant: request.tenant,
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/admin/login', async (request, response, next) => {
  try {
    if (!request.tenant) {
      throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
    }

    const credentials = loginSchema.parse(request.body);
    const session = await authService.loginAdmin({
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
      tenantId: request.tenant.id,
      tenantSlug: request.tenant.slug,
    });

    response.json({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      user: session.user,
      tenant: request.tenant,
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.get('/me', async (request, response, next) => {
  try {
    const accessToken = getBearerToken(request.header('authorization'));

    if (!request.tenant) {
      throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
    }

    const user = await authService.findUserByAccessToken({
      accessToken,
      tenantId: request.tenant.id,
      tenantSlug: request.tenant.slug,
    });

    response.json({
      ...user,
      tenant: request.tenant,
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.get('/admin/me', async (request, response, next) => {
  try {
    const accessToken = getBearerToken(request.header('authorization'));

    if (!request.tenant) {
      throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
    }

    const user = await authService.findAdminUserByAccessToken({
      accessToken,
      tenantId: request.tenant.id,
      tenantSlug: request.tenant.slug,
    });

    response.json({
      ...user,
      tenant: request.tenant,
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/logout', async (request, response, next) => {
  try {
    const accessToken = getBearerToken(request.header('authorization'));

    await authService.logout(accessToken);

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

const sessions = new SessionService();
for (const [path, administrative] of [['/refresh', false], ['/admin/refresh', true]] as const) {
  authRoutes.post(path, async (request, response, next) => {
    try {
      if (!request.tenant) throw new HttpError(400, 'TENANT_REQUIRED', 'Instituicao nao informada.');
      requireJsonAuthProof(request);
      const { refreshToken } = refreshSchema.parse(request.body);
      const session = await sessions.refreshInstitution({ refreshToken, tenant: request.tenant, administrative });
      response.json({ ...session, tenant: request.tenant });
    } catch (error) { next(error); }
  });
}
