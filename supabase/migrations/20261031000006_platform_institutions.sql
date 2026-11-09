begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.tenants
  add column operational_status text not null default 'active'
    check (operational_status in ('active', 'suspended')),
  add column operational_version integer not null default 1 check (operational_version > 0);

create table public.platform_operations (
  actor_auth_id uuid not null,
  idempotency_key uuid not null,
  operation text not null check (operation in ('create','update','suspend','reactivate','bootstrap')),
  payload_hash bytea not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_auth_id, idempotency_key)
);

create table public.platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  actor_auth_id uuid not null,
  action text not null check (action in ('institution_created','institution_updated',
    'institution_suspended','institution_reactivated','administrator_bootstrapped','institutional_administrative_grant')),
  request_id uuid not null,
  target_user_id uuid,
  from_status text check (from_status in ('active','suspended')),
  to_status text check (to_status in ('active','suspended')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index platform_audit_events_tenant_time_idx on public.platform_audit_events(tenant_id,occurred_at desc,id desc);
create unique index platform_audit_first_administrator_key on public.platform_audit_events(tenant_id)
  where action = 'administrator_bootstrapped';

alter table public.platform_operations enable row level security;
alter table public.platform_audit_events enable row level security;
revoke all on public.platform_operations, public.platform_audit_events from public, anon, authenticated, service_role;
grant select on public.platform_audit_events to service_role;
create policy platform_audit_service_read on public.platform_audit_events for select to service_role using (true);

create function public.reject_platform_audit_mutation() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception using errcode = '42501', message = 'Platform audit events are append-only.';
end $$;
create trigger platform_audit_append_only before update or delete on public.platform_audit_events
  for each row execute function public.reject_platform_audit_mutation();
create trigger platform_audit_no_truncate before truncate on public.platform_audit_events
  for each statement execute function public.reject_platform_audit_mutation();

create function public.assert_operational_tenant(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  current_status text;
begin
  select operational_status into current_status from public.tenants where id=p_tenant_id for share;
  if not found then
    raise exception using errcode='PT404', message='INSTITUTION_NOT_FOUND';
  end if;
  if current_status <> 'active' then
    raise exception using errcode='PT403', message='TENANT_SUSPENDED';
  end if;
end $$;

create function public.require_operational_tenant() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_operational_tenant(old.tenant_id);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.tenant_id is distinct from new.tenant_id then
    perform public.assert_operational_tenant(old.tenant_id);
  end if;
  perform public.assert_operational_tenant(new.tenant_id);
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'app_users','courses','classes','activities','grades','invites','messages',
    'academic_periods','subjects','enrollments','enrollment_status_history','teaching_assignments',
    'activity_submissions','activity_submission_versions','grade_revisions',
    'academic_notices','academic_notice_revisions','academic_notice_recipients','academic_notice_reads',
    'academic_conversations','academic_conversation_reads','academic_notifications'
  ] loop
    execute format('create trigger a0_require_operational_tenant before insert or update or delete on public.%I for each row execute function public.require_operational_tenant()', table_name);
  end loop;
end $$;

create function public.platform_manage_institution(
  p_actor_auth_id uuid, p_operation text, p_idempotency_key uuid, p_request_id uuid, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  fingerprint bytea;
  journal public.platform_operations%rowtype;
  institution public.tenants%rowtype;
  membership public.app_users%rowtype;
  institution_id uuid;
  expected_version integer;
  safe_name text;
  safe_email text;
  auth_identity record;
  auth_count integer := 0;
  target_auth_id uuid;
  auth_confirmed boolean;
  prior_status text;
  audit_action text;
  outcome jsonb;
  allowed_keys text[];
begin
  if p_actor_auth_id is null or p_idempotency_key is null or p_request_id is null
    or p_operation is null or p_operation not in ('create','update','suspend','reactivate','bootstrap')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode='22023', message='Invalid platform operation arguments.';
  end if;
  perform 1 from auth.users where id=p_actor_auth_id for share;
  if not found then raise exception using errcode='42501', message='A verified Auth actor is required.'; end if;
  allowed_keys := case p_operation
    when 'create' then array['name','slug']
    when 'update' then array['id','name','expectedVersion']
    when 'bootstrap' then array['id','email','name']
    else array['id','expectedVersion'] end;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(allowed_keys))
    or not (p_payload ?& allowed_keys) then
    raise exception using errcode='22023', message='Invalid platform operation payload.';
  end if;
  if p_operation in ('create','update','bootstrap') then
    safe_name := btrim(p_payload->>'name');
    if jsonb_typeof(p_payload->'name') <> 'string' or safe_name is null or safe_name=''
      or char_length(safe_name)>200 or (p_payload->>'name') ~ '[[:cntrl:]]' then
      raise exception using errcode='22023', message='Invalid institution or administrator name.';
    end if;
  end if;
  if p_operation='create' then
    if jsonb_typeof(p_payload->'slug') <> 'string' or char_length(p_payload->>'slug') not between 3 and 63
      or (p_payload->>'slug') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' then
      raise exception using errcode='22023', message='Invalid institution slug.';
    end if;
  else
    if jsonb_typeof(p_payload->'id') <> 'string'
      or (p_payload->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='22023', message='Invalid institution identifier.';
    end if;
    institution_id := (p_payload->>'id')::uuid;
    if p_operation <> 'bootstrap' then
      if jsonb_typeof(p_payload->'expectedVersion') <> 'number'
        or (p_payload->>'expectedVersion') !~ '^[1-9][0-9]{0,9}$' then
        raise exception using errcode='22023', message='Invalid expected institution version.';
      end if;
      if (p_payload->>'expectedVersion')::numeric > 2147483646 then
        raise exception using errcode='22023', message='Invalid expected institution version.';
      end if;
      expected_version := (p_payload->>'expectedVersion')::integer;
    else
      safe_email := lower(btrim(p_payload->>'email'));
      if jsonb_typeof(p_payload->'email') <> 'string' or safe_email is null or char_length(safe_email)>254
        or safe_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
        raise exception using errcode='22023', message='Invalid administrator email.';
      end if;
    end if;
  end if;

  fingerprint := pg_catalog.sha256(pg_catalog.convert_to(p_payload::text,'UTF8'));
  insert into public.platform_operations(actor_auth_id,idempotency_key,operation,payload_hash)
    values(p_actor_auth_id,p_idempotency_key,p_operation,fingerprint)
    on conflict(actor_auth_id,idempotency_key) do nothing;
  select * into journal from public.platform_operations
    where actor_auth_id=p_actor_auth_id and idempotency_key=p_idempotency_key for update;
  if journal.operation <> p_operation or journal.payload_hash <> fingerprint then
    raise exception using errcode='PT409', message='IDEMPOTENCY_CONFLICT';
  end if;
  if journal.result is not null then return journal.result; end if;

  if p_operation='create' then
    insert into public.tenants(name,slug) values(safe_name,p_payload->>'slug') returning * into institution;
    audit_action := 'institution_created';
  else
    select * into institution from public.tenants where id=institution_id for update;
    if not found then raise exception using errcode='PT404', message='INSTITUTION_NOT_FOUND'; end if;
    prior_status := institution.operational_status;
    if p_operation='bootstrap' then
      if institution.operational_status <> 'active' then
        raise exception using errcode='PT403', message='TENANT_SUSPENDED';
      end if;
      if exists(select 1 from public.platform_audit_events where tenant_id=institution_id and action='administrator_bootstrapped') then
        raise exception using errcode='PT409', message='BOOTSTRAP_ALREADY_COMPLETED';
      end if;
      if exists(select 1 from public.app_users where tenant_id=institution_id and role in ('owner','admin','coordinator')) then
        raise exception using errcode='PT409', message='BOOTSTRAP_MANAGER_EXISTS';
      end if;
      for auth_identity in select id,email_confirmed_at from auth.users where lower(btrim(email))=safe_email order by id for share loop
        auth_count := auth_count+1;
        target_auth_id := auth_identity.id;
        auth_confirmed := auth_identity.email_confirmed_at is not null;
      end loop;
      if auth_count=0 then raise exception using errcode='PT409', message='BOOTSTRAP_AUTH_REQUIRED'; end if;
      if auth_count>1 then raise exception using errcode='PT409', message='BOOTSTRAP_AUTH_AMBIGUOUS'; end if;
      if not auth_confirmed then raise exception using errcode='PT409', message='BOOTSTRAP_AUTH_UNCONFIRMED'; end if;
      if exists(select 1 from public.app_users where tenant_id=institution_id
        and (auth_user_id=target_auth_id or lower(btrim(email))=safe_email)) then
        raise exception using errcode='PT409', message='BOOTSTRAP_MEMBERSHIP_EXISTS';
      end if;
      insert into public.app_users(tenant_id,auth_user_id,name,email,role,active)
        values(institution_id,target_auth_id,safe_name,safe_email,'admin',true) returning * into membership;
      insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,target_user_id)
        values(institution_id,p_actor_auth_id,'administrator_bootstrapped',p_request_id,membership.id);
      outcome := jsonb_build_object('institutionId',institution_id,'administrator',
        jsonb_build_object('id',membership.id,'role','admin','active',true));
    else
      if institution.operational_version <> expected_version then
        raise exception using errcode='PT409', message='VERSION_CONFLICT';
      end if;
      if p_operation='update' then
        update public.tenants set name=safe_name,operational_version=operational_version+1,updated_at=clock_timestamp()
          where id=institution_id returning * into institution;
        audit_action := 'institution_updated';
      else
        update public.tenants set operational_status=case p_operation when 'suspend' then 'suspended' else 'active' end,
          operational_version=operational_version+1,updated_at=clock_timestamp()
          where id=institution_id returning * into institution;
        audit_action := case p_operation when 'suspend' then 'institution_suspended' else 'institution_reactivated' end;
      end if;
    end if;
  end if;
  if p_operation <> 'bootstrap' then
    insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,from_status,to_status)
      values(institution.id,p_actor_auth_id,audit_action,p_request_id,prior_status,institution.operational_status);
    outcome := jsonb_build_object('id',institution.id,'name',institution.name,'slug',institution.slug,
      'operationalStatus',institution.operational_status,'version',institution.operational_version,
      'createdAt',institution.created_at,'updatedAt',institution.updated_at);
  end if;
  update public.platform_operations set result=outcome
    where actor_auth_id=p_actor_auth_id and idempotency_key=p_idempotency_key;
  return outcome;
end $$;

create function public.manage_institutional_membership(
  p_tenant_id uuid, p_actor_auth_id uuid, p_operation text, p_payload jsonb, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor public.app_users%rowtype;
  target public.app_users%rowtype;
  target_id uuid;
  desired_role text;
  actor_rank integer;
  target_rank integer;
  desired_rank integer;
  allowed_keys text[];
  safe_name text;
  safe_email text;
begin
  if p_tenant_id is null or p_actor_auth_id is null or p_request_id is null
    or p_operation is null or p_operation not in ('create','updateRole')
    or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023', message='Invalid membership operation arguments.';
  end if;
  perform public.assert_operational_tenant(p_tenant_id);
  allowed_keys := case p_operation when 'create' then array['auth_user_id','name','email','role','course_id','registration','semester']
    else array['id','role','expected_role'] end;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(allowed_keys)) then
    raise exception using errcode='22023', message='Invalid membership payload.';
  end if;
  desired_role := p_payload->>'role';
  if desired_role is null or jsonb_typeof(p_payload->'role')<>'string'
    or desired_role not in ('student','teacher','coordinator','admin','owner') then
    raise exception using errcode='23514', message='Invalid institutional role.';
  end if;
  if p_operation='updateRole' then
    if not (p_payload ?& array['id','role','expected_role']) or jsonb_typeof(p_payload->'id')<>'string'
      or (p_payload->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_payload->'expected_role')<>'string' then
      raise exception using errcode='22023', message='Invalid membership role update.';
    end if;
    target_id := (p_payload->>'id')::uuid;
    perform 1 from public.app_users where tenant_id=p_tenant_id and (auth_user_id=p_actor_auth_id or id=target_id) order by id for update;
  else
    perform 1 from public.app_users where tenant_id=p_tenant_id and auth_user_id=p_actor_auth_id for share;
  end if;
  select * into actor from public.app_users where tenant_id=p_tenant_id and auth_user_id=p_actor_auth_id and active;
  if not found then raise exception using errcode='42501', message='An active institutional actor is required.'; end if;
  actor_rank := case actor.role when 'owner' then 3 when 'admin' then 2 when 'coordinator' then 1 else 0 end;
  desired_rank := case desired_role when 'owner' then 3 when 'admin' then 2 when 'coordinator' then 1 else 0 end;
  if actor_rank=0 or desired_rank>=actor_rank then
    raise exception using errcode='42501', message='Membership exceeds current institutional authority.';
  end if;
  if p_operation='updateRole' then
    select * into target from public.app_users where tenant_id=p_tenant_id and id=target_id;
    if not found then raise exception using errcode='P0002', message='Institutional membership not found.'; end if;
    target_rank := case target.role when 'owner' then 3 when 'admin' then 2 when 'coordinator' then 1 else 0 end;
    if target.id=actor.id or target_rank>=actor_rank then
      raise exception using errcode='42501', message='Self, peer or superior role changes are forbidden.';
    end if;
    if target.role <> p_payload->>'expected_role' then
      raise exception using errcode='PT409', message='MEMBERSHIP_ROLE_CONFLICT';
    end if;
    update public.app_users set role=desired_role,updated_at=clock_timestamp()
      where tenant_id=p_tenant_id and id=target_id returning * into target;
  else
    safe_name := btrim(p_payload->>'name'); safe_email := lower(btrim(p_payload->>'email'));
    if not (p_payload ?& array['auth_user_id','name','email','role'])
      or jsonb_typeof(p_payload->'auth_user_id')<>'string'
      or (p_payload->>'auth_user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_payload->'name')<>'string' or safe_name is null or safe_name=''
      or jsonb_typeof(p_payload->'email')<>'string' or safe_email is null or safe_email=''
      or safe_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
      raise exception using errcode='22023', message='Invalid membership identity.';
    end if;
    insert into public.app_users(tenant_id,auth_user_id,name,email,role,course_id,registration,semester,active)
      values(p_tenant_id,(p_payload->>'auth_user_id')::uuid,safe_name,safe_email,desired_role,
        (p_payload->>'course_id')::uuid,p_payload->>'registration',(p_payload->>'semester')::integer,true)
      returning * into target;
  end if;
  if desired_role in ('coordinator','admin','owner') and (p_operation='create' or target.role is distinct from p_payload->>'expected_role') then
    insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,target_user_id)
      values(p_tenant_id,p_actor_auth_id,'institutional_administrative_grant',p_request_id,target.id);
  end if;
  return to_jsonb(target);
end $$;

alter function public.accept_institution_invite(text,uuid,text,text) rename to accept_institution_invite_pre_p02;
revoke all on function public.accept_institution_invite_pre_p02(text,uuid,text,text) from public,anon,authenticated,service_role;
create function public.accept_institution_invite(
  p_code text,p_auth_user_id uuid,p_email text,p_name text,p_request_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  tenant uuid;
  invitation public.invites%rowtype;
  outcome jsonb;
begin
  select tenant_id into tenant from public.invites where code=upper(btrim(p_code));
  if not found then raise exception using errcode='P0002', message='Invitation is invalid or expired.'; end if;
  perform public.assert_operational_tenant(tenant);
  select * into invitation from public.invites where code=upper(btrim(p_code)) for update;
  if not found or invitation.tenant_id is distinct from tenant then
    raise exception using errcode='P0002', message='Invitation is invalid or expired.';
  end if;
  if invitation.role in ('admin','coordinator') and p_request_id is null then
    raise exception using errcode='22023', message='Administrative invitation requires request correlation.';
  end if;
  outcome := public.accept_institution_invite_pre_p02(p_code,p_auth_user_id,p_email,p_name);
  if invitation.role in ('admin','coordinator') then
    insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,target_user_id)
      values(tenant,invitation.created_by,'institutional_administrative_grant',p_request_id,(outcome->>'id')::uuid);
  end if;
  return outcome;
end $$;

revoke all on function public.reject_platform_audit_mutation(),public.assert_operational_tenant(uuid),
  public.require_operational_tenant(),public.platform_manage_institution(uuid,text,uuid,uuid,jsonb),
  public.manage_institutional_membership(uuid,uuid,text,jsonb,uuid),public.accept_institution_invite(text,uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.platform_manage_institution(uuid,text,uuid,uuid,jsonb),
  public.manage_institutional_membership(uuid,uuid,text,jsonb,uuid),public.accept_institution_invite(text,uuid,text,text,uuid)
  to service_role;

commit;
