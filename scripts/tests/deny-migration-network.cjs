'use strict';
let attempts = 0;
function denied() { attempts++; throw new Error('OFFLINE_BOUNDARY_VIOLATION'); }
process.on('exit', () => {
  if (attempts > 0) {
    process.stderr.write('OFFLINE_BOUNDARY_VIOLATION\n');
    process.exitCode = 99;
  }
});
function block(object, name) {
  if (typeof object[name] !== 'function') return;
  Object.defineProperty(object, name, { value: denied, configurable: true, writable: true });
}
function blockConstructor(object, name) {
  const Original = object[name];
  if (typeof Original !== 'function') return;
  function BlockedConstructor() { return denied(); }
  BlockedConstructor.prototype = Original.prototype;
  block(Original.prototype, 'constructor');
  Object.defineProperty(object, name, { value: BlockedConstructor, configurable: true, writable: true });
}
for (const api of [require('node:dns'), require('node:dns/promises')]) {
  const isNetworkMethod = name => /^(lookup|resolve|reverse|setServers)/.test(name);
  for (const name of Object.getOwnPropertyNames(api).filter(isNetworkMethod)) block(api, name);
  if (api.Resolver) {
    for (let prototype = api.Resolver.prototype; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const name of Object.getOwnPropertyNames(prototype).filter(isNetworkMethod)) block(prototype, name);
    }
    blockConstructor(api, 'Resolver');
  }
}
for (const [moduleName, methods] of [
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:http2', ['connect', 'createServer', 'createSecureServer']],
  ['node:dgram', ['createSocket']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) {
  const api = require(moduleName);
  for (const name of methods) block(api, name);
}
block(require('node:net').Socket.prototype, 'connect');
block(require('node:net').Server.prototype, 'listen');
for (const name of ['bind', 'connect', 'send', 'addMembership', 'addSourceSpecificMembership']) block(require('node:dgram').Socket.prototype, name);
block(require('node:child_process').ChildProcess.prototype, 'spawn');
blockConstructor(require('node:worker_threads'), 'Worker');
block(globalThis, 'fetch');
blockConstructor(globalThis, 'WebSocket');
blockConstructor(require('pg'), 'Client');
block(require('../lib/migration-executor.cjs'), 'applyGuardedMigration');
require('node:module').syncBuiltinESMExports();
