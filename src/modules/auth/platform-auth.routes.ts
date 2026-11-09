import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformUser } from '../../middleware/platform-context';
import { platformAuthorization } from '../../shared/authorization';
import { HttpError } from '../../shared/http-error';
import { PlatformAuthService } from './platform-auth.service';
import { SessionService } from './session.service';
import { refreshSchema, requireJsonAuthProof } from './session.schemas';

const credentialsSchema = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: z.string().min(6).max(128) }).strict();
const emptySchema = z.object({}).strict();
const service = new PlatformAuthService();
export const platformAuthRoutes = Router();
const sessions = new SessionService();

platformAuthRoutes.post('/refresh', async (request, response, next) => {
  try {
    requireJsonAuthProof(request);
    response.json(await sessions.refreshPlatform(refreshSchema.parse(request.body).refreshToken));
  } catch (error) { next(error); }
});

platformAuthRoutes.post('/login', async (request, response, next) => {
  try {
    emptySchema.parse(request.query);
    response.json(await service.login(credentialsSchema.parse(request.body)));
  } catch (error) { next(error); }
});

platformAuthRoutes.get('/me', requirePlatformUser, (request, response, next) => {
  try {
    emptySchema.parse(request.query);
    emptySchema.parse(request.body ?? {});
    if (!request.platformPrincipal) throw new HttpError(401, 'AUTH_TOKEN_REQUIRED', 'Token de autenticacao ausente.');
    response.json({ authorization: platformAuthorization(request.platformPrincipal) });
  } catch (error) { next(error); }
});
