const projectRef = 'pvacwfypqsstdrfxajkg';
const authOrigin = `https://${projectRef}.supabase.co`;

const requiredEnv = [
  'UNICONNECT_ENVIRONMENT',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'DEMO_UNIVERSITY_PASSWORD',
  'DEMO_TEACHER_PASSWORD',
  'DEMO_STUDENT_PASSWORD',
] as const;

export class DemoSeedError extends Error {}

const connectionErrorCategories = new Map<string, string>([
  ['28P01', 'Autenticação PostgreSQL'],
  ['28000', 'Autenticação PostgreSQL'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS ou certificado'],
  ['CERT_HAS_EXPIRED', 'TLS ou certificado'],
  ['CERT_NOT_YET_VALID', 'TLS ou certificado'],
  ['CERT_REVOKED', 'TLS ou certificado'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS ou certificado'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS ou certificado'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS ou certificado'],
  ['UNABLE_TO_GET_ISSUER_CERT', 'TLS ou certificado'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS ou certificado'],
  ['ERR_OSSL_PEM_NO_START_LINE', 'TLS ou certificado'],
  ['ERR_SSL_WRONG_VERSION_NUMBER', 'TLS ou certificado'],
  ['ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'TLS ou certificado'],
  ['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'TLS ou certificado'],
  ['ENOTFOUND', 'DNS'],
  ['EAI_AGAIN', 'DNS'],
  ['ETIMEDOUT', 'Timeout de conexão'],
  ['ERR_SOCKET_CONNECTION_TIMEOUT', 'Timeout de conexão'],
  ['ERR_TLS_HANDSHAKE_TIMEOUT', 'Timeout de conexão'],
  ['ECONNRESET', 'Conexão encerrada'],
  ['EPIPE', 'Conexão encerrada'],
  ['ERR_SOCKET_CLOSED', 'Conexão encerrada'],
  ['ERR_SOCKET_CLOSED_BEFORE_CONNECTION', 'Conexão encerrada'],
  ['08003', 'Conexão encerrada'],
  ['57P01', 'Conexão encerrada'],
  ['ECONNREFUSED', 'Conexão recusada'],
  ['ENETUNREACH', 'Rede inacessível'],
  ['EHOSTUNREACH', 'Rede inacessível'],
]);

export function describeDemoSeedConnectionError(error: unknown): string {
  const details = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof details.code === 'string' ? details.code : undefined;
  const message = typeof details.message === 'string' ? details.message : '';

  // Supavisor can report a project-routing failure as ENOTFOUND in its message.
  if (/^(?:FATAL: )?(?:\(ENOTFOUND\) )?(?:tenant or user not found|tenant\/user [\w.%-]+ not found)$/i.test(message)) {
    return code === 'XX000' ? 'Roteamento do pooler (XX000)' : 'Roteamento do pooler';
  }

  // Never print an unrecognized code or any part of the original message.
  const category = code === undefined ? undefined : connectionErrorCategories.get(code);
  if (category !== undefined) return `${category} (${code})`;

  // node-postgres emits these errors without a code.
  switch (message) {
    case 'timeout expired':
      return 'Timeout de conexão';
    case 'Connection terminated':
    case 'Connection terminated unexpectedly':
      return 'Conexão encerrada';
    case 'The server does not support SSL connections':
    case 'There was an error establishing an SSL connection':
      return 'TLS ou certificado';
    default:
      return 'Falha de conexão PostgreSQL não classificada';
  }
}

export function validateDemoSeedEnvironment(env: Record<string, string | undefined>) {
  for (const key of requiredEnv) {
    if (!env[key]?.trim()) throw new DemoSeedError(`${key} ausente no arquivo de homologacao.`);
  }
  const values = env as typeof env & Record<(typeof requiredEnv)[number], string>;
  if (values.UNICONNECT_ENVIRONMENT !== 'homologation' || values.SUPABASE_PROJECT_REF !== projectRef) {
    throw new DemoSeedError('Seed permitido somente no projeto Supabase de homologacao autorizado.');
  }
  if (values.SUPABASE_URL !== authOrigin && values.SUPABASE_URL !== `${authOrigin}/`) {
    throw new DemoSeedError('SUPABASE_URL deve ser a origem HTTPS oficial do projeto de homologacao.');
  }
  validateAdminKey(values.SUPABASE_SERVICE_ROLE_KEY);

  if (env.SUPABASE_DB_SSL_MODE !== undefined && env.SUPABASE_DB_SSL_MODE !== 'verify-full') {
    throw new DemoSeedError('SUPABASE_DB_SSL_MODE deve ser verify-full.');
  }
  return {
    SUPABASE_URL: authOrigin,
    SUPABASE_SERVICE_ROLE_KEY: values.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: validateDatabaseUrl(values.SUPABASE_DB_URL),
    SUPABASE_DB_SSL_MODE: env.SUPABASE_DB_SSL_MODE,
    SUPABASE_DB_CA_FILE: env.SUPABASE_DB_CA_FILE,
    DEMO_UNIVERSITY_PASSWORD: values.DEMO_UNIVERSITY_PASSWORD,
    DEMO_TEACHER_PASSWORD: values.DEMO_TEACHER_PASSWORD,
    DEMO_STUDENT_PASSWORD: values.DEMO_STUDENT_PASSWORD,
  };
}

function validateAdminKey(key: string) {
  // An opaque secret is only proven by the project's authenticated Admin API.
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return;
  try {
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
      const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
      // The claims reject mismatches locally. The Admin API verifies the credential.
      if (claims?.role === 'service_role' && claims.ref === projectRef) return;
    }
  } catch {
    // Report only a fixed message, never key material or parser details.
  }
  throw new DemoSeedError('SUPABASE_SERVICE_ROLE_KEY deve ser uma credencial administrativa da homologacao.');
}

function validateDatabaseUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const direct = url.hostname === `db.${projectRef}.supabase.co` && user === 'postgres';
    const pooled = /^aws-\d+-[a-z0-9]+(?:-[a-z0-9]+)+\.pooler\.supabase\.com$/.test(url.hostname)
      && user === `postgres.${projectRef}`;
    const sslModes = url.searchParams.getAll('sslmode');
    if (['postgres:', 'postgresql:'].includes(url.protocol) && (direct || pooled)
      && ['', '5432', '6543'].includes(url.port) && url.pathname === '/postgres'
      && password.trim() && !password.includes('\0') && !url.hash
      && [...url.searchParams.keys()].every(key => key === 'sslmode')
      && sslModes.length <= 1 && sslModes.every(mode => ['require', 'verify-full'].includes(mode))) {
      // Pin even an omitted port so pg cannot fall back to an inherited PGPORT.
      url.port ||= '5432';
      return url.toString();
    }
  } catch {
    // URL parser errors may contain the database password.
  }
  throw new DemoSeedError('SUPABASE_DB_URL deve identificar o Postgres do projeto de homologacao sem opcoes de redirecionamento.');
}
