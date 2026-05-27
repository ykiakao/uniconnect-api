import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  API_VERSION: z.string().default('v1'),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:8080'),
});

export const env = envSchema.parse(process.env);
