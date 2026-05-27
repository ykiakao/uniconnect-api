import { Router } from 'express';
import { z } from 'zod';

import { users } from '../../data/mock-store';
import { HttpError } from '../../shared/http-error';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const authRoutes = Router();

authRoutes.post('/login', (request, response) => {
  const credentials = loginSchema.parse(request.body);
  const normalizedEmail = credentials.email.trim().toLowerCase();
  const user = users.find(
    (item) =>
      item.email === normalizedEmail && item.tenantId === request.tenant?.id,
  );

  if (!user) {
    throw new HttpError(401, 'Credenciais inválidas.');
  }

  response.json({
    accessToken: `mock-token-${user.id}`,
    user,
    tenant: request.tenant,
  });
});

authRoutes.get('/me', (request, response) => {
  const user = users.find((item) => item.tenantId === request.tenant?.id);

  response.json({
    user,
    tenant: request.tenant,
  });
});
