import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} não configurada no .env.`);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

function createDbClient() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error('SUPABASE_DB_URL não configurada no .env.');
  }

  return new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function ensureAuthUser(email: string, password: string) {
  const { error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error && !error.message.toLowerCase().includes('already')) {
    throw error;
  }

  console.log(`Auth user pronto: ${email}`);
}

async function main() {
  if (process.env.SETUP_AUTH_ONLY === 'true') {
    await ensureAuthUser(
      'aluno@uni.com',
      process.env.DEMO_STUDENT_PASSWORD ?? '123456',
    );
    await ensureAuthUser(
      'professor@uni.com',
      process.env.DEMO_TEACHER_PASSWORD ?? '123456',
    );
    console.log('Usuários Auth configurados.');
    return;
  }

  const db = createDbClient();
  await db.connect();

  try {
    async function runSqlFile(fileName: string) {
      const sql = readFileSync(join(process.cwd(), 'supabase', fileName), 'utf8');
      await db.query(sql);
      console.log(`SQL executado: ${fileName}`);
    }

    await runSqlFile('schema.sql');
    await ensureAuthUser(
      'aluno@uni.com',
      process.env.DEMO_STUDENT_PASSWORD ?? '123456',
    );
    await ensureAuthUser(
      'professor@uni.com',
      process.env.DEMO_TEACHER_PASSWORD ?? '123456',
    );
    await runSqlFile('seed.sql');
    console.log('Supabase configurado para o MVP UniConnect.');
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
