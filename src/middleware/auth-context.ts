import { NextFunction, Request, Response } from 'express';

import { createSupabaseAnonClient } from '../config/supabase';
import { AuthRepository } from '../modules/auth/auth.repository';
import { HttpError } from '../shared/http-error';
import { AppUser } from '../shared/types';

declare global {
  namespace Express {
    interface Request {
      currentUser?: AppUser;
    }
  }
}

const supabase = createSupabaseAnonClient();
const authRepository = new AuthRepository();

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

export async function requireTenantUser(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const accessToken = getBearerToken(request.header('authorization'));

    if (!request.tenant) {
      throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
    }

    const routeSlug = request.params.slug;
    if (routeSlug && routeSlug !== request.tenant.slug) {
      throw new HttpError(
        404,
        'TENANT_NOT_FOUND',
        'Instituição não encontrada',
      );
    }

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new HttpError(
        401,
        'INVALID_SESSION',
        'Sessão inválida ou expirada.',
        error?.message,
      );
    }

    request.currentUser = await authRepository.findUserByAuthId({
      authUserId: data.user.id,
      tenantId: request.tenant.id,
    });
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuthenticatedUser(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const accessToken = getBearerToken(request.header('authorization'));
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data.user) {
      throw new HttpError(
        401,
        'INVALID_SESSION',
        'SessÃ£o invÃ¡lida ou expirada.',
        error?.message,
      );
    }

    request.currentUser = await authRepository.findAnyUserByAuthId(data.user.id);
    next();
  } catch (error) {
    next(error);
  }
}
