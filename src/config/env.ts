import 'dotenv/config';
import { z } from 'zod';

export function isSafeAuthRedirectUrl(value: string, nodeEnv: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || /^\w+:\/\/[^/]*@/.test(value) || value.includes('?') || value.includes('#')) return false;
    return url.protocol === 'https:' || (nodeEnv !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),
  APP_ORIGIN: z.string().default(''),
  ACADEMIC_ATTACHMENTS_MODE: z.enum(['disabled', 'read_only', 'enabled']).default('disabled'),
  ACADEMIC_ATTACHMENTS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('academic-attachments'),
  ACADEMIC_ATTACHMENT_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().min(15).max(60).default(60),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  AUTH_RECOVERY_REDIRECT_URL: z.string().url().optional(),
  AUTH_INVITE_REDIRECT_URL: z.string().url().optional(),
  PLATFORM_ADMIN_AUTH_USER_IDS: z.string().default('').transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean).map((id) => z.guid().parse(id)),
  ),
  ACADEMIC_PROVIDER: z.enum(['disabled', 'demo', 'native']).default('disabled'),
  ACADEMIC_DEMO_TENANT_SLUG: z.string().trim().min(1).max(64).default('edukmais'),
}).superRefine((value, context) => {
  for (const key of ['AUTH_RECOVERY_REDIRECT_URL', 'AUTH_INVITE_REDIRECT_URL'] as const) {
    if (value[key] && !isSafeAuthRedirectUrl(value[key], value.NODE_ENV)) {
      context.addIssue({ code: 'custom', path: [key], message: 'Configure HTTPS sem credenciais, query ou fragmento; HTTP loopback somente fora de producao.' });
    }
  }
});

export const env = envSchema.parse(process.env);
