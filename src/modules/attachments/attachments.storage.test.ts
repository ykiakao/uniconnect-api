import * as supabase from '../../config/supabase';
import { env } from '../../config/env';
import { readyAttachment, storedAttachment } from '../../test/attachments-fixtures';
import { SupabaseAttachmentStorage } from './attachments.storage';
import { FILE_TYPES } from './attachments.validation';
const storage=new SupabaseAttachmentStorage();
function mockStorage(methods: Record<string, unknown> = {}, isPublic = false, fileSizeLimit = 10000000) {
  return {storage:{getBucket:async()=>({data:{id:'academic-attachments',public:isPublic,file_size_limit:fileSizeLimit,allowed_mime_types:Object.keys(FILE_TYPES)},error:null}),from:()=>methods}} as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>;
}
beforeEach(()=>jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(mockStorage()));
function signed(path:string,seconds:number) {
  const token=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+seconds})).toString('base64url')}.signature`;
  return `${env.SUPABASE_URL}/storage/v1/object/${path}?token=${token}`;
}
afterEach(()=>jest.restoreAllMocks());
describe('private Storage adapter',()=>{
  it('signs only the reserved temporary path without privileged headers in the capability',async()=>{
    const file=storedAttachment();const createSignedUploadUrl=jest.fn().mockResolvedValue({data:{signedUrl:signed(`upload/sign/${file.bucket}/${file.staging_path}`,7200)},error:null});
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(mockStorage({createSignedUploadUrl}));
    const result=await storage.signUpload(file);
    expect(createSignedUploadUrl).toHaveBeenCalledWith(file.staging_path,{upsert:false});
    expect(result.method).toBe('PUT');expect(result.headers).toEqual({'Content-Type':'application/pdf','x-upsert':'false','cache-control':'max-age=0'});
    expect(JSON.stringify(result)).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
  });
  it('rejects signed URLs that point to another origin or object',async()=>{
    const file=storedAttachment();
    const createSignedUploadUrl=jest.fn().mockResolvedValue({data:{signedUrl:'https://evil.invalid/upload?token=x'},error:null});
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(mockStorage({createSignedUploadUrl}));
    await expect(storage.signUpload(file)).rejects.toMatchObject({statusCode:503});
  });
  it('counts streamed bytes and stops even when Content-Length is missing or dishonest',async()=>{
    jest.spyOn(global,'fetch').mockResolvedValue(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(6000000));controller.enqueue(new Uint8Array(4000001));controller.close()}})));
    await expect(storage.read(storedAttachment())).rejects.toMatchObject({statusCode:413});
  });
  it('distinguishes missing upload from a dependency outage without exposing provider details',async()=>{
    const fetch=jest.spyOn(global,'fetch').mockResolvedValueOnce(new Response('missing',{status:404})).mockRejectedValueOnce(new Error('private-token-provider-error'));
    await expect(storage.read(storedAttachment())).rejects.toMatchObject({statusCode:409,code:'ATTACHMENT_UPLOAD_NOT_FOUND'});
    await expect(storage.read(storedAttachment())).rejects.toMatchObject({statusCode:503});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('writes a final candidate using create semantics and conservative cache, without a redirect',async()=>{
    const file=readyAttachment();const bytes=Buffer.alloc(100);const fetch=jest.spyOn(global,'fetch').mockResolvedValue(new Response('{}'));
    await storage.writeFinal(file,bytes,'application/pdf');
    const [url,init]=fetch.mock.calls[0];
    expect(url).toContain(`/object/${file.bucket}/${file.candidate_path}`);expect(init).toMatchObject({method:'POST',redirect:'error',headers:{'x-upsert':'false','cache-control':'max-age=0'}});
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(bytes);
  });
  it('returns a short signed download only for the final confirmed object',async()=>{
    const file=readyAttachment();const createSignedUrl=jest.fn().mockResolvedValue({data:{signedUrl:signed(`sign/${file.bucket}/${file.final_path}`,60)},error:null});
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(mockStorage({createSignedUrl}));
    expect(await storage.signDownload(file)).toHaveProperty('expiresAt');expect(createSignedUrl).toHaveBeenCalledWith(file.final_path,60,{download:'sample.pdf'});
    await expect(storage.signDownload(storedAttachment())).rejects.toMatchObject({statusCode:503});
  });
  it('accepts private buckets with the exact or larger application file limit',async()=>{
    const file=storedAttachment();

    for(const limit of [10000000,50000000]){
      const createSignedUploadUrl=jest.fn().mockResolvedValue({
        data:{signedUrl:signed(`upload/sign/${file.bucket}/${file.staging_path}`,7200)},
        error:null
      });

      jest.spyOn(supabase,'createSupabaseAdminClient')
        .mockReturnValue(mockStorage({createSignedUploadUrl},false,limit));

      await expect(storage.signUpload(file))
        .resolves.toMatchObject({method:'PUT'});

      expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects private buckets with a limit below the application file limit',async()=>{
    const createSignedUploadUrl=jest.fn();

    jest.spyOn(supabase,'createSupabaseAdminClient')
      .mockReturnValue(mockStorage({createSignedUploadUrl},false,9999999));

    await expect(storage.signUpload(storedAttachment()))
      .rejects.toMatchObject({statusCode:503});

    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });
  it('refuses a public or misconfigured bucket before issuing any capability or transfer',async()=>{
    const createSignedUploadUrl=jest.fn();
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue(mockStorage({createSignedUploadUrl},true));
    await expect(storage.signUpload(storedAttachment())).rejects.toMatchObject({statusCode:503});
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    jest.spyOn(supabase,'createSupabaseAdminClient').mockReturnValue({storage:{getBucket:async()=>({data:{id:'academic-attachments',public:false,file_size_limit:50000000,allowed_mime_types:null},error:null})}} as unknown as ReturnType<typeof supabase.createSupabaseAdminClient>);
    await expect(storage.read(storedAttachment())).rejects.toMatchObject({statusCode:503});
  });
});
