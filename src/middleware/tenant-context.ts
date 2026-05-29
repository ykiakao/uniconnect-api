import { NextFunction, Request, Response } from 'express';

import { TenantRepository } from '../modules/tenants/tenant.repository';
import { Tenant } from '../shared/types';

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

const tenantRepository = new TenantRepository();

export async function tenantContext(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const slug = request.header('x-tenant-slug')?.trim();

    if (!slug) {
      next();
      return;
    }

    request.tenant = await tenantRepository.findBySlug(slug);
    next();
  } catch (error) {
    next(error);
  }
}
