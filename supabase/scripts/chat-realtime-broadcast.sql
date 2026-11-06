-- PREPARED ONLY. Apply once, in the separately authorized test project, as its migration owner.
-- No credentials, users, historical migration edits, publication changes or direct academic grants.
begin;

do $preflight$
begin
  if to_regclass('public.academic_conversations') is null
    or to_regclass('public.academic_conversation_reads') is null
    or to_regclass('public.messages') is null
    or to_regclass('realtime.messages') is null
    or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null
    or to_regprocedure('realtime.topic()') is null
    or to_regprocedure('auth.uid()') is null then
    raise exception 'CHAT_REALTIME_PREREQUISITES_MISSING';
  end if;
  if not exists(select 1 from pg_catalog.pg_attribute where attrelid='public.tenants'::regclass
    and attname='operational_status' and not attisdropped) then
    raise exception 'CHAT_TENANT_STATUS_PREREQUISITE_MISSING';
  end if;
  if not exists(select 1 from pg_catalog.pg_class where oid='realtime.messages'::regclass and relrowsecurity)
    or not pg_catalog.has_table_privilege('authenticated','realtime.messages','SELECT') then
    raise exception 'CHAT_REALTIME_RLS_OR_RECEIVE_GRANT_MISSING';
  end if;
  if not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'CHAT_MIGRATION_OWNER_REQUIRES_RLS_BYPASS';
  end if;
end $preflight$;

create function public.chat_service_open(at_time timestamptz) returns boolean
language sql stable strict set search_path = '' as $fn$
  select extract(isodow from at_time at time zone 'America/Rio_Branco') between 1 and 5
    and (at_time at time zone 'America/Rio_Branco')::time >= time '13:00'
    and (at_time at time zone 'America/Rio_Branco')::time < time '18:00'
$fn$;
revoke all on function public.chat_service_open(timestamptz) from public, anon, authenticated, service_role;

create function public.chat_enforce_service_window() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  -- Existing workflow guards/locks run first (trigger names are ordered lexically).
  -- An insert rejected here also rolls back sequence advancement and notifications.
  if new.conversation_id is not null and not public.chat_service_open(pg_catalog.clock_timestamp()) then
    raise exception using errcode = 'PCH01', message = 'CHAT_OUTSIDE_SERVICE_HOURS';
  end if;
  return new;
end $fn$;
revoke all on function public.chat_enforce_service_window() from public, anon, authenticated, service_role;
create trigger zz_chat_service_window before insert on public.messages
  for each row execute function public.chat_enforce_service_window();

create function public.chat_can_receive_topic(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $fn$
declare
  caller uuid := auth.uid();
  target_tenant uuid;
  target_conversation uuid;
  uuid_pattern constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
begin
  if caller is null or p_topic is null
    or p_topic !~ ('^uc:chat:' || uuid_pattern || ':' || uuid_pattern || ':' || uuid_pattern || '$') then
    return false;
  end if;
  if pg_catalog.split_part(p_topic, ':', 5)::uuid <> caller then return false; end if;
  target_tenant := pg_catalog.split_part(p_topic, ':', 3)::uuid;
  target_conversation := pg_catalog.split_part(p_topic, ':', 4)::uuid;
  return exists (
    select 1 from public.academic_conversations c
    join public.app_users u on u.tenant_id = c.tenant_id and u.id in (c.student_id, c.teacher_id)
    join public.tenants t on t.id = c.tenant_id
    where c.tenant_id = target_tenant and c.id = target_conversation
      and u.auth_user_id = caller and u.active and t.operational_status = 'active'
  );
end $fn$;
revoke all on function public.chat_can_receive_topic(text) from public, anon, authenticated, service_role;
grant execute on function public.chat_can_receive_topic(text) to authenticated;

-- Only this predicate grants receipt of reserved topics. Restrictive guards prevent a
-- future permissive policy from admitting a nonparticipant or enabling client publish.
create policy uc_chat_receive on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and public.chat_can_receive_topic((select realtime.topic())));
create policy uc_chat_receive_scope on realtime.messages
  as restrictive for select to public
  using (topic not like 'uc:chat:%' or
    (extension = 'broadcast' and auth.role() = 'authenticated'
      and topic = (select realtime.topic()) and public.chat_can_receive_topic(topic)));
create policy uc_chat_no_client_send on realtime.messages
  as restrictive for insert to public
  with check (topic not like 'uc:chat:%');
create policy uc_chat_no_client_update on realtime.messages
  as restrictive for update to public
  using (topic not like 'uc:chat:%') with check (topic not like 'uc:chat:%');
create policy uc_chat_no_client_delete on realtime.messages
  as restrictive for delete to public
  using (topic not like 'uc:chat:%');

create function public.chat_broadcast_change() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  recipient record;
  event_name text;
  payload jsonb;
begin
  if tg_table_name = 'messages' then
    if new.conversation_id is null then return new; end if;
    event_name := 'message.created';
    payload := pg_catalog.jsonb_build_object('version',1,'tenantId',new.tenant_id,
      'conversationId',new.conversation_id,'messageId',new.id,'sequence',new.sequence);
  elsif tg_table_name = 'academic_conversation_reads' then
    if tg_op = 'UPDATE' and new.last_read_sequence <= old.last_read_sequence then return new; end if;
    event_name := 'conversation.read';
    payload := pg_catalog.jsonb_build_object('version',1,'tenantId',new.tenant_id,
      'conversationId',new.conversation_id,'readerId',new.user_id,'upToSequence',new.last_read_sequence);
  else
    raise exception 'CHAT_BROADCAST_TRIGGER_TARGET_INVALID';
  end if;
  -- Destination-specific topics avoid stale policy-cache delivery to an inactive
  -- member: each emission rechecks current membership and institution status.
  for recipient in
    select distinct u.auth_user_id from public.academic_conversations c
    join public.app_users u on u.tenant_id = c.tenant_id and u.id in (c.student_id, c.teacher_id)
    join public.tenants t on t.id = c.tenant_id
    where c.tenant_id = new.tenant_id and c.id = new.conversation_id
      and u.active and t.operational_status = 'active'
  loop
    -- This INSERT into the managed Realtime queue is in the SAME transaction.
    -- WAL delivery happens after COMMIT. Managed realtime.send may warn rather than
    -- raise on enqueue failure; clients MUST also perform periodic HTTP catch-up.
    perform realtime.send(payload, event_name,
      'uc:chat:' || new.tenant_id::text || ':' || new.conversation_id::text || ':' || recipient.auth_user_id::text, true);
  end loop;
  return new;
end $fn$;
revoke all on function public.chat_broadcast_change() from public, anon, authenticated, service_role;
create trigger messages_private_broadcast after insert on public.messages
  for each row execute function public.chat_broadcast_change();
create trigger conversation_reads_private_broadcast after insert or update on public.academic_conversation_reads
  for each row execute function public.chat_broadcast_change();

-- Keep the legacy RPC's authorization/locks/sequence/idempotency/DTO. Requiring this
-- new service-only wrapper prevents an API deploy from sending through an old DB.
create function public.academic_chat_send(p_tenant_id uuid, p_actor_id uuid, p_payload jsonb) returns jsonb
language sql security definer set search_path = '' as $fn$
  select public.academic_communication(p_tenant_id, p_actor_id, 'message_send', p_payload)
$fn$;
revoke all on function public.academic_chat_send(uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.academic_chat_send(uuid,uuid,jsonb) to service_role;

-- No permissive INSERT/UPDATE/DELETE policy, academic SELECT grant or public channel.
-- Service setting "Allow public access" must be checked/disabled through a separately
-- authorized Supabase configuration step; this SQL does not change service settings.
commit;
