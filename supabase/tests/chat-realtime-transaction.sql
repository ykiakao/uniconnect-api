-- PREPARED, NOT RUN. Separate authorization required: transient synthetic messages/receipts.
-- Same fixture_json as authorization probe, during the real institutional service window.
-- Uses existing users/conversation, creates no academic accounts, rolls everything back.
\set ON_ERROR_STOP on
\if :{?fixture_json}
\else
  \echo 'Missing existing fixture_json.'
  \quit 1
\endif
begin;
select pg_catalog.set_config('uniconnect.chat_test', :'fixture_json', true);
do $test$
declare
  f jsonb := pg_catalog.current_setting('uniconnect.chat_test')::jsonb;
  tenant uuid := (f->>'tenantId')::uuid;
  conversation uuid := (f->>'conversationId')::uuid;
  actor uuid;
  attempt uuid := gen_random_uuid();
  first_message jsonb;
  duplicate jsonb;
  discarded jsonb;
  before_sequence integer;
  n integer;
begin
  if not public.chat_service_open(pg_catalog.clock_timestamp()) then raise exception 'RUN_ONLY_DURING_REAL_SERVICE_WINDOW'; end if;
  select c.student_id,c.last_sequence into strict actor,before_sequence
    from public.academic_conversations c join public.app_users s on s.tenant_id=c.tenant_id and s.id=c.student_id
      join public.app_users t on t.tenant_id=c.tenant_id and t.id=c.teacher_id
    where c.id=conversation and c.tenant_id=tenant and s.auth_user_id=(f->>'studentAuthId')::uuid
      and t.auth_user_id=(f->>'teacherAuthId')::uuid and s.active and t.active;
  first_message := public.academic_chat_send(tenant,actor,jsonb_build_object('id',conversation,'content','Synthetic transaction probe; rollback only','clientMessageId',attempt));
  duplicate := public.academic_chat_send(tenant,actor,jsonb_build_object('id',conversation,'content','Synthetic transaction probe; rollback only','clientMessageId',attempt));
  if first_message->>'id' is distinct from duplicate->>'id' or (first_message->>'sequence')::integer<>before_sequence+1 then
    raise exception 'MESSAGE_IDEMPOTENCY_OR_SEQUENCE_FAILED';
  end if;
  select count(*) into n from realtime.messages r where r.event='message.created'
    and r.payload->>'messageId'=first_message->>'id' and r.private
    and r.topic in ('uc:chat:'||tenant||':'||conversation||':'||(f->>'studentAuthId'),
                   'uc:chat:'||tenant||':'||conversation||':'||(f->>'teacherAuthId'));
  if n<>2 then raise exception 'EXPECTED_ONE_SIGNAL_PER_ACTIVE_DESTINATION'; end if;
  perform public.academic_communication(tenant,actor,'message_read',jsonb_build_object('id',conversation,'upToSequence',(first_message->>'sequence')::integer));
  perform public.academic_communication(tenant,actor,'message_read',jsonb_build_object('id',conversation,'upToSequence',(first_message->>'sequence')::integer));
  select count(*) into n from realtime.messages r where r.event='conversation.read' and r.private
    and r.payload->>'conversationId'=conversation::text and r.payload->>'readerId'=actor::text
    and (r.payload->>'upToSequence')::integer=(first_message->>'sequence')::integer;
  if n<>2 then raise exception 'READ_WATERMARK_SIGNAL_IDEMPOTENCY_FAILED'; end if;
  begin
    discarded := public.academic_chat_send(tenant,actor,jsonb_build_object('id',conversation,'content','Synthetic rolled-back probe','clientMessageId',gen_random_uuid()));
    raise exception using errcode='PCH99',message='ROLLBACK_PROBE';
  exception when sqlstate 'PCH99' then null;
  end;
  if exists(select 1 from public.messages where id=(discarded->>'id')::uuid)
    or exists(select 1 from realtime.messages where payload->>'messageId'=discarded->>'id')
    or (select last_sequence from public.academic_conversations where id=conversation and tenant_id=tenant)<>before_sequence+1 then
    raise exception 'ROLLED_BACK_MESSAGE_OR_SIGNAL_SURVIVED';
  end if;
end $test$;
rollback;
\echo 'PASS transactional queue/idempotency/rollback assertions; no COMMIT, live delivery remains untested.'
