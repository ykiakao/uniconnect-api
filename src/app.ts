import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { errorHandler } from './middleware/error-handler';
import { tenantContext } from './middleware/tenant-context';
import { routes } from './routes';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.APP_ORIGIN }));
app.use(express.json());
app.use(`/api/${env.API_VERSION}`, tenantContext, routes);
app.use(errorHandler);
