'use strict';
require('../network-api-sentinels.cjs');
require('../deny-migration-network.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('./local-lab.cjs');
const pg = require('./control-store.pg.cjs');
const { PgFaultGate, startProxy } = require('./fault-gateway.cjs');
const { HelperObserver, runObservedHelper } = require('./helper-observer.cjs');
const { CASES, assertCaseEvidence, runIntegratedCase } = require('./contracts.postgres.test.cjs');
const config = () => ({ version: 1, runId: 'a'.repeat(32), host: '127.0.0.1', port: 5432,
  database: `pgc_${'a'.repeat(32)}`, role: 'pgc_executor', postgresImage: `postgres@sha256:${'1'.repeat(64)}`,
  workerImage: `node@sha256:${'2'.repeat(64)}`, nodeMajor: 22, engine: 'npipe:////./pipe/dockerDesktopLinuxEngine' });
function topology(c = config()) {
  const container = (id, image, networkMode) => ({ id, runId: c.runId, image, networkMode,
    networks: [], portBindings: {}, privileged: false, mounts: [] });
  return { daemon: { endpoint: c.engine, os: 'linux', local: true },
    postgres: container('b'.repeat(64), c.postgresImage, 'none'),
    worker: container('c'.repeat(64), c.workerImage, `container:${'b'.repeat(64)}`),
    supervisor: { isolationRef: 'synthetic-os-review', independentlyReviewed: true } };
}
const error = expected => e => e?.code === expected && e.message === expected;
const frame = (type, payload) => { const p = Buffer.from(payload), b = Buffer.alloc(5); b[0] = type.charCodeAt(0); b.writeUInt32BE(p.length + 4, 1); return Buffer.concat([b, p]); };
const query = text => frame('Q', `${text}\0`), commit = () => frame('C', 'COMMIT\0'), idle = () => frame('Z', 'I');
function armedGate(mode) {
  const gate = new PgFaultGate(mode), c = { runRef: 'run-1', attemptId: 'attempt-1', queryRef: 'source-1', phase: 'MIGRATION_COMMIT' };
  gate.confirmAdmission({ ...c, receiptRef: 'admission-1' }); gate.arm(c); gate.beginQuery(c); return gate;
}

test('supervisor is offline even with fully consistent synthetic declarations', () => {
  const token = lab.prepareTarget(config()), report = lab.inspectTopology(token, topology());
  assert.equal(report.declarationsConsistent, true); assert.equal(report.isolationVerified, false);
  assert.equal(report.executionEnabled, false); assert.equal(report.readiness, 'NO_GO');
  assert.equal(lab.lifecyclePlan(token).containerPolicy.publishPorts, false);
  assert.equal(lab.lifecyclePlan(token).containerPolicy.pull, 'never');
});
for (const host of ['localhost', '::1', '127.0.0.2', 'db.pvacwfypqsstdrfxajkg.supabase.co', 'db.kpwofazhpiqrxjvxkozl.supabase.co', 'host.docker.internal', '\\\\server\\share']) {
  test(`rejects noncanonical destination ${host}`, () => assert.throws(() => lab.prepareTarget({ ...config(), host }), error('LOCAL_TARGET_REQUIRED')));
}
for (const [key, value] of [['password', 'synthetic-secret'], ['connectionString', 'synthetic-dsn'], ['authorized', true], ['osIsolated', true], ['env', {}]])
  test(`configuration cannot add ${key}`, () => assert.throws(() => lab.prepareTarget({ ...config(), [key]: value }), error('INVALID_CONFIG')));
for (const patch of [{ port: 6543 }, { database: 'postgres' }, { runId: 'unknown' }, { role: 'postgres' },
  { engine: 'tcp://127.0.0.1:2375' }, { engine: 'ssh://remote' }, { postgresImage: 'postgres:17' },
  { workerImage: 'node:22' }, { nodeMajor: 20 }, { version: 2 }]) test(`rejects incomplete or unsafe declaration ${JSON.stringify(patch)}`, () => assert.throws(() => lab.prepareTarget({ ...config(), ...patch })));
for (const [name, change] of [
  ['remote daemon', t => { t.daemon.endpoint = 'ssh://remote'; }],
  ['unconfirmed daemon', t => { t.daemon.local = false; }],
  ['Windows daemon', t => { t.daemon.os = 'windows'; }],
  ['bridge', t => { t.postgres.networkMode = 'bridge'; }],
  ['worker host network', t => { t.worker.networkMode = 'host'; }],
  ['additional network', t => { t.worker.networks = ['bridge']; }],
  ['published port', t => { t.postgres.portBindings = { '5432/tcp': [{ HostPort: '5432' }] }; }],
  ['host mount', t => { t.worker.mounts = ['docker.sock']; }],
  ['privileged', t => { t.worker.privileged = true; }],
  ['foreign run', t => { t.postgres.runId = 'f'.repeat(32); }],
  ['wrong digest', t => { t.worker.image = 'node:24'; }],
  ['missing OS review', t => { t.supervisor.independentlyReviewed = false; }],
  ['same container', t => { t.worker.id = t.postgres.id; }],
]) test(`topology rejects ${name} without I/O`, () => {
  const t = topology(); change(t); const result = lab.inspectTopology(lab.prepareTarget(config()), t);
  assert.equal(result.declarationsConsistent, false); assert.equal(result.executionEnabled, false);
});
test('topology and token cannot be replaced with approval booleans', () => {
  assert.equal(lab.inspectTopology(lab.prepareTarget(config()), {}).declarationsConsistent, false);
  assert.throws(() => lab.inspectTopology({ qualified: true }, topology()), error('LOCAL_TARGET_TOKEN_REQUIRED'));
});
test('config snapshot and cleanup plans are immutable and scoped to owned IDs', () => {
  const c = config(), token = lab.prepareTarget(c); c.host = 'remote';
  assert.equal(lab.targetData(token).host, '127.0.0.1');
  const own = [{ id: 'b'.repeat(64), runId: 'a'.repeat(32) }];
  assert.equal(lab.ownedCleanupPlan(token, own).executable, false);
  assert.throws(() => lab.ownedCleanupPlan(token, [{ ...own[0], runId: 'wrong' }]), error('RESOURCE_OWNERSHIP_REQUIRED'));
  assert.throws(() => lab.ownedCleanupPlan(token, [own[0], own[0]]), error('RESOURCE_OWNERSHIP_REQUIRED'));
});
for (const args of [['--execute'], ['--execute', '--config', '\\\\server\\secret'], ['--run'], ['--allow-local-migrations'], ['--force'], ['--offline'], []])
  test(`CLI never enables execution ${JSON.stringify(args)}`, () => {
    const lines = []; assert.equal(lab.main(args, line => lines.push(line)), 2);
    assert.equal(JSON.parse(lines[0]).executionEnabled, false); assert.doesNotMatch(lines[0], /server|secret/);
  });
test('all live entry points fail before pg, sockets, helper, credentials or services', async () => {
  const token = lab.prepareTarget(config());
  await assert.rejects(pg.openPgSession(token, 'synthetic-secret-not-a-real-password'), error('LOCAL_EXECUTION_DISABLED'));
  await assert.rejects(new pg.PreparedPgAdapter(token).connect('synthetic-secret'), error('LOCAL_EXECUTION_DISABLED'));
  await assert.rejects(new pg.PreparedPgAdapter(token).execute(), error('LOCAL_EXECUTION_DISABLED'));
  await assert.rejects(runObservedHelper(), error('LOCAL_EXECUTION_DISABLED'));
  await assert.rejects(runIntegratedCase('PGC-01'), error('LOCAL_EXECUTION_DISABLED'));
  assert.throws(startProxy, error('LOCAL_EXECUTION_DISABLED'));
});
test('identity is specific to a disposable PG17.11 session, never project names or owners', () => {
  const token = lab.prepareTarget(config());
  const row = { database: config().database, login: 'pgc_executor', role: 'pgc_executor', pid: 30, version: 170011, fixture_marker: 'authorized-local-only-v1', database_oid: 123,
    backend_start: '2026-11-01T10:00:00Z', server_start: '2026-11-01T09:00:00Z' };
  assert.equal(pg.validateIdentity(token, row).qualifiedForExecution, false);
  for (const patch of [{ database: 'postgres' }, { login: 'postgres' }, { role: 'postgres' }, { pid: 0 }, { version: 160015 }, { version: 170010 }, { fixture_marker: null }])
    assert.throws(() => pg.validateIdentity(token, { ...row, ...patch }), error('DISPOSABLE_IDENTITY_MISMATCH'));
});
test('pg operation descriptors are parameterized, bounded to fixture and keep provisional key', () => {
  assert.deepEqual(pg.descriptor('lock').values, [1431193923, 1345336576]);
  assert.deepEqual(pg.descriptor('unlock').values, pg.LOCK_KEY);
  const p = { attemptId: '11111111-1111-4111-8111-111111111111', id: 'supabase/schema.sql', rawHash: '1'.repeat(64), normalizedHash: '2'.repeat(64), packageDigest: '3'.repeat(64), runRef: 'synthetic-run', sessionNonce: '22222222-2222-4222-8222-222222222222' };
  const d = pg.descriptor('admit', p); assert.equal(d.text.includes(p.attemptId), false); assert.equal(d.values[0], p.attemptId);
  assert.equal(d.values[6], null); assert.equal(Object.isFrozen(d.values), true);
  assert.throws(() => pg.descriptor('admit', { ...p, id: "x'; drop schema public;" }), error('INVALID_ADMISSION'));
  assert.throws(() => pg.descriptor('raw-sql'), error('UNKNOWN_OPERATION'));
});
test('APPLIED requires commit/postcheck evidence before producing any query descriptor', () => {
  const p = { attemptId: '11111111-1111-4111-8111-111111111111', state: 'APPLIED', outcome: 'COMMITTED', postcheck: 'PASS', receiptRef: 'receipt-1', commitAck: true,
    runRef: 'run-1', sessionNonce: '22222222-2222-4222-8222-222222222222' };
  assert.equal(pg.descriptor('finish', p).values[1], 'APPLIED');
  for (const patch of [{ commitAck: false }, { outcome: 'UNKNOWN' }, { postcheck: 'UNKNOWN' }])
    assert.throws(() => pg.descriptor('finish', { ...p, ...patch }), error('COMMIT_PROOF_REQUIRED'));
});
test('catalog and manual-review descriptors preserve original receipts and reject unsafe retry', () => {
  assert.throws(() => pg.descriptor('catalog', { id: 'source', ordinal: 12 }), error('INVALID_CATALOG_ENTRY'));
  const p = { attemptId: '11111111-1111-4111-8111-111111111111', state: 'FAILED', outcome: 'NOT_COMMITTED',
    postcheck: 'NOT_RUN', reviewRef: 'review-1', reconciliationReceiptRef: 'reconcile-1', retryAuthorizationRef: 'retry-1', failureKind: 'KNOWN_FAILURE' };
  const d = pg.descriptor('review', p);
  assert.match(d.text, /reconciliation_receipt_ref=/); assert.doesNotMatch(d.text, /\sreceipt_ref=/);
  assert.equal(d.values[6], 'retry-1');
  assert.throws(() => pg.descriptor('review', { ...p, outcome: 'COMMITTED', commitAck: true }), error('RETRY_NOT_SAFE'));
});
test('gateway handles fragmented and coalesced messages without a socket', () => {
  const g = new PgFaultGate('PASS'), b = Buffer.concat([query('begin'), query('commit')]);
  assert.equal(g.feed('frontend', b.subarray(0, 3)).forward.length, 0);
  assert.equal(g.feed('frontend', b.subarray(3)).forward.length, 2);
  assert.equal(g.report().fired, false);
});
test('gate stops standalone COMMIT before forwarding it', () => {
  const g = armedGate('DROP_BEFORE_COMMIT'), r = g.feed('frontend', query('COMMIT;'));
  assert.equal(r.forward.length, 0); assert.equal(r.close, true); assert.equal(g.report().serverCommitFrameObserved, false);
});
test('embedded COMMIT is not silently treated as a before-send injection', () => {
  const g = armedGate('DROP_BEFORE_COMMIT'); g.feed('frontend', query('begin; select 1; commit;'));
  assert.equal(g.report().fired, false);
});
test('gate separates server commit observation from client ack', () => {
  const g = armedGate('DROP_COMMIT_ACK'); g.feed('frontend', query('commit'));
  const r = g.feed('backend', Buffer.concat([commit(), idle()]));
  assert.equal(r.forward.length, 0); assert.equal(g.report().serverCommitFrameObserved, true); assert.equal(r.close, true);
});
test('after-commit gate forwards ACK/idle and closes before postcheck', () => {
  const g = armedGate('CLOSE_AFTER_COMMIT_IDLE');
  g.feed('frontend', query('commit'));
  assert.equal(g.feed('backend', Buffer.concat([commit(), idle()])).forward.length, 2);
  assert.equal(g.feed('frontend', query('select 1')).forward.length, 0);
});
test('ROLLBACK does not fire COMMIT gate; no payload enters gateway reports', () => {
  const g = new PgFaultGate('DROP_COMMIT_ACK'); g.feed('backend', frame('C', 'ROLLBACK\0'));
  g.feed('frontend', query('SYNTHETIC_SECRET_DO_NOT_LOG'));
  assert.equal(g.report().fired, false); assert.doesNotMatch(JSON.stringify(g.report()), /SYNTHETIC_SECRET|ROLLBACK/);
});
test('malformed/big protocol frames stop safely', () => {
  assert.throws(() => new PgFaultGate('PASS').feed('backend', Buffer.from([67, 0, 0, 0, 0])), error('INVALID_FRAME_LENGTH'));
  assert.throws(() => new PgFaultGate('PASS').feed('backend', Buffer.alloc(1024 * 1024 + 1)), error('FRAME_LIMIT'));
  assert.throws(() => new PgFaultGate('PASS').feed('backend', frame('Z', 'X')), error('INVALID_READY_FRAME'));
  assert.throws(() => new PgFaultGate('secret'), error('INVALID_GATE_MODE'));
});
test('truncated protocol at EOF is inconclusive rather than a successful barrier', () => {
  const g = new PgFaultGate('DROP_COMMIT_ACK'); g.feed('backend', commit().subarray(0, 6));
  assert.throws(() => g.end('backend'), error('TRUNCATED_PROTOCOL'));
  assert.equal(g.report().fired, false); assert.equal(g.report().failed, true);
});
const root = path.join(__dirname, '../../..');
const manifest = require('../../lib/migration-manifest.cjs');
for (const name of Object.keys(manifest)) test(`observer recognizes class and hash without executing ${name}`, () => {
  const source = fs.readFileSync(path.join(root, 'supabase', name === 'schema.sql' ? name : `migrations/${name}`), 'utf8');
  const observer = new HelperObserver(name, source);
  if (name === '20260528000002_activities_grades_reports.sql') observer.afterQuery(observer.beforeQuery('begin'), { command: 'BEGIN' }, 'T');
  const q = observer.beforeQuery(source);
  observer.afterQuery(q, { command: 'CREATE', rows: [{ sensitive: 'not-logged' }] });
  assert.equal(observer.receipt('PASS').appliedCandidate, false);
  assert.doesNotMatch(JSON.stringify(observer.receipt()), /not-logged|create table|rows/);
});
function observerFixture() {
  const name = '20260528000002_activities_grades_reports.sql';
  const source = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
  const observer = new HelperObserver(name, source); observer.afterQuery(observer.beforeQuery('begin'), { command: 'BEGIN' }, 'T');
  return { source, observer };
}
test('helper observer requires source, commit ACK, idle and postcheck; never qualifies operation', () => {
  const { source, observer: o } = observerFixture();
  const sourceQ = o.beforeQuery(source); o.afterQuery(sourceQ, { command: 'ALTER' }, 'T');
  assert.equal(o.receipt('PASS').appliedCandidate, false);
  const commitQ = o.beforeQuery('commit'); o.afterQuery(commitQ, { command: 'COMMIT' }, 'I');
  assert.equal(o.receipt('PASS').appliedCandidate, true); assert.equal(o.receipt('FAIL').appliedCandidate, false);
  assert.equal(o.receipt('PASS').operationallyQualified, false);
});
test('ROLLBACK tag, pending query and exceptions cannot become commit proof', () => {
  for (const scenario of ['rollback', 'pending', 'error']) {
    const { source, observer: o } = observerFixture(); const sourceQ = o.beforeQuery(source);
    o.afterQuery(sourceQ, { command: 'ALTER' }, 'T'); const q = o.beforeQuery('commit');
    if (scenario === 'rollback') o.afterQuery(q, { command: 'ROLLBACK' }, 'I');
    if (scenario === 'error') o.queryFailed(q);
    assert.equal(o.receipt('PASS').appliedCandidate, false);
  }
});
test('original error and rollback failure keep distinct phases without raw exceptions', () => {
  const { source, observer: o } = observerFixture(); o.queryFailed(o.beforeQuery(source));
  o.queryFailed(o.beforeQuery('rollback'));
  assert.deepEqual(o.receipt().events.filter(e => e.phase === 'QUERY_ERROR').map(e => e.kind), ['SOURCE', 'ROLLBACK']);
  assert.equal(o.receipt('PASS').appliedCandidate, false);
  assert.throws(() => o.beforeQuery(source), error('QUERY_AFTER_FAILURE'));
});
test('observer refuses replay and does not accept a COMMIT tag in an auxiliary phase', () => {
  const { source, observer: o } = observerFixture(); o.afterQuery(o.beforeQuery(source), { command: 'ALTER' }, 'T');
  assert.throws(() => o.beforeQuery(source), error('SOURCE_REPLAY_OR_DRIFT'));
  assert.throws(() => o.beforeQuery('select 1'), error('QUERY_AFTER_FAILURE'));
  const next = observerFixture(); next.observer.afterQuery(next.observer.beforeQuery(next.source), { command: 'ALTER' }, 'T');
  assert.throws(() => next.observer.afterQuery(next.observer.beforeQuery('select 1'), { command: 'COMMIT' }, 'I'), error('INVALID_COMMIT_PHASE'));
  assert.equal(o.receipt('PASS').appliedCandidate, false);
});
test('observer rejects missing/unknown tags without copying payload into receipts', () => {
  const { source, observer: o } = observerFixture();
  assert.throws(() => o.afterQuery(o.beforeQuery(source), { command: 'SYNTHETICSECRET' }, 'I'), error('COMMAND_PROOF_REQUIRED'));
  assert.doesNotMatch(JSON.stringify(o.receipt()), /SYNTHETICSECRET/);
  assert.equal(o.receipt('PASS').appliedCandidate, false);
});
test('helper BEGIN and no nested warning are mandatory; resolved COMMIT alone is insufficient', () => {
  const name = '20260528000002_activities_grades_reports.sql';
  const source = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
  const o = new HelperObserver(name, source);
  assert.throws(() => o.beforeQuery(source), error('HELPER_BEGIN_PROOF_REQUIRED'));
  const other = new HelperObserver(name, source);
  assert.throws(() => other.beforeQuery('commit'), error('INVALID_COMMIT_PHASE'));
  const valid = observerFixture().observer;
  valid.recordNotice('25001'); assert.equal(valid.receipt('PASS').appliedCandidate, false);
  assert.throws(() => valid.beforeQuery(source), error('QUERY_AFTER_FAILURE'));
});
test('configuration example stays incomplete, unqualified and without secret fields', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  assert.throws(() => lab.prepareTarget(c), error('INVALID_RUN'));
  assert.equal(Object.hasOwn(c, 'password'), false); assert.equal(c.postgresImage, null);
});
test('fixture SQL is new, private and guarded; this check does not execute or parse PostgreSQL', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'ledger.fixture.sql'), 'utf8');
  for (const snippet of ['170011', 'PGC_LOCK_REQUIRED', 'security invoker set search_path=pg_catalog',
    'pgc_one_applied', 'pgc_one_blocker', 'pgc_retry_consumed_once', 'nologin', 'nobypassrls', 'PGC_ORIGINAL_RECEIPT_IMMUTABLE', 'PGC_NO_REENTRY']) assert.ok(fixture.includes(snippet));
  assert.doesNotMatch(fixture, /security definer|password\s*['"]|pvacwfypqsstdrfxajkg|kpwofazhpiqrxjvxkozl/i);
});
test('all 28 integrated recipes remain NOT_RUN; unit oracle acceptance cannot mark PASS', () => {
  assert.equal(CASES.length, 28); assert.equal(new Set(CASES.map(c => c.id)).size, 28);
  for (const c of CASES) {
    assert.equal(c.status, 'NOT_RUN'); assert.ok(c.steps.length > 0);
    const mock = { caseId: c.id, provenance: 'LOCAL_POSTGRES_OBSERVATION', serverVersion: 170011, runId: 'a'.repeat(32), observed: c.expected };
    assert.equal(assertCaseEvidence(c.id, mock).executionStatusUnchanged, 'NOT_RUN');
    assert.throws(() => assertCaseEvidence(c.id, { ...mock, observed: {} }), error('CASE_ORACLE_FAILED'));
  }
});
