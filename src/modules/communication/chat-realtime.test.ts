import { CommunicationService } from './communication.service';
import { CommunicationRepository, checkCommunicationError } from './communication.repository';
import { AppUser } from '../../shared/types';
import { chatServiceOpen } from './chat-realtime';
import { createSupabaseAdminClient } from '../../config/supabase';

const tenant='11111111-1111-4111-8111-111111111111';
const conversation='22222222-2222-4222-8222-222222222222';
const student='33333333-3333-4333-8333-333333333333';
const teacher='44444444-4444-4444-8444-444444444444';
const auth='55555555-5555-4555-8555-555555555555';
const user: AppUser={id:student,tenantId:tenant,authUserId:auth,name:'Synthetic',email:'student@example.invalid',role:'student',active:true};
const row={id:conversation,tenant_id:tenant,class_id:'66666666-6666-4666-8666-666666666666',student_id:student,teacher_id:teacher,last_sequence:4,created_at:'2026-11-05T18:00:00Z',updated_at:'2026-11-05T18:00:00Z'};
const message={id:'77777777-7777-4777-8777-777777777777',tenant_id:tenant,conversation_id:conversation,sender_id:student,content:'Synthetic',sequence:5,client_message_id:'88888888-8888-4888-8888-888888888888',created_at:'2026-11-05T18:00:00Z'};
function sample(utc='2026-11-05T19:00:00Z',value:unknown=message) {
  const execute=jest.fn().mockResolvedValue(value);
  const service=new CommunicationService({execute} as CommunicationRepository,()=>new Date(utc));
  return {service,execute};
}

describe('institutional chat service window',()=>{
  it.each(['2026-11-05T17:59:59.999Z','2026-11-05T23:00:00Z','2026-11-06T03:00:00Z','2026-11-07T19:00:00Z','2026-11-08T19:00:00Z','2026-11-09T17:59:59Z'])(
    'reports the service window closed at %s',utc=>{
      expect(chatServiceOpen(new Date(utc))).toBe(false);
    });
  it.each(['2026-11-05T18:00:00Z','2026-11-05T22:59:59.999Z','2026-11-06T19:00:00Z','2026-11-09T18:00:00Z'])(
    'reports the service window open at %s using Rio Branco rather than UTC',utc=>{
      expect(chatServiceOpen(new Date(utc))).toBe(true);
    });
  it('keeps history and read confirmations available on a Sunday',async()=>{
    const {service,execute}=sample('2026-11-08T19:00:00Z',{data:[],has_more:false,next_after_sequence:4});
    await expect(service.execute(user,tenant,'message_list',{id:conversation,limit:20,afterSequence:4})).resolves.toMatchObject({meta:{nextAfterSequence:4}});
    execute.mockResolvedValue({conversation_id:conversation,last_read_sequence:4,read_at:'2026-11-08T19:00:00Z'});
    await expect(service.execute(user,tenant,'message_read',{id:conversation,upToSequence:4})).resolves.toMatchObject({lastReadSequence:4});
  });
  it('maps the database clock guard to a stable HTTP error',()=>{
    expect(()=>checkCommunicationError({code:'PCH01'})).toThrow(expect.objectContaining({statusCode:403,code:'CHAT_OUTSIDE_SERVICE_HOURS'}));
  });
  it('reports an invalid clock closed',()=>{ expect(chatServiceOpen(new Date('invalid'))).toBe(false); });
  it('uses only the guarded send RPC and fails closed on an older schema',async()=>{
    const client=createSupabaseAdminClient();
    const rpc=jest.fn().mockResolvedValue({data:null,error:{code:'PGRST202'},status:404});
    const factory=jest.spyOn(require('../../config/supabase'),'createSupabaseAdminClient').mockReturnValue({...client,rpc});
    try {
      await expect(new CommunicationRepository().execute(tenant,student,'message_send',{id:conversation})).rejects.toMatchObject({statusCode:503,code:'DATABASE_MIGRATION_REQUIRED'});
      expect(rpc).toHaveBeenCalledWith('academic_chat_send',{p_tenant_id:tenant,p_actor_id:student,p_payload:{id:conversation}});
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally { factory.mockRestore(); }
  });
});

describe('authorized private channel descriptor',()=>{
  it('derives a destination-specific topic after an authorized conversation lookup',async()=>{
    const {service,execute}=sample('2026-11-05T19:00:00Z',row);
    const descriptor=await service.realtime(user,tenant,conversation);
    expect(execute).toHaveBeenCalledWith(tenant,student,'conversation_get',{id:conversation});
    expect(descriptor).toMatchObject({transport:'supabase-broadcast',private:true,topic:`uc:chat:${tenant}:${conversation}:${auth}`,events:['message.created','conversation.read'],lastSequence:4,serviceWindow:{timeZone:'America/Rio_Branco',weekdays:[1,2,3,4,5],opensAt:'13:00',closesAt:'18:00',canSendNow:true}});
    expect(JSON.stringify(descriptor)).not.toMatch(/service_role|password|accessToken|secret/i);
  });
  it('offers a read subscription outside the service window',async()=>{
    const {service}=sample('2026-11-08T19:00:00Z',row);
    expect((await service.realtime(user,tenant,conversation)).serviceWindow.canSendNow).toBe(false);
  });
  it.each([{...user,tenantId:teacher},{...user,active:false}])('rejects invalid institutional membership',async invalid=>{
    const {service,execute}=sample(undefined,row);
    await expect(service.realtime(invalid,tenant,conversation)).rejects.toMatchObject({statusCode:403});
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{...row,tenant_id:teacher},{...row,student_id:teacher},{...row,id:teacher}])('rejects a foreign or substituted conversation returned by a dependency',async invalid=>{
    const {service}=sample(undefined,invalid);
    await expect(service.realtime(user,tenant,conversation)).rejects.toMatchObject({statusCode:502});
  });
  it('propagates authorization failure without returning a topic',async()=>{
    const {service,execute}=sample(undefined,row);
    execute.mockRejectedValue(Object.assign(new Error('Not found'),{statusCode:404}));
    await expect(service.realtime(user,tenant,conversation)).rejects.toMatchObject({statusCode:404});
  });
  it('never acknowledges a message when persistence fails',async()=>{
    const {service,execute}=sample();execute.mockRejectedValue(new Error('persistence failed'));
    await expect(service.execute(user,tenant,'message_send',{id:conversation})).rejects.toThrow('persistence failed');
  });
});
