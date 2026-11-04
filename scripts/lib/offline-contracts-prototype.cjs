'use strict';
// Closed, synchronous, RAM-only model. Never import this module in an operational path.
const { createHash } = require('node:crypto');
const PROTOTYPE_LOCK_KEY = Object.freeze([1431193923, 1345336576]);
const STATUS = Object.freeze({ mode: 'SIMULATED', readiness: 'NO_GO', rehearsals: 'NOT_RUN',
  realExecutionAllowed: false, lockApproved: false });
const snapshots = new WeakMap(), sessions = new WeakMap(), permits = new WeakMap(), receipts = new WeakMap();
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (condition, code) => { if (!condition) fail(code); };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const copy = value => freeze(JSON.parse(JSON.stringify(value)));
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
const pathId = value => typeof value === 'string' && /^[a-z0-9_.\/-]+$/.test(value) &&
  !value.startsWith('/') && !value.includes('..') && !value.includes('//');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

class OfflinePackageVerifier {
  #anchors;
  constructor(independentAnchors) {
    check(independentAnchors instanceof Map && independentAnchors.size > 0, 'TRUST_ANCHOR_REQUIRED');
    this.#anchors = new Map(independentAnchors);
    for (const [id, sha] of this.#anchors) check(ref(id) && digest(sha), 'INVALID_TRUST_ANCHOR');
  }
  verify(bytes, approvalRef) {
    check(typeof bytes === 'string' && bytes.length <= 1024 * 1024, 'INVALID_PACKAGE');
    check(this.#anchors.has(approvalRef) && hash(bytes) === this.#anchors.get(approvalRef), 'ANCHOR_MISMATCH');
    let p;
    try { p = JSON.parse(bytes); } catch { fail('INVALID_PACKAGE'); }
    check(exact(p, ['version', 'environment', 'projectRef', 'baselineRef', 'files', 'artifacts']) &&
      p.version === 'prototype-v0.1' && p.environment === 'homologation' &&
      p.projectRef === 'pvacwfypqsstdrfxajkg' && ref(p.baselineRef), 'INVALID_PACKAGE_CONTEXT');
    check(Array.isArray(p.files) && p.files.length === 11 && Array.isArray(p.artifacts), 'INVALID_PACKAGE_CONTENT');
    const ids = new Set();
    for (const [index, f] of p.files.entries()) {
      check(exact(f, ['id', 'ordinal', 'text', 'rawHash', 'normalizedHash']) && f.ordinal === index + 1 &&
        pathId(f.id) && f.id.startsWith('supabase/') && f.id.endsWith('.sql') && !ids.has(f.id) &&
        typeof f.text === 'string' && digest(f.rawHash) && digest(f.normalizedHash) &&
        hash(f.text) === f.rawHash && hash(f.text.replace(/\r\n/g, '\n')) === f.normalizedHash, 'INVALID_SOURCE');
      ids.add(f.id);
    }
    const required = new Set(['scripts/lib/migration-executor.cjs', 'scripts/homologation-migrations.cjs',
      'scripts/homologation-preflight.cjs', 'scripts/lib/migration-manifest.cjs', 'package-lock.json', 'runtime-contract.json']);
    for (const a of p.artifacts) {
      check(exact(a, ['id', 'text', 'rawHash']) && pathId(a.id) && !ids.has(a.id) &&
        typeof a.text === 'string' && digest(a.rawHash) && hash(a.text) === a.rawHash, 'INVALID_ARTIFACT');
      ids.add(a.id); required.delete(a.id);
    }
    check(required.size === 0, 'MISSING_ARTIFACT');
    const token = Object.freeze({ kind: 'VERIFIED_OFFLINE_SNAPSHOT' });
    snapshots.set(token, freeze({ ...p, packageDigest: hash(bytes), approvalRef }));
    return token;
  }
}
const snapshot = token => { check(snapshots.has(token), 'VERIFIED_SNAPSHOT_REQUIRED'); return snapshots.get(token); };

// One instance represents one database scope. It offers no cross-process exclusion or durability.
class MemoryControlStore {
  #scope = 'pvacwfypqsstdrfxajkg/postgres/academic';
  #lock = null; #catalog = new Map(); #attempts = []; #runs = [];
  #events = []; #clock = 0; #fault = null; #nextSession = 0;
  #event(type, details = {}) { this.#events.push({ tick: ++this.#clock, type, ...details }); }
  openSession() {
    const token = Object.freeze({ kind: 'FAKE_SESSION' });
    sessions.set(token, { store: this, id: `session-${++this.#nextSession}`, clientAlive: true, backendAlive: true });
    return token;
  }
  #session(token) {
    const s = sessions.get(token);
    check(s && s.store === this && s.clientAlive && s.backendAlive, 'SESSION_LOST'); return s;
  }
  #owns(token) { const s = this.#session(token); check(this.#lock === token, 'LOCK_REQUIRED'); return s; }
  tryAcquire(token) {
    this.#session(token);
    if (this.#lock !== null) return false; // Reject reentrance, too.
    this.#lock = token; this.#event('LOCK_ACQUIRED'); return true;
  }
  release(token) { this.#owns(token); this.#lock = null; this.#event('LOCK_RELEASED'); }
  loseClient(token) { const s = this.#session(token); s.clientAlive = false; this.#event('CLIENT_LOST'); }
  terminateBackend(token) {
    const s = sessions.get(token); check(s && s.store === this, 'INVALID_SESSION');
    s.clientAlive = false; s.backendAlive = false;
    if (this.#lock === token) this.#lock = null;
    this.#event('BACKEND_TERMINATED');
  }
  transactionBoundary(token) { this.#owns(token); this.#event('SIMULATED_TRANSACTION_BOUNDARY'); }
  bootstrapCatalog(token, verified) {
    this.#owns(token); const p = snapshot(verified);
    // Validate all before changing the in-memory catalog.
    for (const f of p.files) {
      const old = this.#catalog.get(f.id);
      check(!old || (old.rawHash === f.rawHash && old.normalizedHash === f.normalizedHash && old.ordinal === f.ordinal), 'CATALOG_DRIFT');
    }
    for (const f of p.files) if (!this.#catalog.has(f.id)) this.#catalog.set(f.id,
      freeze({ id: f.id, ordinal: f.ordinal, rawHash: f.rawHash, normalizedHash: f.normalizedHash, registeredAt: ++this.#clock }));
    this.#event('CATALOG_REGISTERED');
  }
  injectLedgerFault(operation, point) {
    check(['admit', 'finish'].includes(operation) && ['before', 'after'].includes(point), 'INVALID_FAULT');
    this.#fault = { operation, point };
  }
  #faultAt(operation, point) {
    if (this.#fault?.operation === operation && this.#fault.point === point) {
      this.#fault = null; fail('LEDGER_ACK_UNCERTAIN');
    }
  }
  authorizeRetry(token, attemptId, { reviewRef, authorizationRef, evidenceRef }) {
    this.#owns(token);
    check([reviewRef, authorizationRef, evidenceRef].every(ref), 'REVIEW_REFERENCES_REQUIRED');
    const a = this.#attempts.find(item => item.id === attemptId);
    check(a && a.state === 'FAILED' && ['NOT_DISPATCHED', 'NOT_COMMITTED'].includes(a.commitOutcome) &&
      !a.resolution, 'RETRY_NOT_SAFE');
    const permit = Object.freeze({ kind: 'SIMULATED_RETRY_AUTHORIZATION' });
    permits.set(permit, { store: this, attemptId, packageDigest: a.packageDigest, consumed: false });
    a.resolution = { reviewRef, authorizationRef, evidenceRef, at: ++this.#clock };
    this.#event('SPECIFIC_RETRY_REVIEWED', { attemptId });
    return permit;
  }
  beginRun(token, verified, retryPermit) {
    const s = this.#owns(token), p = snapshot(verified);
    check(this.#catalog.size === p.files.length && p.files.every(f => {
      const c = this.#catalog.get(f.id); return c?.rawHash === f.rawHash && c.normalizedHash === f.normalizedHash && c.ordinal === f.ordinal;
    }), 'CATALOG_NOT_READY');
    const blocking = this.#attempts.filter(a => a.state !== 'APPLIED' &&
      !(a.state === 'FAILED' && a.resolution && this.#attempts.some(later =>
        later.migrationId === a.migrationId && later.attemptNo > a.attemptNo && later.state === 'APPLIED')));
    const permit = permits.get(retryPermit);
    const retry = blocking.length > 0 && permit?.store === this && !permit.consumed &&
      permit.packageDigest === p.packageDigest && blocking.every(a => a.state === 'FAILED' && a.resolution) &&
      blocking.at(-1).id === permit.attemptId;
    check(blocking.length === 0 || retry, 'UNRESOLVED_ATTEMPT');
    // Even an APPLIED record with lost ledger ack requires manual reconciliation, not replay.
    const uncertainRuns = this.#runs.filter(r => r.state === 'UNKNOWN');
    check(uncertainRuns.length === 0, 'UNRESOLVED_RUN');
    check(!this.#runs.some(r => r.state === 'RUNNING'), 'UNRESOLVED_RUN');
    if (retry) permit.consumed = true;
    const run = { id: `run-${this.#runs.length + 1}`, scope: this.#scope, session: s.id,
      packageDigest: p.packageDigest, baselineRef: p.baselineRef, state: 'RUNNING' };
    this.#runs.push(run); this.#event('RUN_ADMITTED', { runId: run.id }); return run.id;
  }
  pending(verified) { const p = snapshot(verified); return p.files.filter(f => !this.#attempts.some(a => a.migrationId === f.id && a.state === 'APPLIED')); }
  #run(token, runId) {
    const s = this.#owns(token), run = this.#runs.find(r => r.id === runId);
    check(run?.session === s.id && run.state === 'RUNNING', 'RUN_NOT_ACTIVE'); return run;
  }
  admit(token, runId, verified, file) {
    const run = this.#run(token, runId), p = snapshot(verified);
    check(p.packageDigest === run.packageDigest && this.pending(verified)[0] === file, 'SOURCE_ORDER_VIOLATION');
    check(!this.#attempts.some(a => ['RUNNING', 'UNKNOWN'].includes(a.state)), 'UNRESOLVED_ATTEMPT');
    this.#faultAt('admit', 'before');
    const a = { id: `attempt-${this.#attempts.length + 1}`, migrationId: file.id, runId, session: run.session,
      packageDigest: run.packageDigest, rawHash: file.rawHash, normalizedHash: file.normalizedHash,
      attemptNo: this.#attempts.filter(v => v.migrationId === file.id).length + 1,
      state: 'RUNNING', commitOutcome: 'UNKNOWN', startedAt: ++this.#clock, finishedAt: null, receipt: null };
    this.#attempts.push(a); this.#event('ATTEMPT_ADMITTED', { attemptId: a.id });
    this.#faultAt('admit', 'after'); return a.id;
  }
  dispatchDouble(token, runId, attemptId, double) {
    this.#run(token, runId);
    check(double && Object.getPrototypeOf(double) === ScriptedHelperDouble.prototype &&
      Object.isFrozen(double), 'FAKE_HELPER_REQUIRED');
    const a = this.#attempts.find(item => item.id === attemptId);
    check(a?.state === 'RUNNING' && a.runId === runId && !a.helperInvoked, 'ADMISSION_REQUIRED');
    a.helperInvoked = true; this.#event('DOUBLE_DISPATCHED', { attemptId });
    return double.simulate(this, token, copy(a));
  }
  finish(token, runId, attemptId, receipt) {
    this.#run(token, runId); const a = this.#attempts.find(item => item.id === attemptId);
    check(a?.state === 'RUNNING' && a.runId === runId, 'ADMISSION_REQUIRED');
    this.#faultAt('finish', 'before');
    const result = classifyReceipt(receipt, a);
    Object.assign(a, result, { receipt: receipts.has(receipt) ? receipt : null,
      finishedAt: result.state === 'UNKNOWN' ? null : ++this.#clock });
    this.#event('ATTEMPT_RECORDED', { attemptId, state: a.state });
    this.#faultAt('finish', 'after'); return a.state;
  }
  stopRun(token, runId, state) {
    const run = this.#run(token, runId);
    check(['APPLIED', 'FAILED', 'UNKNOWN'].includes(state), 'INVALID_RUN_STATE');
    if (state === 'APPLIED') check([...this.#catalog.keys()].every(id =>
      this.#attempts.some(a => a.migrationId === id && a.state === 'APPLIED')), 'RUN_NOT_PROVEN');
    run.state = state; this.#event('RUN_STOPPED', { state });
  }
  observe() { return copy({ ...STATUS, scope: this.#scope, catalog: [...this.#catalog.values()],
    attempts: this.#attempts, runs: this.#runs, events: this.#events, lockHeld: this.#lock !== null }); }
}

const PHASES = Object.freeze(['BEFORE_SEND', 'SENT', 'EXECUTING', 'COMMIT_SENT', 'COMMIT_ACK', 'POSTCHECK_STARTED', 'POSTCHECK_PASS']);
const SCENARIOS = Object.freeze(['success', 'before-send', 'rollback', 'executing', 'commit-lost',
  'after-commit', 'postcheck-interrupted', 'postcheck-failed', 'session-lost', 'malformed', 'throw',
  'commit-without-ack', 'pass-without-postcheck', 'out-of-order', 'wrong-identity']);
class ScriptedHelperDouble {
  #scenario;
  constructor(scenario = 'success') {
    check(SCENARIOS.includes(scenario), 'INVALID_SCENARIO'); this.#scenario = scenario; Object.freeze(this);
  }
  simulate(store, token, a) {
    const scenario = this.#scenario;
    if (scenario === 'throw') fail('SIMULATED_DRIVER_ERROR');
    if (scenario === 'session-lost') { store.loseClient(token); fail('SESSION_LOST'); }
    if (scenario === 'malformed') return Object.freeze({ state: 'APPLIED', commitOutcome: 'COMMITTED' });
    let count = 7, outcome = 'COMMITTED', postcheck = 'PASS', failureKind = null;
    if (scenario === 'before-send') { count = 1; outcome = 'NOT_DISPATCHED'; postcheck = 'NOT_RUN'; }
    if (scenario === 'rollback') { count = 3; outcome = 'NOT_COMMITTED'; postcheck = 'NOT_RUN'; }
    if (scenario === 'executing') { count = 3; outcome = 'UNKNOWN'; postcheck = 'NOT_RUN'; }
    if (scenario === 'commit-lost') { count = 4; outcome = 'UNKNOWN'; postcheck = 'NOT_RUN'; }
    if (scenario === 'after-commit') { count = 5; postcheck = 'NOT_RUN'; }
    if (scenario === 'postcheck-interrupted') { count = 6; postcheck = 'UNKNOWN'; }
    if (scenario === 'postcheck-failed') { count = 6; postcheck = 'FAIL'; }
    if (scenario === 'commit-without-ack') count = 4;
    if (scenario === 'pass-without-postcheck') count = 5;
    if (scenario !== 'success') failureKind = `SIMULATED_${scenario.replaceAll('-', '_').toUpperCase()}`;
    const phases = PHASES.slice(0, count);
    if (scenario === 'out-of-order') phases.reverse();
    const r = freeze({ version: 1, mode: 'SIMULATED', runId: a.runId, attemptId: a.id, session: a.session,
      migrationId: a.migrationId, rawHash: a.rawHash, normalizedHash: a.normalizedHash, packageDigest: a.packageDigest,
      ...(scenario === 'wrong-identity' ? { attemptId: 'unrelated-attempt' } : {}),
      phases, commitOutcome: outcome, postcheck, failureKind,
      rollbackEvidence: scenario === 'rollback' ? 'SIMULATED_FULL_FILE_NO_EFFECTS' : null });
    receipts.set(r, true); return r;
  }
}
Object.freeze(ScriptedHelperDouble.prototype);
function classifyReceipt(r, a) {
  const unknown = { state: 'UNKNOWN', commitOutcome: 'UNKNOWN', failureKind: 'RECEIPT_NOT_PROVEN' };
  if (!receipts.has(r) || !['runId', 'attemptId', 'session', 'migrationId', 'rawHash', 'normalizedHash', 'packageDigest']
    .every(key => r[key] === (key === 'attemptId' ? a.id : a[key])) ||
    !r.phases.every((phase, i) => phase === PHASES[i])) return unknown;
  if (r.commitOutcome === 'COMMITTED' && !r.phases.includes('COMMIT_ACK')) return unknown;
  if (r.commitOutcome === 'COMMITTED' && r.postcheck === 'PASS' && r.phases.at(-1) === 'POSTCHECK_PASS')
    return { state: 'APPLIED', commitOutcome: 'COMMITTED', failureKind: null };
  if ((r.commitOutcome === 'NOT_DISPATCHED' && r.phases.length === 1) ||
      (r.commitOutcome === 'NOT_COMMITTED' && r.rollbackEvidence === 'SIMULATED_FULL_FILE_NO_EFFECTS') ||
      (r.commitOutcome === 'COMMITTED' && r.postcheck === 'FAIL'))
    return { state: 'FAILED', commitOutcome: r.commitOutcome, failureKind: r.failureKind };
  return { state: 'UNKNOWN', commitOutcome: r.commitOutcome, failureKind: r.failureKind || 'OUTCOME_UNKNOWN' };
}

class PrototypeExecutor {
  #store; #session; #snapshot; #run = null; #stopped = false;
  constructor(store, session, verified) {
    check(store instanceof MemoryControlStore && sessions.get(session)?.store === store, 'FAKE_STORE_REQUIRED');
    snapshot(verified); this.#store = store; this.#session = session; this.#snapshot = verified;
  }
  start(retryPermit) {
    check(!this.#run && !this.#stopped, 'EXECUTOR_ALREADY_USED');
    check(this.#store.tryAcquire(this.#session), 'LOCK_BUSY');
    try { this.#run = this.#store.beginRun(this.#session, this.#snapshot, retryPermit); }
    catch (error) { this.#store.release(this.#session); this.#stopped = true; throw error; }
  }
  step(double = new ScriptedHelperDouble()) {
    check(this.#run && !this.#stopped, 'EXECUTOR_NOT_ACTIVE');
    let attemptId = null, awaitingHelper = false;
    try {
      const file = this.#store.pending(this.#snapshot)[0];
      if (!file) { this.#end('APPLIED'); return 'APPLIED'; }
      attemptId = this.#store.admit(this.#session, this.#run, this.#snapshot, file);
      awaitingHelper = true;
      const receipt = this.#store.dispatchDouble(this.#session, this.#run, attemptId, double);
      awaitingHelper = false;
      const state = this.#store.finish(this.#session, this.#run, attemptId, receipt);
      if (state !== 'APPLIED') this.#end(state);
      else if (this.#store.pending(this.#snapshot).length === 0) this.#end('APPLIED');
      return state;
    } catch {
      // Loss of ledger ack or session never implies rollback. Do not rewrite an APPLIED record.
      // A missing helper receipt can be recorded as UNKNOWN only while the session is usable.
      // Never retry a ledger write whose acknowledgement was itself lost.
      if (awaitingHelper) try { this.#store.finish(this.#session, this.#run, attemptId, null); } catch { /* Leave RUNNING. */ }
      try { this.#store.stopRun(this.#session, this.#run, 'UNKNOWN'); } catch { /* RUNNING stays blocking. */ }
      try { this.#store.release(this.#session); } catch { /* Backend may still own the lock. */ }
      this.#stopped = true; return 'UNKNOWN';
    }
  }
  #end(state) { this.#store.stopRun(this.#session, this.#run, state); this.#store.release(this.#session); this.#stopped = true; }
}
module.exports = { STATUS, PROTOTYPE_LOCK_KEY, OfflinePackageVerifier, MemoryControlStore,
  ScriptedHelperDouble, PrototypeExecutor, SCENARIOS };
