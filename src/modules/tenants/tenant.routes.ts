import { Router } from 'express';

export const tenantRoutes = Router();

tenantRoutes.get('/current', (request, response) => {
  response.json({ tenant: request.tenant });
});
