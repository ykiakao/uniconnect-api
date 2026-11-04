import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'dotenv';

import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { Client } from 'pg';
import { buildAdminDatabaseConfig } from '../src/config/admin-database';
import { DemoSeedError, describeDemoSeedConnectionError, validateDemoSeedEnvironment } from '../src/config/demo-seed-environment';

function loadEnvironment(args: string[], preflight: boolean) {
  if (args.length !== (preflight ? 3 : 2) || args[0] !== '--env-file'
    || !args[1]?.trim() || args[1].startsWith('--') || (preflight && args[2] !== '--preflight')) {
    throw new DemoSeedError('Uso: npm run seed:demo -- --env-file <arquivo-de-homologacao> [--preflight]');
  }
  let values: Record<string, string>;
  try {
    const file = args[1];
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || basename(realpathSync(file)).toLowerCase() === '.env') {
      throw new Error();
    }
    // File values stay isolated from the process environment and dotenv defaults.
    values = parse(readFileSync(file, 'utf8'));
  } catch {
    throw new DemoSeedError('Use um arquivo regular exclusivo de homologacao, diferente de .env.');
  }
  return validateDemoSeedEnvironment(values);
}

function buildDemoUsers(env: ReturnType<typeof validateDemoSeedEnvironment>) {
  const demoUniversityPassword = env.DEMO_UNIVERSITY_PASSWORD;
  return [
    { email: 'admin@uniconnect.app', password: demoUniversityPassword },
    { email: 'gestor@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'coordenador@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'professor.comp@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'professor.eng@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'professor.si@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'professor@edukmais.edu.br', password: env.DEMO_TEACHER_PASSWORD },
    { email: 'aluno@edukmais.edu.br', password: env.DEMO_STUDENT_PASSWORD },
    { email: 'aluno01@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'aluno02@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'aluno03@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'aluno04@edukmais.edu.br', password: demoUniversityPassword },
    { email: 'aluno05@edukmais.edu.br', password: demoUniversityPassword },
  ];
}

type AuthAdmin = SupabaseClient['auth']['admin'];

async function findAuthUserByEmail(admin: AuthAdmin, email: string): Promise<User | null> {
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data, error } = await admin.listUsers({
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

async function ensureAuthUser(admin: AuthAdmin, params: { email: string; password: string }) {
  const { email, password } = params;
  const existing = await findAuthUserByEmail(admin, email);

  if (existing) {
    const { error } = await admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });

    if (error) throw error;

    console.log(`Auth user atualizado: ${email}`);
    return;
  }

  const { error } = await admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) throw error;

  console.log(`Auth user criado: ${email}`);
}

async function main() {
  const args = process.argv.slice(2);
  const preflight = args.includes('--preflight');
  if (!preflight) return runSeed(args, false);

  const checks = [
    'Ambiente, projeto e configuração TLS',
    'Conexão PostgreSQL com TLS',
    'Identidade e esquema PostgreSQL',
    'Leitura administrativa no Supabase Auth',
  ];
  let passed = 0;
  let success = false;
  try {
    await runSeed(args, true, () => { passed += 1; });
    success = true;
  } finally {
    console.log(success ? 'Pré-voo aprovado.' : 'Pré-voo reprovado.');
    for (const [index, check] of checks.entries()) {
      const result = index < passed ? 'APROVADO' : index === passed ? 'FALHOU' : 'NÃO EXECUTADO';
      console.log(`${result} — ${check}`);
    }
    if (!success && passed === checks.length) console.log('FALHOU — Encerramento da conexão');
  }
}

async function runSeed(args: string[], preflight: boolean, approve?: () => void) {
  const env = loadEnvironment(args, preflight);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || process.env.PGOPTIONS || process.env.PGREPLICATION) {
    throw new DemoSeedError('Remova configuracoes TLS ou PostgreSQL inseguras herdadas do processo.');
  }
  const sql = preflight ? undefined : readFileSync(
    join(process.cwd(), 'supabase', 'seed_demo.sql'),
    'utf8',
  );
  const db = new Client(buildAdminDatabaseConfig(env.SUPABASE_DB_URL, {
    mode: env.SUPABASE_DB_SSL_MODE,
    ca: env.SUPABASE_DB_CA_FILE ? readFileSync(env.SUPABASE_DB_CA_FILE, 'utf8') : undefined,
  }));
  approve?.();

  let connected = false;
  let failure = 'Falha ao verificar a identidade ou o esquema do PostgreSQL da homologacao.';
  try {
    await db.connect();
    connected = true;
    approve?.();
    const { rows } = await db.query<{ ready: boolean }>(`
      select (
        session_user = 'postgres' and current_database() = 'postgres'
        and to_regclass('public.academic_periods') is not null
        and to_regclass('public.subjects') is not null
        and to_regclass('public.enrollments') is not null
        and to_regclass('public.teaching_assignments') is not null
        and to_regclass('public.activity_submissions') is not null
        and to_regclass('public.activity_submission_versions') is not null
        and to_regclass('public.grade_revisions') is not null
        and to_regprocedure('public.assert_operational_tenant(uuid)') is not null
        and to_regprocedure('public.manage_academic_activity(uuid,uuid,text,uuid,uuid,jsonb)') is not null
        and to_regprocedure('public.submit_activity_answer(uuid,uuid,uuid,integer,text)') is not null
        and to_regprocedure('public.review_activity_submission(uuid,uuid,uuid,integer,integer,numeric,text,boolean)') is not null
        and to_regprocedure('public.publish_activity_review(uuid,uuid,uuid,integer)') is not null
        and not exists (
          select 1 from (values
            ('classes', 'subject_id'), ('classes', 'academic_period_id'), ('classes', 'academic_status'),
            ('app_users', 'active'), ('app_users', 'course_id'), ('activities', 'workflow_enabled'),
            ('activities', 'state'), ('grades', 'publication_state'), ('messages', 'conversation_id')
          ) required(table_name, column_name)
          where not exists (
            select 1 from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = required.table_name and c.column_name = required.column_name
          )
        )
      ) as ready
    `);
    if (rows.length !== 1 || rows[0].ready !== true) {
      throw new DemoSeedError('Banco, role administrativa ou schema academico incompativel com o seed demo.');
    }
    approve?.();

    failure = 'Falha ao confirmar a credencial administrativa do Auth da homologacao.';
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: async (input, init) => {
          try {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
            const allowed = !preflight || (method === 'GET' && url.pathname === '/auth/v1/admin/users');
            if (allowed && url.origin === env.SUPABASE_URL && !url.username && !url.password) {
              return await fetch(input, { ...init, redirect: 'error' });
            }
          } catch {
            // Auth SDK can log fetch exceptions. Never forward the original error.
          }
          throw new Error('Requisicao ao Auth de homologacao bloqueada ou indisponivel.');
        },
      },
    });
    const admin = supabase.auth.admin;
    const { data, error } = await admin.listUsers({ page: 1, perPage: 1 });
    if (error || !Array.isArray(data?.users)) throw new DemoSeedError(failure);
    approve?.();
    if (sql === undefined) return;

    // Auth is outside the SQL transaction: rollback cannot undo account/password changes.
    // Use an isolated, authorized demo; stop and review failures instead of retrying blindly.
    failure = 'Falha durante a preparacao do Auth. Algumas contas podem ter sido alteradas.';
    for (const user of buildDemoUsers(env)) {
      await ensureAuthUser(admin, user);
    }

    failure = 'Falha ao aplicar o SQL do seed. As alteracoes no Auth podem ter sido mantidas.';
    await db.query(sql);
    console.log('Seed demo da EduKMais executado.');
  } catch (error) {
    if (!connected) throw new DemoSeedError(describeDemoSeedConnectionError(error));
    if (error instanceof DemoSeedError) throw error;
    throw new DemoSeedError(failure);
  } finally {
    if (connected) await db.end();
    else await db.end().catch(() => {}); // Preserve the diagnosis if cleanup also fails.
  }
}

main().catch((error) => {
  console.error(error instanceof DemoSeedError ? error.message : 'Falha local ao preparar ou finalizar o seed demo.');
  process.exitCode = 1;
});
