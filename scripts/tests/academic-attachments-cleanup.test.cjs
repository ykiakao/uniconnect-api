const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { runCleanup, localUrl } = require('../lib/academic-attachments-cleanup.cjs');
function file() {
  const tenant=randomUUID(),activity=randomUUID(),id=randomUUID(),attempt=randomUUID();
  const staging_path=`staging/${tenant}/${activity}/${id}/${attempt}`;
  const final_path=`files/${tenant}/${activity}/${id}/${attempt}.pdf`;
  return {id,bucket:'academic-attachments',staging_path,final_path,candidate_paths:[final_path],protected:true};
}
test('dry-run never claims, deletes or changes database state and protects historical objects',async()=>{
  const row=file(), calls=[];
  const result=await runCleanup({rpc:async(...args)=>{calls.push(args);return [row]},remove:async()=>assert.fail('No deletion in dry-run')});
  assert.deepEqual(calls,[['candidates']]); assert.equal(result.results[0].objects,1);
});
test('execution checks fresh claims and only confirms after successful Storage deletion',async()=>{
  const row=file(),token=randomUUID(),calls=[];
  const rpc=async(operation,id,value)=>{calls.push(operation);return operation==='candidates'?[row]:operation==='claim'?{id,bucket:row.bucket,paths:[row.staging_path],token}:{id};};
  const result=await runCleanup({rpc,remove:async(bucket,paths)=>{calls.push('remove');assert.deepEqual(paths,[row.staging_path])},execute:true});
  assert.deepEqual(calls,['candidates','claim','remove','finish']); assert.equal(result.results[0].action,'cleaned');
});
test('failed deletion cannot finalize; forged, protected or foreign paths are not deleted',async()=>{
  for(const dangerous of [false,true]) {
    const row=file(),calls=[];
    const result=await runCleanup({execute:true,rpc:async(op)=>{calls.push(op);return op==='candidates'?[row]:{id:row.id,bucket:row.bucket,paths:dangerous?[row.final_path]:[row.staging_path],token:randomUUID()}},remove:async()=>{throw new Error('Storage unavailable')}});
    assert.ok(!calls.includes('finish')); assert.equal(result.results[0].action,'failed');
  }
  const row=file();row.candidate_paths=['files/other-tenant/secret.pdf'];
  assert.equal((await runCleanup({rpc:async()=>[row],remove:async()=>assert.fail('Unsafe path')})).results[0].action,'failed');
});
test('CLI rejects every hosted URL before creating any client',()=>{
  for(const url of ['https://pvacwfypqsstdrfxajkg.supabase.co','https://kpwofazhpiqrxjvxkozl.supabase.co','http://localhost:54321','http://127.0.0.1.evil.invalid/','http://user:pass@127.0.0.1/','http://127.0.0.1/?x=1']) assert.throws(()=>localUrl(url));
  assert.equal(localUrl('http://127.0.0.1:54321'),'http://127.0.0.1:54321');
});
