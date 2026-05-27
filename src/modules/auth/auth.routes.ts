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
    throw new HttpError(401, 'Token de autenticação ausente.');
  }

  return token;
}

authRoutes.post('/login', async (request, response, next) => {
  try {
    if (!request.tenant) {
      throw new HttpError(400, 'Tenant não carregado.');
    }

    const credentials = loginSchema.parse(request.body);
    const session = await authService.login({
      email: credentials.email.trim().toLowerCase(),
      password: credentials.password,
      tenantId: request.tenant.id,
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
    if (!request.tenant) {
      throw new HttpError(400, 'Tenant não carregado.');
    }

    const accessToken = getBearerToken(request.header('authorization'));
    const user = await authService.findUserByAccessToken({
      accessToken,
      tenantId: request.tenant.id,
    });

    response.json({
      user,
      tenant: request.tenant,
    });
  } catch (error) {
    next(error);
  }
});
