import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { createSupabaseAdminClient } from './config/supabase';
import { errorHandler } from './middleware/error-handler';
import { tenantContext } from './middleware/tenant-context';
import { routes } from './routes';

export const app = express();

const allowedOrigins = new Set(
  env.APP_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isAllowedLocalOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin) || isAllowedLocalOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origem não permitida pelo CORS: ${origin}`));
    },
  }),
);
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
  } catch (error) {
    response.status(503).json({
      status: 'error',
      service: 'uniconnect-api',
      environment: env.NODE_ENV,
      database: {
        status: 'error',
        message: error instanceof Error ? error.message : 'Erro desconhecido',
      },
      timestamp: new Date().toISOString(),
    });
  }
});

app.use(`/api/${env.API_VERSION}`, tenantContext, routes);
app.use(errorHandler);
