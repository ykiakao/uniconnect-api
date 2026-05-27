import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

import { env } from './env';

function requireSupabaseConfig(key: string | undefined, label: string) {
  if (!key) {
    throw new Error(`${label} não configurada no ambiente.`);
  }

  return key;
}

const supabaseRuntimeOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: WebSocket as never,
  },
};

export function createSupabaseAnonClient() {
  return createClient(
    requireSupabaseConfig(env.SUPABASE_URL, 'SUPABASE_URL'),
    requireSupabaseConfig(env.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY'),
    supabaseRuntimeOptions,
  );
}

export function createSupabaseAdminClient() {
  return createClient(
    requireSupabaseConfig(env.SUPABASE_URL, 'SUPABASE_URL'),
    requireSupabaseConfig(
      env.SUPABASE_SERVICE_ROLE_KEY,
      'SUPABASE_SERVICE_ROLE_KEY',
    ),
    supabaseRuntimeOptions,
  );
}
