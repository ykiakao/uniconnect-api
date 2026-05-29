import 'dotenv/config';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, User } from '@supabase/supabase-js';
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
        name: 'Universidade Norte',
        slug: 'universidade-norte',
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
      auth_user_id: authUsers.get('aluno@uni.com')!.id,
      name: 'Lucas Oliveira',
      email: 'aluno@uni.com',
      role: 'student',
      course: 'Engenharia de Software',
      registration: '2024021845',
      semester: 4,
    },
    {
      tenant_id: tenant.id,
      auth_user_id: authUsers.get('professor@uni.com')!.id,
      name: 'Marina Costa',
      email: 'professor@uni.com',
      role: 'teacher',
      course: 'Engenharia de Software',
    },
    {
      tenant_id: tenant.id,
      auth_user_id: authUsers.get('coordenador@uni.com')!.id,
      name: 'Patricia Almeida',
      email: 'coordenador@uni.com',
      role: 'admin',
      course: 'Engenharia de Software',
    },
    {
      tenant_id: tenant.id,
      auth_user_id: authUsers.get('dono@uni.com')!.id,
      name: 'Rafael Andrade',
      email: 'dono@uni.com',
      role: 'admin',
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
      email: 'aluno@uni.com',
      password: process.env.DEMO_STUDENT_PASSWORD ?? '123456',
    },
    {
      email: 'professor@uni.com',
      password: process.env.DEMO_TEACHER_PASSWORD ?? '123456',
    },
    {
      email: 'coordenador@uni.com',
      password: process.env.DEMO_COORDINATOR_PASSWORD ?? '123456',
    },
    {
      email: 'dono@uni.com',
      password: process.env.DEMO_OWNER_PASSWORD ?? '123456',
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
    async function runSqlFile(fileName: string) {
      const sql = readFileSync(join(process.cwd(), 'supabase', fileName), 'utf8');
      await db.query(sql);
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
        await db.query(sql);
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
