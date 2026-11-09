import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { createSupabaseAdminClient } from './config/supabase';
import { errorHandler } from './middleware/error-handler';
import { tenantContext } from './middleware/tenant-context';
import { routes, routeRegistry, platformRoutes } from './routes';
import { academicHttpBoundary } from './modules/academic/academic.protection';
import { sensitiveResponse } from './middleware/sensitive-response';
import { createRateLimit } from './middleware/rate-limit';
import { createHttpObservability } from './observability/http-observability';
import { HttpError } from './shared/http-error';

export const app = express();
app.disable('etag');

const allowedOrigins = new Set(
  env.APP_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isAllowedLocalOrigin(origin: string) {
  if (env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      url.origin === origin &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

routeRegistry.register('GET', `/api/${env.API_VERSION}/health`);
routeRegistry.register('GET', `/api/${env.API_VERSION}/health/ready`);
app.use(createHttpObservability({ resolveRoute: (method, path) => routeRegistry.resolve(method, path) }));
app.use(`/api/${env.API_VERSION}`, sensitiveResponse);
app.use(helmet());
app.use(
  cors({
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin) || isAllowedLocalOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new HttpError(403, 'CORS_ORIGIN_FORBIDDEN', 'Origem nao permitida.'));
    },
  }),
);
app.use([`/api/${env.API_VERSION}/auth/login`, `/api/${env.API_VERSION}/auth/admin/login`, `/api/${env.API_VERSION}/auth/platform/login`],
  createRateLimit({ max: 30, windowMs: 15 * 60 * 1000 }));
app.use(`/api/${env.API_VERSION}/invites`, createRateLimit({ max: 60, windowMs: 60000 }));
app.use([`/api/${env.API_VERSION}/auth/refresh`, `/api/${env.API_VERSION}/auth/admin/refresh`, `/api/${env.API_VERSION}/auth/platform/refresh`],
  createRateLimit({ max: 60, windowMs: 60000 }));
app.use(`/api/${env.API_VERSION}/auth/password/recovery`, createRateLimit({ max: 10, windowMs: 15 * 60 * 1000 }));
app.use([`/api/${env.API_VERSION}/auth/password/reset`, `/api/${env.API_VERSION}/auth/accounts/activate`],
  createRateLimit({ max: 30, windowMs: 15 * 60 * 1000 }));
app.use(`/api/${env.API_VERSION}/tenants/:slug/invites`, createRateLimit({ max: 30, windowMs: 60000 }));
app.use(`/api/${env.API_VERSION}/tenants/:slug/academic`, academicHttpBoundary);
app.use(express.json());

app.get(`/api/${env.API_VERSION}/health`, (_request, response) => {
  response.json({
    status: 'ok',
    service: 'uniconnect-api',
    timestamp: new Date().toISOString(),
  });
});

app.get(`/api/${env.API_VERSION}/health/ready`, async (_request, response) => {
  const startedAt = Date.now();

  try {
    const { error } = await createSupabaseAdminClient()
      .from('tenants')
      .select('id', { count: 'exact', head: true });

    if (error) throw new Error(error.message);

    response.json({
      status: 'ok',
      service: 'uniconnect-api',
      environment: env.NODE_ENV,
      database: { status: 'ok', latencyMs: Date.now() - startedAt },
      timestamp: new Date().toISOString(),
    });
  } catch {
    response.status(503).json({
      status: 'error',
      service: 'uniconnect-api',
      environment: env.NODE_ENV,
      database: {
        status: 'error',
        message: 'Nao foi possivel confirmar a conexao com o banco.',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

app.use(`/api/${env.API_VERSION}`, platformRoutes);
app.use(`/api/${env.API_VERSION}`, tenantContext, routes);
app.use((_request, _response, next) => next(new HttpError(404, 'NOT_FOUND', 'Recurso nao encontrado.')));
app.use(errorHandler);
