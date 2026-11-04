const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { isAllowedUrl, startGoTrueHarness } = require('./lib/gotrue-local.cjs');

const tenantSlug = 'uniconnect-local';
const teacherEmail = 'professor@uniconnect.invalid';
const studentEmail = 'aluno@uniconnect.invalid';
const unlinkedEmail = 'sem-vinculo@uniconnect.invalid';

function readPassword(signal) {
  // Windows PowerShell reads from the console. The password travels only through the private pipe.
  const command = `
    $ErrorActionPreference = 'Stop'
    $secret = Read-Host -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $bytes = $null
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
      [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    } finally {
      if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
      $secret.Dispose()
    }
  `;
  if (signal.aborted) return Promise.resolve(null);
  process.stderr.write('Senha sintética para professor e aluno (12 a 72 bytes, sem eco): ');

  return new Promise((resolve, reject) => {
    const reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
      stdio: ['inherit', 'pipe', 'ignore'],
      signal,
    });
    const chunks = [];
    reader.stdout.on('data', chunk => chunks.push(chunk));
    reader.stdout.once('error', reject);
    reader.once('error', reject);
    reader.once('close', code => {
      try {
        if (signal.aborted) resolve(null);
        else if (code !== 0) reject(new Error('Falha na leitura protegida da senha.'));
        else {
          const bytes = Buffer.concat(chunks);
          try { resolve(bytes.toString('utf8')); }
          finally { bytes.fill(0); }
        }
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
    });
  }).catch(error => {
    if (signal.aborted) return null;
    throw error;
  }).finally(() => {
    process.stderr.write('\n');
  });
}

async function createFixture(harness, password, signal) {
  const admin = harness.client(true).auth.admin;
  const members = [
    { email: teacherEmail, name: 'Professor Demo', role: 'teacher' },
    { email: studentEmail, name: 'Aluno Demo', role: 'student' },
  ];

  for (const member of members) {
    signal.throwIfAborted();
    const { data, error } = await admin.createUser({
      email: member.email, password, email_confirm: true,
    });
    if (error || !data.user?.id) throw new Error('Auth local não criou a conta.');
    member.authId = data.user.id;
  }
  signal.throwIfAborted();
  await harness.createAuth(unlinkedEmail);
  signal.throwIfAborted();

  const { db } = harness;
  await db.query('BEGIN');
  try {
    const { rows: [tenant] } = await db.query(
      "INSERT INTO public.tenants (name, slug, status) VALUES ('UniConnect Demo', $1, 'active') RETURNING id",
      [tenantSlug],
    );
    for (const member of members) {
      const { rows: [link] } = await db.query(
        'INSERT INTO public.app_users (tenant_id, auth_user_id, name, email, role, active) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [tenant.id, member.authId, member.name, member.email, member.role],
      );
      member.id = link.id;
    }

    const { rows: [course] } = await db.query(
      "INSERT INTO public.courses (tenant_id, name) VALUES ($1, 'Curso Demo') RETURNING id",
      [tenant.id],
    );
    const { rows: [period] } = await db.query(
      "INSERT INTO public.academic_periods (tenant_id, code, name, status) VALUES ($1, 'DEMO', 'Período Demo', 'active') RETURNING id",
      [tenant.id],
    );
    const { rows: [subject] } = await db.query(
      "INSERT INTO public.subjects (tenant_id, course_id, code, name) VALUES ($1, $2, 'DEMO-01', 'Disciplina Demo') RETURNING id",
      [tenant.id, course.id],
    );
    const { rows: [offering] } = await db.query(
      "INSERT INTO public.classes (tenant_id, course_id, subject_id, academic_period_id, name) VALUES ($1, $2, $3, $4, 'Oferta Demo') RETURNING id",
      [tenant.id, course.id, subject.id, period.id],
    );
    const [teacher, student] = members;
    await db.query(
      'INSERT INTO public.teaching_assignments (tenant_id, class_id, teacher_id) VALUES ($1, $2, $3)',
      [tenant.id, offering.id, teacher.id],
    );
    await db.query(
      'INSERT INTO public.enrollments (tenant_id, class_id, student_id) VALUES ($1, $2, $3)',
      [tenant.id, offering.id, student.id],
    );
    signal.throwIfAborted();
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function verifyUnlinkedAccount(harness, apiUrl, signal) {
  const { data, error } = await harness.client().auth.signInWithPassword({
    email: unlinkedEmail, password: harness.password,
  });
  if (error || !data.session?.access_token) throw new Error('Login GoTrue da conta sem vínculo falhou.');

  const response = await fetch(`${apiUrl}/tenants/${tenantSlug}/offerings`, {
    headers: {
      'x-tenant-slug': tenantSlug,
      Authorization: `Bearer ${data.session.access_token}`,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  const body = await response.json();
  if (response.status !== 403 || body?.error?.code !== 'USER_NOT_LINKED_TO_TENANT') {
    throw new Error('A API não confirmou a negativa esperada.');
  }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--allow-local-migrations'
      || process.versions.node.split('.')[0] !== '22') {
    console.error('Use Node.js 22 e execute: node scripts/demo-local.cjs --allow-local-migrations');
    process.exitCode = 1;
    return;
  }
  if (process.platform !== 'win32' || !process.stdin.isTTY) {
    console.error('Use um terminal interativo no Windows com Docker Desktop Linux.');
    process.exitCode = 1;
    return;
  }

  const overrides = /^(?:DOCKER_(?:HOST|CONTEXT|CONFIG|TLS_VERIFY|CERT_PATH)$|PG[A-Z_]+$|DATABASE_URL$|SUPABASE_|DOTENV_CONFIG_|NODE_(?:OPTIONS|USE_ENV_PROXY|DEBUG|DEBUG_NATIVE)$)/i;
  if (Object.keys(process.env).some(name => overrides.test(name))) {
    console.error('Use um terminal limpo, sem configuração de conexão ou de carregamento herdada.');
    process.exitCode = 1;
    return;
  }
  // Pin every Docker operation, including cleanup, to the local Linux engine.
  process.env.DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine';
  process.env.APP_ORIGIN = 'http://127.0.0.1';

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let harness;
  let phase = 'leitura da senha sintética';

  try {
    let password = await readPassword(shutdown.signal);
    if (password === null || shutdown.signal.aborted) return;
    if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      console.error('Informe uma senha sintética de 12 a 72 bytes.');
      process.exitCode = 1;
      return;
    }

    phase = 'inicialização do ambiente descartável';
    harness = await startGoTrueHarness({});
    shutdown.signal.throwIfAborted();
    const origins = new Set([harness.apiOrigin, harness.gateway]);
    if (!isAllowedUrl(harness.apiOrigin, origins) || !isAllowedUrl(harness.gateway, origins)) {
      throw new Error('Origem local inválida.');
    }
    const apiUrl = `${harness.apiOrigin}/api/v1`;

    phase = 'criação da fixture acadêmica';
    await createFixture(harness, password, shutdown.signal);
    password = undefined;
    phase = 'encerramento da conexão auxiliar';
    await harness.closeDatabase();
    shutdown.signal.throwIfAborted();
    phase = 'verificação da conta sem vínculo';
    await verifyUnlinkedAccount(harness, apiUrl, shutdown.signal);
    shutdown.signal.throwIfAborted();

    console.log(`API local: ${apiUrl}\nPorta: ${new URL(apiUrl).port}\nTenant slug: ${tenantSlug}`);
    console.log(`Professor: ${teacherEmail}\nAluno: ${studentEmail}`);
    console.log('Conta sem vínculo rejeitada (403). Use Ctrl+C para encerrar e descartar os dados.');
    await once(shutdown.signal, 'abort');
  } catch {
    if (!shutdown.signal.aborted) {
      console.error(`Falha na etapa de ${phase}. O ambiente da demo não está pronto.`);
      process.exitCode = 1;
    }
  } finally {
    if (harness) {
      try {
        await harness.close();
        console.log('Ambiente descartável encerrado.');
      } catch {
        console.error('Limpeza incompleta. Verifique os recursos da execução local.');
        process.exitCode = 1;
      }
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main();
