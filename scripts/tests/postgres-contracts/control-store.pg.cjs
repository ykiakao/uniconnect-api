'use strict';
const { executionBlocked, targetData, check, freeze, validateEnvironmentNames } = require('./local-lab.cjs');
const { SessionLockProtocol } = require('./run-model.cjs');
const LOCK_KEY = Object.freeze([1431193923, 1345336576]); // Provisional, not reserved.
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(value) && !value.includes('..');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const dateText = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
const failure = p => {
  check(p.failureKind == null || ['KNOWN_FAILURE', 'POSTCHECK_FAILED', 'OUTCOME_UNPROVEN', 'SESSION_LOST', 'LEDGER_ACK_LOST'].includes(p.failureKind), 'INVALID_FAILURE_KIND');
  check(p.state !== 'FAILED' || p.failureKind != null, 'FAILURE_KIND_REQUIRED');
  check(p.state !== 'APPLIED' || p.failureKind == null, 'INVALID_FAILURE_KIND');
  return p.failureKind ?? null;
};
function descriptor(operation, payload = {}) {
  let text, values = [];
  switch (operation) {
    case 'identity':
      text = `select current_database() as database, session_user::text as login, current_user::text as role,
        pg_backend_pid() as pid, current_setting('server_version_num')::integer as version,
        current_setting('uniconnect.pgc_fixture',true) as fixture_marker, pg_postmaster_start_time() as server_start,
        (select backend_start from pg_catalog.pg_stat_activity where pid=pg_backend_pid()) as backend_start,
        (select oid from pg_catalog.pg_database where datname=current_database()) as database_oid`; break;
    case 'lock': text = 'select pg_catalog.pg_try_advisory_lock($1::integer,$2::integer) as acquired'; values = [...LOCK_KEY]; break;
    case 'unlock': text = 'select pg_catalog.pg_advisory_unlock($1::integer,$2::integer) as released'; values = [...LOCK_KEY]; break;
    case 'pending': text = `select 'RUN' as kind,run_ref as id,state from uniconnect_migration_control.migration_runs
        where scope_id=current_database() and blocks_scope
        union all select 'ATTEMPT',attempt_id::text,state from uniconnect_migration_control.migration_attempts
        where scope_id=current_database() and blocks_scope`; break;
    case 'run_open':
      check(identifier(payload.runRef) && uuid(payload.sessionNonce) && sha(payload.packageDigest), 'INVALID_RUN_BINDING');
      text = `insert into uniconnect_migration_control.migration_runs(scope_id,run_ref,session_nonce,package_digest)
        values(current_database(),$1,$2::uuid,$3) returning run_ref,state`;
      values = [payload.runRef, payload.sessionNonce, payload.packageDigest]; break;
    case 'run_unknown':
      check(identifier(payload.runRef) && uuid(payload.sessionNonce), 'INVALID_RUN_BINDING');
      text = `update uniconnect_migration_control.migration_runs set state='UNKNOWN'
        where scope_id=current_database() and run_ref=$1 and session_nonce=$2::uuid and state='RUNNING' returning state`;
      values = [payload.runRef, payload.sessionNonce]; break;
    case 'run_review':
      check(identifier(payload.runRef) && identifier(payload.reviewRef) && identifier(payload.reconciliationReceiptRef), 'INVALID_REVIEW');
      text = `update uniconnect_migration_control.migration_runs set state='RECONCILED',resolution_ref=$2,receipt_ref=$3
        where scope_id=current_database() and run_ref=$1 and state in ('RUNNING','UNKNOWN') returning state`;
      values = [payload.runRef, payload.reviewRef, payload.reconciliationReceiptRef]; break;
    case 'catalog':
      check(identifier(payload.id) && Number.isInteger(payload.ordinal) && payload.ordinal >= 1 && payload.ordinal <= 11 &&
        sha(payload.rawHash) && sha(payload.normalizedHash), 'INVALID_CATALOG_ENTRY');
      text = `insert into uniconnect_migration_control.migration_catalog(scope_id,migration_id,ordinal,raw_hash,normalized_hash)
        values(current_database(),$1,$2,$3,$4) returning migration_id`;
      values = [payload.id, payload.ordinal, payload.rawHash, payload.normalizedHash]; break;
    case 'admit':
      check(identifier(payload.id) && sha(payload.rawHash) && sha(payload.normalizedHash) &&
        sha(payload.packageDigest) && uuid(payload.attemptId) && identifier(payload.runRef) &&
        uuid(payload.sessionNonce) && (payload.retryAuthorizationRef == null || identifier(payload.retryAuthorizationRef)), 'INVALID_ADMISSION');
      text = `insert into uniconnect_migration_control.migration_attempts
        (attempt_id,scope_id,migration_id,raw_hash,normalized_hash,attempt_no,run_ref,package_digest,consumed_authorization_ref,session_nonce)
        select $1::uuid,current_database(),$2,$3,$4,coalesce(max(attempt_no),0)+1,$5,$6,$7,$8::uuid
        from uniconnect_migration_control.migration_attempts where scope_id=current_database() and migration_id=$2 returning attempt_id,state`;
      values = [payload.attemptId, payload.id, payload.rawHash, payload.normalizedHash, payload.runRef, payload.packageDigest, payload.retryAuthorizationRef ?? null, payload.sessionNonce]; break;
    case 'finish':
      check(uuid(payload.attemptId) && ['APPLIED', 'FAILED', 'UNKNOWN'].includes(payload.state) &&
        ['COMMITTED', 'NOT_COMMITTED', 'NOT_DISPATCHED', 'UNKNOWN'].includes(payload.outcome) &&
        ['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN'].includes(payload.postcheck) && identifier(payload.receiptRef) &&
        identifier(payload.runRef) && uuid(payload.sessionNonce), 'INVALID_COMPLETION');
      check(payload.state !== 'APPLIED' || (payload.outcome === 'COMMITTED' && payload.postcheck === 'PASS' && payload.commitAck === true), 'COMMIT_PROOF_REQUIRED');
      check(payload.state !== 'FAILED' || payload.outcome !== 'UNKNOWN', 'KNOWN_OUTCOME_REQUIRED');
      check(payload.outcome !== 'COMMITTED' || payload.commitAck === true, 'COMMIT_PROOF_REQUIRED');
      failure(payload);
      text = `update uniconnect_migration_control.migration_attempts set state=$2,commit_outcome=$3,postcheck=$4,
        receipt_ref=$5,commit_ack_at=case when $6 then clock_timestamp() else null end,
        finished_at=case when $2='UNKNOWN' then null else clock_timestamp() end,failure_kind=$7
        where attempt_id=$1::uuid and state='RUNNING' and run_ref=$8 and session_nonce=$9::uuid returning attempt_id,state`;
      values = [payload.attemptId, payload.state, payload.outcome, payload.postcheck, payload.receiptRef, payload.commitAck === true, failure(payload), payload.runRef, payload.sessionNonce]; break;
    case 'review':
      check(uuid(payload.attemptId) && ['APPLIED', 'FAILED', 'UNKNOWN'].includes(payload.state) &&
        ['COMMITTED', 'NOT_COMMITTED', 'NOT_DISPATCHED', 'UNKNOWN'].includes(payload.outcome) &&
        ['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN'].includes(payload.postcheck) && identifier(payload.reviewRef) &&
        identifier(payload.reconciliationReceiptRef) && (payload.retryAuthorizationRef == null || identifier(payload.retryAuthorizationRef)), 'INVALID_REVIEW');
      check(payload.state !== 'APPLIED' || (payload.outcome === 'COMMITTED' && payload.postcheck === 'PASS' && payload.commitAck === true), 'COMMIT_PROOF_REQUIRED');
      check(payload.outcome !== 'COMMITTED' || payload.commitAck === true, 'COMMIT_PROOF_REQUIRED');
      check(payload.state !== 'FAILED' || payload.outcome !== 'UNKNOWN', 'KNOWN_OUTCOME_REQUIRED');
      check(payload.retryAuthorizationRef == null || (payload.state === 'FAILED' && ['NOT_DISPATCHED', 'NOT_COMMITTED'].includes(payload.outcome)), 'RETRY_NOT_SAFE');
      failure(payload);
      text = `update uniconnect_migration_control.migration_attempts set state=$2,commit_outcome=$3,postcheck=$4,
        resolution_ref=$5,reconciliation_receipt_ref=$6,retry_authorization_ref=coalesce(retry_authorization_ref,$7),
        commit_ack_at=case when $8 then coalesce(commit_ack_at,clock_timestamp()) else commit_ack_at end,
        finished_at=case when $2='UNKNOWN' then null else coalesce(finished_at,clock_timestamp()) end,failure_kind=$9
        where attempt_id=$1::uuid and state in ('RUNNING','UNKNOWN','FAILED') returning attempt_id,state`;
      values = [payload.attemptId, payload.state, payload.outcome, payload.postcheck, payload.reviewRef,
        payload.reconciliationReceiptRef, payload.retryAuthorizationRef ?? null, payload.commitAck === true, failure(payload)]; break;
    default: check(false, 'UNKNOWN_OPERATION');
  }
  return freeze({ operation, text, values });
}
function validateIdentity(token, row) {
  const c = targetData(token);
  check(row && row.database === c.database && row.login === c.role && row.role === c.role &&
    Number.isInteger(row.pid) && row.pid > 0 && row.version === 170011 &&
    Number.isInteger(row.database_oid) && row.database_oid > 0 &&
    [row.backend_start, row.server_start].every(value => typeof dateText(value) === 'string' && Number.isFinite(Date.parse(dateText(value)))) &&
    row.fixture_marker === 'authorized-local-only-v1', 'DISPOSABLE_IDENTITY_MISMATCH');
  return freeze({ observed: true, qualifiedForExecution: false, pid: row.pid });
}
function buildPgOptions(token, secret, inheritedNames) {
  validateEnvironmentNames(inheritedNames); // Only names; never inspect/log inherited values.
  const c = targetData(token);
  check(typeof secret === 'string' && secret.length >= 24, 'LOCAL_SECRET_REQUIRED');
  const options = { host: c.host, port: c.port, database: c.database, user: c.role, ssl: false,
    options: '-c search_path=pg_catalog,public', client_encoding: 'UTF8', binary: false,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, application_name: `pgc_${c.runId}` };
  Object.defineProperty(options, 'password', { value: secret, enumerable: false });
  return Object.freeze(options);
}
async function openPgSession(token, secret) {
  executionBlocked(); // No caller/env/metadata can bypass this barrier in this version.
  // Prepared pg binding; deliberately unreachable until a separately reviewed release.
  const options = buildPgOptions(token, secret, Object.keys(process.env));
  const { Client } = require('pg');
  const client = new Client(options);
  try {
    await client.connect();
    validateIdentity(token, (await client.query(descriptor('identity').text)).rows[0]);
    return client;
  } catch {
    await client.end().catch(() => {});
    check(false, 'LOCAL_PG_OPEN_FAILED');
  }
}
class PreparedPgAdapter {
  #target; #protocol; #nonce;
  constructor(token) { targetData(token); this.#target = token; }
  observeSession(row, nonce) {
    check(!this.#protocol && uuid(nonce), 'SESSION_ALREADY_BOUND_OR_INVALID'); validateIdentity(this.#target, row);
    this.#nonce = nonce;
    this.#protocol = new SessionLockProtocol({ pid: row.pid, backendStart: dateText(row.backend_start), serverStart: dateText(row.server_start),
      databaseOid: row.database_oid, login: row.login, role: row.role, nonce });
  }
  prepare(operation, payload) {
    if (operation === 'lock') { check(this.#protocol, 'SESSION_IDENTITY_REQUIRED'); this.#protocol.requestAcquire(); }
    else if (operation !== 'identity') {
      check(this.#protocol?.report().state === 'HELD', 'LOCK_NOT_HELD');
      if (['run_open', 'run_unknown', 'admit', 'finish'].includes(operation)) check(payload?.sessionNonce === this.#nonce, 'SESSION_NONCE_MISMATCH');
      if (operation === 'unlock') this.#protocol.requestRelease();
    }
    return descriptor(operation, payload);
  }
  recordLockObservation(observation) { check(this.#protocol, 'SESSION_IDENTITY_REQUIRED'); return this.#protocol.acknowledge(observation); }
  recordReleaseObservation(session, acknowledged) { check(this.#protocol, 'SESSION_IDENTITY_REQUIRED'); this.#protocol.acknowledgeRelease(session, acknowledged); }
  notifySessionLost() { check(this.#protocol, 'SESSION_IDENTITY_REQUIRED'); this.#protocol.loseSession(); }
  observeBoundary(session, held) { check(this.#protocol, 'SESSION_IDENTITY_REQUIRED'); return this.#protocol.boundary(session, held); }
  async connect(secret) { return openPgSession(this.#target, secret); }
  async execute() { executionBlocked(); }
}
module.exports = { PreparedPgAdapter, descriptor, validateIdentity, openPgSession, buildPgOptions, LOCK_KEY };
