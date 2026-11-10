'use strict';
const { executionBlocked, check, freeze } = require('./local-lab.cjs');
// Recipes + acceptance oracles, not a live dispatcher. No imports of services or bootstraps.
const definitions = [
  ['LOCK_RACE', 'B', ['two_sessions','try_once','observe_locks'], { winners: 1, loserAdmissions: 0, loserDispatches: 0 }],
  ['LOCK_BOUNDARIES', 'B', ['acquire','commit','rollback','observe_locks'], { sameBackend: true, heldAfterCommit: true, heldAfterRollback: true }],
  ['REENTRANCE', 'B', ['acquire_twice_control','balance_unlocks','reject_second_protocol_acquisition'], { engineReentrant: true, balancedRelease: true, protocolDuplicateRefused: true }],
  ['RELEASE', 'B', ['foreign_unlock','owner_unlock','observe_locks'], { foreignReleased: false, ownerReleased: true, remainingOwnedLocks: 0 }],
  ['SESSION_LOSS', 'B', ['disconnect_client','observe_backend','deny_takeover','terminate_owned_backend_if_authorized'], { takeoverBeforeBackendEnd: false, automaticReconnects: 0 }],
  ['PROCESS_RACE', 'B', ['two_owned_worker_processes','barrier','try_once'], { distinctProcesses: true, winners: 1, loserDispatches: 0 }],
  ['BOOTSTRAP', 'B', ['verify_fresh_cluster','bootstrap_control','inject_partial_fixture'], { separateBootstrap: true, catalogImpliesApplied: false, partialBootstrapBlocked: true }],
  ['CATALOG', 'OB', ['register_catalog','reject_drift','reject_alias'], { driftRejected: true, ordinalUnique: true, identityImmutable: true }],
  ['ADMISSION', 'B', ['admit','independent_read','dispatch','drop_admission_ack'], { durableBeforeDispatch: true, lostAckDispatches: 0 }],
  ['UNIQUENESS', 'B', ['direct_concurrent_attempts','direct_duplicate_applied'], { simultaneousBlockers: 1, appliedPerSource: 1 }],
  ['TRANSITIONS', 'OB', ['forged_completion','mutate_identity','delete_history'], { forgedAppliedRejected: true, identityMutationRejected: true, historyDeletionRejected: true }],
  ['KNOWN_FAILURES', 'B', ['before_send','full_rollback_proof','committed_postcheck_failure'], { failedImpliesRollback: false, committedReplayRefused: true }],
  ['BEFORE_COMMIT', 'B', ['gate_standalone_commit','interrupt','independent_marker_read'], { commitForwarded: false, durableMarker: false, phaseProven: true }],
  ['COMMIT_ACK_LOST', 'B', ['forward_commit','hold_commit_response','independent_marker_read'], { commitForwarded: true, clientOutcome: 'UNKNOWN', automaticReplay: false, phaseProven: true }],
  ['AFTER_COMMIT', 'B', ['ack_commit','interrupt_postcheck'], { outcome: 'COMMITTED', applied: false, stopped: true }],
  ['LEDGER_ACK_LOST', 'B', ['admission_ack_variants','completion_ack_variants'], { preservedApplied: true, nextDispatches: 0, automaticReconnects: 0 }],
  ['ABORT_TIMEOUT', 'B', ['statement_timeout','aborted_transaction','rollback_failure'], { causesSeparated: true, resolvedPromiseImpliesCommit: false }],
  ['RECONCILE', 'B', ['authorized_observer','insufficient_proof','sufficient_proof_without_replay'], { insufficientRemainsUnknown: true, replayDispatches: 0, originalReceiptPreserved: true }],
  ['SPECIFIC_RETRY', 'OB', ['authorize_failed_no_effects','consume_once','reject_wrong_binding'], { historicalFailurePreserved: true, consumedOnce: true, wrongBindingRejected: true }],
  ['PRIVATE_ACL', 'B', ['api_connections','inherited_defaults','runtime_positive_control'], { apiUsage: false, apiRead: false, apiWrite: false, runtimeRequiredRights: true }],
  ['RLS_ROLES', 'BE', ['restricted_reader','two_nonempty_tenants','bypass_control'], { readerSuperuser: false, readerBypass: false, crossTenantRows: 0, positiveTenantRows: 1 }],
  ['PACKAGE', 'O', ['external_anchor','tamper_source_and_manifest','snapshot_replace'], { independentAnchor: true, tamperRejected: true, snapshotReused: true }],
  ['DISPATCH_BYTES', 'BH', ['verify_snapshot','capture_dispatch_digest'], { dispatchMatchesSnapshot: true, driftDispatches: 0 }],
  ['S03', 'H', ['original_helper','preflight','temp_ctas','postcheck','internal_commit'], { outerBegin: false, sameSessionLock: true, snapshotPreserved: true, ledgerOutsideSourceTransaction: true }],
  ['SOURCE_CLASSES', 'H', ['eleven_original_sources','complete_results','ready_for_query','postchecks'], { sourceCount: 11, originalHashes: true, outerBegin: false, stopOnFirstFailure: true }],
  ['EVENT_PROFILE', 'HE', ['canonical_event','temporary_ctas','rollback','other_event_profile'], { canonicalBodyReviewed: true, allRelevantEventsAccounted: true, assumedTempRls: false }],
  ['LAB_BOUNDARY', 'OB', ['deny_remote_config','deny_inherited_endpoint','verify_os_isolation'], { remoteAttempts: 0, publishedPorts: 0, supervisorIsolationProven: true }],
  ['CLEANUP', 'B', ['export_receipts','verify_sessions','remove_owned_resources_only'], { remainingOwnedResources: 0, foreignResourcesTouched: 0, receiptExported: true }],
];
const CASES = freeze(definitions.map(([name, profile, steps, expected], index) => ({
  id: `PGC-${String(index + 1).padStart(2, '0')}`, name, profile, steps, expected, status: 'NOT_RUN' })));
function assertCaseEvidence(id, evidence) {
  const row = CASES.find(c => c.id === id); check(row, 'UNKNOWN_CASE');
  check(evidence && evidence.caseId === id && evidence.provenance === 'LOCAL_POSTGRES_OBSERVATION' &&
    evidence.serverVersion === 170011 && /^[a-f0-9]{32}$/.test(evidence.runId), 'CASE_PROVENANCE_REQUIRED');
  check(Object.entries(row.expected).every(([key, value]) => evidence.observed?.[key] === value), 'CASE_ORACLE_FAILED');
  return freeze({ caseId: id, oracleMatched: true, executionStatusUnchanged: 'NOT_RUN', authorizesExecution: false });
}
async function runIntegratedCase() { executionBlocked(); }
module.exports = { CASES, assertCaseEvidence, runIntegratedCase };
if (require.main === module) {
  const { test } = require('node:test');
  for (const row of CASES) test(`${row.id} ${row.name}`, { skip: 'NOT_RUN: local database execution disabled' }, async () => runIntegratedCase(row.id));
}
