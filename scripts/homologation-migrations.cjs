const projectRef = 'pvacwfypqsstdrfxajkg';
const productionRef = 'kpwofazhpiqrxjvxkozl';
const privateFile = 'C:\\UniConnect\\Homologation\\private\\homologation-migrations.local.json';
const blockers = Object.freeze([
  'REMOTE_EXECUTION_DISABLED', 'EXECUTOR_IDENTITY_NOT_VERIFIED',
  'GLOBAL_LOCK_CONTRACT_UNRESOLVED', 'LEDGER_CONTRACT_UNRESOLVED',
  'CREDENTIAL_CHANNEL_NOT_IMPLEMENTED', 'REHEARSALS_NOT_RUN',
  'BACKUP_RECOVERY_NOT_VERIFIED', 'OPERATOR_AUTHORIZATION_NOT_RECORDED',
  'PRIVATE_STORAGE_NOT_QUALIFIED', 'SOURCE_PACKAGE_NOT_QUALIFIED',
]);
const knownErrors = new Set(['INVALID_ARGUMENTS', 'CONFIG_PATH_NOT_ALLOWED',
  'PRIVATE_STORAGE_NOT_QUALIFIED', 'INVALID_JSON', 'INVALID_CONFIG_CONTENT', 'AMBIGUOUS_JSON']);

function fail(code) { return Object.assign(new Error(code), { code }); }
function parseArgs(args) {
  let mode = null, config = null;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (['--offline', '--execute', '--help'].includes(value) && mode === null) mode = value.slice(2);
    else if (value === '--config' && config === null && typeof args[i + 1] === 'string' &&
      args[i + 1].length > 0 && !args[i + 1].startsWith('-')) config = args[++i];
    else throw fail('INVALID_ARGUMENTS');
  }
  if (mode === 'help' && config !== null) throw fail('INVALID_ARGUMENTS');
  return { mode: mode ?? 'offline', config };
}

function shape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validRole(value) {
  return typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value) &&
    !['unknown', 'pending', 'anon', 'authenticated', 'service_role', 'authenticator'].includes(value);
}
function inspectConfiguration(config, inheritedNames = []) {
  const issues = [];
  const executionBlockers = [...blockers];
  if (inheritedNames.some(name => /^(PG[A-Z0-9_]*|DATABASE_URL|SUPABASE_[A-Z0-9_]*|UNICONNECT_ENVIRONMENT|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(name))) {
    issues.push('INHERITED_CONFIGURATION');
  }
  if (!shape(config, ['version', 'environment', 'projectRef', 'connection', 'evidenceReferences']) ||
    !shape(config.connection, ['channel', 'host', 'port', 'database', 'tlsMode', 'login', 'expectedSessionUser', 'expectedCurrentUser']) ||
    !shape(config.evidenceReferences, ['Q06', 'Q07', 'Q08', 'Q12'])) {
    issues.push('INVALID_CONFIGURATION_SHAPE');
  } else {
    if (JSON.stringify(config).toLowerCase().includes(productionRef)) issues.push('PRODUCTION_FORBIDDEN');
    if (config.version !== 1) issues.push('INVALID_CONFIG_VERSION');
    if (config.environment !== 'homologation') issues.push('INVALID_ENVIRONMENT');
    if (config.projectRef !== projectRef) issues.push('INVALID_PROJECT');
    const connection = config.connection;
    if (!['direct', 'session-pooler'].includes(connection.channel)) issues.push('INVALID_CHANNEL');
    const direct = connection.channel === 'direct' && connection.host === `db.${projectRef}.supabase.co`;
    const pooled = connection.channel === 'session-pooler' && typeof connection.host === 'string' &&
      /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(connection.host);
    if (!direct && !pooled) issues.push('INVALID_ENDPOINT');
    if (connection.port !== 5432 || connection.database !== 'postgres') issues.push('INVALID_DATABASE_TARGET');
    if (connection.tlsMode !== 'verify-full') issues.push('TLS_VERIFICATION_REQUIRED');
    if (!validRole(connection.expectedSessionUser) || !validRole(connection.expectedCurrentUser)) {
      issues.push('EXECUTOR_IDENTITY_INCOMPLETE');
    }
    if (connection.expectedCurrentUser !== connection.expectedSessionUser) issues.push('ROLE_SWITCH_UNSUPPORTED');
    const expectedLogin = connection.channel === 'session-pooler'
      ? `${connection.expectedSessionUser}.${projectRef}` : connection.expectedSessionUser;
    if (typeof connection.login !== 'string' || !connection.login || connection.login !== expectedLogin ||
      (connection.channel === 'direct' && !validRole(connection.login))) issues.push('LOGIN_IDENTITY_MISMATCH');
    if (connection.channel === 'session-pooler') executionBlockers.push('SESSION_POOLER_NOT_VALIDATED');
    if (Object.values(config.evidenceReferences).some(value => typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) issues.push('EVIDENCE_REFERENCES_INCOMPLETE');
  }
  return { configurationValid: issues.length === 0, issues: [...new Set(issues)],
    identityVerified: false, projectIdentityVerified: false,
    remoteExecutionAvailable: false, executionBlockers };
}

function compactJson(text) {
  let result = '', quoted = false, escaped = false;
  for (const char of text) {
    if (quoted || !/\s/.test(char)) result += char;
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return result;
}
function readConfiguration(selectedFile = null) {
  if (selectedFile !== null && selectedFile !== privateFile) throw fail('CONFIG_PATH_NOT_ALLOWED');
  throw fail('PRIVATE_STORAGE_NOT_QUALIFIED');
}
function parseConfigurationText(input) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw fail('INVALID_CONFIG_CONTENT');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length > 65536) throw fail('INVALID_CONFIG_CONTENT');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw fail('INVALID_JSON'); }
  let config;
  try { config = JSON.parse(text); }
  catch { throw fail('INVALID_JSON'); }
  if (compactJson(text) !== JSON.stringify(config)) throw fail('AMBIGUOUS_JSON');
  return config;
}

function baseReport() {
  return { mode: 'offline', readiness: 'NO_GO', rehearsals: 'NOT_RUN',
    connectionAttempted: false, migrationInvoked: false, remoteExecutionAvailable: false,
    storageQualified: false, sourceVerification: 'NOT_PERFORMED_UNQUALIFIED_STORAGE',
    identityVerified: false, projectIdentityVerified: false, executionBlockers: [...blockers] };
}
function main(args = process.argv.slice(2), write = line => process.stdout.write(line)) {
  let report;
  try {
    const options = parseArgs(args);
    if (options.mode === 'execute') {
      report = { ...baseReport(), status: 'EXECUTION_DISABLED' };
    } else if (options.mode === 'help') {
      report = { ...baseReport(), status: 'HELP', usage: [
        'node scripts/homologation-migrations.cjs [--offline] [--config <isolated-json>]',
        '--execute is permanently blocked in this implementation',
      ] };
    } else {
      readConfiguration(options.config);
      throw fail('PRIVATE_STORAGE_NOT_QUALIFIED');
    }
  } catch (error) {
    report = { ...baseReport(), status: 'BLOCKED_CONFIGURATION',
      code: knownErrors.has(error?.code) ? error.code :
        knownErrors.has(error?.message) ? error.message : 'OFFLINE_INSPECTION_FAILED' };
  }
  write(`${JSON.stringify(report)}\n`);
  return report.status === 'HELP' ? 0 : 2;
}

module.exports = { parseArgs, inspectConfiguration, parseConfigurationText, readConfiguration, main };
if (require.main === module) process.exitCode = main();
