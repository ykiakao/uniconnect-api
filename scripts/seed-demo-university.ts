import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, User } from '@supabase/supabase-js';
import { Client } from 'pg';

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
] as const;

const demoPassword = process.env.DEMO_UNIVERSITY_PASSWORD ?? 'Demo@2026';

const demoUsers = [
  'admin@uniconnect.app',
  'gestor@edukmais.edu.br',
  'coordenador@edukmais.edu.br',
  'professor.comp@edukmais.edu.br',
  'professor.eng@edukmais.edu.br',
  'professor.si@edukmais.edu.br',
  'aluno01@edukmais.edu.br',
  'aluno02@edukmais.edu.br',
  'aluno03@edukmais.edu.br',
  'aluno04@edukmais.edu.br',
  'aluno05@edukmais.edu.br',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`${key} nao configurada no .env.`);
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

async function findAuthUserByEmail(email: string): Promise<User | null> {
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) throw error;

    const user = data.users.find(
      (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
    );

    if (user) return user;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function ensureAuthUser(email: string) {
  const existing = await findAuthUserByEmail(email);

  if (existing) {
    console.log(`Auth user ja existe: ${email}`);
    return;
  }

  const { error } = await supabase.auth.admin.createUser({
    email,
    password: demoPassword,
    email_confirm: true,
  });

  if (error) throw error;

  console.log(`Auth user criado: ${email}`);
}

async function main() {
  for (const email of demoUsers) {
    await ensureAuthUser(email);
  }

  const db = new Client({
    connectionString: process.env.SUPABASE_DB_URL!,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  try {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'seed_demo.sql'),
      'utf8',
    );
    await db.query(sql);
    console.log('Seed demo da EduKMais executado.');
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
