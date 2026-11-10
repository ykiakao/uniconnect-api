-- PREPARED, NOT RUN. psql, separately authorized uniconnect-test connection only.
-- Supply -v fixture_json=<JSON> with EXISTING test identities/conversations described in docs/chat-realtime.md.
\set ON_ERROR_STOP on
\if :{?fixture_json}
\else
  \echo 'Missing fixture_json; do not create accounts to satisfy this probe.'
  \quit 1
\endif
begin read only;
select pg_catalog.set_config('uniconnect.chat_test', :'fixture_json', true);
do $test$
declare f jsonb := pg_catalog.current_setting('uniconnect.chat_test')::jsonb;
begin
  if public.chat_service_open('2026-11-05T17:59:59.999Z')
    or not public.chat_service_open('2026-11-05T18:00:00Z')
    or not public.chat_service_open('2026-11-05T22:59:59.999Z')
    or public.chat_service_open('2026-11-05T23:00:00Z')
    or public.chat_service_open('2026-11-07T19:00:00Z')
    or public.chat_service_open('2026-11-08T19:00:00Z') then
    raise exception 'CHAT_WINDOW_BOUNDARY_TEST_FAILED';
  end if;
  if not exists(select 1 from public.academic_conversations c
    join public.app_users s on s.tenant_id=c.tenant_id and s.id=c.student_id
    join public.app_users t on t.tenant_id=c.tenant_id and t.id=c.teacher_id
    where c.id=(f->>'conversationId')::uuid and c.tenant_id=(f->>'tenantId')::uuid
      and s.auth_user_id=(f->>'studentAuthId')::uuid and t.auth_user_id=(f->>'teacherAuthId')::uuid
      and s.active and t.active) then raise exception 'EXISTING_PARTICIPANT_FIXTURE_REQUIRED'; end if;
  if not exists(select 1 from public.app_users u where u.auth_user_id=(f->>'outsiderAuthId')::uuid and u.active
    and not exists(select 1 from public.academic_conversations c where c.id=(f->>'conversationId')::uuid
      and c.tenant_id=u.tenant_id and u.id in(c.student_id,c.teacher_id))) then
    raise exception 'EXISTING_NONPARTICIPANT_FIXTURE_REQUIRED';
  end if;
  if not exists(select 1 from public.tenants where id=(f->>'otherTenantId')::uuid and id<>(f->>'tenantId')::uuid) then
    raise exception 'EXISTING_SECOND_TENANT_REQUIRED';
  end if;
  if not exists(select 1 from public.academic_conversations c where c.id=(f->>'otherConversationId')::uuid
    and not exists(select 1 from public.app_users u where u.tenant_id=c.tenant_id
      and u.id in(c.student_id,c.teacher_id) and u.auth_user_id=(f->>'studentAuthId')::uuid)) then
    raise exception 'EXISTING_UNAUTHORIZED_CONVERSATION_REQUIRED';
  end if;
  if pg_catalog.has_function_privilege('anon','public.chat_can_receive_topic(text)','EXECUTE')
    or pg_catalog.has_function_privilege('authenticated','public.academic_chat_send(uuid,uuid,jsonb)','EXECUTE')
    or not pg_catalog.has_function_privilege('service_role','public.academic_chat_send(uuid,uuid,jsonb)','EXECUTE') then
    raise exception 'CHAT_HELPER_ACL_TEST_FAILED';
  end if;
  if pg_catalog.has_table_privilege('authenticated','public.messages','SELECT')
    or pg_catalog.has_table_privilege('authenticated','public.academic_conversations','SELECT')
    or pg_catalog.has_table_privilege('authenticated','public.academic_conversation_reads','SELECT') then
    raise exception 'UNEXPECTED_DIRECT_ACADEMIC_READ';
  end if;
end $test$;
set local role authenticated;
do $test$
declare
  f jsonb := pg_catalog.current_setting('uniconnect.chat_test')::jsonb;
  prefix text := 'uc:chat:' || (f->>'tenantId') || ':' || (f->>'conversationId') || ':';
  topic text;
begin
  perform pg_catalog.set_config('request.jwt.claims',pg_catalog.jsonb_build_object('sub',f->>'studentAuthId','role','authenticated')::text,true);
  topic := prefix || (f->>'studentAuthId');
  if not public.chat_can_receive_topic(topic) then raise exception 'STUDENT_RECEIVE_DENIED'; end if;
  if public.chat_can_receive_topic(prefix || (f->>'teacherAuthId'))
    or public.chat_can_receive_topic('uc:chat:' || (f->>'otherTenantId') || ':' || (f->>'conversationId') || ':' || (f->>'studentAuthId'))
    or public.chat_can_receive_topic('uc:chat:' || (f->>'tenantId') || ':' || (f->>'otherConversationId') || ':' || (f->>'studentAuthId'))
    or public.chat_can_receive_topic(topic || ':extra') or public.chat_can_receive_topic('global') then
    raise exception 'UNAUTHORIZED_TOPIC_ACCEPTED';
  end if;
  perform pg_catalog.set_config('request.jwt.claims',pg_catalog.jsonb_build_object('sub',f->>'teacherAuthId','role','authenticated')::text,true);
  if not public.chat_can_receive_topic(prefix || (f->>'teacherAuthId')) then raise exception 'TEACHER_RECEIVE_DENIED'; end if;
  perform pg_catalog.set_config('request.jwt.claims',pg_catalog.jsonb_build_object('sub',f->>'outsiderAuthId','role','authenticated')::text,true);
  if public.chat_can_receive_topic(prefix || (f->>'outsiderAuthId')) then raise exception 'OUTSIDER_ACCEPTED'; end if;
end $test$;
rollback;
\echo 'PASS read-only fixture authorization/window assertions; live channel probes are still required.'
