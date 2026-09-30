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

const demoUniversityPassword =
  process.env.DEMO_UNIVERSITY_PASSWORD ?? 'Demo@2026';

const demoUsers = [
  { email: 'admin@uniconnect.app', password: demoUniversityPassword },
  { email: 'gestor@edukmais.edu.br', password: demoUniversityPassword },
  {
    email: 'coordenador@edukmais.edu.br',
    password: demoUniversityPassword,
  },
  { email: 'professor.comp@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'professor.eng@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'professor.si@edukmais.edu.br', password: demoUniversityPassword },
  {
    email: 'professor@edukmais.edu.br',
    password: process.env.DEMO_TEACHER_PASSWORD ?? '123456',
  },
  {
    email: 'aluno@edukmais.edu.br',
    password: process.env.DEMO_STUDENT_PASSWORD ?? '123456',
  },
  { email: 'aluno01@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'aluno02@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'aluno03@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'aluno04@edukmais.edu.br', password: demoUniversityPassword },
  { email: 'aluno05@edukmais.edu.br', password: demoUniversityPassword },
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

async function ensureAuthUser(params: { email: string; password: string }) {
  const { email, password } = params;
  const existing = await findAuthUserByEmail(email);

  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });

    if (error) throw error;

    console.log(`Auth user atualizado: ${email}`);
    return;
  }

  const { error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) throw error;

  console.log(`Auth user criado: ${email}`);
}

async function main() {
  for (const user of demoUsers) {
    await ensureAuthUser(user);
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
