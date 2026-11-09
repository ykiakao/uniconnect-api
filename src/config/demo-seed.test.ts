import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'dotenv';
import { AssignmentSchema, EnrollmentSchema, OfferingSchema, PeriodSchema, SubjectSchema, validatePeriodDates } from '../modules/academic-structure/academic-structure.schemas';
import { activityCreateSchema, answerSchema, publishReviewSchema, reviewSchema, versionSchema } from '../modules/activities/activities.workflow.schemas';
import { DemoSeedError, describeDemoSeedConnectionError, validateDemoSeedEnvironment } from './demo-seed-environment';

const root = join(__dirname, '../..');
const sql = readFileSync(join(root, 'supabase/seed_demo.sql'), 'utf8');
const script = readFileSync(join(root, 'scripts/seed-demo-university.ts'), 'utf8');

type Fixture = Record<string, any>;
function fixtures(): Record<string, Fixture[]> {
  const match = sql.match(/\$fixtures\$([\s\S]*?)\$fixtures\$::jsonb/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}
function keyed(rows: Fixture[], field = 'key') {
  expect(new Set(rows.map(row => row[field])).size).toBe(rows.length);
  return new Map(rows.map(row => [row[field], row]));
}

describe('demo academic fixtures (static SQL review, no database execution)', () => {
  it('defines every required relation without orphan keys or ambiguous identities', () => {
    const f = fixtures();
    const users = keyed(f.users, 'email');
    const courses = keyed(f.courses);
    const periods = keyed(f.periods, 'code');
    const subjects = keyed(f.subjects, 'code');
    const classes = keyed(f.classes);
    const activities = keyed(f.activities);
    expect(f.users).toHaveLength(13);
    expect(f.courses).toHaveLength(3);
    expect(f.classes).toHaveLength(4);
    expect(f.activities).toHaveLength(6);
    for (const member of f.users) {
      expect(member.email).toMatch(/^[^\s@]+@[^\s@]+$/);
      expect(['admin', 'coordinator', 'teacher', 'student']).toContain(member.role);
      expect(member.name.trim()).not.toBe('');
      if (member.course) expect(courses.has(member.course)).toBe(true);
      if (member.role === 'student') {
        expect(member.registration).toMatch(/^DEMO-/);
        expect(member.semester).toBeGreaterThan(0);
      }
    }
    for (const period of f.periods) {
      expect(period.status).toBe('active');
      expect(period.start_date <= period.end_date).toBe(true);
    }
    for (const subject of f.subjects) {
      expect(courses.has(subject.course)).toBe(true);
      expect(subject.status).toBe('active');
    }
    for (const offering of f.classes) {
      expect(subjects.get(offering.subject)?.course).toBe(offering.course);
      expect(periods.has(offering.period)).toBe(true);
      expect(users.get(offering.teacher)?.role).toBe('teacher');
      expect(offering.semester).toBeGreaterThan(0);
      for (const teacher of offering.additional_teachers) expect(users.get(teacher)?.role).toBe('teacher');
    }
    keyed(f.enrollments.map(row => ({ key: `${row.class}:${row.student}` })));
    for (const enrollment of f.enrollments) {
      expect(users.get(enrollment.student)?.role).toBe('student');
      expect(classes.get(enrollment.class)?.course).toBe(users.get(enrollment.student)?.course);
    }
    for (const activity of f.activities) {
      expect(classes.has(activity.class)).toBe(true);
      expect(activity.title.trim()).not.toBe('');
      expect(activity.due_days).toBeGreaterThan(0);
      expect(activity.instructions.trim()).not.toBe('');
      expect(activity.evaluation_criteria.trim()).not.toBe('');
    }
    keyed(f.deliveries.map(row => ({ key: `${row.activity}:${row.student}` })));
    for (const delivery of f.deliveries) {
      const activity = activities.get(delivery.activity);
      expect(activity).toBeDefined();
      expect(f.enrollments).toContainEqual({ class: activity!.class, student: delivery.student });
      expect(delivery.answer.trim().length).toBeGreaterThan(0);
      expect(delivery.answer.length).toBeLessThanOrEqual(20000);
      expect(['pending', 'draft', 'published']).toContain(delivery.review);
      if (delivery.review !== 'pending') {
        expect(delivery.grade).toBeGreaterThanOrEqual(0);
        expect(delivery.grade).toBeLessThanOrEqual(10);
      }
    }
    for (const message of f.messages) {
      expect(classes.has(message.class)).toBe(true);
      expect(users.has(message.sender)).toBe(true);
      expect(message.content.trim()).not.toBe('');
    }
  });

  it('gives the principal demo teacher and student valid academic participation', () => {
    const f = fixtures();
    const classes = f.classes.filter(row => row.teacher === 'professor@edukmais.edu.br' || row.additional_teachers.includes('professor@edukmais.edu.br'));
    expect(classes.length).toBeGreaterThan(0);
    for (const offering of classes) {
      expect([offering.teacher, ...offering.additional_teachers]).toContain('professor.eng@edukmais.edu.br');
      expect(f.enrollments).toContainEqual({ class: offering.key, student: 'aluno@edukmais.edu.br' });
    }
    expect(f.deliveries.some(row => row.review === 'pending')).toBe(true);
    expect(f.deliveries.some(row => row.review === 'draft')).toBe(true);
    expect(f.deliveries.some(row => row.review === 'published')).toBe(true);
    expect(f.activities.some(activity => !f.deliveries.some(row => row.activity === activity.key))).toBe(true);
  });

  it('satisfies the production input validators without relaxing required fields', () => {
    const f = fixtures();
    const id = '11111111-1111-4111-8111-111111111111';
    for (const period of f.periods) {
      const input = PeriodSchema.parse({ code: period.code, name: period.name, status: period.status,
        startDate: period.start_date, endDate: period.end_date });
      expect(() => validatePeriodDates(input)).not.toThrow();
    }
    for (const subject of f.subjects) {
      expect(SubjectSchema.safeParse({ courseId: id, code: subject.code, name: subject.name, status: subject.status }).success).toBe(true);
    }
    for (const offering of f.classes) {
      expect(OfferingSchema.safeParse({ courseId: id, subjectId: id, periodId: id, teacherAuthId: id,
        name: offering.name, status: 'active' }).success).toBe(true);
    }
    expect(EnrollmentSchema.safeParse({ classId: id, studentId: id, status: 'active' }).success).toBe(true);
    expect(AssignmentSchema.safeParse({ classId: id, teacherId: id, status: 'active' }).success).toBe(true);
    for (const activity of f.activities) {
      const created = activityCreateSchema.parse({ title: activity.title, description: activity.description,
        type: activity.type, instructions: activity.instructions, evaluationCriteria: activity.evaluation_criteria,
        dueDate: new Date(Date.UTC(2026, 0, 1 + activity.due_days)).toISOString() });
      expect(created.allowLate).toBe(false);
    }
    expect(versionSchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    for (const delivery of f.deliveries) {
      expect(answerSchema.safeParse({ answer: delivery.answer, expectedVersion: 0 }).success).toBe(true);
      if (delivery.review !== 'pending') {
        expect(reviewSchema.safeParse({ expectedRevision: 0, submissionVersion: 1,
          grade: delivery.grade, feedback: delivery.feedback, publish: false }).success).toBe(true);
      }
    }
    expect(publishReviewSchema.safeParse({ expectedRevision: 1 }).success).toBe(true);
  });

  it('orders academic dependencies and lets class triggers own primary assignments', () => {
    const tables = ['courses', 'app_users', 'academic_periods', 'subjects', 'classes', 'enrollments'];
    let previous = -1;
    for (const table of tables) {
      const position = sql.indexOf(`insert into public.${table}`);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    expect(sql).toMatch(/insert into public\.classes\s*\([^)]*subject_id[^)]*academic_period_id[^)]*teacher_id/);
    expect(sql).toMatch(/insert into public\.teaching_assignments\s*\([^)]*teacher_id,\s*status\)/);
    expect(sql).not.toMatch(/insert into public\.teaching_assignments\s*\([^)]*is_primary/);
    expect(sql.indexOf('public.manage_academic_activity(')).toBeGreaterThan(previous);
  });

  it('uses the guarded draft, publication, submission and review operations with member IDs', () => {
    for (const operation of ['manage_academic_activity', 'submit_activity_answer', 'review_activity_submission', 'publish_activity_review']) {
      expect(sql).toContain(`public.${operation}(`);
    }
    expect(sql).toContain("'create'");
    expect(sql).toContain("'publish'");
    expect(sql).toContain("'expected_version'");
    expect(sql).toContain("delivery_row.current_version");
    expect(sql).toContain("grade_row.revision");
    expect(sql).not.toMatch(/insert into public\.(activities|activity_submissions|activity_submission_versions|grades|grade_revisions)\b/);
    expect(sql).not.toMatch(/set_config|disable\s+trigger|session_replication_role|alter\s+table|create\s+(?:or\s+replace\s+)?function|\bgrant\b|row\s+level\s+security/i);
  });

  it('preserves repeat preparation and history instead of resetting the tenant', () => {
    expect(sql).not.toMatch(/\b(delete\s+from|truncate|drop\s+table)\b/i);
    expect(sql).not.toMatch(/on conflict[^;]*do update/i);
    expect(sql).toMatch(/^--[^]*\bdo \$\$/);
    expect(sql.trim()).toMatch(/end \$\$;$/);
    expect(sql).toContain('into strict');
    expect(sql).toContain('activity_row.id is null');
    expect(sql).toContain('delivery_row.id is null and grade_row.id is null');
    expect(sql).toContain('grade_row.id is null and delivery_created');
    expect(sql).toContain('tenant_id = demo_tenant_id');
    expect(sql).toContain('pg_advisory_xact_lock');
  });

  it('keeps SQL and Auth identities synchronized without embedding passwords', () => {
    const emails = fixtures().users.map(row => row.email).sort();
    const scriptedEmails = [...script.matchAll(/email: '([^']+)'/g)].map(match => match[1]).sort();
    expect(scriptedEmails).toEqual(emails);
    expect(sql).not.toMatch(/password|encrypted_password|service_role_key|access_token|refresh_token/i);
    expect(script).not.toMatch(/password:\s*['"`]/);
  });
});

const testRef = 'pvacwfypqsstdrfxajkg';
const productionRef = 'kpwofazhpiqrxjvxkozl';
const authUrl = `https://${testRef}.supabase.co`;
const dbUrl = `postgresql://postgres:fixture%40password@db.${testRef}.supabase.co/postgres`;
const pooler = 'aws-0-us-east-1.pooler.supabase.com';
const fixtureEnv = {
  UNICONNECT_ENVIRONMENT: 'homologation',
  SUPABASE_PROJECT_REF: testRef,
  SUPABASE_URL: authUrl,
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic',
  SUPABASE_DB_URL: dbUrl,
  DEMO_UNIVERSITY_PASSWORD: 'fixture-university',
  DEMO_TEACHER_PASSWORD: 'fixture-teacher',
  DEMO_STUDENT_PASSWORD: 'fixture-student',
};

function legacyKey(ref: string, role = 'service_role') {
  return ['header', Buffer.from(JSON.stringify({ ref, role })).toString('base64url'), 'signature'].join('.');
}

describe('demo seed target validation without network', () => {
  it.each(Object.keys(fixtureEnv))('requires %s in the selected file', name => {
    for (const value of [undefined, '', '  ']) {
      expect(() => validateDemoSeedEnvironment({ ...fixtureEnv, [name]: value })).toThrow(name);
    }
  });

  it.each([
    { UNICONNECT_ENVIRONMENT: 'production' },
    { SUPABASE_PROJECT_REF: productionRef },
    { SUPABASE_URL: `https://${productionRef}.supabase.co` },
    { SUPABASE_URL: `${authUrl}.invalid` },
    { SUPABASE_URL: `${authUrl}/auth/v1` },
    { SUPABASE_URL: authUrl.replace('https:', 'http:') },
    { SUPABASE_SERVICE_ROLE_KEY: legacyKey(productionRef) },
    { SUPABASE_SERVICE_ROLE_KEY: legacyKey(testRef, 'anon') },
    { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_synthetic' },
    { SUPABASE_DB_URL: dbUrl.replace(testRef, productionRef) },
    { SUPABASE_DB_URL: `postgres://postgres.${productionRef}:fixture@${pooler}:6543/postgres` },
    { SUPABASE_DB_URL: `postgres://postgres:fixture@${pooler}:5432/postgres` },
    { SUPABASE_DB_URL: `postgres://postgres.${testRef}:fixture@${pooler}.invalid/postgres` },
    { SUPABASE_DB_URL: `${dbUrl}?user=postgres.${productionRef}` },
    { SUPABASE_DB_URL: `${dbUrl}?host=db.${productionRef}.supabase.co` },
    { SUPABASE_DB_URL: `${dbUrl}?sslmode=require&sslmode=disable` },
    { SUPABASE_DB_URL: `${dbUrl}?sslmode=no-verify` },
    { SUPABASE_DB_URL: dbUrl.replace('fixture%40password', '%xx') },
    { SUPABASE_DB_URL: dbUrl.replace('fixture%40password', '') },
    { SUPABASE_DB_SSL_MODE: 'disable' },
  ])('blocks inconsistent configuration %#', overrides => {
    expect(() => validateDemoSeedEnvironment({ ...fixtureEnv, ...overrides })).toThrow(DemoSeedError);
  });

  it.each(['5432', '6543'])('accepts the authorized direct host and shared pooler on %s', port => {
    for (const authority of [`postgres:fixture@db.${testRef}.supabase.co`, `postgres%2E${testRef}:fixture@${pooler}`]) {
      const url = `postgresql://${authority}:${port}/postgres?sslmode=verify-full`;
      expect(validateDemoSeedEnvironment({ ...fixtureEnv, SUPABASE_DB_URL: url, SUPABASE_SERVICE_ROLE_KEY: legacyKey(testRef) }).SUPABASE_DB_URL).toBe(url);
    }
    expect(new URL(validateDemoSeedEnvironment(fixtureEnv).SUPABASE_DB_URL).port).toBe('5432');
  });
});

type RunnerOptions = {
  missingFile?: boolean; ready?: boolean; connectError?: boolean; sqlError?: boolean; authError?: boolean;
  probeDenied?: boolean; malformedProbe?: boolean; args?: string[]; fileEnv?: Record<string, string | undefined>;
  probeUrl?: string; processEnv?: Record<string, string>; probeMethod?: string;
  queryError?: boolean; endError?: boolean;
  connectionFailure?: { code?: string; message: string };
};
function runner(options: RunnerOptions = {}) {
  const events: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const passwords = new Map<string, string>();
  const identities = new Map<string, { id: string; email: string }>();
  let authFetch: typeof fetch;
  const auth = {
    listUsers: async ({ perPage }: { perPage: number }) => {
      if (perPage === 1) {
        events.push('auth:preflight');
        if (options.probeDenied) return { error: new Error('fixture-sensitive-credential') };
        if (options.malformedProbe) return { data: {}, error: null };
        if (options.probeUrl) await authFetch(options.probeUrl, { method: options.probeMethod, redirect: 'follow' });
      }
      return { data: { users: [...identities.values()] }, error: null };
    },
    createUser: async ({ email, password }: { email: string; password: string }) => {
      events.push('auth:create');
      if (options.authError) return { error: new Error('Synthetic Auth failure') };
      passwords.set(email, password);
      identities.set(email, { email, id: `fixture-${identities.size}` });
      return { error: null };
    },
    updateUserById: async () => { events.push('auth:update'); return { error: null }; },
  };
  const javascript = ts.transpileModule(script.replace('main().catch(', 'globalThis.completion = main().catch('), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const run = async () => {
    const context = {
      exports: {}, completion: undefined as unknown,
      URL,
      fetch: async (input: string, init: RequestInit) => {
        events.push('auth:fetch');
        expect(input).toBe(`${authUrl}/auth/v1/admin/users`);
        expect(init.redirect).toBe('error');
      },
      process: {
        env: { ...fixtureEnv, SUPABASE_URL: `https://${productionRef}.supabase.co`, ...options.processEnv },
        argv: ['tsx', 'seed', ...(options.args ?? ['--env-file', '.env.seed-homologation'])],
        cwd: () => '/synthetic-repo',
        set exitCode(code: number) { if (code === 1) events.push('exit'); },
      },
      console: { log(message: string) { logs.push(message); }, error(message: string) { errors.push(message); } },
      require: (name: string) => {
        if (name === 'dotenv') return { parse };
        if (name === 'node:path') return { basename, join };
        if (name === 'node:fs') return {
          lstatSync: () => ({ isFile: () => true, nlink: 1 }),
          realpathSync: (path: string) => path,
          readFileSync: (path: string) => {
            if (path.endsWith('.sql')) {
              events.push('file:read');
              if (options.missingFile) throw new Error('Synthetic missing file');
              return sql;
            }
            events.push('env:read');
            return Object.entries(options.fileEnv ?? fixtureEnv)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => `${key}=${value}`).join('\n');
          },
        };
        if (name === '@supabase/supabase-js') return { createClient: (url: string, key: string, config: { global: { fetch: typeof fetch } }) => {
          events.push('auth:client');
          expect(url).toBe(authUrl);
          expect(key).toBe(fixtureEnv.SUPABASE_SERVICE_ROLE_KEY);
          authFetch = config.global.fetch;
          return { auth: { admin: auth } };
        } };
        if (name === '../src/config/demo-seed-environment') return { DemoSeedError, describeDemoSeedConnectionError, validateDemoSeedEnvironment };
        if (name === '../src/config/admin-database') return { buildAdminDatabaseConfig: (url: string) => {
          events.push('db:config');
          expect(new URL(url).hostname).toBe(`db.${testRef}.supabase.co`);
          return {};
        } };
        if (name === 'pg') return { Client: class {
          async connect() {
            events.push('db:connect');
            if (options.connectionFailure) throw options.connectionFailure;
            if (options.connectError) throw new Error('Synthetic connection failure');
          }
          async query(query: string) {
            if (query === sql) {
              events.push('db:seed');
              if (options.sqlError) throw new Error('Synthetic SQL failure');
              return { rows: [] };
            }
            events.push('db:preflight');
            expect(query.trim()).toMatch(/^select\b/i);
            expect(query).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|call)\b/i);
            expect(query).toContain("session_user = 'postgres'");
            expect(query).toContain('to_regprocedure');
            if (options.queryError) throw new Error('fixture-sensitive-credential');
            return { rows: [{ ready: options.ready ?? true }] };
          }
          async end() {
            events.push('db:end');
            if (options.endError) throw new Error('fixture-sensitive-credential');
          }
        } };
        throw new Error(`Module outside the isolated test boundary: ${name}`);
      },
    };
    runInNewContext(javascript, context);
    await context.completion;
  };
  return { events, errors, logs, identities, passwords, run };
}

describe('demo seed --preflight with isolated clients', () => {
  const args = ['--env-file', '.env.seed-homologation', '--preflight'];
  const authUsers = `${authUrl}/auth/v1/admin/users`;

  it('reports each check and only reads the PostgreSQL catalog and Auth', async () => {
    const seed = runner({ args, probeUrl: authUsers, missingFile: true });
    seed.identities.set('admin@uniconnect.app', { email: 'admin@uniconnect.app', id: 'existing' });
    await seed.run();
    expect(seed.events).toEqual([
      'env:read', 'db:config', 'db:connect', 'db:preflight',
      'auth:client', 'auth:preflight', 'auth:fetch', 'db:end',
    ]);
    expect(seed.logs[0]).toBe('Pré-voo aprovado.');
    expect(seed.logs.filter(line => line.startsWith('APROVADO'))).toHaveLength(4);
    expect(seed.errors).toEqual([]);
    expect(seed.identities.size).toBe(1);
  });

  it.each<[RunnerOptions, string]>([
    [{ args: [...args, '--preflight'] }, 'Ambiente, projeto e configuração TLS'],
    [{ fileEnv: { ...fixtureEnv, SUPABASE_URL: `https://${productionRef}.supabase.co` } }, 'Ambiente, projeto e configuração TLS'],
    [{ processEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }, 'Ambiente, projeto e configuração TLS'],
    [{ connectError: true }, 'Conexão PostgreSQL com TLS'],
    [{ ready: false }, 'Identidade e esquema PostgreSQL'],
    [{ queryError: true }, 'Identidade e esquema PostgreSQL'],
    [{ probeDenied: true }, 'Leitura administrativa no Supabase Auth'],
    [{ malformedProbe: true }, 'Leitura administrativa no Supabase Auth'],
    [{ probeUrl: authUsers, probeMethod: 'POST' }, 'Leitura administrativa no Supabase Auth'],
    [{ endError: true }, 'Encerramento da conexão'],
  ])('fails closed without writes for %j', async (options, failedCheck) => {
    const seed = runner({ args, ...options });
    await seed.run();
    expect(seed.events.at(-1)).toBe('exit');
    expect(seed.events).not.toContain('auth:fetch');
    expect(seed.events.filter(event => ['file:read', 'auth:create', 'auth:update', 'db:seed'].includes(event))).toEqual([]);
    expect(seed.logs[0]).toBe('Pré-voo reprovado.');
    expect(seed.logs).toContain(`FALHOU — ${failedCheck}`);
    expect(seed.errors).toHaveLength(1);
    expect([...seed.logs, ...seed.errors].join(' ')).not.toMatch(/fixture-sensitive-credential|sb_secret_synthetic|fixture%40password/);
  });

  const sensitiveMessage = `Connection failed for ${dbUrl} with ${fixtureEnv.SUPABASE_SERVICE_ROLE_KEY}`;
  it.each([
    ['28P01', sensitiveMessage, 'Autenticação PostgreSQL (28P01)'],
    ['28000', sensitiveMessage, 'Autenticação PostgreSQL (28000)'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', sensitiveMessage, 'TLS ou certificado (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', sensitiveMessage, 'TLS ou certificado (ERR_TLS_CERT_ALTNAME_INVALID)'],
    ['ENOTFOUND', sensitiveMessage, 'DNS (ENOTFOUND)'],
    ['EAI_AGAIN', sensitiveMessage, 'DNS (EAI_AGAIN)'],
    ['ETIMEDOUT', sensitiveMessage, 'Timeout de conexão (ETIMEDOUT)'],
    ['ERR_TLS_HANDSHAKE_TIMEOUT', sensitiveMessage, 'Timeout de conexão (ERR_TLS_HANDSHAKE_TIMEOUT)'],
    ['ECONNRESET', sensitiveMessage, 'Conexão encerrada (ECONNRESET)'],
    ['ECONNREFUSED', sensitiveMessage, 'Conexão recusada (ECONNREFUSED)'],
    ['XX000', `(ENOTFOUND) tenant/user postgres.${testRef} not found`, 'Roteamento do pooler (XX000)'],
    [undefined, 'timeout expired', 'Timeout de conexão'],
    [undefined, 'Connection terminated unexpectedly', 'Conexão encerrada'],
    [undefined, 'The server does not support SSL connections', 'TLS ou certificado'],
    ['ERR_TLS_SECRET_TOKEN', sensitiveMessage, 'Falha de conexão PostgreSQL não classificada'],
    [fixtureEnv.SUPABASE_SERVICE_ROLE_KEY, sensitiveMessage, 'Falha de conexão PostgreSQL não classificada'],
  ])('reports a sanitized connection diagnosis %#', async (code, message, expected) => {
    const seed = runner({ args, connectionFailure: { code, message } });
    await seed.run();
    expect(seed.errors).toEqual([expected]);
    expect(seed.logs).toContain('FALHOU — Conexão PostgreSQL com TLS');
    expect(seed.events).toEqual(['env:read', 'db:config', 'db:connect', 'db:end', 'exit']);
    expect(seed.logs.join(' ')).not.toMatch(/fixture|sb_secret|supabase\.co/);
  });

  it('preserves the safe connection diagnosis when cleanup also fails', async () => {
    const seed = runner({ args, endError: true, connectionFailure: { code: '28P01', message: sensitiveMessage } });
    await seed.run();
    expect(seed.errors).toEqual(['Autenticação PostgreSQL (28P01)']);
    expect(seed.events).toEqual(['env:read', 'db:config', 'db:connect', 'db:end', 'exit']);
  });
});

describe('demo seed orchestration with isolated Auth and database mocks', () => {
  it('reads local SQL and verifies the schema before any Auth change', async () => {
    const seed = runner();
    await seed.run();
    expect(seed.events.indexOf('file:read')).toBeLessThan(seed.events.indexOf('db:connect'));
    expect(seed.events.indexOf('db:preflight')).toBeLessThan(seed.events.indexOf('auth:preflight'));
    expect(seed.events.indexOf('auth:preflight')).toBeLessThan(seed.events.indexOf('auth:create'));
    expect(seed.events.indexOf('db:seed')).toBeGreaterThan(seed.events.lastIndexOf('auth:create'));
    expect(seed.events.at(-1)).toBe('db:end');
    expect(seed.events).not.toContain('exit');
    expect(seed.passwords.get('professor@edukmais.edu.br')).toBe(fixtureEnv.DEMO_TEACHER_PASSWORD);
    expect(seed.passwords.get('aluno@edukmais.edu.br')).toBe(fixtureEnv.DEMO_STUDENT_PASSWORD);
    expect(seed.passwords.get('admin@uniconnect.app')).toBe(fixtureEnv.DEMO_UNIVERSITY_PASSWORD);
  });

  it.each<RunnerOptions>([
    { args: [] }, { args: ['--env-file', '.env'] },
    { fileEnv: { ...fixtureEnv, SUPABASE_URL: `https://${productionRef}.supabase.co` } },
    { fileEnv: { ...fixtureEnv, SUPABASE_DB_URL: dbUrl.replace(testRef, productionRef) } },
    { fileEnv: { ...fixtureEnv, SUPABASE_SERVICE_ROLE_KEY: undefined } },
    { processEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
  ])('rejects bad file selection or target before creating clients %#', async options => {
    const seed = runner(options);
    await seed.run();
    expect(seed.events.filter(event => event !== 'env:read')).toEqual(['exit']);
    expect(seed.errors).toHaveLength(1);
    if (options.args) expect(seed.events).not.toContain('env:read');
  });

  it('restricts Auth requests to the approved origin and disables redirects', async () => {
    const allowed = runner({ probeUrl: `${authUrl}/auth/v1/admin/users` });
    await allowed.run();
    expect(allowed.events).toContain('auth:fetch');
    expect(allowed.events).not.toContain('exit');

    const blocked = runner({ probeUrl: `https://${productionRef}.supabase.co/auth/v1/admin/users` });
    await blocked.run();
    expect(blocked.events).not.toContain('auth:fetch');
    expect(blocked.events).not.toContain('db:seed');
    expect(blocked.events.at(-1)).toBe('exit');
    expect(blocked.identities.size).toBe(0);
  });

  it.each<RunnerOptions>([{ probeDenied: true }, { malformedProbe: true }])('blocks writes after an unsuccessful Auth preflight %#', async options => {
    const seed = runner(options);
    await seed.run();
    expect(seed.events.slice(-3)).toEqual(['auth:preflight', 'db:end', 'exit']);
    expect(seed.identities.size).toBe(0);
    expect(seed.events).not.toContain('db:seed');
    expect(seed.errors.join(' ')).not.toContain('fixture-sensitive-credential');
  });

  it.each<RunnerOptions>([{ missingFile: true }, { connectError: true }, { ready: false }])('stops before Auth on local/schema preflight failure %j', async options => {
    const seed = runner(options);
    await seed.run();
    expect(seed.identities.size).toBe(0);
    expect(seed.events).not.toContain('auth:create');
    expect(seed.events).not.toContain('db:seed');
    expect(seed.events).toContain('exit');
  });

  it('reuses all 13 Auth identities on repeated preparation without changing their IDs', async () => {
    const seed = runner();
    await seed.run();
    const original = [...seed.identities.values()];
    await seed.run();
    expect([...seed.identities.values()]).toEqual(original);
    expect(seed.identities.size).toBe(13);
    expect(seed.events.filter(event => event === 'auth:create')).toHaveLength(13);
    expect(seed.events.filter(event => event === 'auth:update')).toHaveLength(13);
    expect(seed.events.filter(event => event === 'db:seed')).toHaveLength(2);
    expect(seed.events).not.toContain('exit');
  });

  it('stops after an Auth failure without submitting the SQL batch', async () => {
    const seed = runner({ authError: true });
    await seed.run();
    expect(seed.events).not.toContain('db:seed');
    expect(seed.events.slice(-2)).toEqual(['db:end', 'exit']);
  });

  it('documents the unavoidable Auth side effects when the later SQL batch fails', async () => {
    const seed = runner({ sqlError: true });
    await seed.run();
    expect(seed.identities.size).toBe(13);
    expect(seed.events.filter(event => event === 'db:seed')).toHaveLength(1);
    expect(seed.events.slice(-2)).toEqual(['db:end', 'exit']);
    expect(script).toMatch(/Auth.*(?:rollback|transa[cç][aã]o)/);
  });
});
