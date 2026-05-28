import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { errorHandler } from './middleware/error-handler';
import { tenantContext } from './middleware/tenant-context';
import { routes } from './routes';

export const app = express();

const allowedOrigins = new Set(
  env.APP_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function isAllowedDevOrigin(origin: string) {
  if (env.NODE_ENV !== 'development') return false;

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
      if (!origin || allowedOrigins.has(origin) || isAllowedDevOrigin(origin)) {
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

app.use(`/api/${env.API_VERSION}`, tenantContext, routes);
app.use(errorHandler);
