import { app } from './app';
import { env } from './config/env';

app.listen(env.PORT, () => {
  console.log(`UniConnect API running at http://localhost:${env.PORT}`);
});
