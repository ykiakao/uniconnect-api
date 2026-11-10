import { RequestHandler } from 'express';
import { PlatformAuthService } from '../modules/auth/platform-auth.service';
import { PlatformPrincipal } from '../shared/authorization';
import { HttpError } from '../shared/http-error';

declare global {
  namespace Express {
    interface Request { platformPrincipal?: PlatformPrincipal; }
  }
}

const service = new PlatformAuthService();
export const requirePlatformUser: RequestHandler = async (request, _response, next) => {
  try {
    const bearer = /^Bearer ([^\s]+)$/.exec(request.header('authorization') ?? '');
    if (!bearer) throw new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Token de autenticacao ausente.');
    request.platformPrincipal = await service.authorize(bearer[1]);
    next();
  } catch (error) { next(error); }
};
