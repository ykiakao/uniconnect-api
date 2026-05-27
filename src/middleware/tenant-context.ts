import { NextFunction, Request, Response } from 'express';

import { tenants } from '../data/mock-store';
import { HttpError } from '../shared/http-error';
import { Tenant } from '../shared/types';

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

export function tenantContext(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  const slug = request.header('x-tenant-slug') ?? 'universidade-norte';
  const tenant = tenants.find((item) => item.slug === slug);

  if (!tenant) {
    throw new HttpError(404, 'Instituição não encontrada.');
  }

  request.tenant = tenant;
  next();
}
