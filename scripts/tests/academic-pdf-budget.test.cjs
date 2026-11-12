const {test} = require('node:test');
const assert = require('node:assert/strict');
const {installPdfDecodeBudget} = require('../lib/academic-pdf-budget.cjs');
const Decoder = require('pdf-lib/cjs/core/streams/DecodeStream').default;
test('PDF parser refuses oversized ArrayBuffer requests before allocation',()=>{
  const restore=installPdfDecodeBudget();
  try {
    const decoder=new Decoder();
    assert.equal(decoder.ensureBuffer(1024).byteLength,1024);
    assert.throws(()=>decoder.ensureBuffer(17*1024*1024),/limit/);
    assert.equal(decoder.buffer.byteLength,1024);
    assert.throws(()=>decoder.ensureBuffer(Infinity),/limit/);
  } finally {restore();}
});
test('PDF decoder allocation budget is shared across streams',()=>{
  const restore=installPdfDecodeBudget();
  try {
    for(let i=0;i<32;i++) new Decoder().ensureBuffer(1024*1024);
    assert.throws(()=>new Decoder().ensureBuffer(1),/budget/);
  } finally {restore();}
});
