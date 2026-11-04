'use strict';
// Installed before the guard in negative controls: native transports never run.
let reached = false;
function sentinel() { reached = true; throw new Error('NATIVE_API_SENTINEL_REACHED'); }
process.on('exit', () => {
  if (reached) {
    process.stderr.write('NATIVE_API_SENTINEL_REACHED\n');
    process.exitCode = 98;
  }
});
function replace(object, name) {
  if (typeof object[name] === 'function') Object.defineProperty(object, name,
    { value: sentinel, configurable: true, writable: true });
}
function constructor(object, name) {
  const Original = object[name];
  if (typeof Original !== 'function') return;
  function NativeSentinel() { return sentinel(); }
  NativeSentinel.prototype = Original.prototype;
  replace(Original.prototype, 'constructor');
  Object.defineProperty(object, name, { value: NativeSentinel, configurable: true, writable: true });
}
for (const dns of [require('node:dns'), require('node:dns/promises')]) {
  const methods = [...new Set([...Object.getOwnPropertyNames(dns), ...Object.getOwnPropertyNames(dns.Resolver.prototype)])]
    .filter(name => /^(lookup|resolve|reverse|setServers)/.test(name));
  for (const name of methods) { replace(dns, name); if (dns.Resolver) replace(dns.Resolver.prototype, name); }
  constructor(dns, 'Resolver');
}
for (const [moduleName, names] of [
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:http2', ['connect', 'createServer', 'createSecureServer']],
  ['node:dgram', ['createSocket']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const name of names) replace(require(moduleName), name);
replace(require('node:net').Socket.prototype, 'connect');
replace(require('node:net').Server.prototype, 'listen');
for (const name of ['bind', 'connect', 'send', 'addMembership', 'addSourceSpecificMembership']) replace(require('node:dgram').Socket.prototype, name);
replace(require('node:child_process').ChildProcess.prototype, 'spawn');
constructor(require('node:worker_threads'), 'Worker');
replace(globalThis, 'fetch');
constructor(globalThis, 'WebSocket');
constructor(require('pg'), 'Client');
replace(require('../lib/migration-executor.cjs'), 'applyGuardedMigration');
require('node:module').syncBuiltinESMExports();
