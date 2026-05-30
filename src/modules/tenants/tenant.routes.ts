import { Router } from 'express';
import { z } from 'zod';

import { HttpError } from '../../shared/http-error';
import { TenantRepository } from './tenant.repository';

export const tenantRoutes = Router();
const tenantRepository = new TenantRepository();

const lookupSchema = z.object({
  slug: z.string().trim().min(1),
});

tenantRoutes.get('/lookup', async (request, response, next) => {
  try {
    const query = lookupSchema.parse(request.query);
    const tenant = await tenantRepository.findBySlug(query.slug);

    response.json({
      name: tenant.name,
      slug: tenant.slug,
    });
  } catch (error) {
    next(error);
  }
});

tenantRoutes.get('/current', (request, response) => {
  if (!request.tenant) {
    throw new HttpError(400, 'TENANT_REQUIRED', 'Instituição não informada');
  }

  response.json({ tenant: request.tenant });
});
