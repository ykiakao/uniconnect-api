import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { app } from '../../app';
import { env } from '../../config/env';
import { createSupabaseAdminClient } from '../../config/supabase';
import * as supabase from '../../config/supabase';
import { HttpError } from '../../shared/http-error';
import { logger } from '../../observability/logger';
import { attachmentTenant, storedAttachment, readyAttachment } from '../../test/attachments-fixtures';
import { AttachmentsRepository } from './attachments.repository';
import { attachmentMetadata, StoredFile } from './attachments.schemas';
import { SupabaseAttachmentStorage } from './attachments.storage';

const base='/api/v1/tenants/edukmais';
function http(method:'get'|'post'|'delete',path:string,role='student') { return request(app)[method](`${base}${path}`).set('x-tenant-slug','edukmais').set('Authorization',`Bearer valid-${role}-token`); }
let file:StoredFile,bytes:Buffer,linked:boolean;
let rpc:jest.SpyInstance;
const capability={url:'https://test.supabase.co/private-upload?token=synthetic-sensitive-token',method:'PUT',headers:{'Content-Type':'application/pdf'},expiresAt:new Date(Date.now()+7200000).toISOString()};
beforeEach(async()=>{
  env.ACADEMIC_ATTACHMENTS_MODE='enabled';linked=false;
  const pdf=await PDFDocument.create();pdf.addPage();bytes=Buffer.from(await pdf.save());
  file=storedAttachment({declared_size:bytes.length});
  rpc=jest.spyOn(AttachmentsRepository.prototype,'rpc').mockImplementation(async(name,args)=>{
    if(args.p_tenant_id!==attachmentTenant) throw new HttpError(404,'NOT_FOUND','Not found');
    if(name==='academic_attachment_reserve') { file={...file,created_by:String(args.p_actor_id),purpose:args.p_purpose as 'material'|'submission'};return structuredClone(file); }
    if(name==='academic_attachment_upload') {
      if(args.p_actor_id!==file.created_by) throw new HttpError(404,'NOT_FOUND','Not found');
      const payload=args.p_payload as Record<string,unknown>;
      switch(args.p_operation) {
        case 'sign':file.upload_expires_at=new Date(Date.now()+7200000).toISOString();break;
        case 'claim': {
          const path=`files/${file.tenant_id}/${file.activity_scope_id}/${file.id}/${payload.leaseToken}.pdf`;
          file={...file,state:'validating',lease_token:String(payload.leaseToken),candidate_path:path,candidate_paths:[path]};break;
        }
        case 'finish':file={...readyAttachment(file),size_bytes:bytes.length,sha256:String(payload.sha256)};break;
        case 'cancel':file.state='cancelled';break;
        case 'reject':file.state='rejected';break;
        case 'release':file.state='pending';break;
      }
      return structuredClone(file);
    }
    if(name==='academic_attachment_material') {
      if(args.p_operation==='list') return linked?[attachmentMetadata(file)]:[];
      linked=args.p_operation==='add';return {id:file.id,revision:3,...(linked?{attachment:attachmentMetadata(file)}:{})};
    }
    if(name==='academic_attachment_download') { if(!linked) throw new HttpError(404,'NOT_FOUND','Not found');return structuredClone(file); }
    if(name==='academic_attachment_versions') return (args.p_versions as {submissionId:string;version:number}[]).map(row=>({...row,attachments:linked?[attachmentMetadata(file)]:[]}));
    throw new Error('Unexpected RPC');
  });
  jest.spyOn(SupabaseAttachmentStorage.prototype,'signUpload').mockResolvedValue(capability as Awaited<ReturnType<SupabaseAttachmentStorage['signUpload']>>);
  jest.spyOn(SupabaseAttachmentStorage.prototype,'read').mockImplementation(async()=>bytes);
  jest.spyOn(SupabaseAttachmentStorage.prototype,'writeFinal').mockResolvedValue(undefined);
  jest.spyOn(SupabaseAttachmentStorage.prototype,'signDownload').mockResolvedValue({url:'https://test.supabase.co/private-download?token=synthetic-download-token',expiresAt:new Date(Date.now()+60000).toISOString()});
});
afterEach(()=>{env.ACADEMIC_ATTACHMENTS_MODE='disabled';jest.restoreAllMocks();});
describe('academic attachment HTTP contracts',()=>{
  it('requires Auth and matching route/header tenant before any attachment RPC',async()=>{
    const path=`/activities/${file.activity_scope_id}/attachments`;
    expect((await request(app).get(`${base}${path}`).set('x-tenant-slug','edukmais')).status).toBe(401);
    expect((await request(app).get(`/api/v1/tenants/other${path}`).set('x-tenant-slug','edukmais').set('Authorization','Bearer valid-student-token')).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects arbitrary paths/owners, missing idempotency and invalid metadata',async()=>{
    const path=`/activities/${file.activity_scope_id}/submissions/attachment-uploads`;
    const body={fileName:'sample.pdf',sizeBytes:bytes.length,contentType:'application/pdf',expectedVersion:0};
    expect((await http('post',path).send(body)).status).toBe(400);
    expect((await http('post',path).set('Idempotency-Key',randomUUID()).send({...body,path:'../../private',studentId:'another'})).status).toBe(400);
    expect((await http('post',path).set('Idempotency-Key',randomUUID()).send({...body,sizeBytes:10000001})).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('supports teacher material reservation, confirmation, list, download and removal',async()=>{
    const activity=file.activity_scope_id;
    const logs=jest.spyOn(logger,'request');
    const reserve=await http('post',`/activities/${activity}/attachment-uploads`,'teacher').set('Idempotency-Key',randomUUID()).send({fileName:'sample.pdf',sizeBytes:bytes.length,contentType:'application/pdf'});
    expect(reserve.status).toBe(201);expect(reserve.body.upload.method).toBe('PUT');
    expect(rpc.mock.calls[0][1]).toMatchObject({p_tenant_id:attachmentTenant,p_actor_id:'user-teacher',p_purpose:'material'});
    const complete=await http('post',`/attachment-uploads/${file.id}/complete`,'teacher').send({});
    expect(complete.status).toBe(200);expect(complete.body.state).toBe('ready');expect(complete.body).not.toHaveProperty('final_path');
    const add=await http('post',`/activities/${activity}/attachments`,'teacher').send({fileId:file.id,expectedVersion:2});expect(add.status).toBe(201);
    expect((await http('get',`/activities/${activity}/attachments`)).body.data[0].id).toBe(file.id);
    const download=await http('post',`/attachments/${file.id}/download-url`).send({});expect(download.status).toBe(200);expect(download.headers['cache-control']).toContain('no-store');
    const remove=await http('delete',`/activities/${activity}/attachments/${file.id}?expectedVersion=3`,'teacher');expect(remove.status).toBe(200);expect(remove.body.revision).toBe(3);
    expect((await http('post',`/attachments/${file.id}/download-url`).send({})).status).toBe(404);
    const serialized=JSON.stringify(logs.mock.calls);expect(serialized).not.toContain('synthetic-sensitive-token');expect(serialized).not.toContain('synthetic-download-token');
  });
  it('exposes own upload status/cancellation and version metadata without internal paths',async()=>{
    expect((await http('get',`/attachment-uploads/${file.id}`)).status).toBe(200);
    const versions=await http('get',`/submissions/${randomUUID()}/versions/1/attachments`);expect(versions.status).toBe(200);expect(versions.body).toEqual({data:[]});
    expect((await http('delete',`/attachment-uploads/${file.id}`)).status).toBe(204);
    const status=await http('get',`/attachment-uploads/${file.id}`);expect(status.body.state).toBe('cancelled');expect(status.body).not.toHaveProperty('staging_path');
  });
  it('preserves text-only submission and uses the atomic RPC with attachment IDs when enabled',async()=>{
    file={...readyAttachment(file),size_bytes:bytes.length};linked=true;
    const client=createSupabaseAdminClient();const original=client.rpc.bind(client);
    const calls:Record<string,unknown>[]=[];
    const submitRpc=async(name:string,args:Record<string,unknown>)=>{
      if(name!=='submit_activity_answer_with_attachments') return original(name,args);
      calls.push(args);
      linked=(args.p_attachment_ids as string[]).length>0;
      return {data:{id:randomUUID(),tenant_id:attachmentTenant,activity_id:file.activity_scope_id,class_id:randomUUID(),student_id:'user-student',current_version:1,answer:args.p_answer,submitted_at:new Date().toISOString(),is_late:false},error:null,status:200};
    };
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue({...client,rpc:submitRpc} as unknown as ReturnType<typeof createSupabaseAdminClient>);
    const response=await http('post',`/activities/${file.activity_scope_id}/submissions`).send({answer:'Synthetic text',expectedVersion:0,attachmentIds:[file.id]});
    expect(response.status).toBe(201);expect(response.body.attachments[0].id).toBe(file.id);expect(calls[0].p_attachment_ids).toEqual([file.id]);
    const text=await http('post',`/activities/${file.activity_scope_id}/submissions`).send({answer:'Text only',expectedVersion:0});expect(text.status).toBe(201);expect(calls[1].p_attachment_ids).toEqual([]);expect(text.body.attachments).toEqual([]);
  });
  it('keeps read_only reads available and rejects mutation or new submission references',async()=>{
    env.ACADEMIC_ATTACHMENTS_MODE='read_only';
    expect((await http('get',`/activities/${file.activity_scope_id}/attachments`)).status).toBe(200);
    expect((await http('post',`/attachment-uploads/${file.id}/complete`).send({})).status).toBe(503);
    expect((await http('post',`/activities/${file.activity_scope_id}/submissions`).send({answer:'Text',expectedVersion:0,attachmentIds:[file.id]})).status).toBe(503);
  });
});
