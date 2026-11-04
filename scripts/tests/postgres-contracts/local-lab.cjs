'use strict';
// Offline supervisor. No fs, process execution, Docker SDK, environment or transport imports.
const { createHash } = require('node:crypto');
const STATUS = Object.freeze({ readiness: 'NO_GO', originalCases: 'NOT_RUN', integratedCases: 'NOT_RUN',
  executionEnabled: false, windowsIsolationVerified: false });
const BLOCKERS = Object.freeze(['EXECUTION_NOT_AUTHORIZED', 'WINDOWS_ISOLATION_NOT_QUALIFIED',
  'DAEMON_NOT_QUALIFIED', 'PG17_IMAGE_NOT_QUALIFIED', 'CREDENTIAL_DELIVERY_NOT_IMPLEMENTED',
  'CONTRACTS_NOT_APPROVED', 'LIVE_DRIVER_NOT_RELEASED', 'EVENT_PROFILE_NOT_QUALIFIED']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const targetPlans = new WeakMap();
function executionBlocked() { fail('LOCAL_EXECUTION_DISABLED'); }
const MINIMAL_ENV = Object.freeze({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' });
function validateEnvironmentNames(names) {
  check(Array.isArray(names) && names.every(name => typeof name === 'string' && Object.hasOwn(MINIMAL_ENV, name)), 'INHERITED_ENVIRONMENT_REJECTED');
}
function buildMinimalEnvironment(explicit = {}) {
  check(explicit && typeof explicit === 'object' && !Array.isArray(explicit), 'INVALID_ENVIRONMENT');
  validateEnvironmentNames(Object.keys(explicit)); // Reject keys before inspecting any value.
  check(Object.keys(explicit).every(key => {
    const property = Object.getOwnPropertyDescriptor(explicit, key);
    return Object.hasOwn(property, 'value') && property.value === MINIMAL_ENV[key];
  }), 'INVALID_ENVIRONMENT');
  return Object.freeze({ ...MINIMAL_ENV }); // Never spread process.env.
}
function prepareTarget(config) {
  check(exact(config, ['version', 'runId', 'host', 'port', 'database', 'role', 'postgresImage', 'workerImage', 'nodeMajor', 'engine']), 'INVALID_CONFIG');
  check(config.version === 1 && /^[a-f0-9]{32}$/.test(config.runId), 'INVALID_RUN');
  check(config.host === '127.0.0.1' && config.port === 5432 && config.database === `pgc_${config.runId}`, 'LOCAL_TARGET_REQUIRED');
  check(['pgc_executor', 'pgc_reviewer', 'pgc_reader', 'pgc_api'].includes(config.role), 'INVALID_LOCAL_ROLE');
  check(typeof config.postgresImage === 'string' && /^postgres@sha256:[a-f0-9]{64}$/.test(config.postgresImage) &&
    typeof config.workerImage === 'string' && /^node@sha256:[a-f0-9]{64}$/.test(config.workerImage), 'PINNED_IMAGES_REQUIRED');
  check([22, 24].includes(config.nodeMajor) && config.engine === 'npipe:////./pipe/dockerDesktopLinuxEngine', 'LOCAL_ENGINE_REQUIRED');
  const data = freeze(JSON.parse(JSON.stringify(config)));
  const token = Object.freeze({ kind: 'OFFLINE_LOCAL_TARGET', qualified: false });
  targetPlans.set(token, data); return token;
}
function targetData(token) { check(targetPlans.has(token), 'LOCAL_TARGET_TOKEN_REQUIRED'); return targetPlans.get(token); }
function inspectTopology(token, evidence) {
  const c = targetData(token), issues = [];
  if (!exact(evidence, ['daemon', 'postgres', 'worker', 'supervisor'])) issues.push('INCOMPLETE_TOPOLOGY');
  else {
    if (!exact(evidence.daemon, ['endpoint', 'os', 'local']) || evidence.daemon.endpoint !== c.engine ||
      evidence.daemon.os !== 'linux' || evidence.daemon.local !== true) issues.push('LOCAL_DAEMON_REQUIRED');
    const p = evidence.postgres, w = evidence.worker;
    const containerKeys = ['id', 'runId', 'networkMode', 'networks', 'portBindings', 'privileged', 'mounts', 'image'];
    for (const [item, image] of [[p, c.postgresImage], [w, c.workerImage]]) {
      if (!exact(item, containerKeys) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) ||
        item.runId !== c.runId || item.image !== image || item.privileged !== false ||
        !Array.isArray(item.mounts) || item.mounts.length !== 0 ||
        !exact(item.portBindings, []) || !Array.isArray(item.networks) || item.networks.length !== 0) issues.push('UNSAFE_CONTAINER');
    }
    if (p?.networkMode !== 'none' || w?.networkMode !== `container:${p?.id}` || p?.id === w?.id) issues.push('ISOLATED_NAMESPACE_REQUIRED');
    if (!exact(evidence.supervisor, ['isolationRef', 'independentlyReviewed']) ||
      !/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(evidence.supervisor.isolationRef ?? '') ||
      evidence.supervisor.independentlyReviewed !== true) issues.push('SUPERVISOR_EVIDENCE_MISSING');
  }
  // Even perfect supplied metadata is a declaration, never live attestation or permission.
  return freeze({ ...STATUS, declarationsConsistent: issues.length === 0, issues,
    blockers: [...BLOCKERS], isolationVerified: false });
}
function lifecyclePlan(token) {
  const c = targetData(token);
  return freeze({ ...STATUS, runId: c.runId, database: c.database,
    stages: ['QUALIFY_HOST_OFFLINE', 'AUTHORIZE_LOCAL_LAB', 'CREATE_OWNED_PG_NONE', 'JOIN_WORKER_NAMESPACE',
      'VERIFY_DISPOSABLE_IDENTITY', 'BOOTSTRAP_FIXTURE_SEPARATELY', 'RUN_APPROVED_CASES', 'EXPORT_SAFE_RECEIPTS', 'REMOVE_OWNED_IDS'],
    containerPolicy: { publishPorts: false, pull: 'never', network: 'none', workerNetwork: 'container:OWNED_PG_ID',
      mountHostPaths: false, exposeDockerSocket: false }, blockers: [...BLOCKERS] });
}
function ownedCleanupPlan(token, resources) {
  const c = targetData(token);
  check(Array.isArray(resources) && resources.length <= 2 && resources.every(r => exact(r, ['id', 'runId']) &&
    r.runId === c.runId && /^[a-f0-9]{64}$/.test(r.id)) && new Set(resources.map(r => r.id)).size === resources.length, 'RESOURCE_OWNERSHIP_REQUIRED');
  return freeze({ kind: 'PLAN_ONLY', ids: resources.map(r => r.id).reverse(), executable: false });
}
function main(args = process.argv.slice(2), write = line => process.stdout.write(line)) {
  // Deny execution before parsing configuration, credentials or evidence.
  const denied = args.includes('--execute') || args.includes('--run') || args.includes('--allow-local-migrations');
  const valid = args.length === 0 || (args.length === 1 && ['--offline', '--help'].includes(args[0]));
  const status = denied ? 'LOCAL_EXECUTION_DISABLED' : valid ? 'OFFLINE_ONLY' : 'INVALID_ARGUMENTS';
  write(`${JSON.stringify({ ...STATUS, status, blockers: [...BLOCKERS] })}\n`);
  return args.length === 1 && args[0] === '--help' ? 0 : 2;
}
// Content identity only, not an approval or independent trust anchor.
const contentHash = text => createHash('sha256').update(text).digest('hex');
module.exports = { STATUS, BLOCKERS, executionBlocked, prepareTarget, targetData, inspectTopology,
  lifecyclePlan, ownedCleanupPlan, contentHash, check, freeze, main, validateEnvironmentNames, buildMinimalEnvironment };
if (require.main === module) process.exitCode = main();
