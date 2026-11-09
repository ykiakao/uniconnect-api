const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parse } = require('dotenv');

const projectRef = 'pvacwfypqsstdrfxajkg';
const mainRef = 'kpwofazhpiqrxjvxkozl';
const identityKeys = ['UNICONNECT_ENVIRONMENT', 'SUPABASE_PROJECT_REF'];
const apiKeys = [...identityKeys, 'NODE_ENV', 'HOST', 'PORT', 'API_VERSION', 'APP_ORIGIN', 'ACADEMIC_PROVIDER',
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PLATFORM_ADMIN_AUTH_USER_IDS',
  'AUTH_RECOVERY_REDIRECT_URL', 'AUTH_INVITE_REDIRECT_URL'];
const dbKeys = [...identityKeys, 'SUPABASE_DB_URL', 'SUPABASE_DB_SSL_MODE', 'SUPABASE_DB_CA_FILE'];
const order = ['schema.sql', '20260528000001_academic_base.sql', '20260528000002_activities_grades_reports.sql',
  '20260528000003_invites.sql', '20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql',
  '20261026000003_institutional_management.sql', '20261026000004_activity_workflow.sql',
  '20261026000005_academic_communication.sql', '20261031000006_platform_institutions.sql',
  '20261101000007_accounts_and_responsibility.sql'];
const isLoopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

function safeRedirect(value, environment) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !/\w+:\/\/[^/]*@/.test(value) && !value.includes('?') && !value.includes('#') &&
      (url.protocol === 'https:' || (environment !== 'production' && url.protocol === 'http:' && isLoopback(url.hostname)));
  } catch { return false; }
}
function inspectConfiguration(values, { profile = 'api', template = false, inherited = {} } = {}) {
  const issues = [], missing = [];
  const allowed = profile === 'api' ? apiKeys : dbKeys;
  const protectedKeys = [...new Set([...apiKeys, ...dbKeys])];
  if (!['api', 'migrations'].includes(profile)) issues.push('INVALID_PROFILE');
  if (Object.keys(values).some(key => !allowed.includes(key))) issues.push('UNEXPECTED_CONFIGURATION');
  if (Object.values(values).some(value => String(value).includes(mainRef))) issues.push('MAIN_PROJECT_FORBIDDEN');
  if (protectedKeys.some(key => inherited[key] !== undefined && inherited[key] !== '')) issues.push('INHERITED_CONFIGURATION');
  if (values.UNICONNECT_ENVIRONMENT !== 'homologation' || values.SUPABASE_PROJECT_REF !== projectRef) issues.push('INVALID_ENVIRONMENT_MARKER');
  if (profile === 'api') {
    try {
      const url = new URL(values.SUPABASE_URL);
      if (url.origin !== `https://${projectRef}.supabase.co` || url.pathname !== '/' || url.username || url.password ||
        String(values.SUPABASE_URL).includes('?') || String(values.SUPABASE_URL).includes('#')) issues.push('INVALID_API_TARGET');
    } catch { issues.push('INVALID_API_TARGET'); }
    if (!['development', 'production'].includes(values.NODE_ENV)) issues.push('INVALID_NODE_ENV');
    if (values.HOST !== '127.0.0.1' || values.PORT !== '3334' || values.API_VERSION !== 'v1') issues.push('INVALID_LOCAL_BINDING');
    if (values.ACADEMIC_PROVIDER !== 'disabled') issues.push('PROVIDER_NOT_DISABLED');
    try {
      const origins = values.APP_ORIGIN.split(',');
      if (!origins.length || origins.some(origin => {
        const url = new URL(origin.trim());
        return url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
          !(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)));
      })) issues.push('INVALID_ORIGIN');
    } catch { issues.push('INVALID_ORIGIN'); }
    for (const key of ['AUTH_RECOVERY_REDIRECT_URL', 'AUTH_INVITE_REDIRECT_URL']) {
      if (Object.hasOwn(values, key) && !safeRedirect(values[key], values.NODE_ENV)) issues.push('INVALID_REDIRECT');
    }
    const ids = String(values.PLATFORM_ADMIN_AUTH_USER_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
    if (ids.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) issues.push('INVALID_ALLOWLIST');
    for (const [key, role, prefix] of [['SUPABASE_ANON_KEY', 'anon', 'sb_publishable_'], ['SUPABASE_SERVICE_ROLE_KEY', 'service_role', 'sb_secret_']]) {
      const value = values[key];
      if (!value) { missing.push(key); continue; }
      if (value.startsWith('eyJ')) {
        try {
          const parts = value.split('.');
          if (parts.length !== 3) throw new Error('Invalid key.');
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (payload.ref !== projectRef) issues.push('KEY_PROJECT_MISMATCH');
          if (payload.role !== role) issues.push('KEY_ROLE_MISMATCH');
        } catch { issues.push('INVALID_KEY_FORMAT'); }
      } else if (!value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length)) || value.length < prefix.length + 10) issues.push('INVALID_KEY_FORMAT');
    }
  } else if (profile === 'migrations') {
    if (values.SUPABASE_DB_SSL_MODE !== 'verify-full') issues.push('TLS_VERIFICATION_REQUIRED');
    if (!values.SUPABASE_DB_URL) missing.push('SUPABASE_DB_URL');
    else {
      try {
        const url = new URL(values.SUPABASE_DB_URL);
        const direct = url.hostname === `db.${projectRef}.supabase.co`;
        const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && decodeURIComponent(url.username).endsWith(`.${projectRef}`);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(direct || pooled) || (url.port && url.port !== '5432') ||
          url.pathname !== '/postgres' || !url.username || !url.password || url.hash ||
          [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'verify-full')) issues.push('INVALID_DATABASE_TARGET');
      } catch { issues.push('INVALID_DATABASE_TARGET'); }
    }
  }
  return { profile, projectRef, template, configurationComplete: issues.length === 0 && missing.length === 0,
    issues: [...new Set(issues)], missing, credentialOwnership: 'NOT_VERIFIED_OFFLINE', remoteAccessAuthorized: false, dotenvLoadedIntoProcess: false };
}
function parseArgs(args) {
  let template = false, profile = 'api';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--template' && !template) template = true;
    else if (args[i] === '--profile' && ['api', 'migrations'].includes(args[i + 1])) profile = args[++i];
    else throw new Error('INVALID_ARGUMENTS');
  }
  return { template, profile };
}
function verifyMigrations(root) {
  const manifest = require(path.join(root, 'scripts/lib/migration-manifest.cjs'));
  if (Object.keys(manifest).length !== order.length || order.some(name => !Object.hasOwn(manifest, name))) throw new Error('MIGRATION_MANIFEST_INVALID');
  for (const name of order) {
    const file = path.join(root, 'supabase', name === 'schema.sql' ? name : `migrations/${name}`);
    const hash = createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    if (hash !== manifest[name]) throw new Error('MIGRATION_HASH_MISMATCH');
  }
  return { verified: true, count: order.length, order: [...order], remoteSchemaVerified: false, executorInvoked: false };
}
function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args), root = path.resolve(__dirname, '..');
    const name = `.env.homologation${options.profile === 'migrations' ? '-migrations' : ''}${options.template ? '.example' : ''}`;
    const file = path.join(root, name);
    if (!fs.existsSync(file)) throw new Error('ISOLATED_CONFIG_MISSING');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('UNSAFE_CONFIG_FILE');
    const result = inspectConfiguration(parse(fs.readFileSync(file)), { ...options, inherited: process.env });
    const migrations = verifyMigrations(root);
    const passed = result.issues.length === 0 && (options.template || result.configurationComplete);
    process.stdout.write(JSON.stringify({ status: passed ? (options.template ? 'TEMPLATE_PREPARED_NOT_CONNECTED' : 'OFFLINE_CONFIG_CHECKS_PASSED') : 'BLOCKED_CONFIGURATION', ...result, migrations }) + '\n');
    if (!passed) process.exitCode = 2;
  } catch (error) {
    const known = ['INVALID_ARGUMENTS', 'ISOLATED_CONFIG_MISSING', 'UNSAFE_CONFIG_FILE', 'MIGRATION_MANIFEST_INVALID', 'MIGRATION_HASH_MISMATCH'];
    process.stdout.write(JSON.stringify({ status: 'BLOCKED_CONFIGURATION', code: known.includes(error.message) ? error.message : 'LOCAL_PREFLIGHT_FAILED', remoteAccessAuthorized: false }) + '\n');
    process.exitCode = 2;
  }
}
module.exports = { inspectConfiguration, parseArgs, verifyMigrations };
if (require.main === module) main();
