import { Router } from 'express';

import { authRoutes } from './modules/auth/auth.routes';
import { tenantRoutes } from './modules/tenants/tenant.routes';

export const routes = Router();

routes.use('/auth', authRoutes);
routes.use('/tenants', tenantRoutes);
