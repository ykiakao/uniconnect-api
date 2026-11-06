import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Artifact checks only: these tests DO NOT execute SQL or establish runtime RLS safety.
const file=join(__dirname,'../../../supabase/scripts/chat-realtime-broadcast.sql');
const sql=existsSync(file)?readFileSync(file,'utf8'):'';
const body=(name:string)=>sql.split('create function public.'+name)[1]?.split('$fn$;')[0] ?? '';

describe('unapplied Broadcast SQL contract',()=>{
  it('is atomic and refuses a missing Realtime/schema prerequisite',()=>{
    expect(sql.trim()).toMatch(/^--[\s\S]*\bbegin;/i);
    expect(sql.trim()).toMatch(/commit;$/i);
    expect(sql).toContain("to_regprocedure('realtime.send(jsonb,text,text,boolean)')");
    expect(sql).toContain("to_regclass('public.academic_conversations')");
  });
  it('binds receive authorization to Auth UID, exact tenant, conversation and current active participant',()=>{
    const fn=body('chat_can_receive_topic');
    expect(fn).toContain('security definer set search_path =');
    expect(fn).toContain('auth.uid()');
    expect(fn).toContain('p_topic !~');
    expect(fn).toContain('c.tenant_id = target_tenant');
    expect(fn).toContain('c.id = target_conversation');
    expect(fn).toContain('u.tenant_id = c.tenant_id');
    expect(fn).toContain('u.auth_user_id = caller');
    expect(fn).toContain('u.id in (c.student_id, c.teacher_id)');
    expect(fn).toContain('u.active');
    expect(fn).toContain("t.operational_status = 'active'");
  });
  it('adds only a narrow receive policy and restricts reserved-topic publishing even if another policy is added',()=>{
    expect(sql).toMatch(/create policy uc_chat_receive[\s\S]*?for select to authenticated[\s\S]*?chat_can_receive_topic/);
    expect(sql).toMatch(/create policy uc_chat_receive_scope[\s\S]*?as restrictive for select to public/);
    expect(sql).toMatch(/create policy uc_chat_no_client_send[\s\S]*?as restrictive for insert to public/);
    expect(sql).toContain("topic not like 'uc:chat:%'");
    expect(sql).not.toMatch(/for insert to authenticated\s+with check\s*\(true\)/i);
    expect(sql).not.toMatch(/grant\s+select\s+on\s+(?:table\s+)?public\./i);
    expect(sql).not.toMatch(/alter\s+publication/i);
  });
  it('emits private identifier-only signals through database-transactional realtime.send',()=>{
    const fn=body('chat_broadcast_change');
    expect(fn).toContain('realtime.send(payload, event_name,');
    expect(fn).toContain("recipient.auth_user_id::text, true)");
    expect(fn).toContain('u.active');
    expect(fn).toContain("t.operational_status = 'active'");
    expect(fn).not.toMatch(/new\.content|new\.email|exception when others/i);
    expect(sql).toContain('after insert on public.messages');
    expect(sql).toContain('after insert or update on public.academic_conversation_reads');
    expect(fn).toContain('new.last_read_sequence <= old.last_read_sequence');
  });
  it('checks actual insert time with a late BEFORE trigger without changing historical RPC/constraints',()=>{
    expect(body('chat_service_open')).toContain("at time zone 'America/Rio_Branco'");
    expect(body('chat_service_open')).toContain("time '18:00'");
    expect(body('chat_enforce_service_window')).toContain('clock_timestamp()');
    expect(body('chat_enforce_service_window')).toContain("errcode = 'PCH01'");
    expect(sql).toContain('create trigger zz_chat_service_window before insert on public.messages');
    expect(sql).not.toMatch(/create or replace function public\.academic_communication|disable trigger|drop constraint/i);
  });
  it('does not grant helper execution or table writes to untrusted clients',()=>{
    expect(sql).toContain('revoke all on function public.chat_can_receive_topic(text) from public, anon, authenticated, service_role;');
    expect(sql).toContain('grant execute on function public.chat_can_receive_topic(text) to authenticated;');
    expect(sql).not.toMatch(/grant[^;]*(?:insert|update|delete)[^;]*public\./i);
    expect(sql).not.toMatch(/create table realtime\.|alter table realtime\.messages|create publication/i);
    expect(sql).toContain('grant execute on function public.academic_chat_send(uuid,uuid,jsonb) to service_role;');
    expect(body('academic_chat_send')).toContain("public.academic_communication(p_tenant_id, p_actor_id, 'message_send', p_payload)");
  });
});
