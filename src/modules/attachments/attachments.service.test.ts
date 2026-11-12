import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { HttpError } from '../../shared/http-error';
import { readyAttachment, storedAttachment, attachmentTenant, attachmentUser } from '../../test/attachments-fixtures';
import { AttachmentsRepository } from './attachments.repository';
import { AttachmentsService } from './attachments.service';
import { AttachmentStorage } from './attachments.storage';

const context={tenantId:attachmentTenant,user:attachmentUser};
function harness() {
  let file=storedAttachment();
  const repository=new AttachmentsRepository();
  const calls:string[]=[];
  const upload=jest.spyOn(repository,'upload').mockImplementation(async(_c,_id,operation,payload={})=>{
    calls.push(operation);
    if(operation==='claim') {
      const path=`files/${file.tenant_id}/${file.activity_scope_id}/${file.id}/${payload.leaseToken}.pdf`;
      file={...file,state:'validating',lease_token:String(payload.leaseToken),candidate_path:path,candidate_paths:[...file.candidate_paths,path]};
    }
    if(operation==='finish') file=readyAttachment(file);
    if(operation==='release' && file.state!=='ready') file={...file,state:'pending'};
    if(operation==='reject') file={...file,state:'rejected'};
    return structuredClone(file);
  });
  const storage:jest.Mocked<AttachmentStorage>={signUpload:jest.fn(),read:jest.fn().mockResolvedValue(Buffer.alloc(100)),writeFinal:jest.fn().mockResolvedValue(undefined),signDownload:jest.fn()};
  const inspect=jest.fn().mockResolvedValue({contentType:'application/pdf',extension:'pdf',sizeBytes:100,sha256:'a'.repeat(64)});
  return {repository,upload,storage,inspect,calls,service:new AttachmentsService(repository,storage,inspect),file:()=>file};
}
beforeEach(()=>{env.ACADEMIC_ATTACHMENTS_MODE='enabled';});
afterEach(()=>{env.ACADEMIC_ATTACHMENTS_MODE='disabled';jest.restoreAllMocks();});
describe('attachment lifecycle service',()=>{
  it('validates the received bytes before writing those exact bytes and confirming once',async()=>{
    const h=harness();
    const result=await h.service.complete(context,h.file().id);
    expect(result).toMatchObject({status:200,body:{state:'ready',attachment:{sizeBytes:100}}});
    expect(h.storage.writeFinal.mock.calls[0][1]).toBe(h.inspect.mock.calls[0][0]);
    expect(h.calls).toEqual(['get','claim','finish']);
    await h.service.complete(context,h.file().id);
    expect(h.storage.read).toHaveBeenCalledTimes(1);expect(h.storage.writeFinal).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupt content and size mismatch without writing or publishing',async()=>{
    for(const mismatch of [false,true]) {
      const h=harness();
      if(mismatch) h.storage.read.mockResolvedValue(Buffer.alloc(99));
      else h.inspect.mockRejectedValue(new HttpError(415,'ATTACHMENT_FORMAT_REJECTED','Invalid file'));
      await expect(h.service.complete(context,h.file().id)).rejects.toMatchObject({statusCode:415});
      expect(h.storage.writeFinal).not.toHaveBeenCalled();expect(h.calls).toContain('reject');expect(h.calls).not.toContain('finish');
    }
  });
  it('releases temporary failures and retries using a different immutable candidate',async()=>{
    const h=harness();h.storage.writeFinal.mockRejectedValueOnce(new HttpError(503,'UNAVAILABLE','Unavailable'));
    await expect(h.service.complete(context,h.file().id)).rejects.toMatchObject({statusCode:503});
    expect(h.file().state).toBe('pending');
    await h.service.complete(context,h.file().id);
    expect(h.storage.writeFinal.mock.calls[0][0].candidate_path).not.toBe(h.storage.writeFinal.mock.calls[1][0].candidate_path);
  });
  it('does not process a lease acquired by another process',async()=>{
    const h=harness();h.upload.mockResolvedValueOnce(h.file()).mockResolvedValueOnce({...h.file(),state:'validating',lease_token:randomUUID()});
    expect((await h.service.complete(context,h.file().id)).status).toBe(202);expect(h.storage.read).not.toHaveBeenCalled();
  });
  it('recovers a committed confirmation whose database response was lost without another object write',async()=>{
    const h=harness();const original=h.upload.getMockImplementation()!;let lose=true;
    h.upload.mockImplementation(async(...args)=>{
      const result=await original(...args);
      if(args[2]==='finish' && lose) {lose=false;throw new HttpError(503,'DEPENDENCY_UNAVAILABLE','Response lost')}
      return result;
    });
    await expect(h.service.complete(context,h.file().id)).rejects.toMatchObject({statusCode:503});
    expect(h.file().state).toBe('ready');expect((await h.service.complete(context,h.file().id)).status).toBe(200);
    expect(h.storage.writeFinal).toHaveBeenCalledTimes(1);
  });
  it('returns 202 to concurrent confirmations for the same actor',async()=>{
    const h=harness();let resume!:(value:Buffer)=>void;
    h.storage.read.mockImplementation(()=>new Promise(resolve=>{resume=resolve}));
    const first=h.service.complete(context,h.file().id);
    while(!resume) await new Promise(resolve=>setImmediate(resolve));
    expect((await h.service.complete(context,h.file().id)).status).toBe(202);
    resume(Buffer.alloc(100));expect((await first).status).toBe(200);expect(h.storage.read).toHaveBeenCalledTimes(1);
  });
  it('never issues a fresh capability on an idempotent retry',async()=>{
    const h=harness();const file={...h.file(),upload_expires_at:new Date(Date.now()+7200000).toISOString()};
    jest.spyOn(h.repository,'reserve').mockResolvedValue(file);
    const result=await h.service.reserve(context,file.activity_scope_id,'submission',{fileName:'sample.pdf',sizeBytes:100,contentType:'application/pdf',expectedVersion:0},randomUUID());
    expect(result).not.toHaveProperty('upload');expect(h.storage.signUpload).not.toHaveBeenCalled();
  });
  it('read_only and disabled modes block mutations before any storage access',async()=>{
    const h=harness();
    for(const mode of ['disabled','read_only'] as const) {
      env.ACADEMIC_ATTACHMENTS_MODE=mode;
      await expect(h.service.complete(context,h.file().id)).rejects.toMatchObject({statusCode:503});
    }
    expect(h.repository.upload).not.toHaveBeenCalled();expect(h.storage.read).not.toHaveBeenCalled();
  });
});
