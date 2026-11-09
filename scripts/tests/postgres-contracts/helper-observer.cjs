'use strict';
const manifest = require('../../lib/migration-manifest.cjs');
const { contentHash, check, freeze, executionBlocked } = require('./local-lab.cjs');
const EXPLICIT = new Set(['20261026000001_security_integrity.sql', '20261026000002_academic_structure.sql',
  '20261026000003_institutional_management.sql', '20261026000004_activity_workflow.sql',
  '20261026000005_academic_communication.sql', '20261031000006_platform_institutions.sql', '20261101000007_accounts_and_responsibility.sql']);
const COMMANDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'COMMENT', 'DO', 'GRANT', 'REVOKE', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'LOCK', 'SHOW']);
class HelperObserver {
  #name; #hash; #rawHash; #kind; #queries = new Map(); #events = []; #commit = false; #source = false;
  #failed = false; #idle = false; #serial = 0; #rollback = false; #beginAck = false;
  #transaction = 'I'; #phase = 'NEW';
  constructor(name, sourceText) {
    check(Object.hasOwn(manifest, name) && typeof sourceText === 'string' &&
      contentHash(sourceText.replace(/\r\n/g, '\n')) === manifest[name], 'UNRECOGNIZED_SOURCE');
    this.#name = name; this.#hash = manifest[name]; this.#rawHash = contentHash(sourceText);
    this.#kind = name === '20260528000002_activities_grades_reports.sql' ? 'HELPER_TRANSACTION' : EXPLICIT.has(name) ? 'SOURCE_TRANSACTION' : 'IMPLICIT_FILE';
  }
  #require(condition, code) {
    if (!condition) { this.#failed = true; this.#phase = 'UNKNOWN'; check(false, code); }
  }
  beforeQuery(text) {
    this.#require(typeof text === 'string' && this.#queries.size === 0, 'QUERY_ORDER_ERROR');
    const kind = contentHash(text.replace(/\r\n/g, '\n')) === this.#hash ? 'SOURCE' :
      /^\s*(begin|commit|rollback)\s*;?\s*$/i.exec(text)?.[1].toUpperCase() || 'AUXILIARY';
    this.#require(!this.#failed || kind === 'ROLLBACK', 'QUERY_AFTER_FAILURE');
    this.#require(kind !== 'SOURCE' || (!this.#source && contentHash(text) === this.#rawHash), 'SOURCE_REPLAY_OR_DRIFT');
    if (this.#kind === 'HELPER_TRANSACTION') {
      this.#require(kind !== 'SOURCE' || (this.#beginAck && this.#transaction === 'T' && this.#phase === 'IN_TRANSACTION'), 'HELPER_BEGIN_PROOF_REQUIRED');
      this.#require(kind !== 'BEGIN' || (!this.#beginAck && this.#phase === 'NEW'), 'DUPLICATE_BEGIN');
      this.#require(kind !== 'COMMIT' || (this.#transaction === 'T' && this.#phase === 'SOURCE_CONFIRMED' && this.#source && !this.#commit), 'INVALID_COMMIT_PHASE');
      this.#require(kind !== 'AUXILIARY' || ['IN_TRANSACTION', 'SOURCE_CONFIRMED', 'COMMITTED'].includes(this.#phase), 'INVALID_AUXILIARY_PHASE');
    } else {
      this.#require(!['BEGIN', 'COMMIT'].includes(kind), 'UNEXPECTED_OUTER_TRANSACTION');
    }
    const token = Object.freeze({ ordinal: ++this.#serial }); this.#queries.set(token, { kind, prior: this.#phase });
    this.#phase = `${kind}_PENDING`;
    this.#events.push({ phase: 'QUERY_SENT', kind }); this.#idle = false; return token;
  }
  afterQuery(token, result, ready = 'UNKNOWN') {
    this.#require(this.#queries.has(token) && ['I', 'T', 'E', 'UNKNOWN'].includes(ready), 'UNKNOWN_QUERY');
    const { kind, prior } = this.#queries.get(token); this.#queries.delete(token);
    const results = Array.isArray(result) ? result : [result];
    if (!(results.length > 0 && results.every(r => r && COMMANDS.has(r.command)))) {
      this.#require(false, 'COMMAND_PROOF_REQUIRED');
    }
    const commands = results.map(r => r.command);
    this.#events.push({ phase: 'QUERY_ACK', kind, commands, ready });
    if (kind === 'BEGIN') {
      if (!(commands.length === 1 && commands[0] === 'BEGIN' && ready === 'T')) {
        this.#require(false, 'BEGIN_PROOF_REQUIRED');
      }
      this.#beginAck = true;
    }
    if (commands.includes('ROLLBACK')) { this.#rollback = true; this.#commit = false; }
    else if (commands.includes('COMMIT')) {
      if (!((kind === 'COMMIT' && this.#kind === 'HELPER_TRANSACTION' && this.#beginAck && this.#source && commands.length === 1) ||
        (kind === 'SOURCE' && this.#kind === 'SOURCE_TRANSACTION' && commands[0] === 'BEGIN' && commands.at(-1) === 'COMMIT'))) {
        this.#require(false, 'INVALID_COMMIT_PHASE');
      }
      if (ready === 'I') this.#commit = true;
    }
    if (kind === 'SOURCE') this.#source = true;
    this.#idle = ready === 'I'; this.#transaction = ready;
    if (this.#rollback) { this.#phase = 'ROLLED_BACK'; return; }
    const expected = this.#kind === 'HELPER_TRANSACTION' &&
      (kind === 'SOURCE' || kind === 'BEGIN' || (kind === 'AUXILIARY' && prior !== 'COMMITTED')) ? 'T' : 'I';
    if (ready !== expected) { this.#failed = true; this.#phase = 'UNKNOWN'; return; }
    this.#phase = kind === 'BEGIN' ? 'IN_TRANSACTION' : kind === 'SOURCE' ?
      (this.#kind === 'HELPER_TRANSACTION' ? 'SOURCE_CONFIRMED' : this.#commit ? 'COMMITTED' : 'IMPLICIT_UNPROVEN') :
      kind === 'COMMIT' ? 'COMMITTED' : kind === 'ROLLBACK' ? 'ROLLED_BACK' : prior;
  }
  queryFailed(token) {
    this.#require(this.#queries.has(token), 'UNKNOWN_QUERY'); const { kind } = this.#queries.get(token); this.#queries.delete(token);
    this.#failed = true; this.#idle = false; this.#phase = 'UNKNOWN'; this.#events.push({ phase: 'QUERY_ERROR', kind });
  }
  recordNotice(code) {
    // Neither nested BEGIN nor COMMIT without a transaction is acceptable proof.
    if (typeof code === 'string' && /^(25|08|40|57)[A-Z0-9]{3}$/.test(code)) {
      this.#failed = true; this.#phase = 'UNKNOWN'; this.#events.push({ phase: 'TRANSACTION_WARNING', kind: 'SANITIZED' });
    }
  }
  interrupt() { this.#failed = true; this.#phase = 'UNKNOWN'; this.#events.push({ phase: 'INTERRUPTED', kind: 'SANITIZED' }); }
  receipt(postcheck = 'NOT_RUN') {
    check(['NOT_RUN', 'PASS', 'FAIL', 'UNKNOWN'].includes(postcheck), 'INVALID_POSTCHECK');
    const commit = this.#commit && this.#phase === 'COMMITTED' && this.#idle && !this.#failed && !this.#rollback && this.#source && this.#queries.size === 0;
    return freeze({ name: this.#name, rawHash: this.#rawHash, normalizedHash: this.#hash, transactionClass: this.#kind,
      evidenceClass: 'OBSERVATION_ONLY', operationallyQualified: false,
      commitOutcome: this.#commit ? 'COMMITTED' : 'UNKNOWN', postcheck, phase: this.#phase,
      appliedCandidate: commit && postcheck === 'PASS', events: JSON.parse(JSON.stringify(this.#events)) });
  }
}
async function runObservedHelper() { executionBlocked(); }
module.exports = { HelperObserver, runObservedHelper };
