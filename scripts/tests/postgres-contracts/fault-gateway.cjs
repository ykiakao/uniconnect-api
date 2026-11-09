'use strict';
const { executionBlocked, check, freeze } = require('./local-lab.cjs');
const MODES = Object.freeze(['PASS', 'DROP_BEFORE_COMMIT', 'DROP_COMMIT_ACK', 'CLOSE_AFTER_COMMIT_IDLE']);
// Post-authentication PostgreSQL v3 frames only. No startup/auth/TLS or socket handling.
class PgFaultGate {
  #mode; #buffers = { frontend: Buffer.alloc(0), backend: Buffer.alloc(0) };
  #commit = false; #closed = false; #fired = false; #frames = 0; #failed = false;
  #admission = null; #armed = null; #active = null; #evidence = null; #usedQueries = new Set();
  #queryFrames = 0;
  constructor(mode) { check(MODES.includes(mode), 'INVALID_GATE_MODE'); this.#mode = mode; }
  #context(c) {
    check(c && ['runRef','attemptId','queryRef'].every(k => typeof c[k] === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/.test(c[k])) &&
      ['LEDGER_ADMISSION','LEDGER_COMPLETION','LEDGER_RUN','MIGRATION_COMMIT','POSTCHECK'].includes(c.phase), 'INVALID_GATE_CONTEXT');
    return freeze({ runRef: c.runRef, attemptId: c.attemptId, queryRef: c.queryRef, phase: c.phase });
  }
  confirmAdmission(c) {
    check(!this.#admission && c && typeof c.receiptRef === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/.test(c.receiptRef), 'ADMISSION_RECEIPT_REQUIRED');
    const context = this.#context({ ...c, phase: 'LEDGER_ADMISSION' });
    this.#admission = freeze({ ...context, receiptRef: c.receiptRef, evidenceClass: 'SYNTHETIC_ONLY' });
  }
  arm(context) {
    const c = this.#context(context);
    check(!this.#armed && !this.#active && !this.#closed && !this.#failed && this.#buffers.frontend.length === 0 && this.#buffers.backend.length === 0 &&
      c.phase === 'MIGRATION_COMMIT' && this.#admission?.runRef === c.runRef && this.#admission?.attemptId === c.attemptId, 'ARMING_NOT_AUTHORIZED');
    this.#armed = c;
  }
  beginQuery(context) {
    const c = this.#context(context);
    check(!this.#active && !this.#closed && !this.#failed && !this.#usedQueries.has(c.queryRef) &&
      this.#buffers.frontend.length === 0 && this.#buffers.backend.length === 0, 'QUERY_CORRELATION_ERROR');
    this.#active = c; this.#usedQueries.add(c.queryRef); this.#commit = false; this.#queryFrames = 0;
  }
  #matches() { return this.#queryFrames === 1 && this.#armed && this.#active && ['runRef','attemptId','queryRef','phase'].every(k => this.#armed[k] === this.#active[k]); }
  #fire(point) {
    this.#fired = this.#closed = true;
    this.#evidence = freeze({ ...this.#active, point, evidenceClass: 'SYNTHETIC_ONLY', frontendQueryFrames: this.#queryFrames, admissionReceiptRef: this.#admission.receiptRef });
  }
  feed(direction, chunk) {
    check(!this.#failed && ['frontend', 'backend'].includes(direction) && Buffer.isBuffer(chunk), 'INVALID_FRAME_INPUT');
    if (this.#closed) return { forward: [], close: true };
    const forward = [];
    try {
      check(this.#buffers[direction].length + chunk.length <= 1024 * 1024, 'FRAME_LIMIT');
      let buffer = Buffer.concat([this.#buffers[direction], chunk]);
      while (buffer.length >= 5) {
        const size = buffer.readUInt32BE(1);
        check(size >= 4 && size <= 1024 * 1024 - 1, 'INVALID_FRAME_LENGTH');
        if (buffer.length < size + 1) break;
        const frame = Buffer.from(buffer.subarray(0, size + 1)); buffer = buffer.subarray(size + 1);
        const type = String.fromCharCode(frame[0]); this.#frames++;
        check(/^[A-Za-z]$/.test(type), 'UNSUPPORTED_PROTOCOL_FRAME');
        if (direction === 'frontend' && this.#active) {
          check(type === 'Q', 'EXTENDED_OR_PIPELINED_PROTOCOL_UNSUPPORTED');
          this.#queryFrames++;
          check(this.#queryFrames === 1, 'EXTENDED_OR_PIPELINED_PROTOCOL_UNSUPPORTED');
        }
        if (direction === 'frontend' && type === 'Q') {
          check(frame.at(-1) === 0, 'INVALID_QUERY_FRAME');
          const standaloneCommit = /^\s*commit\s*;?\s*$/i.test(frame.subarray(5, -1).toString('utf8'));
          if (this.#matches() && this.#mode === 'DROP_BEFORE_COMMIT' && standaloneCommit) { this.#fire('BEFORE_COMMIT_SEND'); break; }
        }
        if (direction === 'backend' && type === 'C') {
          check(frame.at(-1) === 0, 'INVALID_COMMAND_FRAME');
          if (this.#matches() && frame.subarray(5, -1).toString('ascii') === 'COMMIT') {
            this.#commit = true;
            if (this.#mode === 'DROP_COMMIT_ACK') { this.#fire('SERVER_COMMIT_ACK_WITHHELD'); break; }
          }
        }
        forward.push(frame);
        if (direction === 'backend' && type === 'Z') {
          check(size === 5 && ['I', 'T', 'E'].includes(String.fromCharCode(frame[5])), 'INVALID_READY_FRAME');
          if (this.#matches() && this.#mode === 'CLOSE_AFTER_COMMIT_IDLE' && this.#commit && frame[5] === 73) {
            this.#fire('CLIENT_IDLE_RELEASED'); break;
          }
          this.#active = null;
        }
      }
      this.#buffers[direction] = this.#closed ? Buffer.alloc(0) : Buffer.from(buffer);
      if (this.#closed) this.#buffers = { frontend: Buffer.alloc(0), backend: Buffer.alloc(0) };
      return { forward, close: this.#closed };
    } catch (error) { this.#failed = true; this.#buffers = { frontend: Buffer.alloc(0), backend: Buffer.alloc(0) }; throw error; }
  }
  report() { return freeze({ mode: this.#mode, status: 'OFFLINE_MODEL', fired: this.#fired,
    armed: this.#armed !== null, evidence: this.#evidence,
    serverCommitFrameObserved: this.#commit, closed: this.#closed, frames: this.#frames, failed: this.#failed }); }
  end(direction) {
    check(['frontend', 'backend'].includes(direction), 'INVALID_FRAME_INPUT');
    if (this.#buffers[direction].length > 0) {
      this.#failed = true; this.#buffers = { frontend: Buffer.alloc(0), backend: Buffer.alloc(0) };
      check(false, 'TRUNCATED_PROTOCOL');
    }
    this.#closed = true;
  }
}
function startProxy() { executionBlocked(); }
module.exports = { PgFaultGate, startProxy, MODES };
