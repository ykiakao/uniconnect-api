import { Router } from 'express';

import { HttpError } from '../../shared/http-error';

export const tenantRoutes = Router();

tenantRoutes.get('/current', (request, response) => {
  if (!request.tenant) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
  }

  response.json({ tenant: request.tenant });
});
