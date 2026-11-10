require('./network-api-sentinels.cjs');
require('./deny-migration-network.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, digest } = require('./contract-prototype-fixtures.cjs');
const prototype = require('../lib/offline-contracts-prototype.cjs');
const { OfflinePackageVerifier, MemoryControlStore, ScriptedHelperDouble, PrototypeExecutor } = prototype;
// Fixed trust input for a synthetic fixture, maintained separately from its candidate bytes.
// Not a release approval, signature implementation, or operational trust root.
const TRUST = 'ab80a8ef7b3288db25fe761a03a4ff271d954fa0703558a4a1da7e906b2dad35';
function verified() { return new OfflinePackageVerifier(new Map([['test-review-v1', TRUST]]))
  .verify(JSON.stringify(fixture()), 'test-review-v1'); }
function alternative(kind) {
  const p = fixture();
  if (kind === 'baseline') p.baselineRef = 'synthetic-baseline-v2';
  else {
    p.files[0].text = 'SYNTHETIC_CHANGED_SOURCE'; p.files[0].rawHash = digest(p.files[0].text);
    p.files[0].normalizedHash = p.files[0].rawHash;
  }
  const anchor = kind === 'baseline' ? '0241cfa3c13846d4d98652dbf116042f107285353c96b28e02578cb3293fab2d'
    : '2c9594601abf20770ab875b35a83d6c77622dc51d95ff955ec1646044d031eb6';
  return new OfflinePackageVerifier(new Map([['alternative-fixture', anchor]])).verify(JSON.stringify(p), 'alternative-fixture');
}
function setup() {
  const store = new MemoryControlStore(), token = verified(), session = store.openSession();
  assert.equal(store.tryAcquire(session), true);
  store.bootstrapCatalog(session, token); store.release(session);
  const executor = new PrototypeExecutor(store, session, token);
  return { store, token, session, executor };
}
const code = expected => error => error?.code === expected && error.message === expected;
const review = { reviewRef: 'review-1', authorizationRef: 'authorization-1', evidenceRef: 'evidence-1' };
function retryFor(s, attemptId = 'attempt-1') {
  const reviewer = s.store.openSession();
  assert.equal(s.store.tryAcquire(reviewer), true);
  const permit = s.store.authorizeRetry(reviewer, attemptId, review);
  s.store.release(reviewer); return permit;
}

test('prototype cannot enable execution and keeps the lock key provisional', () => {
  assert.deepEqual(prototype.PROTOTYPE_LOCK_KEY, [1431193923, 1345336576]);
  assert.equal(prototype.STATUS.realExecutionAllowed, false);
  assert.equal(prototype.STATUS.readiness, 'NO_GO');
  assert.equal(prototype.STATUS.rehearsals, 'NOT_RUN');
  assert.equal(fixture().files.length, 11);
});

test('trust is mandatory and is copied independently of the caller Map', () => {
  assert.throws(() => new OfflinePackageVerifier(), code('TRUST_ANCHOR_REQUIRED'));
  assert.throws(() => new OfflinePackageVerifier(new Map()), code('TRUST_ANCHOR_REQUIRED'));
  assert.throws(() => new OfflinePackageVerifier(new Map([['x', 'bad']])), code('INVALID_TRUST_ANCHOR'));
  const map = new Map([['test-review-v1', TRUST]]), verifier = new OfflinePackageVerifier(map);
  map.clear(); assert.ok(verifier.verify(JSON.stringify(fixture()), 'test-review-v1'));
});
for (const [name, mutate] of [
  ['source bytes', p => { p.files[0].text += 'changed'; }],
  ['source bytes and digest', p => { p.files[0].text = 'changed'; p.files[0].rawHash = '0'.repeat(64); }],
  ['order', p => { p.files.reverse(); }],
  ['production target', p => { p.projectRef = 'kpwofazhpiqrxjvxkozl'; }],
  ['source omission', p => { p.files.pop(); }],
  ['path alias', p => { p.files[0].id = '../schema.sql'; }],
  ['artifact', p => { p.artifacts[0].text += 'changed'; }],
  ['self supplied anchor', p => { p.anchor = TRUST; }],
  ['case collision', p => { p.files[1].id = p.files[0].id.toUpperCase(); }],
]) test(`external anchor rejects drift in ${name}`, () => {
  const p = fixture(); mutate(p);
  assert.throws(() => new OfflinePackageVerifier(new Map([['test-review-v1', TRUST]]))
    .verify(JSON.stringify(p), 'test-review-v1'), code('ANCHOR_MISMATCH'));
});
test('unknown approval, wrong digest, non-string and oversized input fail closed', () => {
  const v = new OfflinePackageVerifier(new Map([['test-review-v1', TRUST]]));
  assert.throws(() => v.verify(JSON.stringify(fixture()), 'unknown'), code('ANCHOR_MISMATCH'));
  assert.throws(() => v.verify('{}', 'test-review-v1'), code('ANCHOR_MISMATCH'));
  assert.throws(() => v.verify(fixture(), 'test-review-v1'), code('INVALID_PACKAGE'));
  assert.throws(() => v.verify('x'.repeat(1024 * 1024 + 1), 'test-review-v1'), code('INVALID_PACKAGE'));
});
// Additional pinned negative fixtures: even a trusted digest cannot waive shape/integrity rules.
for (const [name, mutate, anchor, expected] of [
  ['shape', p => { p.extra = true; }, '284339203d2d405a559b571550b4dedda8d66de5d49b93b561c4fb2199e1b962', 'INVALID_PACKAGE_CONTEXT'],
  ['production', p => { p.projectRef = 'kpwofazhpiqrxjvxkozl'; }, '47e4d5cc19a7745a65017f545450720df9363cf626756ed17e404ce9d72a2be1', 'INVALID_PACKAGE_CONTEXT'],
  ['count', p => { p.files.pop(); }, '9d648c050ab2566522f5ad09098fb0e4c394e766e1b1a1b34a776df700419242', 'INVALID_PACKAGE_CONTENT'],
  ['order', p => { p.files[0].ordinal = 2; }, '0e03bf74a389568f2ef525ec7f9cec19d6fa7ff9a32ceb5f67db8e62baa7bae9', 'INVALID_SOURCE'],
  ['path', p => { p.files[0].id = '../schema.sql'; }, '14cfab829414b4ce5f1c910a50ab5b393c1b00894c766f719acf8e28c08233cb', 'INVALID_SOURCE'],
  ['source hash', p => { p.files[0].rawHash = '0'.repeat(64); }, 'ca8ec8951d66f272802eafdb93de2b3159fa279ff40010d7ce01a6ded32d5a98', 'INVALID_SOURCE'],
  ['artifact omission', p => { p.artifacts.pop(); }, 'e301881cfb73cea220174636dab91542758796de1c0d20866b530538b5904b41', 'MISSING_ARTIFACT'],
  ['duplicate', p => { p.files[1].id = p.files[0].id; }, '3ce2d707b53888ca4b6490503c7841e643eb12f4ea014274d6c54b83fb95b220', 'INVALID_SOURCE'],
]) test(`independent trust does not waive ${name} validation`, () => {
  const p = fixture(); mutate(p);
  assert.throws(() => new OfflinePackageVerifier(new Map([['negative-fixture', anchor]]))
    .verify(JSON.stringify(p), 'negative-fixture'), code(expected));
});
test('snapshot is opaque, immutable and does not reread a mutated candidate', () => {
  const p = fixture(), bytes = JSON.stringify(p);
  const token = new OfflinePackageVerifier(new Map([['test-review-v1', TRUST]])).verify(bytes, 'test-review-v1');
  p.files[0].text = 'REPLACED'; p.files.length = 0;
  assert.equal(Object.isFrozen(token), true);
  const store = new MemoryControlStore(), session = store.openSession(); store.tryAcquire(session);
  store.bootstrapCatalog(session, token); assert.equal(store.observe().catalog.length, 11);
  assert.throws(() => store.bootstrapCatalog(session, {}), code('VERIFIED_SNAPSHOT_REQUIRED'));
});
test('catalog bootstrap requires own live lock and does not imply APPLIED', () => {
  const store = new MemoryControlStore(), a = store.openSession(), b = store.openSession();
  assert.throws(() => store.bootstrapCatalog(a, verified()), code('LOCK_REQUIRED'));
  store.tryAcquire(a);
  assert.throws(() => store.bootstrapCatalog(b, verified()), code('LOCK_REQUIRED'));
  store.bootstrapCatalog(a, verified()); store.bootstrapCatalog(a, verified());
  assert.equal(store.observe().catalog.length, 11); assert.equal(store.observe().attempts.length, 0);
});
test('no implicit bootstrap or arbitrary database driver', () => {
  const store = new MemoryControlStore(), session = store.openSession();
  assert.throws(() => new PrototypeExecutor(store, session, verified()).start(), code('CATALOG_NOT_READY'));
  assert.equal(store.observe().lockHeld, false);
  assert.throws(() => new PrototypeExecutor({ query() { assert.fail('must not be called'); } }, session, verified()), code('FAKE_STORE_REQUIRED'));
});
test('nonblocking exclusive lock refuses another executor, including reentrance', () => {
  const s = setup(); s.executor.start();
  assert.equal(s.store.tryAcquire(s.session), false);
  const contender = new PrototypeExecutor(s.store, s.store.openSession(), s.token);
  assert.throws(() => contender.start(), code('LOCK_BUSY'));
  assert.equal(s.store.observe().attempts.length, 0);
});
test('session lock survives modeled COMMIT/ROLLBACK boundaries and every source', () => {
  const s = setup(); s.executor.start();
  for (let index = 0; index < 11; index++) {
    s.store.transactionBoundary(s.session);
    assert.equal(s.executor.step(), 'APPLIED');
    assert.equal(s.store.observe().lockHeld, index !== 10);
  }
  const o = s.store.observe(); assert.equal(o.attempts.length, 11);
  assert.ok(o.attempts.every(a => a.state === 'APPLIED' && a.commitOutcome === 'COMMITTED'));
  assert.equal(o.runs[0].state, 'APPLIED');
  assert.throws(() => s.executor.step(), code('EXECUTOR_NOT_ACTIVE'));
});
test('only lock owner can release it', () => {
  const s = setup(), other = s.store.openSession(); s.executor.start();
  assert.throws(() => s.store.release(other), code('LOCK_REQUIRED'));
  assert.equal(s.store.observe().lockHeld, true);
});
test('client loss does not imply server released lock; backend termination is separate', () => {
  const s = setup(); s.executor.start(); s.store.loseClient(s.session);
  assert.equal(s.executor.step(), 'UNKNOWN');
  assert.equal(s.store.observe().lockHeld, true);
  assert.throws(() => s.store.tryAcquire(s.session), code('SESSION_LOST'));
  const fresh = s.store.openSession(); assert.equal(s.store.tryAcquire(fresh), false);
  s.store.terminateBackend(s.session); assert.equal(s.store.tryAcquire(fresh), true);
  s.store.release(fresh);
  assert.throws(() => new PrototypeExecutor(s.store, fresh, s.token).start(), code('UNRESOLVED_RUN'));
});
test('admission is confirmed before invoking double, in source order with immutable identities', () => {
  const s = setup(); s.executor.start(); s.executor.step();
  const o = s.store.observe(), admitted = o.events.findIndex(e => e.type === 'ATTEMPT_ADMITTED');
  assert.ok(admitted >= 0 && admitted < o.events.findIndex(e => e.type === 'DOUBLE_DISPATCHED'));
  assert.equal(o.attempts[0].migrationId, fixture().files[0].id);
  assert.equal(o.attempts[0].attemptNo, 1); assert.equal(Object.isFrozen(o.attempts[0]), true);
  assert.equal(o.attempts[0].rawHash, fixture().files[0].rawHash);
});
const faults = [
  ['before-send', 'FAILED', 'NOT_DISPATCHED', 1], ['rollback', 'FAILED', 'NOT_COMMITTED', 3],
  ['executing', 'UNKNOWN', 'UNKNOWN', 3], ['commit-lost', 'UNKNOWN', 'UNKNOWN', 4],
  ['after-commit', 'UNKNOWN', 'COMMITTED', 5], ['postcheck-interrupted', 'UNKNOWN', 'COMMITTED', 6],
  ['postcheck-failed', 'FAILED', 'COMMITTED', 6], ['malformed', 'UNKNOWN', 'UNKNOWN', null],
  ['commit-without-ack', 'UNKNOWN', 'UNKNOWN', 4], ['pass-without-postcheck', 'UNKNOWN', 'COMMITTED', 5],
  ['out-of-order', 'UNKNOWN', 'UNKNOWN', 7], ['wrong-identity', 'UNKNOWN', 'UNKNOWN', 7],
];
for (const [scenario, state, outcome, phases] of faults) test(`receipt and stop at ${scenario}`, () => {
  const s = setup(); s.executor.start();
  assert.equal(s.executor.step(new ScriptedHelperDouble(scenario)), state);
  const o = s.store.observe(), a = o.attempts[0];
  assert.equal(a.state, state); assert.equal(a.commitOutcome, outcome);
  assert.equal(a.receipt?.phases.length ?? null, phases);
  assert.equal(o.attempts.length, 1); assert.equal(o.runs[0].state, state); assert.equal(o.lockHeld, false);
  assert.throws(() => s.executor.step(), code('EXECUTOR_NOT_ACTIVE'));
  assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), s.token).start(), code('UNRESOLVED_ATTEMPT'));
});
for (const scenario of ['throw', 'session-lost']) test(`unexpected ${scenario} stays blocking, never rollback inferred`, () => {
  const s = setup(); s.executor.start(); assert.equal(s.executor.step(new ScriptedHelperDouble(scenario)), 'UNKNOWN');
  assert.equal(s.store.observe().attempts[0].state, scenario === 'throw' ? 'UNKNOWN' : 'RUNNING');
  assert.equal(s.store.observe().attempts[0].commitOutcome, 'UNKNOWN');
  assert.equal(s.store.observe().attempts[0].finishedAt, null);
});
for (const operation of ['admit', 'finish']) for (const point of ['before', 'after']) {
  test(`lost ${operation} ack ${point} write stops without automatic retry`, () => {
    const s = setup(); s.executor.start(); s.store.injectLedgerFault(operation, point);
    assert.equal(s.executor.step(), 'UNKNOWN'); const o = s.store.observe();
    assert.equal(o.runs[0].state, 'UNKNOWN'); assert.equal(o.lockHeld, false);
    if (operation === 'admit') {
      assert.equal(o.events.filter(e => e.type === 'DOUBLE_DISPATCHED').length, 0);
      assert.equal(o.attempts.length, point === 'before' ? 0 : 1);
    } else assert.equal(o.attempts[0].state, point === 'before' ? 'RUNNING' : 'APPLIED');
    assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), s.token).start(),
      code(o.attempts.some(a => a.state !== 'APPLIED') ? 'UNRESOLVED_ATTEMPT' : 'UNRESOLVED_RUN'));
  });
}
for (const scenario of ['before-send', 'rollback']) test(`specific review permits one new attempt after ${scenario}, preserving history`, () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble(scenario));
  const permit = retryFor(s);
  assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), s.token).start({ approved: true }), code('UNRESOLVED_ATTEMPT'));
  const retry = new PrototypeExecutor(s.store, s.store.openSession(), s.token); retry.start(permit);
  assert.equal(retry.step(), 'APPLIED');
  const o = s.store.observe(); assert.equal(o.attempts[0].state, 'FAILED');
  assert.equal(o.attempts[0].attemptNo, 1); assert.equal(o.attempts[1].attemptNo, 2);
  assert.equal(o.attempts[1].state, 'APPLIED'); assert.ok(o.attempts[0].resolution);
});
for (const scenario of ['executing', 'commit-lost', 'after-commit', 'postcheck-failed']) {
  test(`manual retry cannot override ${scenario} with evidence references alone`, () => {
    const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble(scenario));
    assert.throws(() => retryFor(s), code('RETRY_NOT_SAFE'));
  });
}
test('review needs own live lock and references, and cannot be issued twice', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('rollback'));
  const reviewer = s.store.openSession();
  assert.throws(() => s.store.authorizeRetry(reviewer, 'attempt-1', review), code('LOCK_REQUIRED'));
  s.store.tryAcquire(reviewer);
  assert.throws(() => s.store.authorizeRetry(reviewer, 'attempt-1', { reviewRef: 'x' }), code('REVIEW_REFERENCES_REQUIRED'));
  s.store.authorizeRetry(reviewer, 'attempt-1', review);
  assert.throws(() => s.store.authorizeRetry(reviewer, 'attempt-1', review), code('RETRY_NOT_SAFE'));
});
test('a retry permit is bound to its own store and cannot authorize another scope model', () => {
  const a = setup(), b = setup();
  for (const s of [a, b]) { s.executor.start(); s.executor.step(new ScriptedHelperDouble('rollback')); }
  const permit = retryFor(a);
  assert.throws(() => new PrototypeExecutor(b.store, b.store.openSession(), b.token).start(permit), code('UNRESOLVED_ATTEMPT'));
});
test('new baseline does not erase failures or inherit retry authorization', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('rollback'));
  const permit = retryFor(s);
  assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), alternative('baseline')).start(permit), code('UNRESOLVED_ATTEMPT'));
  assert.equal(s.store.observe().attempts.length, 1);
});
test('a newly trusted release cannot rewrite a catalog identity or its hashes', () => {
  const s = setup(), reviewer = s.store.openSession(); s.store.tryAcquire(reviewer);
  const before = s.store.observe().catalog;
  assert.throws(() => s.store.bootstrapCatalog(reviewer, alternative('source')), code('CATALOG_DRIFT'));
  assert.deepEqual(s.store.observe().catalog, before);
});
test('consumed permit cannot authorize a second failed attempt', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('rollback'));
  const permit = retryFor(s), second = new PrototypeExecutor(s.store, s.store.openSession(), s.token);
  second.start(permit); second.step(new ScriptedHelperDouble('before-send'));
  assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), s.token).start(permit), code('UNRESOLVED_ATTEMPT'));
  const newPermit = retryFor(s, 'attempt-2'), third = new PrototypeExecutor(s.store, s.store.openSession(), s.token);
  third.start(newPermit); third.step(); assert.equal(s.store.observe().attempts[2].attemptNo, 3);
});
test('historical resolved failures do not require replay after the chain succeeds', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('rollback'));
  const next = new PrototypeExecutor(s.store, s.store.openSession(), s.token); next.start(retryFor(s));
  for (let i = 0; i < 11; i++) next.step();
  const noReplay = new PrototypeExecutor(s.store, s.store.openSession(), s.token); noReplay.start(); noReplay.step();
  assert.equal(s.store.observe().attempts.length, 12);
});
test('a forged receipt or RUNNING cannot be promoted manually to APPLIED', () => {
  const s = setup(); s.executor.start();
  assert.throws(() => s.store.stopRun(s.session, 'run-1', 'APPLIED'), code('RUN_NOT_PROVEN'));
  const file = s.store.pending(s.token)[0], id = s.store.admit(s.session, 'run-1', s.token, file);
  assert.equal(s.store.finish(s.session, 'run-1', id, { state: 'APPLIED', commitOutcome: 'COMMITTED' }), 'UNKNOWN');
});
test('source order and concurrent admissions are checked separately from the lock', () => {
  const s = setup(); s.executor.start(); const files = s.store.pending(s.token);
  assert.throws(() => s.store.admit(s.session, 'run-1', s.token, files[1]), code('SOURCE_ORDER_VIOLATION'));
  s.store.admit(s.session, 'run-1', s.token, files[0]);
  assert.throws(() => s.store.admit(s.session, 'run-1', s.token, files[0]), code('UNRESOLVED_ATTEMPT'));
});
test('a subclass cannot smuggle an arbitrary helper implementation into dispatch', () => {
  let called = false;
  class OtherHelper extends ScriptedHelperDouble { simulate() { called = true; } }
  const s = setup(); s.executor.start(); assert.equal(s.executor.step(new OtherHelper()), 'UNKNOWN');
  assert.equal(called, false);
});
test('success is not duplicate APPLIED and snapshots of history cannot alter the ledger', () => {
  const s = setup(); s.executor.start(); for (let i = 0; i < 11; i++) s.executor.step();
  const next = new PrototypeExecutor(s.store, s.store.openSession(), s.token); next.start(); next.step();
  assert.equal(s.store.observe().attempts.length, 11);
  assert.equal(Object.isFrozen(s.store.observe().attempts), true);
});
test('unknown outcomes are deliberately not reconciled by a generic boolean approval', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('commit-lost'));
  assert.throws(() => new PrototypeExecutor(s.store, s.store.openSession(), s.token).start(true), code('UNRESOLVED_ATTEMPT'));
});
test('diagnostics exclude source contents and raw exceptions, and no source text is evaluated', () => {
  const s = setup(); s.executor.start(); s.executor.step(new ScriptedHelperDouble('throw'));
  const output = JSON.stringify(s.store.observe());
  assert.equal(output.includes('SYNTHETIC_NON_SQL_SOURCE'), false);
  assert.equal(output.includes('SYNTHETIC_ARTIFACT'), false);
  assert.equal(output.includes('stack'), false);
  assert.throws(() => new ScriptedHelperDouble('password=secret'), code('INVALID_SCENARIO'));
});
test('plain SQL adapters are refused before being called', () => {
  const s = setup(); s.executor.start(); let called = false;
  assert.equal(s.executor.step({ simulate() { called = true; }, query() { called = true; } }), 'UNKNOWN');
  assert.equal(called, false);
});
test('existing operational CLI still unconditionally denies execute', () => {
  const cli = require('../homologation-migrations.cjs');
  const messages = []; const result = cli.main(['--execute', '--config', '\\\\server\\secret'], value => messages.push(value));
  assert.equal(result, 2); assert.match(JSON.stringify(messages), /EXECUTION_DISABLED/);
  assert.doesNotMatch(JSON.stringify(messages), /server|secret/);
});
