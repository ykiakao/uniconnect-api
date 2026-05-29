import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../../shared/http-error';
import { AuthService } from './auth.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const authService = new AuthService();

export const authRoutes = Router();

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

    response.json(user);
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

    response.json(user);
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/logout', async (request, response, next) => {
  try {
    const accessToken = getBearerToken(request.header('authorization'));

    try {
      await authService.logout(accessToken);
    } catch {
      // Logout is intentionally idempotent for already invalid tokens.
    }

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

authRoutes.post('/refresh', (_request, response) => {
  response.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Refresh token ainda não implementado',
    },
  });
});
