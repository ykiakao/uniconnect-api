begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.platform_account_provisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null check (char_length(name) between 1 and 200 and name !~ '[[:cntrl:]]'),
  email text not null check (email=lower(btrim(email)) and char_length(email)<=254),
  state text not null default 'pending' check (state in ('pending','invite_requested','awaiting_confirmation','ready','needs_review')),
  auth_user_id uuid,
  invite_attempted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (tenant_id,email)
);
create table public.platform_account_operations (
  actor_auth_id uuid not null,
  idempotency_key uuid not null,
  operation text not null check (operation in ('reserve_provision','designate_responsible','replace_responsible')),
  payload_hash bytea not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_auth_id,idempotency_key)
);
create table public.institution_responsibles (
  tenant_id uuid primary key references public.tenants(id),
  user_id uuid not null,
  version integer not null check (version>0),
  foreign key (tenant_id,user_id) references public.app_users(tenant_id,id)
);
alter table public.platform_account_provisions enable row level security;
alter table public.platform_account_operations enable row level security;
alter table public.institution_responsibles enable row level security;
revoke all on public.platform_account_provisions,public.platform_account_operations,public.institution_responsibles
  from public,anon,authenticated,service_role;
grant select(id,tenant_id,state,created_at,updated_at) on public.platform_account_provisions to service_role;
create policy platform_account_provisions_service_read on public.platform_account_provisions for select to service_role using (true);

alter table public.platform_audit_events add column previous_user_id uuid;
alter table public.platform_audit_events drop constraint platform_audit_events_action_check;
alter table public.platform_audit_events add constraint platform_audit_events_action_check check (action in (
  'institution_created','institution_updated','institution_suspended','institution_reactivated',
  'administrator_bootstrapped','institutional_administrative_grant','account_provisioning_requested',
  'account_invite_requested','account_invite_reconciled','responsible_designated','responsible_replaced'));

create function public.account_provision_dto(p public.platform_account_provisions) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',p.id,'institutionId',p.tenant_id,'state',p.state,'createdAt',p.created_at,'updatedAt',p.updated_at)
$$;

create function public.guard_responsible_membership() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.institution_responsibles where tenant_id=old.tenant_id and user_id=old.id)
    and (tg_op='DELETE' or new.tenant_id is distinct from old.tenant_id or new.id is distinct from old.id
      or new.auth_user_id is distinct from old.auth_user_id
      or new.role <> 'admin' or not new.active) then
    raise exception using errcode='23514',message='RESPONSIBLE_REPLACEMENT_REQUIRED';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger a1_guard_responsible_membership before update or delete on public.app_users
  for each row execute function public.guard_responsible_membership();

create function public.guard_responsible_target() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.assert_operational_tenant(new.tenant_id);
  perform 1 from public.app_users where tenant_id=new.tenant_id and id=new.user_id and role='admin' and active for update;
  if not found then raise exception using errcode='PT409',message='RESPONSIBLE_ACTIVE_ADMIN_REQUIRED'; end if;
  return new;
end $$;
create trigger institution_responsibles_target before insert or update on public.institution_responsibles
  for each row execute function public.guard_responsible_target();

create function public.platform_manage_accounts(
  p_actor_auth_id uuid,p_operation text,p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  allowed_keys text[];
  tenant uuid;
  fingerprint bytea;
  journal public.platform_account_operations%rowtype;
  provision public.platform_account_provisions%rowtype;
  responsible public.institution_responsibles%rowtype;
  target public.app_users%rowtype;
  prior public.app_users%rowtype;
  auth_identity record;
  auth_count integer:=0;
  identity_id uuid;
  identity_confirmed boolean;
  expected_version integer;
  safe_name text;
  safe_email text;
  outcome jsonb;
  invite_required boolean:=false;
  old_state text;
  old_auth_id uuid;
  audit_action text;
begin
  if p_actor_auth_id is null or p_request_id is null or p_operation is null
    or p_operation not in ('reserve_provision','prepare_provision','reconcile_provision','get_responsible','designate_responsible','replace_responsible')
    or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='Invalid account operation arguments.';
  end if;
  perform 1 from auth.users where id=p_actor_auth_id for share;
  if not found then raise exception using errcode='42501',message='A verified Auth actor is required.'; end if;
  allowed_keys:=case p_operation
    when 'reserve_provision' then array['institutionId','name','email']
    when 'prepare_provision' then array['institutionId','provisionId']
    when 'reconcile_provision' then array['institutionId','provisionId']
    when 'get_responsible' then array['institutionId']
    when 'designate_responsible' then array['institutionId','administratorId','expectedVersion']
    else array['institutionId','name','email','expectedVersion'] end;
  if not (p_payload ?& allowed_keys) or exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(allowed_keys)) then
    raise exception using errcode='22023',message='Invalid account operation payload.';
  end if;
  if jsonb_typeof(p_payload->'institutionId')<>'string'
    or (p_payload->>'institutionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='22023',message='Invalid institution identifier.';
  end if;
  tenant:=(p_payload->>'institutionId')::uuid;
  if p_operation in ('prepare_provision','reconcile_provision','designate_responsible') then
    if jsonb_typeof(p_payload->case when p_operation='designate_responsible' then 'administratorId' else 'provisionId' end)<>'string'
      or (p_payload->>case when p_operation='designate_responsible' then 'administratorId' else 'provisionId' end)
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode='22023',message='Invalid account identifier.';
    end if;
  end if;
  if p_operation in ('reserve_provision','replace_responsible') then
    safe_name:=btrim(p_payload->>'name'); safe_email:=lower(btrim(p_payload->>'email'));
    if jsonb_typeof(p_payload->'name')<>'string' or safe_name='' or char_length(safe_name)>200 or safe_name ~ '[[:cntrl:]]'
      or jsonb_typeof(p_payload->'email')<>'string' or char_length(safe_email)>254
      or safe_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or safe_email ~ '[[:cntrl:]]' then
      raise exception using errcode='22023',message='Invalid account identity.';
    end if;
  end if;
  if p_operation in ('designate_responsible','replace_responsible') then
    if jsonb_typeof(p_payload->'expectedVersion')<>'number' or (p_payload->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,9})$'
      or (p_payload->>'expectedVersion')::numeric>2147483646 then
      raise exception using errcode='22023',message='Invalid responsible version.';
    end if;
    expected_version:=(p_payload->>'expectedVersion')::integer;
    if (p_operation='designate_responsible' and expected_version<>0) or (p_operation='replace_responsible' and expected_version<1) then
      raise exception using errcode='22023',message='Invalid responsible version.';
    end if;
  end if;
  if p_operation in ('reserve_provision','designate_responsible','replace_responsible') then
    if p_idempotency_key is null then raise exception using errcode='22023',message='Idempotency key is required.'; end if;
    fingerprint:=pg_catalog.sha256(pg_catalog.convert_to(p_payload::text,'UTF8'));
    insert into public.platform_account_operations(actor_auth_id,idempotency_key,operation,payload_hash)
      values(p_actor_auth_id,p_idempotency_key,p_operation,fingerprint) on conflict do nothing;
    select * into journal from public.platform_account_operations where actor_auth_id=p_actor_auth_id and idempotency_key=p_idempotency_key for update;
    if journal.operation<>p_operation or journal.payload_hash<>fingerprint then
      raise exception using errcode='PT409',message='IDEMPOTENCY_CONFLICT';
    end if;
    if journal.result is not null then
      if p_operation='reserve_provision' then
        select * into provision from public.platform_account_provisions where id=(journal.result->>'id')::uuid and tenant_id=tenant;
        return public.account_provision_dto(provision);
      end if;
      return journal.result;
    end if;
  end if;
  if p_operation='get_responsible' then
    perform 1 from public.tenants where id=tenant for share;
    if not found then raise exception using errcode='PT404',message='INSTITUTION_NOT_FOUND'; end if;
    select * into responsible from public.institution_responsibles where tenant_id=tenant;
    if not found then return null; end if;
    return jsonb_build_object('institutionId',tenant,'responsibleUserId',responsible.user_id,'version',responsible.version);
  end if;
  perform 1 from public.tenants where id=tenant for update;
  if not found then raise exception using errcode='PT404',message='INSTITUTION_NOT_FOUND'; end if;
  perform public.assert_operational_tenant(tenant);
  if p_operation='reserve_provision' then
    insert into public.platform_account_provisions(tenant_id,name,email) values(tenant,safe_name,safe_email)
      on conflict(tenant_id,email) do nothing;
    select * into provision from public.platform_account_provisions where tenant_id=tenant and email=safe_email for update;
    if provision.name<>safe_name then raise exception using errcode='PT409',message='PROVISION_IDENTITY_CONFLICT'; end if;
    outcome:=public.account_provision_dto(provision);
    audit_action:='account_provisioning_requested';
  elsif p_operation in ('prepare_provision','reconcile_provision') then
    select * into provision from public.platform_account_provisions where tenant_id=tenant and id=(p_payload->>'provisionId')::uuid for update;
    if not found then raise exception using errcode='PT404',message='PROVISION_NOT_FOUND'; end if;
    old_state:=provision.state; old_auth_id:=provision.auth_user_id;
    for auth_identity in select id,email_confirmed_at from auth.users where lower(btrim(email))=provision.email order by id for share loop
      auth_count:=auth_count+1; identity_id:=auth_identity.id; identity_confirmed:=auth_identity.email_confirmed_at is not null;
    end loop;
    if auth_count>1 then raise exception using errcode='PT409',message='ACCOUNT_AUTH_AMBIGUOUS'; end if;
    if auth_count=1 then
      if provision.auth_user_id is not null and provision.auth_user_id<>identity_id then
        raise exception using errcode='PT409',message='PROVISION_IDENTITY_CHANGED';
      end if;
      provision.auth_user_id:=identity_id;
      provision.state:=case when identity_confirmed then 'ready' else 'awaiting_confirmation' end;
    elsif p_operation='prepare_provision' and provision.invite_attempted_at is null and provision.auth_user_id is null then
      provision.invite_attempted_at:=clock_timestamp(); provision.state:='invite_requested'; invite_required:=true;
    else provision.state:='needs_review'; end if;
    if provision.state is distinct from old_state or provision.auth_user_id is distinct from old_auth_id then
      update public.platform_account_provisions set state=provision.state,auth_user_id=provision.auth_user_id,
        invite_attempted_at=provision.invite_attempted_at,updated_at=clock_timestamp() where id=provision.id returning * into provision;
      insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id)
        values(tenant,p_actor_auth_id,case when invite_required then 'account_invite_requested' else 'account_invite_reconciled' end,p_request_id);
    end if;
    return jsonb_build_object('provision',public.account_provision_dto(provision),'inviteRequired',invite_required,'email',provision.email);
  else
    select * into responsible from public.institution_responsibles where tenant_id=tenant for update;
    if p_operation='designate_responsible' then
      if found then raise exception using errcode='PT409',message='RESPONSIBLE_VERSION_CONFLICT'; end if;
      select * into target from public.app_users where tenant_id=tenant and id=(p_payload->>'administratorId')::uuid for update;
      if not found or target.role<>'admin' or not target.active then
        raise exception using errcode='PT409',message='RESPONSIBLE_ACTIVE_ADMIN_REQUIRED';
      end if;
      insert into public.institution_responsibles(tenant_id,user_id,version) values(tenant,target.id,1) returning * into responsible;
      audit_action:='responsible_designated';
    else
      if not found then raise exception using errcode='PT409',message='RESPONSIBLE_REQUIRED'; end if;
      if responsible.version<>expected_version then raise exception using errcode='PT409',message='RESPONSIBLE_VERSION_CONFLICT'; end if;
      select * into prior from public.app_users where tenant_id=tenant and id=responsible.user_id for update;
      if not found or prior.role<>'admin' or not prior.active then
        raise exception using errcode='PT409',message='RESPONSIBLE_ACTIVE_ADMIN_REQUIRED';
      end if;
      for auth_identity in select id,email_confirmed_at from auth.users where lower(btrim(email))=safe_email order by id for share loop
        auth_count:=auth_count+1; identity_id:=auth_identity.id; identity_confirmed:=auth_identity.email_confirmed_at is not null;
      end loop;
      if auth_count=0 then raise exception using errcode='PT409',message='ACCOUNT_AUTH_REQUIRED'; end if;
      if auth_count>1 then raise exception using errcode='PT409',message='ACCOUNT_AUTH_AMBIGUOUS'; end if;
      if not identity_confirmed then raise exception using errcode='PT409',message='ACCOUNT_AUTH_UNCONFIRMED'; end if;
      select * into target from public.app_users where tenant_id=tenant and auth_user_id=identity_id for update;
      if found then
        if target.role<>'admin' then raise exception using errcode='PT409',message='RESPONSIBLE_TARGET_ROLE_CONFLICT'; end if;
        if target.id=prior.id then raise exception using errcode='PT409',message='RESPONSIBLE_ALREADY_CURRENT'; end if;
        update public.app_users set active=true,updated_at=clock_timestamp() where id=target.id returning * into target;
      else
        if exists(select 1 from public.app_users where tenant_id=tenant and lower(btrim(email))=safe_email) then
          raise exception using errcode='PT409',message='RESPONSIBLE_TARGET_IDENTITY_CONFLICT';
        end if;
        insert into public.app_users(tenant_id,auth_user_id,name,email,role,active)
          values(tenant,identity_id,safe_name,safe_email,'admin',true) returning * into target;
      end if;
      update public.institution_responsibles set user_id=target.id,version=version+1 where tenant_id=tenant returning * into responsible;
      update public.app_users set active=false,updated_at=clock_timestamp() where tenant_id=tenant and id=prior.id;
      audit_action:='responsible_replaced';
    end if;
    outcome:=jsonb_build_object('institutionId',tenant,'responsibleUserId',responsible.user_id,'version',responsible.version);
  end if;
  insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,target_user_id,previous_user_id)
    values(tenant,p_actor_auth_id,audit_action,p_request_id,target.id,prior.id);
  update public.platform_account_operations set result=outcome where actor_auth_id=p_actor_auth_id and idempotency_key=p_idempotency_key;
  return outcome;
end $$;

alter function public.platform_manage_institution(uuid,text,uuid,uuid,jsonb) rename to platform_manage_institution_pre_p03;
revoke all on function public.platform_manage_institution_pre_p03(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.platform_manage_institution(
  p_actor_auth_id uuid,p_operation text,p_idempotency_key uuid,p_request_id uuid,p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  was_replay boolean:=false;
  outcome jsonb;
  tenant uuid;
  administrator uuid;
begin
  if p_operation='bootstrap' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_auth_id::text||':'||p_idempotency_key::text,0));
    select result is not null into was_replay from public.platform_operations
      where actor_auth_id=p_actor_auth_id and idempotency_key=p_idempotency_key;
  end if;
  outcome:=public.platform_manage_institution_pre_p03(p_actor_auth_id,p_operation,p_idempotency_key,p_request_id,p_payload);
  if p_operation='bootstrap' and not coalesce(was_replay,false) then
    tenant:=(outcome->>'institutionId')::uuid; administrator:=(outcome->'administrator'->>'id')::uuid;
    insert into public.institution_responsibles(tenant_id,user_id,version) values(tenant,administrator,1);
    insert into public.platform_audit_events(tenant_id,actor_auth_id,action,request_id,target_user_id)
      values(tenant,p_actor_auth_id,'responsible_designated',p_request_id,administrator);
  end if;
  return outcome;
end $$;
revoke all on function public.account_provision_dto(public.platform_account_provisions),public.guard_responsible_membership(),
  public.guard_responsible_target(),public.platform_manage_accounts(uuid,text,uuid,uuid,jsonb),
  public.platform_manage_institution(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.platform_manage_accounts(uuid,text,uuid,uuid,jsonb),
  public.platform_manage_institution(uuid,text,uuid,uuid,jsonb) to service_role;
commit;
