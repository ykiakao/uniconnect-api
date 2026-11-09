import 'dotenv/config';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, User } from '@supabase/supabase-js';
import { Client } from 'pg';
import { applyGuardedMigration } from './lib/migration-executor.cjs';
import { buildAdminDatabaseConfig, ensureUninitializedAdminDatabase } from '../src/config/admin-database';

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DEMO_STUDENT_PASSWORD',
  'DEMO_TEACHER_PASSWORD',
  'DEMO_COORDINATOR_PASSWORD',
  'DEMO_OWNER_PASSWORD',
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]?.trim()) {
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

  return new Client(buildAdminDatabaseConfig(process.env.SUPABASE_DB_URL, {
    mode: process.env.SUPABASE_DB_SSL_MODE,
    ca: process.env.SUPABASE_DB_CA_FILE ? readFileSync(process.env.SUPABASE_DB_CA_FILE, 'utf8') : undefined,
  }));
}

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

async function ensureAuthUser(email: string, password: string) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error && !error.message.toLowerCase().includes('already')) {
    throw error;
  }

  console.log(`Auth user pronto: ${email}`);
  return data.user ?? (await findAuthUserByEmail(email));
}

async function runApiOnlySetup(
  demoUsers: Array<{ email: string; password: string }>,
) {
  const authUsers = new Map<string, User>();

  for (const user of demoUsers) {
    const authUser = await ensureAuthUser(user.email, user.password);
    if (!authUser) {
      throw new Error(`Auth user nao encontrado apos criacao: ${user.email}`);
    }
    authUsers.set(user.email, authUser);
  }

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .upsert(
      {
        name: 'EduKMais',
        slug: 'edukmais',
        plan: 'growth',
        status: 'trialing',
        active_users: 384,
      },
      { onConflict: 'slug' },
    )
    .select('id')
    .single();

  if (tenantError || !tenant) {
    throw new Error(
      `Nao foi possivel preparar tenant: ${tenantError?.message}`,
    );
  }

  const appUsers = [
      {
        tenant_id: tenant.id,
        auth_user_id: authUsers.get('aluno@edukmais.edu.br')!.id,
        name: 'Lucas Oliveira',
        email: 'aluno@edukmais.edu.br',
        role: 'student',
        course: 'Engenharia de Software',
        registration: '2024021845',
      semester: 4,
    },
      {
        tenant_id: tenant.id,
        auth_user_id: authUsers.get('professor@edukmais.edu.br')!.id,
        name: 'Marina Costa',
        email: 'professor@edukmais.edu.br',
        role: 'teacher',
        course: 'Engenharia de Software',
      },
      {
        tenant_id: tenant.id,
        auth_user_id: authUsers.get('coordenador@edukmais.edu.br')!.id,
        name: 'Patricia Almeida',
        email: 'coordenador@edukmais.edu.br',
        role: 'coordinator',
        course: 'Engenharia de Software',
      },
      {
        tenant_id: tenant.id,
        auth_user_id: authUsers.get('dono@edukmais.edu.br')!.id,
        name: 'Rafael Andrade',
        email: 'dono@edukmais.edu.br',
        role: 'owner',
      },
  ];

  const { error: usersError } = await supabase
    .from('app_users')
    .upsert(appUsers, { onConflict: 'tenant_id,email' });

  if (usersError) {
    throw new Error(
      `Nao foi possivel preparar usuarios administrativos: ${usersError.message}`,
    );
  }

  console.log('Supabase configurado via API para login administrativo.');
}

async function main() {
  const demoUsers = [
    {
      email: 'aluno@edukmais.edu.br',
      password: process.env.DEMO_STUDENT_PASSWORD!,
    },
    {
      email: 'professor@edukmais.edu.br',
      password: process.env.DEMO_TEACHER_PASSWORD!,
    },
    {
      email: 'coordenador@edukmais.edu.br',
      password: process.env.DEMO_COORDINATOR_PASSWORD!,
    },
    {
      email: 'dono@edukmais.edu.br',
      password: process.env.DEMO_OWNER_PASSWORD!,
    },
  ];

  if (process.env.SETUP_AUTH_ONLY === 'true') {
    for (const user of demoUsers) {
      await ensureAuthUser(user.email, user.password);
    }

    console.log('Usuários Auth configurados.');
    return;
  }

  if (process.env.SETUP_API_ONLY === 'true') {
    await runApiOnlySetup(demoUsers);
    return;
  }

  const db = createDbClient();
  await db.connect();

  try {
    await ensureUninitializedAdminDatabase(db);
    async function runSqlFile(fileName: string) {
      const sql = readFileSync(join(process.cwd(), 'supabase', fileName), 'utf8');
      if (fileName === 'seed.sql') await db.query(sql);
      else await applyGuardedMigration(db, { name: fileName, sql });
      console.log(`SQL executado: ${fileName}`);
    }

    async function runMigrations() {
      const migrationsPath = join(process.cwd(), 'supabase', 'migrations');
      if (!existsSync(migrationsPath)) return;

      const migrations = readdirSync(migrationsPath)
        .filter((fileName) => fileName.endsWith('.sql'))
        .sort();

      for (const migration of migrations) {
        const sql = readFileSync(join(migrationsPath, migration), 'utf8');
        await applyGuardedMigration(db, { name: migration, sql });
        console.log(`Migration executada: ${migration}`);
      }
    }

    await runSqlFile('schema.sql');
    await runMigrations();
    for (const user of demoUsers) {
      await ensureAuthUser(user.email, user.password);
    }

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
