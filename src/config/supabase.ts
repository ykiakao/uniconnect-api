import { createClient } from '@supabase/supabase-js';

import { env } from './env';

function requireSupabaseConfig(key: string | undefined, label: string) {
  if (!key) {
    throw new Error(`${label} não configurada no ambiente.`);
  }

  return key;
}

export function createSupabaseAnonClient() {
  return createClient(
    requireSupabaseConfig(env.SUPABASE_URL, 'SUPABASE_URL'),
    requireSupabaseConfig(env.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

export function createSupabaseAdminClient() {
  return createClient(
    requireSupabaseConfig(env.SUPABASE_URL, 'SUPABASE_URL'),
    requireSupabaseConfig(
      env.SUPABASE_SERVICE_ROLE_KEY,
      'SUPABASE_SERVICE_ROLE_KEY',
    ),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
