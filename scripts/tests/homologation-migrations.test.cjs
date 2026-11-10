const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const networkCalls = [];
function denyNetwork() { networkCalls.push('forbidden'); throw new Error('NETWORK_FORBIDDEN'); }
for (const [moduleName, methods] of [
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:dns', ['lookup', 'resolve']], ['node:http', ['request', 'get']],
  ['node:https', ['request', 'get']],
]) {
  for (const method of methods) mock.method(require(moduleName), method, denyNetwork);
}
mock.method(require('node:net').Socket.prototype, 'connect', denyNetwork);
mock.method(globalThis, 'fetch', denyNetwork);
const clientConstructor = mock.method(require('pg'), 'Client', function () {
  throw new Error('CLIENT_CONSTRUCTION_FORBIDDEN');
});
const migration = mock.method(require('../lib/migration-executor.cjs'), 'applyGuardedMigration', function () {
  throw new Error('SQL_FORBIDDEN');
});
const invoker = require('../homologation-migrations.cjs');

const project = 'pvacwfypqsstdrfxajkg';
const production = 'kpwofazhpiqrxjvxkozl';
function configuration() {
  return {
    version: 1, environment: 'homologation', projectRef: project,
    connection: { channel: 'direct', host: `db.${project}.supabase.co`, port: 5432,
      database: 'postgres', tlsMode: 'verify-full', login: 'synthetic_operator',
      expectedSessionUser: 'synthetic_operator', expectedCurrentUser: 'synthetic_operator' },
    evidenceReferences: { Q06: 'synthetic-q06', Q07: 'synthetic-q07', Q08: 'synthetic-q08', Q12: 'synthetic-q12' },
  };
}
function inspect(config, inheritedNames = []) { return invoker.inspectConfiguration(config, inheritedNames); }
after(() => {
  assert.equal(clientConstructor.mock.callCount(), 0, 'no pg.Client may be constructed');
  assert.equal(migration.mock.callCount(), 0, 'no helper SQL may run');
  assert.deepEqual(networkCalls, []);
  mock.restoreAll();
});

test('default arguments and --offline select offline without a config fallback', () => {
  assert.deepEqual(invoker.parseArgs([]), { mode: 'offline', config: null });
  assert.deepEqual(invoker.parseArgs(['--offline']), { mode: 'offline', config: null });
});
test('explicit config and help are parsed without opening files', () => {
  assert.deepEqual(invoker.parseArgs(['--config', 'homologation-migrations.local.json', '--offline']),
    { mode: 'offline', config: 'homologation-migrations.local.json' });
  assert.equal(invoker.parseArgs(['--help']).mode, 'help');
});
for (const args of [['--force'], ['--approved'], ['--apply'], ['--offline', '--offline'],
  ['--offline', '--execute'], ['--config'], ['--config', '--execute'],
  ['--config', 'a', '--config', 'b'], ['--help', '--execute']]) {
  test(`rejects ambiguous or unsupported argument structure ${JSON.stringify(args)}`, () => {
    assert.throws(() => invoker.parseArgs(args), { code: 'INVALID_ARGUMENTS' });
  });
}
test('valid declarations stay unverified and cannot authorize remote execution', () => {
  const result = inspect(configuration());
  assert.equal(result.configurationValid, true);
  assert.equal(result.identityVerified, false);
  assert.equal(result.projectIdentityVerified, false);
  assert.equal(result.remoteExecutionAvailable, false);
});
for (const key of ['login', 'expectedSessionUser', 'expectedCurrentUser']) {
  test(`rejects missing or unknown executor identity ${key}`, () => {
    for (const value of [null, '', 'unknown', 'pending', 'PRIVATE_ROLE;SET ROLE postgres']) {
      const data = configuration(); data.connection[key] = value;
      assert.equal(inspect(data).configurationValid, false);
    }
  });
}
test('does not infer executor from event owners or accept role switching', () => {
  const data = configuration(); data.connection.expectedCurrentUser = 'postgres';
  assert.ok(inspect(data).issues.includes('ROLE_SWITCH_UNSUPPORTED'));
  data.connection.eventOwner = 'postgres';
  assert.ok(inspect(data).issues.includes('INVALID_CONFIGURATION_SHAPE'));
});
test('requires explicit environment and project markers', () => {
  const data = configuration(); data.environment = 'production';
  assert.ok(inspect(data).issues.includes('INVALID_ENVIRONMENT'));
  data.environment = 'homologation'; data.projectRef = 'other';
  assert.ok(inspect(data).issues.includes('INVALID_PROJECT'));
});
test('rejects unsupported configuration versions instead of guessing a migration format', () => {
  const data = configuration(); data.version = 2;
  assert.ok(inspect(data).issues.includes('INVALID_CONFIG_VERSION'));
});
for (const location of ['projectRef', 'host', 'reference']) {
  test(`rejects known production project in ${location}`, () => {
    const data = configuration();
    if (location === 'projectRef') data.projectRef = production;
    if (location === 'host') data.connection.host = `db.${production}.supabase.co`;
    if (location === 'reference') data.evidenceReferences.Q06 = production;
    const result = inspect(data);
    assert.ok(result.issues.includes('PRODUCTION_FORBIDDEN'));
    assert.equal(JSON.stringify(result).includes(production), false);
  });
}
for (const change of [{ channel: null }, { host: 'other.example' }, { host: '127.0.0.1' },
  { host: `DB.${project}.supabase.co` }, { port: 6543 }, { port: '5432' },
  { database: 'other' }, { tlsMode: 'disable' }, { tlsMode: 'require' }]) {
  test(`rejects unsupported channel/endpoint/TLS structure ${JSON.stringify(change)}`, () => {
    const data = configuration(); Object.assign(data.connection, change);
    assert.equal(inspect(data).configurationValid, false);
  });
}
test('supports only explicit session-pooler declarations and never validates them remotely', () => {
  const data = configuration();
  Object.assign(data.connection, { channel: 'session-pooler', host: 'aws-0-synthetic.pooler.supabase.com',
    login: `synthetic_operator.${project}` });
  const result = inspect(data);
  assert.equal(result.configurationValid, true);
  assert.equal(result.remoteExecutionAvailable, false);
  assert.ok(result.executionBlockers.includes('SESSION_POOLER_NOT_VALIDATED'));
  data.connection.login = 'synthetic_operator';
  assert.equal(inspect(data).configurationValid, false);
});
test('does not silently choose the pooler or direct channel', () => {
  const data = configuration(); data.connection.host = 'aws-0-synthetic.pooler.supabase.com';
  assert.equal(inspect(data).configurationValid, false);
  data.connection.channel = 'session-pooler'; data.connection.host = `db.${project}.supabase.co`;
  assert.equal(inspect(data).configurationValid, false);
});
for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PGUSER', 'PGOPTIONS', 'PGSERVICE', 'PGHOST', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
  test(`rejects inherited database/API configuration name ${name}`, () => {
    assert.ok(inspect(configuration(), [name]).issues.includes('INHERITED_CONFIGURATION'));
  });
}
test('rejects secrets, arbitrary fields and forged approval objects without echoing them', () => {
  for (const extra of [{ password: 'SYNTHETIC_PRIVATE' }, { dsn: 'SYNTHETIC_PRIVATE' },
    { approved: true }, { locksApproved: true }, { executionEnabled: true }]) {
    const result = inspect({ ...configuration(), ...extra });
    assert.equal(result.configurationValid, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(result.remoteExecutionAvailable, false);
  }
});
test('evidence references are required declarations, not approval switches', () => {
  const data = configuration(); data.evidenceReferences.Q08 = null;
  assert.ok(inspect(data).issues.includes('EVIDENCE_REFERENCES_INCOMPLETE'));
  data.evidenceReferences.Q08 = 'https://private.example/token';
  assert.equal(inspect(data).configurationValid, false);
});
test('rejects invalid shapes and primitive values', () => {
  for (const value of [null, [], 'PRIVATE', 1, {}, { ...configuration(), connection: null }]) {
    assert.equal(inspect(value).configurationValid, false);
  }
});

test('validates explicitly supplied JSON in memory without file access', () => {
  assert.deepEqual(invoker.parseConfigurationText(JSON.stringify(configuration())), configuration());
  assert.deepEqual(invoker.parseConfigurationText(Buffer.from(JSON.stringify(configuration()))), configuration());
});
test('rejects malformed, duplicate, oversized or invalid UTF-8 content in memory', () => {
  for (const input of ['{"private":"SYNTHETIC_PRIVATE"', '{"version":1,"version":2}',
    ' '.repeat(65537), Buffer.from([0xff]), null]) {
    assert.throws(() => invoker.parseConfigurationText(input), error => {
      assert.equal(error.message.includes('SYNTHETIC_PRIVATE'), false);
      return ['INVALID_JSON', 'AMBIGUOUS_JSON', 'INVALID_CONFIG_CONTENT'].includes(error.code);
    });
  }
});
const fixedFile = 'C:\\UniConnect\\Homologation\\private\\homologation-migrations.local.json';
const forbiddenPaths = [
  '\\\\synthetic.invalid\\share\\homologation-migrations.local.json',
  '//synthetic.invalid/share/homologation-migrations.local.json',
  '\\\\?\\UNC\\synthetic.invalid\\share\\homologation-migrations.local.json',
  '\\\\?\\C:\\UniConnect\\Homologation\\private\\homologation-migrations.local.json',
  '\\\\.\\pipe\\homologation-migrations.local.json',
  '\\??\\C:\\UniConnect\\Homologation\\private\\homologation-migrations.local.json',
  'Z:\\homologation-migrations.local.json', 'C:homologation-migrations.local.json',
  '\\homologation-migrations.local.json', '../homologation-migrations.local.json',
  'homologation-migrations.local.json', '/tmp/homologation-migrations.local.json',
  'file://synthetic.invalid/share/homologation-migrations.local.json', '.env',
  fixedFile + ':alternate-stream', fixedFile.toLowerCase(), fixedFile + '.',
];
function noFileAccess(callback) {
  let attempted = 0;
  const deniedFile = () => { attempted++; throw new Error('FILE_ACCESS_FORBIDDEN'); };
  const changes = [];
  for (const method of ['realpath', 'realpathSync']) {
    if (typeof fs[method].native === 'function') changes.push(mock.method(fs[method], 'native', deniedFile));
  }
  for (const name of ['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readSync', 'fstatSync', 'readFileSync',
    'lstat', 'stat', 'realpath', 'open', 'read', 'fstat', 'readFile']) changes.push(mock.method(fs, name, deniedFile));
  for (const name of ['lstat', 'stat', 'realpath', 'open', 'readFile']) changes.push(mock.method(fs.promises, name, deniedFile));
  try { callback(); assert.equal(attempted, 0); }
  finally { for (const change of changes.reverse()) change.mock.restore(); }
}
for (const [index, file] of forbiddenPaths.entries()) {
  test('rejects unqualified path variant ' + index + ' before filesystem access', () => {
    noFileAccess(() => assert.throws(() => invoker.readConfiguration(file), { code: 'CONFIG_PATH_NOT_ALLOWED' }));
  });
}
for (const scenario of ['fixed storage unknown', 'mapped drive', 'symlink', 'junction', 'other reparse point']) {
  test('does not probe storage even for scenario: ' + scenario, () => {
    noFileAccess(() => assert.throws(() => invoker.readConfiguration(fixedFile), { code: 'PRIVATE_STORAGE_NOT_QUALIFIED' }));
  });
}
test('default config remains blocked without stat, realpath or other file probes', () => {
  noFileAccess(() => assert.throws(() => invoker.readConfiguration(), { code: 'PRIVATE_STORAGE_NOT_QUALIFIED' }));
});
test('execute stays blocked even for malicious, unknown or fixed configuration paths', () => {
  noFileAccess(() => {
    for (const file of [fixedFile, ...forbiddenPaths]) {
      let output = '';
      assert.equal(invoker.main(['--execute', '--config', file], line => { output += line; }), 2);
      const report = JSON.parse(output);
      assert.equal(report.status, 'EXECUTION_DISABLED');
      assert.equal(report.connectionAttempted, false);
      assert.equal(report.migrationInvoked, false);
    }
  });
});
test('offline mode makes no filesystem calls and does not claim SQL package verification', () => {
  noFileAccess(() => {
    let output = '';
    assert.equal(invoker.main([], line => { output += line; }), 2);
    const report = JSON.parse(output);
    assert.equal(report.code, 'PRIVATE_STORAGE_NOT_QUALIFIED');
    assert.equal(report.storageQualified, false);
    assert.equal(report.sourceVerification, 'NOT_PERFORMED_UNQUALIFIED_STORAGE');
    assert.equal(report.remoteExecutionAvailable, false);
    assert.equal(report.readiness, 'NO_GO');
    assert.equal(report.rehearsals, 'NOT_RUN');
  });
});
test('path, argument and parsing errors do not expose sensitive input', () => {
  for (const args of [['--SYNTHETIC_PRIVATE'], ['--config', '\\\\SYNTHETIC_PRIVATE\\share\\homologation-migrations.local.json']]) {
    let output = '';
    assert.equal(invoker.main(args, line => { output += line; }), 2);
    assert.equal(output.includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(JSON.parse(output).connectionAttempted, false);
  }
});
function cleanEnv() {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
const sentinelFile = path.join(__dirname, 'network-api-sentinels.cjs');
const guardFile = path.join(__dirname, 'deny-migration-network.cjs');
function child(args) {
  return spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '../..'),
    env: cleanEnv(), encoding: 'utf8', timeout: 10000 });
}
test('guard installs on the real Node modules without depending on sentinels', () => {
  const result = child(['--require', guardFile, path.join(__dirname, '../homologation-migrations.cjs'), '--help']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).connectionAttempted, false);
});
for (const args of [[], ['--offline'], ['--execute'], ['--help'], ['--offline', '--config', fixedFile]]) {
  test('real CLI process remains blocked/offline: ' + JSON.stringify(args), () => {
    const result = child(['--require', sentinelFile, '--require', guardFile,
      path.join(__dirname, '../homologation-migrations.cjs'), ...args]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, args.includes('--help') ? 0 : 2);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.connectionAttempted, false);
    assert.equal(report.migrationInvoked, false);
    assert.equal(report.remoteExecutionAvailable, false);
    assert.equal(report.readiness, 'NO_GO');
  });
}
const probes = [
  ['net connect', "require('node:net').connect(1, 'synthetic.invalid')"],
  ['net socket prototype', "require('node:net').Socket.prototype.connect.call({}, 1, 'synthetic.invalid')"],
  ['server listen', "require('node:net').Server.prototype.listen.call({}, 1)"],
  ['TLS', "require('node:tls').connect(1, 'synthetic.invalid')"],
  ['DNS callback lookup', "require('node:dns').lookup('synthetic.invalid', () => {})"],
  ['DNS callback resolve', "require('node:dns').resolve4('synthetic.invalid', () => {})"],
  ['DNS callback reverse', "require('node:dns').reverse('192.0.2.1', () => {})"],
  ['DNS promise lookup', "require('node:dns/promises').lookup('synthetic.invalid')"],
  ['DNS promise resolve', "require('node:dns/promises').resolve4('synthetic.invalid')"],
  ['DNS promise reverse', "require('node:dns/promises').reverse('192.0.2.1')"],
  ['DNS resolver constructor', "new (require('node:dns').Resolver)()"],
  ['DNS resolver prototype', "require('node:dns').Resolver.prototype.resolve4.call({}, 'synthetic.invalid')"],
  ['DNS promise resolver', "new (require('node:dns/promises').Resolver)()"],
  ['DNS promise resolver prototype', "require('node:dns/promises').Resolver.prototype.resolve4.call({}, 'synthetic.invalid')"],
  ['HTTP', "require('node:http').request('http://synthetic.invalid')"],
  ['HTTPS', "require('node:https').get('https://synthetic.invalid')"],
  ['HTTP2', "require('node:http2').connect('https://synthetic.invalid')"],
  ['UDP create', "require('node:dgram').createSocket('udp4')"],
  ['UDP send prototype', "require('node:dgram').Socket.prototype.send.call({}, Buffer.from('synthetic'), 1, '192.0.2.1')"],
  ['fetch', "fetch('https://synthetic.invalid')"],
  ['spawn', "require('node:child_process').spawn('synthetic-command')"],
  ['spawnSync', "require('node:child_process').spawnSync('synthetic-command')"],
  ['exec', "require('node:child_process').exec('synthetic-command')"],
  ['execSync', "require('node:child_process').execSync('synthetic-command')"],
  ['execFile', "require('node:child_process').execFile('synthetic-command')"],
  ['execFileSync', "require('node:child_process').execFileSync('synthetic-command')"],
  ['fork', "require('node:child_process').fork('synthetic-command')"],
  ['child prototype spawn', "require('node:child_process').ChildProcess.prototype.spawn.call({}, {})"],
  ['Worker', "new (require('node:worker_threads').Worker)('synthetic-command')"],
  ['Worker prototype constructor', "new (require('node:worker_threads').Worker.prototype.constructor)('synthetic-command')"],
  ['PostgreSQL client', "new (require('pg').Client)()"],
  ['migration helper', "require('./scripts/lib/migration-executor.cjs').applyGuardedMigration()"],
];
if (typeof globalThis.WebSocket === 'function') probes.push(['WebSocket', "new WebSocket('wss://synthetic.invalid')"]);
if (typeof require('node:dns').resolveTlsa === 'function') probes.push(['DNS resolveTlsa', "require('node:dns').resolveTlsa('synthetic.invalid', () => {})"]);
for (const [name, expression] of probes) {
  test('negative control intercepts ' + name + ' with code 99 before native sentinel', () => {
    const result = child(['--require', sentinelFile, '--require', guardFile, '--eval',
      'try { ' + expression + '; } catch {}']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 99, result.stderr);
    assert.equal(result.stderr, 'OFFLINE_BOUNDARY_VIOLATION\n');
  });
}
for (const [name, expression] of [['DNS', probes[4][1]], ['spawn', probes[20][1]]]) {
  test('native sentinel remains safe when guard is absent: ' + name, () => {
    const result = child(['--require', sentinelFile, '--eval', 'try { ' + expression + '; } catch {}']);
    assert.equal(result.status, 98);
    assert.equal(result.stderr, 'NATIVE_API_SENTINEL_REACHED\n');
  });
}
for (const moduleName of ['node:dns/promises', 'node:child_process', 'node:worker_threads']) {
  test('ESM builtin bindings are also instrumented: ' + moduleName, () => {
    const expression = moduleName === 'node:dns/promises' ? "api.lookup('synthetic.invalid')" :
      moduleName === 'node:child_process' ? "api.spawn('synthetic-command')" : "new api.Worker('synthetic-command')";
    const result = child(['--require', sentinelFile, '--require', guardFile, '--input-type=module', '--eval',
      "import * as api from '" + moduleName + "'; try { " + expression + "; } catch {}"]);
    assert.equal(result.status, 99, result.stderr);
    assert.equal(result.stderr, 'OFFLINE_BOUNDARY_VIOLATION\n');
  });
}
