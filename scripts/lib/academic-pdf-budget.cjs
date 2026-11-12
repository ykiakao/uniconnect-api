// This adapter is confined to a disposable worker and the exact pinned parser.
// Worker heap limits do not bound external ArrayBuffer allocations.
function installPdfDecodeBudget() {
  if (require('pdf-lib/package.json').version !== '1.17.1') throw new Error('PDF decoder requires a reviewed budget adapter');
  const Decoder = require('pdf-lib/cjs/core/streams/DecodeStream').default;
  const original = Decoder.prototype.ensureBuffer;
  if (typeof original !== 'function') throw new Error('PDF decoder budget is unavailable');
  let allocated = 0;
  Decoder.prototype.ensureBuffer = function(requested) {
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > 16 * 1024 * 1024) throw new Error('PDF decoded stream limit');
    if (requested > this.buffer.byteLength) {
      let capacity = this.minBufferLength;
      if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Invalid PDF decoder');
      while (capacity < requested) capacity *= 2;
      if (capacity > 16 * 1024 * 1024 || allocated + capacity > 32 * 1024 * 1024) throw new Error('PDF decoder allocation budget');
      allocated += capacity;
    }
    return original.call(this,requested);
  };
  return () => { Decoder.prototype.ensureBuffer = original; };
}
module.exports = { installPdfDecodeBudget };
