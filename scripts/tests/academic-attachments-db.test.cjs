const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const root = join(__dirname, '../..');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1), teacher=id(11), student=id(12), otherStudent=id(13), stranger=id(14), foreign=id(15), offering=id(40);
const authId = actor => id(Number(actor.slice(-12))+1000);
let db;
async function call(name, args) {
  const placeholders = args.map((_,i)=>`$${i+1}`).join(',');
  try { return (await db.query(`select public.${name}(${placeholders}) as result`,args)).rows[0].result; }
  catch(error) { error.message += `\n${error.where ?? ''}`; throw error; }
}
const fail = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code,code,error.message); return true; });
const manage = (actor, operation, activity, payload={}) => call('manage_academic_activity',[tenant,actor,operation,activity,offering,payload]);
async function task(publish=true) {
  const draft=await manage(teacher,'create',null,{title:'Synthetic attachments'});
  return publish ? manage(teacher,'publish',draft.id,{expected_version:draft.revision}) : draft;
}
function reserve(actor, activity, purpose='submission', request={}) {
  return call('academic_attachment_reserve',[tenant,actor,activity,purpose,'academic-attachments',{
    fileName:'sample.pdf',contentType:'application/pdf',sizeBytes:100,idempotencyKey:randomUUID(),...(purpose==='submission'?{expectedVersion:0}:{}),...request,
  }]);
}
const upload = (actor,file,operation,payload={}) => call('academic_attachment_upload',[tenant,actor,file,operation,payload]);
async function ready(actor,activity,purpose='submission',request={}) {
  let file=await reserve(actor,activity,purpose,request);
  file=await upload(actor,file.id,'claim');
  return upload(actor,file.id,'finish',{leaseToken:file.lease_token,sizeBytes:100,contentType:'application/pdf',sha256:'a'.repeat(64)});
}
const submit = (actor,activity,version=0,files=[]) => call('submit_activity_answer_with_attachments',[tenant,actor,activity,version,'Synthetic text',files]);

before(async()=>{
  db=new PGlite({extensions:{pgcrypto}});
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role',true),'authenticated')::text $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;`);
  await db.exec(readFileSync(join(root,'supabase/schema.sql'),'utf8'));
  for(const name of readdirSync(join(root,'supabase/migrations')).filter(x=>x.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root,'supabase/migrations',name),'utf8')); }
    catch(error) { throw new Error(`${name}: ${error.message}`,{cause:error}); }
  }
  await db.query("insert into tenants(id,name,slug) values($1,'Synthetic A','attachment-a'),($2,'Synthetic B','attachment-b')",[tenant,id(2)]);
  for(const [actor,role,scope] of [[teacher,'teacher',tenant],[student,'student',tenant],[otherStudent,'student',tenant],[stranger,'teacher',tenant],[foreign,'student',id(2)]]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,clock_timestamp())',[authId(actor),`${actor}@example.invalid`]);
    await db.query('insert into app_users(id,tenant_id,auth_user_id,name,email,role,active) values($1,$2,$3,\'Synthetic\',$4,$5,true)',[actor,scope,authId(actor),`${actor}@example.invalid`,role]);
  }
  await db.query("insert into courses(id,tenant_id,name) values($1,$2,'Synthetic')",[id(30),tenant]);
  await db.query("insert into academic_periods(id,tenant_id,code,name,status) values($1,$2,'SYN','Synthetic','active')",[id(70),tenant]);
  await db.query("insert into subjects(id,tenant_id,course_id,code,name) values($1,$2,$3,'SYN','Synthetic')",[id(80),tenant,id(30)]);
  await db.query("insert into classes(id,tenant_id,course_id,subject_id,academic_period_id,name,teacher_id) values($1,$2,$3,$4,$5,'Synthetic',$6)",[offering,tenant,id(30),id(80),id(70),authId(teacher)]);
  for(const actor of [student,otherStudent]) await db.query('insert into enrollments(tenant_id,class_id,student_id) values($1,$2,$3)',[tenant,offering,actor]);
}, {timeout:60000});
after(async()=>{if(db) await db.close();});

test('ACL and RLS keep metadata and internal helpers inaccessible to API client roles',async()=>{
  const policies=await db.query("select relname,relrowsecurity from pg_class where relname in ('academic_files','activity_attachments','submission_version_attachments') order by relname");
  assert.equal(policies.rows.length,3); assert.ok(policies.rows.every(x=>x.relrowsecurity));
  for(const role of ['anon','authenticated','service_role']) {
    await db.exec(`set role ${role}`);
    for(const table of ['academic_files','activity_attachments','submission_version_attachments']) await fail(db.query(`select * from ${table}`),'42501');
    await fail(call('academic_attachment_actor',[tenant,teacher]),'42501');
    if(role!=='service_role') await fail(call('academic_attachment_cleanup',['candidates',null,null]),'42501');
    else assert.ok(Array.isArray(await call('academic_attachment_cleanup',['candidates',null,null])));
    await db.exec('reset role');
  }
});
test('reservation enforces identity, enrollment, role, idempotency and a maximum of five',async()=>{
  const activity=await task(); const key=randomUUID();
  const file=await reserve(student,activity.id,'submission',{idempotencyKey:key});
  assert.equal((await reserve(student,activity.id,'submission',{idempotencyKey:key})).id,file.id);
  await fail(reserve(student,activity.id,'submission',{idempotencyKey:key,sizeBytes:101}),'23514');
  await fail(reserve(foreign,activity.id),'42501');
  await fail(reserve(stranger,activity.id,'material'),'42501');
  await fail(reserve(student,activity.id,'material'),'42501');
  await fail(upload(otherStudent,file.id,'get'),'P0002');
  for(let i=1;i<5;i++) await reserve(student,activity.id);
  await fail(reserve(student,activity.id),'54000');
  await db.query("update enrollments set status='cancelled' where tenant_id=$1 and student_id=$2",[tenant,otherStudent]);
  await fail(reserve(otherStudent,activity.id),'42501');
  await db.query("update enrollments set status='active' where tenant_id=$1 and student_id=$2",[tenant,otherStudent]);
});
test('capability is issued once and stale validation leases cannot commit',async()=>{
  const activity=await task(); let file=await reserve(student,activity.id);
  await upload(student,file.id,'sign'); await fail(upload(student,file.id,'sign'),'23514');
  file=await upload(student,file.id,'claim');
  const losingToken=randomUUID();
  const busy=await upload(student,file.id,'claim',{leaseToken:losingToken});
  assert.equal(busy.lease_token,file.lease_token);assert.notEqual(busy.lease_token,losingToken);
  await fail(upload(student,file.id,'release',{leaseToken:losingToken}),'23514');
  await fail(upload(student,file.id,'finish',{leaseToken:randomUUID(),sizeBytes:100,contentType:'application/pdf',sha256:'a'.repeat(64)}),'23514');
  await db.query("update academic_files set lease_until=clock_timestamp()-interval '1 second' where id=$1",[file.id]);
  const newer=await upload(student,file.id,'claim'); assert.notEqual(newer.candidate_path,file.candidate_path);
  await fail(upload(student,file.id,'finish',{leaseToken:file.lease_token,sizeBytes:100,contentType:'application/pdf',sha256:'a'.repeat(64)}),'23514');
});
test('text and attachments commit atomically, preserve history and restrict download',async()=>{
  const activity=await task(); const file=await ready(student,activity.id);
  const wrong=await ready(otherStudent,activity.id);
  await fail(submit(student,activity.id,0,[wrong.id]),'P0002');
  assert.equal((await db.query('select count(*)::int n from activity_submissions where activity_id=$1',[activity.id])).rows[0].n,0);
  const delivery=await submit(student,activity.id,0,[file.id]);
  assert.equal(delivery.current_version,1);
  await fail(submit(student,activity.id,0,[file.id]),'23514');
  const latest=await submit(student,activity.id,1,[]); assert.equal(latest.current_version,2);
  const versions=await call('academic_attachment_versions',[tenant,student,[{submissionId:delivery.id,version:1},{submissionId:delivery.id,version:2}]]);
  assert.equal(versions[0].attachments[0].id,file.id); assert.deepEqual(versions[1].attachments,[]);
  assert.equal((await call('academic_attachment_download',[tenant,teacher,file.id])).id,file.id);
  await fail(call('academic_attachment_download',[tenant,otherStudent,file.id]),'P0002');
  await fail(call('academic_attachment_download',[id(2),foreign,file.id]),'P0002');
  await fail(call('academic_attachment_download',[tenant,stranger,file.id]),'42501');
  await fail(upload(student,file.id,'cancel'),'23514');
  await fail(db.query('delete from submission_version_attachments where file_id=$1',[file.id]),'23514');
  await db.query("update enrollments set status='cancelled' where tenant_id=$1 and student_id=$2",[tenant,student]);
  assert.equal((await call('academic_attachment_download',[tenant,student,file.id])).id,file.id);
  await fail(submit(student,activity.id,2,[file.id]),'42501');
  await db.query("update enrollments set status='active' where tenant_id=$1 and student_id=$2",[tenant,student]);
});
test('pending files and duplicate references cannot produce a partial version',async()=>{
  const activity=await task(); const file=await reserve(student,activity.id);
  await fail(submit(student,activity.id,0,[file.id]),'23514');
  await fail(submit(student,activity.id,0,[file.id,file.id]),'22023');
  const delivery=await submit(student,activity.id); assert.equal(delivery.current_version,1);
});
test('materials use revisions, are private while draft and freeze after a submission',async()=>{
  let activity=await task(false); const file=await ready(teacher,activity.id,'material');
  const add=()=>call('academic_attachment_material',[tenant,teacher,activity.id,'add',file.id,1]);
  assert.equal((await add()).revision,2); assert.equal((await add()).revision,2);
  await fail(call('academic_attachment_download',[tenant,student,file.id]),'P0002');
  activity=await manage(teacher,'publish',activity.id,{expected_version:2});
  assert.equal((await call('academic_attachment_material',[tenant,student,activity.id,'list',null,null])).length,1);
  await submit(student,activity.id);
  assert.equal((await add()).revision,2);
  await manage(teacher,'close',activity.id,{expected_version:activity.revision});
  assert.equal((await add()).revision,2);
  await fail(call('academic_attachment_material',[tenant,teacher,activity.id,'remove',file.id,activity.revision]),'23514');
});
test('removal retries recover the original revision even after the activity closes',async()=>{
  let activity=await task(false);const file=await ready(teacher,activity.id,'material');
  await call('academic_attachment_material',[tenant,teacher,activity.id,'add',file.id,1]);
  const remove=()=>call('academic_attachment_material',[tenant,teacher,activity.id,'remove',file.id,2]);
  assert.equal((await remove()).revision,3);
  activity=await manage(teacher,'publish',activity.id,{expected_version:3});
  await manage(teacher,'close',activity.id,{expected_version:activity.revision});
  assert.equal((await remove()).revision,3);
});
test('deleting a draft preserves upload tombstones and does not leave a permanent FK blockage',async()=>{
  const activity=await task(false);const file=await ready(teacher,activity.id,'material');
  await call('academic_attachment_material',[tenant,teacher,activity.id,'add',file.id,1]);
  await manage(teacher,'delete',activity.id);
  const preserved=await upload(teacher,file.id,'get');
  assert.equal(preserved.state,'cancelled');assert.equal(preserved.activity_id,null);assert.equal(preserved.activity_scope_id,activity.id);
  assert.equal((await db.query('select removed_reason from activity_attachments where file_id=$1',[file.id])).rows[0].removed_reason,'activity_deleted');
  await fail(upload(teacher,file.id,'claim'),'P0002');
});
test('expired reservations, ineligible activities and suspended tenants cannot acquire new capabilities',async()=>{
  const activity=await task();const file=await reserve(student,activity.id);
  await db.query("update academic_files set expires_at=clock_timestamp()-interval '1 second' where id=$1",[file.id]);
  await fail(upload(student,file.id,'sign'),'23514');
  await fail(upload(student,file.id,'claim'),'23514');
  await db.query("update tenants set operational_status='suspended',operational_version=operational_version+1 where id=$1",[tenant]);
  await fail(upload(student,file.id,'get'),'PT403');
  await db.query("update tenants set operational_status='active',operational_version=operational_version+1 where id=$1",[tenant]);
});
test('cancellation after a processing crash is definitive when the validation lease expires',async()=>{
  const activity=await task();const pending=await reserve(student,activity.id);
  await upload(student,pending.id,'claim');
  await fail(upload(student,pending.id,'cancel'),'23514');
  await db.query("update academic_files set lease_until=clock_timestamp()-interval '1 second' where id=$1",[pending.id]);
  const cancelled=await upload(student,pending.id,'cancel');
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.lease_token,null);
  await fail(upload(student,pending.id,'claim'),'23514');
});
test('reviews block both new uploads and attachment re-submissions',async()=>{
  const activity=await task(); const file=await ready(student,activity.id); const delivery=await submit(student,activity.id,0,[file.id]);
  await call('review_activity_submission',[tenant,teacher,delivery.id,0,1,0,'Synthetic review',false]);
  await fail(reserve(student,activity.id,'submission',{expectedVersion:1}),'23514');
  await fail(submit(student,activity.id,1,[]),'23514');
});
test('cleanup does not erase any final object referenced by an older version',async()=>{
  const activity=await task(); const file=await ready(student,activity.id); await submit(student,activity.id,0,[file.id]);
  await db.query("update academic_files set created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '2 days',validated_at=clock_timestamp()-interval '2 days' where id=$1",[file.id]);
  const claim=await call('academic_attachment_cleanup',['claim',file.id,null]);
  assert.ok(claim.paths.includes(file.staging_path)); assert.ok(!claim.paths.includes(file.final_path));
  await call('academic_attachment_cleanup',['finish',file.id,claim.token]);
  assert.equal((await upload(student,file.id,'get')).state,'ready');
});
test('cleanup fencing prevents stale acknowledgments and blocks a new link before deleting an orphan',async()=>{
  const activity=await task(false);const file=await ready(teacher,activity.id,'material');
  await db.query("update academic_files set expires_at=clock_timestamp()-interval '2 days',validated_at=clock_timestamp()-interval '2 days' where id=$1",[file.id]);
  const claim=await call('academic_attachment_cleanup',['claim',file.id,null]);
  assert.ok(claim.paths.includes(file.final_path));
  await fail(call('academic_attachment_cleanup',['finish',file.id,null]),'23514');
  await fail(call('academic_attachment_material',[tenant,teacher,activity.id,'add',file.id,1]),'23514');
  await fail(call('academic_attachment_cleanup',['finish',file.id,randomUUID()]),'23514');
  await call('academic_attachment_cleanup',['finish',file.id,claim.token]);
  await call('academic_attachment_cleanup',['finish',file.id,claim.token]);
  assert.equal((await upload(teacher,file.id,'get')).state,'deleted');
});
test('institution quota covers all activities and is released only by confirmed cleanup',async()=>{
  const source=await task(); const target=await task();
  const ids=(await db.query(`with ids as (select gen_random_uuid() as id from generate_series(1,100))
    insert into academic_files(id,tenant_id,activity_id,activity_scope_id,class_id,created_by,purpose,original_name,declared_type,declared_size,bucket,staging_path,idempotency_key,request_fingerprint)
    select id,$1::uuid,$2::uuid,$2::uuid,$3::uuid,$4::uuid,'submission','quota.pdf','application/pdf',10000000,'academic-attachments','staging/'||($1::uuid)::text||'/'||($2::uuid)::text||'/'||id||'/'||gen_random_uuid(),id::text,'synthetic' from ids returning id`,[tenant,source.id,offering,student])).rows.map(row=>row.id);
  await fail(reserve(student,target.id),'54000');
  await db.query("update academic_files set expires_at=clock_timestamp()-interval '2 days' where id=any($1::uuid[])",[ids]);
  await fail(reserve(student,target.id),'54000');
  for(const fileId of ids) {
    const claim=await call('academic_attachment_cleanup',['claim',fileId,null]);
    await call('academic_attachment_cleanup',['finish',fileId,claim.token]);
  }
  assert.equal((await reserve(student,target.id)).state,'pending');
});
