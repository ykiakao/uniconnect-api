'use strict';
// RAM-only regression model for the SQL contract. Never proves PostgreSQL behavior.
const { check, freeze } = require('./local-lab.cjs');
const keys = ['pid', 'backendStart', 'serverStart', 'databaseOid', 'login', 'role', 'nonce'];
const same = (a, b) => Boolean(a && b && keys.every(k => a[k] === b[k]));
function identity(i) {
  check(i && Number.isInteger(i.pid) && i.pid > 0 && Number.isInteger(i.databaseOid) && i.databaseOid > 0 &&
    ['backendStart', 'serverStart', 'login', 'role', 'nonce'].every(k => typeof i[k] === 'string' && i[k].length > 0), 'SESSION_IDENTITY_REQUIRED');
  return freeze(Object.fromEntries(keys.map(k => [k, i[k]])));
}
class SessionLockProtocol {
  #session; #state = 'NEW';
  constructor(session) { this.#session = identity(session); }
  requestAcquire() { check(this.#state === 'NEW', 'ACQUISITION_ALREADY_ATTEMPTED'); this.#state = 'SENT'; return 'SESSION_EXCLUSIVE_TRY_ONCE'; }
  acknowledge(observation) {
    check(this.#state === 'SENT', 'LOCK_PHASE_ERROR');
    if (!observation || observation.kind !== 'session' || observation.mode !== 'ExclusiveLock' || !same(this.#session, observation.session)) {
      this.#state = 'UNKNOWN'; check(false, 'SESSION_EXCLUSIVE_LOCK_REQUIRED');
    }
    this.#state = observation.acquired === true ? 'HELD' : observation.acquired === false ? 'REFUSED' : 'UNKNOWN';
    return this.#state;
  }
  boundary(session, held) {
    if (this.#state !== 'HELD' || !same(this.#session, session) || held !== true) { this.#state = 'UNKNOWN'; check(false, 'SESSION_LOST_OR_LOCK_UNPROVEN'); }
    return 'SYNTHETIC_OBSERVATION_ONLY';
  }
  loseSession() { this.#state = 'UNKNOWN'; }
  requestRelease() { check(this.#state === 'HELD', 'LOCK_NOT_HELD'); this.#state = 'RELEASE_SENT'; }
  acknowledgeRelease(session, acknowledged) {
    if (this.#state !== 'RELEASE_SENT' || !same(this.#session, session)) { this.#state = 'UNKNOWN'; check(false, 'RELEASE_ACK_UNKNOWN'); }
    this.#state = acknowledged === true ? 'RELEASED' : 'UNKNOWN';
    check(acknowledged === true, 'RELEASE_ACK_UNKNOWN');
  }
  release(session, acknowledged) { this.requestRelease(); this.acknowledgeRelease(session, acknowledged); }
  report() { return freeze({ state: this.#state, continuityProven: false, executionEnabled: false }); }
}
class RunFenceModel {
  #runs = new Map(); #attempts = new Map();
  #owned(runRef, session) {
    const r = this.#runs.get(runRef);
    check(r && r.state === 'RUNNING' && same(r.session, session), 'RUN_OWNER_OR_STATE_MISMATCH'); return r;
  }
  open(runRef, session) {
    check(!this.#runs.has(runRef) && ![...this.#runs.values()].some(r => r.state !== 'RECONCILED'), 'RUN_FENCE_BLOCKED');
    this.#runs.set(runRef, { runRef, session: identity(session), state: 'RUNNING', history: [] });
  }
  admit(id, runRef, session) {
    this.#owned(runRef, session);
    check(!this.#attempts.has(id) && ![...this.#attempts.values()].some(a => ['RUNNING', 'UNKNOWN', 'FAILED'].includes(a.state)), 'ATTEMPT_BLOCKED');
    this.#attempts.set(id, { id, runRef, state: 'RUNNING', history: [], receiptRef: null });
  }
  finish(id, runRef, session, proof) {
    this.#owned(runRef, session); const a = this.#attempts.get(id);
    check(a && a.runRef === runRef && a.state === 'RUNNING', 'ATTEMPT_OWNER_MISMATCH');
    check(proof && proof.commit === 'COMMITTED' && proof.postcheck === 'PASS' && typeof proof.receiptRef === 'string' && proof.receiptRef.length > 0, 'COMMIT_PROOF_REQUIRED');
    a.history.push(a.state); a.state = 'APPLIED'; a.receiptRef = proof.receiptRef;
    // Run remains fenced even after the last APPLIED: only a reviewer can close it.
  }
  loseAcknowledgement(runRef) { const r = this.#runs.get(runRef); check(r && r.state !== 'RECONCILED', 'RUN_NOT_ACTIVE'); r.history.push(r.state); r.state = 'UNKNOWN'; }
  reconcileAttempt(id, review) {
    const a = this.#attempts.get(id);
    check(a && a.state !== 'APPLIED' && review?.role === 'pgc_reviewer' && review.reviewRef && review.receiptRef &&
      review.commit === 'COMMITTED' && review.postcheck === 'PASS', 'MANUAL_RECONCILIATION_REQUIRED');
    a.history.push(a.state); a.state = 'APPLIED'; a.reconciliationReceiptRef = review.receiptRef;
  }
  closeRun(runRef, review) {
    const r = this.#runs.get(runRef);
    check(r && r.state !== 'RECONCILED' && review?.role === 'pgc_reviewer' && review.reviewRef && review.receiptRef &&
      [...this.#attempts.values()].filter(a => a.runRef === runRef).every(a => a.state === 'APPLIED'), 'MANUAL_RECONCILIATION_REQUIRED');
    r.history.push(r.state); r.state = 'RECONCILED'; r.reviewRef = review.reviewRef;
  }
  observe() { return freeze(JSON.parse(JSON.stringify({ mode: 'SIMULATED', runs: [...this.#runs.values()], attempts: [...this.#attempts.values()] }))); }
}
module.exports = { SessionLockProtocol, RunFenceModel };
