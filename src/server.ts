import { app } from './app';
import { env } from './config/env';
import { logger } from './observability/logger';

app.listen(env.PORT, env.HOST, () => {
  logger.startup();
});
