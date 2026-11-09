'use strict';
require('../network-api-sentinels.cjs');
require('../deny-migration-network.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('./local-lab.cjs');
const pg = require('./control-store.pg.cjs');
const { SessionLockProtocol, RunFenceModel } = require('./run-model.cjs');
const { HelperObserver } = require('./helper-observer.cjs');
const { PgFaultGate } = require('./fault-gateway.cjs');
const err = code => e => e?.code === code && e.message === code;
const nonce = '11111111-1111-4111-8111-111111111111';
const session = () => ({ pid: 41, backendStart: '2026-11-01T10:00:00Z', serverStart: '2026-11-01T09:00:00Z',
  databaseOid: 99, login: 'pgc_executor', role: 'pgc_executor', nonce });
const config = () => ({ version: 1, runId: 'a'.repeat(32), host: '127.0.0.1', port: 5432, database: `pgc_${'a'.repeat(32)}`,
  role: 'pgc_executor', postgresImage: `postgres@sha256:${'1'.repeat(64)}`, workerImage: `node@sha256:${'2'.repeat(64)}`,
  nodeMajor: 22, engine: 'npipe:////./pipe/dockerDesktopLinuxEngine' });
const proof = { commit: 'COMMITTED', postcheck: 'PASS', receiptRef: 'receipt-1' };
const review = { ...proof, role: 'pgc_reviewer', reviewRef: 'review-1' };
const frame = (type, payload) => { const p = Buffer.from(payload), b = Buffer.alloc(5); b[0] = type.charCodeAt(0); b.writeUInt32BE(p.length + 4, 1); return Buffer.concat([b, p]); };
const commitFrame = () => frame('C', 'COMMIT\0'), idle = () => frame('Z', 'I');
const correlation = () => ({ runRef: 'run-1', attemptId: 'attempt-1', queryRef: 'source-commit-1', phase: 'MIGRATION_COMMIT' });
function armed(mode) {
  const g = new PgFaultGate(mode), c = correlation();
  g.confirmAdmission({ ...c, receiptRef: 'ledger-admission-ack-1' }); g.arm(c); return g;
}
function observer() {
  const name = '20260528000002_activities_grades_reports.sql';
  const text = fs.readFileSync(path.join(__dirname, '../../..', 'supabase/migrations', name), 'utf8');
  const o = new HelperObserver(name, text); o.afterQuery(o.beforeQuery('begin'), { command: 'BEGIN' }, 'T');
  return { o, text };
}

for (const patch of [{ kind: 'session', mode: 'ShareLock' }, { kind: 'transaction', mode: 'ExclusiveLock' }, { kind: 'unknown', mode: 'ExclusiveLock' }])
  test(`R1 negative lock observation ${JSON.stringify(patch)} stops the synthetic driver`, () => {
    const s = session(), driver = new SessionLockProtocol(s); driver.requestAcquire();
    assert.throws(() => driver.acknowledge({ ...patch, acquired: true, session: s }), err('SESSION_EXCLUSIVE_LOCK_REQUIRED'));
    assert.equal(driver.report().state, 'UNKNOWN');
    assert.throws(() => driver.requestAcquire(), err('ACQUISITION_ALREADY_ATTEMPTED'));
  });
test('R1 driver permits one acquisition request and never claims physical continuity', () => {
  const s = session(), d = new SessionLockProtocol(s); d.requestAcquire();
  assert.equal(d.acknowledge({ kind: 'session', mode: 'ExclusiveLock', acquired: true, session: s }), 'HELD');
  assert.throws(() => d.requestAcquire(), err('ACQUISITION_ALREADY_ATTEMPTED'));
  assert.equal(d.boundary(s, true), 'SYNTHETIC_OBSERVATION_ONLY'); assert.equal(d.report().continuityProven, false);
  d.release(s, true); assert.equal(d.report().state, 'RELEASED');
});
for (const change of [{ backendStart: '2026-11-01T11:00:00Z' }, { serverStart: '2026-11-01T11:00:00Z' },
  { databaseOid: 100 }, { nonce: '22222222-2222-4222-8222-222222222222' }]) test(`R1/R2 same PID is not sufficient ${JSON.stringify(change)}`, () => {
  const s = session(), d = new SessionLockProtocol(s); d.requestAcquire(); d.acknowledge({ kind: 'session', mode: 'ExclusiveLock', acquired: true, session: s });
  assert.throws(() => d.boundary({ ...s, ...change }, true), err('SESSION_LOST_OR_LOCK_UNPROVEN'));
  assert.equal(d.report().state, 'UNKNOWN');
});
test('R1 lost lock/release ack and session loss never allow reacquisition', () => {
  for (const mode of ['lock-lost', 'session-lost', 'release-ack-lost']) {
    const s = session(), d = new SessionLockProtocol(s); d.requestAcquire(); d.acknowledge({ kind: 'session', mode: 'ExclusiveLock', acquired: true, session: s });
    if (mode === 'lock-lost') assert.throws(() => d.boundary(s, false), err('SESSION_LOST_OR_LOCK_UNPROVEN'));
    if (mode === 'session-lost') d.loseSession();
    if (mode === 'release-ack-lost') assert.throws(() => d.release(s), err('RELEASE_ACK_UNKNOWN'));
    assert.throws(() => d.requestAcquire(), err('ACQUISITION_ALREADY_ATTEMPTED'));
  }
});
test('R1 prepared pg driver owns the once-only request and bound session identity', () => {
  const a = new pg.PreparedPgAdapter(lab.prepareTarget(config()));
  assert.throws(() => a.prepare('lock'), err('SESSION_IDENTITY_REQUIRED'));
  const s = session(); a.observeSession({ database: config().database, pid: s.pid, backend_start: new Date(s.backendStart),
    server_start: new Date(s.serverStart), database_oid: s.databaseOid, login: s.login, role: s.role, version: 170011,
    fixture_marker: 'authorized-local-only-v1' }, nonce);
  assert.equal(a.prepare('lock').operation, 'lock');
  assert.throws(() => a.prepare('lock'), err('ACQUISITION_ALREADY_ATTEMPTED'));
});
for (const scenario of ['refused', 'lost', 'wrong-nonce', 'release-pending']) test(`R1/R2 prepared driver cannot prepare writes after ${scenario}`, () => {
  const a = new pg.PreparedPgAdapter(lab.prepareTarget(config())), s = session();
  a.observeSession({ database: config().database, pid: s.pid, backend_start: s.backendStart, server_start: s.serverStart,
    database_oid: s.databaseOid, login: s.login, role: s.role, version: 170011, fixture_marker: 'authorized-local-only-v1' }, nonce);
  a.prepare('lock'); a.recordLockObservation({ kind: 'session', mode: 'ExclusiveLock', acquired: scenario !== 'refused', session: s });
  if (scenario === 'lost') a.notifySessionLost();
  if (scenario === 'release-pending') a.prepare('unlock');
  const p = { runRef: 'run-1', sessionNonce: scenario === 'wrong-nonce' ? '22222222-2222-4222-8222-222222222222' : nonce, packageDigest: '1'.repeat(64) };
  assert.throws(() => a.prepare('run_open', p), err(scenario === 'wrong-nonce' ? 'SESSION_NONCE_MISMATCH' : 'LOCK_NOT_HELD'));
});
test('R2 a successor cannot normally finalize RUNNING, even with reused PID', () => {
  const m = new RunFenceModel(), original = session(), other = { ...original, backendStart: '2026-11-01T12:00:00Z' };
  m.open('run-1', original); m.admit('attempt-1', 'run-1', original);
  assert.throws(() => m.finish('attempt-1', 'run-1', other, proof), err('RUN_OWNER_OR_STATE_MISMATCH'));
  assert.equal(m.observe().attempts[0].state, 'RUNNING');
  assert.throws(() => m.reconcileAttempt('attempt-1', { ...review, role: 'pgc_executor' }), err('MANUAL_RECONCILIATION_REQUIRED'));
  m.reconcileAttempt('attempt-1', review);
  assert.deepEqual(m.observe().attempts[0].history, ['RUNNING']);
  assert.equal(m.observe().attempts[0].receiptRef, null);
  assert.equal(m.observe().attempts[0].reconciliationReceiptRef, 'receipt-1');
  assert.equal(m.observe().runs[0].state, 'RUNNING');
});
test('R2 attempt cannot be reassigned to another run', () => {
  const m = new RunFenceModel(), s = session(); m.open('run-1', s); m.admit('attempt-1', 'run-1', s);
  assert.throws(() => m.finish('attempt-1', 'run-other', s, proof), err('RUN_OWNER_OR_STATE_MISMATCH'));
});
test('R3 APPLIED with lost acknowledgement remains APPLIED and fences the entire run', () => {
  const m = new RunFenceModel(), s = session(); m.open('run-1', s); m.admit('attempt-1', 'run-1', s);
  m.finish('attempt-1', 'run-1', s, proof); m.loseAcknowledgement('run-1');
  assert.equal(m.observe().attempts[0].state, 'APPLIED'); assert.equal(m.observe().runs[0].state, 'UNKNOWN');
  assert.throws(() => m.open('run-2', s), err('RUN_FENCE_BLOCKED'));
  assert.throws(() => m.admit('attempt-2', 'run-1', s), err('RUN_OWNER_OR_STATE_MISMATCH'));
  assert.throws(() => m.closeRun('run-1', { ...review, role: 'pgc_executor' }), err('MANUAL_RECONCILIATION_REQUIRED'));
  m.closeRun('run-1', review); m.open('run-2', { ...s, nonce: 'new-synthetic-nonce' });
  assert.throws(() => m.admit('attempt-1', 'run-2', { ...s, nonce: 'new-synthetic-nonce' }), err('ATTEMPT_BLOCKED'));
  assert.equal(m.observe().attempts[0].state, 'APPLIED');
});
test('R3 successful normal run remains fenced until a manual close; unfinished attempts block closure', () => {
  const m = new RunFenceModel(), s = session(); m.open('run-1', s); m.admit('attempt-1', 'run-1', s);
  assert.throws(() => m.closeRun('run-1', review), err('MANUAL_RECONCILIATION_REQUIRED'));
  m.finish('attempt-1', 'run-1', s, proof);
  assert.throws(() => m.open('run-2', s), err('RUN_FENCE_BLOCKED'));
  assert.equal(m.observe().runs[0].state, 'RUNNING');
});
test('R2/R3 descriptors bind normal finish and query run fences independently of APPLIED', () => {
  const d = pg.descriptor('finish', { attemptId: nonce, runRef: 'run-1', sessionNonce: nonce, state: 'APPLIED',
    outcome: 'COMMITTED', commitAck: true, postcheck: 'PASS', receiptRef: 'r-1' });
  assert.match(d.text, /run_ref=\$8 and session_nonce=\$9/);
  assert.match(pg.descriptor('pending').text, /migration_runs/);
  assert.match(pg.descriptor('run_review', { runRef: 'run-1', reviewRef: 'review', reconciliationReceiptRef: 'receipt' }).text, /RECONCILED/);
});
for (const ready of ['I', 'UNKNOWN', 'E']) test(`R4 SOURCE S03 ending in ${ready} cannot lead to COMMIT proof`, () => {
  const { o, text } = observer(); o.afterQuery(o.beforeQuery(text), { command: 'ALTER' }, ready);
  assert.equal(o.receipt('PASS').appliedCandidate, false); assert.equal(o.receipt().phase, 'UNKNOWN');
  assert.throws(() => o.beforeQuery('commit'), err('QUERY_AFTER_FAILURE'));
});
for (const ready of ['I', 'UNKNOWN']) test(`R4 auxiliary precommit query ending in ${ready} loses certainty`, () => {
  const { o } = observer(); o.afterQuery(o.beforeQuery('select 1'), { command: 'SELECT' }, ready);
  assert.equal(o.receipt('PASS').appliedCandidate, false);
  assert.throws(() => o.beforeQuery('commit'), err('QUERY_AFTER_FAILURE'));
});
for (const state of ['25P01', '25001', '25P02', '40001', '40P01', '08006', '57014']) test(`R4 SQLSTATE ${state} prevents a candidate`, () => {
  const { o, text } = observer(); o.afterQuery(o.beforeQuery(text), { command: 'ALTER' }, 'T'); o.recordNotice(state);
  assert.equal(o.receipt('PASS').appliedCandidate, false);
  assert.throws(() => o.beforeQuery('commit'), err('QUERY_AFTER_FAILURE'));
});
test('R4 commit interruption and missing idle are UNKNOWN; later interruption preserves a known commit', () => {
  for (const mode of ['pending', 'missing-idle', 'after-ack']) {
    const { o, text } = observer(); o.afterQuery(o.beforeQuery(text), { command: 'ALTER' }, 'T'); const q = o.beforeQuery('commit');
    if (mode !== 'pending') o.afterQuery(q, { command: 'COMMIT' }, mode === 'after-ack' ? 'I' : 'UNKNOWN');
    o.interrupt(); const receipt = o.receipt('PASS'); assert.equal(receipt.appliedCandidate, false);
    assert.equal(receipt.commitOutcome, mode === 'after-ack' ? 'COMMITTED' : 'UNKNOWN');
  }
});
test('R5 unarmed gateway never fires on generic COMMIT frames', () => {
  for (const mode of ['DROP_COMMIT_ACK', 'CLOSE_AFTER_COMMIT_IDLE', 'DROP_BEFORE_COMMIT']) {
    const g = new PgFaultGate(mode); g.feed('backend', Buffer.concat([commitFrame(), idle()]));
    assert.equal(g.report().fired, false); assert.equal(g.report().evidence, null);
  }
});
test('R5 cannot arm without admission or for a ledger phase', () => {
  const c = correlation(), g = new PgFaultGate('DROP_COMMIT_ACK');
  assert.throws(() => g.arm(c), err('ARMING_NOT_AUTHORIZED'));
  g.confirmAdmission({ ...c, receiptRef: 'admission' });
  assert.throws(() => g.arm({ ...c, phase: 'LEDGER_COMPLETION' }), err('ARMING_NOT_AUTHORIZED'));
});
for (const mismatch of [{ phase: 'LEDGER_ADMISSION' }, { phase: 'LEDGER_COMPLETION' }, { attemptId: 'other-attempt' },
  { runRef: 'other-run' }, { queryRef: 'other-query' }]) test(`R5 incorrect correlation does not fire ${JSON.stringify(mismatch)}`, () => {
  const g = armed('DROP_COMMIT_ACK'); g.beginQuery({ ...correlation(), ...mismatch });
  g.feed('frontend', frame('Q', 'commit\0'));
  assert.equal(g.feed('backend', Buffer.concat([commitFrame(), idle()])).forward.length, 2);
  assert.equal(g.report().fired, false); assert.equal(g.report().evidence, null);
});
test('R5 target migration can be armed across a ledger COMMIT without firing on that ledger', () => {
  const g = armed('DROP_COMMIT_ACK'); g.beginQuery({ ...correlation(), queryRef: 'ledger-1', phase: 'LEDGER_COMPLETION' });
  g.feed('frontend', frame('Q', 'commit\0'));
  g.feed('backend', Buffer.concat([commitFrame(), idle()])); assert.equal(g.report().fired, false);
  g.beginQuery(correlation()); g.feed('frontend', frame('Q', 'commit\0')); assert.equal(g.feed('backend', commitFrame()).forward.length, 0);
  assert.deepEqual(g.report().evidence, { ...correlation(), point: 'SERVER_COMMIT_ACK_WITHHELD', evidenceClass: 'SYNTHETIC_ONLY', frontendQueryFrames: 1, admissionReceiptRef: 'ledger-admission-ack-1' });
});
test('R5 refuses changing context while fragments are buffered or a query remains active', () => {
  const g = armed('DROP_COMMIT_ACK'); g.beginQuery(correlation()); g.feed('backend', commitFrame().subarray(0, 3));
  assert.throws(() => g.beginQuery({ ...correlation(), queryRef: 'new' }), err('QUERY_CORRELATION_ERROR'));
  assert.equal(g.report().fired, false);
});
for (const split of [false, true]) test(`R5 independent review: second Q cannot inherit the first queryRef, fragmented=${split}`, () => {
  const g = armed('DROP_BEFORE_COMMIT'); g.beginQuery(correlation());
  const first = frame('Q', 'select 1\0'), second = frame('Q', 'commit\0');
  if (split) { g.feed('frontend', first); g.feed('frontend', second.subarray(0, 3)); }
  assert.throws(() => g.feed('frontend', split ? second.subarray(3) : Buffer.concat([first, second])), err('EXTENDED_OR_PIPELINED_PROTOCOL_UNSUPPORTED'));
  assert.equal(g.report().fired, false); assert.equal(g.report().failed, true);
});
test('R5 backend COMMIT alone and extended Execute cannot fabricate target correlation', () => {
  const g = armed('DROP_COMMIT_ACK'); g.beginQuery(correlation());
  g.feed('backend', Buffer.concat([commitFrame(), idle()])); assert.equal(g.report().fired, false);
  const extended = armed('DROP_COMMIT_ACK'); extended.beginQuery(correlation());
  assert.throws(() => extended.feed('frontend', frame('E', '\0\0\0\0\0')), err('EXTENDED_OR_PIPELINED_PROTOCOL_UNSUPPORTED'));
});
for (const name of ['PGOPTIONS', 'PGHOST', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSSLMODE', 'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 'NODE_OPTIONS', 'DOCKER_HOST', 'PATH']) test(`R6 inherited ${name} is refused without reading its value`, () => {
  const env = {}; Object.defineProperty(env, name, { enumerable: true, get() { assert.fail('must not inspect a rejected variable value'); } });
  assert.throws(() => lab.buildMinimalEnvironment(env), err('INHERITED_ENVIRONMENT_REJECTED'));
  assert.throws(() => pg.buildPgOptions(lab.prepareTarget(config()), 'synthetic-password-never-used', [name]), err('INHERITED_ENVIRONMENT_REJECTED'));
});
test('R6 minimum environment is copied from fixed allowlist; pg options do not fall back to PGOPTIONS', () => {
  assert.deepEqual(lab.buildMinimalEnvironment({ TZ: 'UTC' }), { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' });
  assert.throws(() => lab.buildMinimalEnvironment({ TZ: 'synthetic-invalid' }), err('INVALID_ENVIRONMENT'));
  const options = pg.buildPgOptions(lab.prepareTarget(config()), 'synthetic-password-never-used', ['LANG', 'LC_ALL', 'TZ']);
  assert.equal(options.options, '-c search_path=pg_catalog,public'); assert.equal(options.client_encoding, 'UTF8');
  assert.doesNotMatch(JSON.stringify(options), /synthetic-password/);
  assert.throws(() => pg.buildPgOptions(lab.prepareTarget(config()), 'synthetic-password-never-used'), err('INHERITED_ENVIRONMENT_REJECTED'));
});
test('R1–R3 fixture contains server binding, exclusive guard and independent run fence (static only)', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'ledger.fixture.sql'), 'utf8');
  for (const text of ["mode='ExclusiveLock'", 'migration_runs', 'pgc_one_fenced_run', 'backend_start', 'server_start',
    'session_nonce', 'executor_login', 'PGC_ORIGINAL_SESSION_REQUIRED', 'PGC_RUN_REVIEW_REQUIRED', 'PGC_UNRESOLVED_ATTEMPTS']) assert.ok(sql.includes(text));
  assert.ok(sql.includes("NEW.blocks_scope:=NEW.state<>'RECONCILED'"));
});
