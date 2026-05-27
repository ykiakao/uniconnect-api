import { Router } from 'express';

import { authRoutes } from './modules/auth/auth.routes';
import { tenantRoutes } from './modules/tenants/tenant.routes';

export const routes = Router();

routes.get('/health', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'uniconnect-api',
    timestamp: new Date().toISOString(),
  });
});

routes.use('/auth', authRoutes);
routes.use('/tenants', tenantRoutes);
