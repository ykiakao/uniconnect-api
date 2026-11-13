import { Router } from 'express';
import { z } from 'zod';
import { requireTenantUser } from '../../middleware/auth-context';
import { createRateLimit } from '../../middleware/rate-limit';
import { HttpError } from '../../shared/http-error';
import { registerPushDevice, unregisterPushDevice } from './push.devices';

export const pushDevicesRoutes = Router({ mergeParams: true });

pushDevicesRoutes.use(requireTenantUser);

const deviceSchema = z.object({
  token: z.string().trim().min(20).max(4096),
}).strict();

const limit = createRateLimit({ max: 30, windowMs: 60000 });

pushDevicesRoutes.post('/', limit, (request, response, next) => {
  try {
    if (!request.currentUser || !request.tenant) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Autenticacao necessaria.');
    }

    const { token } = deviceSchema.parse(request.body);

    registerPushDevice(
      request.tenant.id,
      request.currentUser.id,
      token,
    );

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

pushDevicesRoutes.delete('/', limit, (request, response, next) => {
  try {
    if (!request.currentUser || !request.tenant) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Autenticacao necessaria.');
    }

    const { token } = deviceSchema.parse(request.body);

    unregisterPushDevice(
      request.tenant.id,
      request.currentUser.id,
      token,
    );

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});
