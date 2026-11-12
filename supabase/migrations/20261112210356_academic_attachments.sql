begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.academic_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  activity_id uuid,
  activity_scope_id uuid not null,
  class_id uuid not null,
  created_by uuid not null,
  purpose text not null check (purpose in ('material','submission')),
  original_name text not null check (char_length(original_name) between 1 and 180 and original_name !~ '[[:cntrl:]/\\]'),
  declared_type text not null check (declared_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg')),
  declared_size integer not null check (declared_size between 1 and 10000000),
  content_type text,
  size_bytes integer check (size_bytes between 1 and 10000000),
  sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
  bucket text not null check (bucket ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  staging_path text not null unique,
  candidate_paths text[] not null default '{}' check (cardinality(candidate_paths) <= 10),
  candidate_path text unique,
  final_path text unique,
  state text not null default 'pending' check (state in ('pending','validating','ready','rejected','cancelled','expired','deleting','deleted')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '2 hours',
  upload_expires_at timestamptz,
  validated_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  cleanup_token uuid,
  last_cleanup_token uuid,
  cleanup_until timestamptz,
  cleanup_kind text check (cleanup_kind in ('staging','unlinked')),
  cleanup_checked_at timestamptz,
  unique (tenant_id,activity_scope_id,purpose,created_by,idempotency_key),
  unique (tenant_id,activity_scope_id,id,purpose,created_by),
  foreign key (tenant_id,class_id,activity_id) references public.activities(tenant_id,class_id,id) on delete set null (activity_id),
  foreign key (tenant_id,created_by) references public.app_users(tenant_id,id),
  check (state <> 'ready' or (final_path is not null and sha256 is not null and size_bytes = declared_size and content_type = declared_type and validated_at is not null)),
  check (state <> 'validating' or (lease_token is not null and lease_until is not null and candidate_path is not null)),
  check ((cleanup_token is null and cleanup_until is null) or (cleanup_token is not null and cleanup_until is not null)),
  check (activity_id is null or activity_id=activity_scope_id),
  check (staging_path like 'staging/' || tenant_id::text || '/' || activity_scope_id::text || '/' || id::text || '/%'),
  check (candidate_path is null or candidate_path like 'files/' || tenant_id::text || '/' || activity_scope_id::text || '/' || id::text || '/%'),
  check (final_path is null or final_path = any(candidate_paths))
);
create index academic_files_owner_idx on public.academic_files(tenant_id,activity_id,created_by,purpose,state);
create index academic_files_cleanup_idx on public.academic_files(cleanup_checked_at,created_at);

create table public.activity_attachments (
  tenant_id uuid not null,
  activity_id uuid not null,
  file_id uuid not null,
  purpose text not null default 'material' check (purpose = 'material'),
  created_by uuid not null,
  position smallint not null check (position between 1 and 5),
  created_at timestamptz not null default clock_timestamp(),
  attached_revision integer not null,
  removed_at timestamptz,
  removed_by uuid,
  removed_reason text,
  removed_revision integer,
  primary key (tenant_id,activity_id,file_id),
  foreign key (tenant_id,activity_id,file_id,purpose,created_by) references public.academic_files(tenant_id,activity_scope_id,id,purpose,created_by),
  foreign key (tenant_id,removed_by) references public.app_users(tenant_id,id),
  check ((removed_at is null and removed_by is null and removed_revision is null and removed_reason is null) or (removed_at is not null and removed_revision is not null and (removed_by is not null or removed_reason='activity_deleted')))
);
create unique index activity_attachments_position_idx on public.activity_attachments(tenant_id,activity_id,position) where removed_at is null;
create index activity_attachments_file_idx on public.activity_attachments(file_id);

alter table public.activity_submissions add constraint activity_submissions_attachment_identity_key unique (tenant_id,id,activity_id,student_id);
create table public.submission_version_attachments (
  tenant_id uuid not null,
  activity_id uuid not null,
  submission_id uuid not null,
  version integer not null,
  file_id uuid not null,
  purpose text not null default 'submission' check (purpose = 'submission'),
  student_id uuid not null,
  position smallint not null check (position between 1 and 5),
  primary key (tenant_id,submission_id,version,file_id),
  unique (tenant_id,submission_id,version,position),
  foreign key (tenant_id,submission_id,version) references public.activity_submission_versions(tenant_id,submission_id,version),
  foreign key (tenant_id,submission_id,activity_id,student_id) references public.activity_submissions(tenant_id,id,activity_id,student_id),
  foreign key (tenant_id,activity_id,file_id,purpose,student_id) references public.academic_files(tenant_id,activity_scope_id,id,purpose,created_by)
);
create index submission_version_attachments_file_idx on public.submission_version_attachments(file_id);

alter table public.academic_files enable row level security;
alter table public.activity_attachments enable row level security;
alter table public.submission_version_attachments enable row level security;
revoke all on public.academic_files,public.activity_attachments,public.submission_version_attachments from public,anon,authenticated,service_role;

create function public.academic_attachment_actor(p_tenant uuid,p_actor uuid) returns public.app_users
language plpgsql set search_path = pg_catalog, public as $$
declare actor public.app_users%rowtype;
begin
  perform public.assert_operational_tenant(p_tenant);
  select * into actor from public.app_users where tenant_id=p_tenant and id=p_actor and active for share;
  if not found then raise exception using errcode='42501',message='Active institutional identity required.'; end if;
  return actor;
end $$;

create function public.academic_attachment_context(p_tenant uuid,p_actor uuid,p_activity uuid,p_purpose text,p_write boolean)
returns public.activities language plpgsql set search_path = pg_catalog, public as $$
declare activity public.activities%rowtype; actor public.app_users%rowtype; target_class_id uuid; visible jsonb;
begin
  actor := public.academic_attachment_actor(p_tenant,p_actor);
  select a.class_id into target_class_id from public.activities a where a.tenant_id=p_tenant and a.id=p_activity;
  if not found then raise exception using errcode='P0002',message='Academic record not found.'; end if;
  if p_write then
    perform 1 from public.classes where tenant_id=p_tenant and id=target_class_id for share;
    select * into activity from public.activities where tenant_id=p_tenant and id=p_activity for no key update;
  else
    select * into activity from public.activities where tenant_id=p_tenant and id=p_activity;
  end if;
  if activity.id is null or activity.assessment_category='exam' then raise exception using errcode='P0002',message='Academic record not found.'; end if;
  if p_write and (not activity.workflow_enabled or activity.state='closed') then raise exception using errcode='23514',message='Attachments are not editable.'; end if;
  if p_write then perform public.workflow_require_active_class(p_tenant,activity.class_id); end if;
  if p_purpose='material' then
    if actor.role='student' and not p_write then
      visible := public.list_academic_activities(p_tenant,p_actor,activity.class_id,0,1,p_activity);
      if jsonb_array_length(visible->'activities')=0 then raise exception using errcode='P0002',message='Academic record not found.'; end if;
    else
      perform public.workflow_authorize_actor(p_tenant,p_actor,activity.class_id,false);
    end if;
    if p_write and exists(select 1 from public.activity_submissions where tenant_id=p_tenant and activity_id=p_activity) then
      raise exception using errcode='23514',message='Materials are frozen after the first submission.';
    end if;
  elsif p_purpose='submission' and p_write then
    if actor.role<>'student' then raise exception using errcode='42501',message='Student identity required.'; end if;
    perform 1 from public.enrollments where tenant_id=p_tenant and class_id=activity.class_id and student_id=p_actor and status='active' for share;
    if not found then raise exception using errcode='42501',message='Active enrollment required.'; end if;
    if activity.state<>'published' or (activity.due_date is not null and clock_timestamp()>activity.due_date and not activity.allow_late)
      or exists(select 1 from public.grades where tenant_id=p_tenant and activity_id=p_activity and student_id=actor.auth_user_id) then
      raise exception using errcode='23514',message='Submission is not eligible.';
    end if;
  else raise exception using errcode='22023',message='Invalid attachment purpose.';
  end if;
  return activity;
end $$;

create function public.academic_attachment_submission(p_tenant uuid,p_actor uuid,p_submission uuid)
returns public.activity_submissions language plpgsql set search_path = pg_catalog, public as $$
declare actor public.app_users%rowtype; delivery public.activity_submissions%rowtype;
begin
  actor := public.academic_attachment_actor(p_tenant,p_actor);
  select * into delivery from public.activity_submissions where tenant_id=p_tenant and id=p_submission;
  if not found then raise exception using errcode='P0002',message='Submission not found.'; end if;
  if actor.role='student' then
    if delivery.student_id<>p_actor then raise exception using errcode='P0002',message='Submission not found.'; end if;
  else perform public.workflow_authorize_actor(p_tenant,p_actor,delivery.class_id,false);
  end if;
  return delivery;
end $$;

create function public.academic_attachment_metadata(p_file public.academic_files) returns jsonb
language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('id',p_file.id,'name',p_file.original_name,'contentType',p_file.content_type,'sizeBytes',p_file.size_bytes,'createdAt',p_file.created_at)
$$;

create function public.academic_attachment_reserve(p_tenant_id uuid,p_actor_id uuid,p_activity_id uuid,p_purpose text,p_bucket text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare activity public.activities%rowtype; file public.academic_files%rowtype; fingerprint text; file_id uuid:=gen_random_uuid(); n integer;
begin
  perform public.academic_attachment_actor(p_tenant_id,p_actor_id);
  perform pg_advisory_xact_lock(hashtextextended('academic-attachments:'||p_tenant_id::text,0));
  if p_request is null or jsonb_typeof(p_request)<>'object' or exists(select 1 from jsonb_object_keys(p_request) k where k not in ('fileName','contentType','sizeBytes','idempotencyKey','expectedVersion')) then raise exception using errcode='22023',message='Invalid reservation.'; end if;
  fingerprint:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
  select * into file from public.academic_files where tenant_id=p_tenant_id and activity_id=p_activity_id and purpose=p_purpose and created_by=p_actor_id and idempotency_key=p_request->>'idempotencyKey';
  if found then
    if file.request_fingerprint<>fingerprint then raise exception using errcode='23514',message='Idempotency conflict.'; end if;
    return to_jsonb(file);
  end if;
  activity:=public.academic_attachment_context(p_tenant_id,p_actor_id,p_activity_id,p_purpose,true);
  if p_purpose='submission' then
    select coalesce(max(current_version),0) into n from public.activity_submissions where tenant_id=p_tenant_id and activity_id=p_activity_id and student_id=p_actor_id;
    if (p_request->>'expectedVersion')::integer is distinct from n then raise exception using errcode='23514',message='Submission version conflict.'; end if;
  end if;
  select count(*) into n from public.academic_files f where tenant_id=p_tenant_id and activity_id=p_activity_id and purpose=p_purpose
    and (p_purpose='material' or created_by=p_actor_id) and state in ('pending','validating','ready')
    and (state='ready' or expires_at>clock_timestamp())
    and not exists(select 1 from public.submission_version_attachments a where a.file_id=f.id)
    and not exists(select 1 from public.activity_attachments a where a.file_id=f.id and a.removed_at is not null);
  if n>=5 then raise exception using errcode='54000',message='Attachment limit.'; end if;
  if (select coalesce(sum(declared_size::bigint),0) from public.academic_files where tenant_id=p_tenant_id and state<>'deleted') + (p_request->>'sizeBytes')::integer > 1000000000 then
    raise exception using errcode='54000',message='Institution attachment quota.';
  end if;
  insert into public.academic_files(id,tenant_id,activity_id,activity_scope_id,class_id,created_by,purpose,original_name,declared_type,declared_size,bucket,staging_path,idempotency_key,request_fingerprint)
    values(file_id,p_tenant_id,p_activity_id,p_activity_id,activity.class_id,p_actor_id,p_purpose,p_request->>'fileName',p_request->>'contentType',(p_request->>'sizeBytes')::integer,p_bucket,
      'staging/'||p_tenant_id||'/'||p_activity_id||'/'||file_id||'/'||gen_random_uuid(),p_request->>'idempotencyKey',fingerprint) returning * into file;
  return to_jsonb(file);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception using errcode='22023',message='Invalid reservation.';
end $$;

create function public.academic_attachment_upload(p_tenant_id uuid,p_actor_id uuid,p_file_id uuid,p_operation text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare file public.academic_files%rowtype; lease uuid; extension text;
begin
  perform public.academic_attachment_actor(p_tenant_id,p_actor_id);
  select * into file from public.academic_files where tenant_id=p_tenant_id and id=p_file_id and created_by=p_actor_id;
  if not found then raise exception using errcode='P0002',message='Upload not found.'; end if;
  if p_operation='get' then return to_jsonb(file); end if;
  if p_operation in ('sign','claim','finish') and file.state<>'ready' then
    perform public.academic_attachment_context(p_tenant_id,p_actor_id,file.activity_id,file.purpose,true);
  end if;
  select * into file from public.academic_files where tenant_id=p_tenant_id and id=p_file_id and created_by=p_actor_id for update;
  if p_operation='cancel' then
    if exists(select 1 from public.activity_attachments where file_id=file.id) or exists(select 1 from public.submission_version_attachments where file_id=file.id)
      or (file.state='validating' and file.lease_until>clock_timestamp()) then raise exception using errcode='23514',message='File is protected.'; end if;
    if file.state in ('pending','validating','ready','rejected','expired','cancelled') then update public.academic_files set state='cancelled',lease_token=null,lease_until=null where id=file.id returning * into file; end if;
  elsif p_operation='sign' then
    if file.state<>'pending' or file.upload_expires_at is not null or file.expires_at<=clock_timestamp() then raise exception using errcode='23514',message='Upload capability already issued or expired.'; end if;
    update public.academic_files set upload_expires_at=clock_timestamp()+interval '2 hours 1 minute' where id=file.id returning * into file;
  elsif p_operation='claim' then
    if file.state='ready' then return to_jsonb(file); end if;
    if file.state='validating' and file.lease_until>clock_timestamp() then return to_jsonb(file); end if;
    if file.state not in ('pending','validating') or file.expires_at<=clock_timestamp() or cardinality(file.candidate_paths)>=10 then raise exception using errcode='23514',message='Upload is not eligible.'; end if;
    lease:=coalesce((p_payload->>'leaseToken')::uuid,gen_random_uuid());
    extension:=case file.declared_type when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' else 'docx' end;
    update public.academic_files set state='validating',lease_token=lease,lease_until=clock_timestamp()+interval '90 seconds',
      candidate_path='files/'||tenant_id||'/'||activity_id||'/'||id||'/'||lease||'.'||extension,
      candidate_paths=array_append(candidate_paths,'files/'||tenant_id||'/'||activity_id||'/'||id||'/'||lease||'.'||extension)
      where id=file.id returning * into file;
  elsif p_operation in ('finish','release','reject') then
    if file.state='ready' and p_operation='finish' then return to_jsonb(file); end if;
    if file.state<>'validating' or file.lease_token is distinct from (p_payload->>'leaseToken')::uuid or file.lease_until<=clock_timestamp() then raise exception using errcode='23514',message='Upload lease lost.'; end if;
    if p_operation='finish' then
      if (p_payload->>'sizeBytes')::integer is distinct from file.declared_size or p_payload->>'contentType' is distinct from file.declared_type or (p_payload->>'sha256') !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Invalid confirmed file.'; end if;
      update public.academic_files set state='ready',final_path=candidate_path,content_type=declared_type,size_bytes=declared_size,sha256=p_payload->>'sha256',validated_at=clock_timestamp(),lease_token=null,lease_until=null where id=file.id returning * into file;
    else
      update public.academic_files set state=case p_operation when 'release' then 'pending' else 'rejected' end,lease_token=null,lease_until=null where id=file.id returning * into file;
    end if;
  else raise exception using errcode='22023',message='Invalid upload operation.';
  end if;
  return to_jsonb(file);
end $$;

create function public.academic_attachment_material(p_tenant_id uuid,p_actor_id uuid,p_activity_id uuid,p_operation text,p_file_id uuid default null,p_expected_version integer default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare activity public.activities%rowtype; file public.academic_files%rowtype; link public.activity_attachments%rowtype; slot integer; previous_context text:=current_setting('app.activity_workflow',true);
begin
  activity:=public.academic_attachment_context(p_tenant_id,p_actor_id,p_activity_id,'material',false);
  if p_operation<>'list' then perform public.workflow_authorize_actor(p_tenant_id,p_actor_id,activity.class_id,false); end if;
  if p_operation='list' then
    return coalesce((select jsonb_agg(public.academic_attachment_metadata(f) order by a.position) from public.activity_attachments a join public.academic_files f on f.id=a.file_id and f.tenant_id=a.tenant_id where a.tenant_id=p_tenant_id and a.activity_id=p_activity_id and a.removed_at is null and f.state='ready'),'[]'::jsonb);
  end if;
  select * into link from public.activity_attachments where tenant_id=p_tenant_id and activity_id=p_activity_id and file_id=p_file_id;
  if found and ((p_operation='add' and link.removed_at is null) or (p_operation='remove' and link.removed_at is not null)) then
    if p_operation='add' and link.created_by<>p_actor_id then raise exception using errcode='P0002',message='File not found.'; end if;
    select * into file from public.academic_files where id=link.file_id and tenant_id=p_tenant_id;
    return jsonb_build_object('revision',case when p_operation='add' then link.attached_revision else link.removed_revision end,'id',link.file_id)
      || case when p_operation='add' then jsonb_build_object('attachment',public.academic_attachment_metadata(file)) else '{}'::jsonb end;
  end if;
  activity:=public.academic_attachment_context(p_tenant_id,p_actor_id,p_activity_id,'material',true);
  if p_expected_version is distinct from activity.revision then raise exception using errcode='23514',message='Activity revision conflict.'; end if;
  select * into file from public.academic_files where tenant_id=p_tenant_id and activity_id=p_activity_id and id=p_file_id and purpose='material' for update;
  if not found then raise exception using errcode='P0002',message='File not found.'; end if;
  if p_operation='add' then
    if file.created_by<>p_actor_id then raise exception using errcode='P0002',message='File not found.'; end if;
    if file.state<>'ready' or link.file_id is not null then raise exception using errcode='23514',message='File not available.'; end if;
    select n into slot from generate_series(1,5) n where not exists(select 1 from public.activity_attachments where tenant_id=p_tenant_id and activity_id=p_activity_id and position=n and removed_at is null) order by n limit 1;
    if slot is null then raise exception using errcode='54000',message='Attachment limit.'; end if;
    insert into public.activity_attachments(tenant_id,activity_id,file_id,created_by,position,attached_revision) values(p_tenant_id,p_activity_id,p_file_id,p_actor_id,slot,activity.revision+1);
  elsif p_operation='remove' then
    if link.file_id is null then raise exception using errcode='P0002',message='File not found.'; end if;
    update public.activity_attachments set removed_at=clock_timestamp(),removed_by=p_actor_id,removed_revision=activity.revision+1 where tenant_id=p_tenant_id and activity_id=p_activity_id and file_id=p_file_id;
  else raise exception using errcode='22023',message='Invalid material operation.';
  end if;
  perform set_config('app.activity_workflow',activity.id::text,true);
  update public.activities set revision=revision+1 where tenant_id=p_tenant_id and id=p_activity_id returning * into activity;
  perform set_config('app.activity_workflow',coalesce(previous_context,''),true);
  return jsonb_build_object('revision',activity.revision,'id',file.id)
    || case when p_operation='add' then jsonb_build_object('attachment',public.academic_attachment_metadata(file)) else '{}'::jsonb end;
end $$;

create function public.academic_attachment_activity_deleted() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.activity_attachments set removed_at=clock_timestamp(),removed_revision=old.revision+1,removed_reason='activity_deleted'
    where tenant_id=old.tenant_id and activity_id=old.id and removed_at is null;
  update public.academic_files set state=case when state in ('deleted','deleting') then state else 'cancelled' end,lease_token=null,lease_until=null
    where tenant_id=old.tenant_id and activity_id=old.id;
  return old;
end $$;
create trigger activities_attachments_delete before delete on public.activities for each row execute function public.academic_attachment_activity_deleted();

create function public.submit_activity_answer_with_attachments(p_tenant_id uuid,p_actor_id uuid,p_activity_id uuid,p_expected_version integer,p_answer text,p_attachment_ids uuid[])
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare delivery jsonb; activity public.activities%rowtype; file public.academic_files%rowtype; file_id uuid; n integer:=0; previous_context text:=current_setting('app.academic_attachments',true);
begin
  if p_attachment_ids is null or cardinality(p_attachment_ids)>5 or exists(select 1 from unnest(p_attachment_ids) id group by id having count(*)>1) or array_position(p_attachment_ids,null) is not null then raise exception using errcode='22023',message='Invalid attachment set.'; end if;
  activity:=public.academic_attachment_context(p_tenant_id,p_actor_id,p_activity_id,'submission',true);
  delivery:=public.submit_activity_answer(p_tenant_id,p_actor_id,p_activity_id,p_expected_version,p_answer);
  perform 1 from public.academic_files where id=any(p_attachment_ids) order by id for update;
  foreach file_id in array p_attachment_ids loop
    select * into file from public.academic_files where tenant_id=p_tenant_id and activity_id=p_activity_id and id=file_id and created_by=p_actor_id and purpose='submission';
    if not found then raise exception using errcode='P0002',message='File not found.'; end if;
    if file.state<>'ready' then raise exception using errcode='23514',message='File not confirmed.'; end if;
    n:=n+1;
    perform set_config('app.academic_attachments',delivery->>'id',true);
    insert into public.submission_version_attachments(tenant_id,activity_id,submission_id,version,file_id,student_id,position)
      values(p_tenant_id,p_activity_id,(delivery->>'id')::uuid,(delivery->>'current_version')::integer,file.id,p_actor_id,n);
  end loop;
  perform set_config('app.academic_attachments',coalesce(previous_context,''),true);
  return delivery;
end $$;

create function public.academic_attachment_immutable_version() returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op<>'INSERT' or current_setting('app.academic_attachments',true) is distinct from new.submission_id::text then raise exception using errcode='23514',message='Submission attachment history is immutable.'; end if;
  return new;
end $$;
create trigger submission_version_attachments_guard before insert or update or delete on public.submission_version_attachments for each row execute function public.academic_attachment_immutable_version();

create function public.academic_attachment_versions(p_tenant_id uuid,p_actor_id uuid,p_versions jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare item jsonb; delivery public.activity_submissions%rowtype; result jsonb:='[]'::jsonb; requested_version integer; files jsonb;
begin
  perform public.academic_attachment_actor(p_tenant_id,p_actor_id);
  if jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions)>100 then raise exception using errcode='22023',message='Invalid versions.'; end if;
  for item in select * from jsonb_array_elements(p_versions) loop
    delivery:=public.academic_attachment_submission(p_tenant_id,p_actor_id,(item->>'submissionId')::uuid);
    requested_version:=(item->>'version')::integer;
    if not exists(select 1 from public.activity_submission_versions where tenant_id=p_tenant_id and submission_id=delivery.id and version=requested_version) then raise exception using errcode='P0002',message='Version not found.'; end if;
    select coalesce(jsonb_agg(public.academic_attachment_metadata(f) order by a.position),'[]'::jsonb) into files
      from public.submission_version_attachments a join public.academic_files f on f.id=a.file_id and f.tenant_id=a.tenant_id
      where a.tenant_id=p_tenant_id and a.submission_id=delivery.id and a.version=requested_version and f.state='ready';
    result:=result||jsonb_build_array(jsonb_build_object('submissionId',delivery.id,'version',requested_version,'attachments',files));
  end loop;
  return result;
end $$;

create function public.academic_attachment_download(p_tenant_id uuid,p_actor_id uuid,p_file_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare file public.academic_files%rowtype; sub_id uuid;
begin
  perform public.academic_attachment_actor(p_tenant_id,p_actor_id);
  select * into file from public.academic_files where tenant_id=p_tenant_id and id=p_file_id and state='ready';
  if not found then raise exception using errcode='P0002',message='File not found.'; end if;
  if file.purpose='material' then
    perform public.academic_attachment_context(p_tenant_id,p_actor_id,file.activity_id,'material',false);
    if not exists(select 1 from public.activity_attachments where tenant_id=p_tenant_id and file_id=file.id and removed_at is null) then raise exception using errcode='P0002',message='File not found.'; end if;
  else
    select submission_id into sub_id from public.submission_version_attachments where tenant_id=p_tenant_id and file_id=file.id limit 1;
    if sub_id is null then raise exception using errcode='P0002',message='File not found.'; end if;
    perform public.academic_attachment_submission(p_tenant_id,p_actor_id,sub_id);
  end if;
  return to_jsonb(file);
end $$;

create function public.academic_attachment_cleanup(p_operation text,p_file_id uuid default null,p_token uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare file public.academic_files%rowtype; linked boolean; paths text[];
begin
  if p_operation='candidates' then
    return coalesce((select jsonb_agg(to_jsonb(f)) from (select id,bucket,staging_path,candidate_paths,final_path,state,
      exists(select 1 from public.activity_attachments a where a.file_id=academic_files.id) or exists(select 1 from public.submission_version_attachments a where a.file_id=academic_files.id) as protected
      from public.academic_files
      where coalesce(upload_expires_at,expires_at)+interval '1 hour'<clock_timestamp()
      and (lease_until is null or lease_until<clock_timestamp()) and (cleanup_until is null or cleanup_until<clock_timestamp())
      and (cleanup_checked_at is null or cleanup_checked_at<clock_timestamp()-interval '24 hours')
      and (state<>'ready' or validated_at<clock_timestamp()-interval '24 hours')
      order by cleanup_checked_at nulls first,created_at limit 100) f),'[]'::jsonb);
  end if;
  select * into file from public.academic_files where id=p_file_id for update;
  if not found then raise exception using errcode='P0002',message='File not found.'; end if;
  if p_operation='claim' then
    if coalesce(file.upload_expires_at,file.expires_at)+interval '1 hour'>=clock_timestamp() or file.lease_until>clock_timestamp() or file.cleanup_until>clock_timestamp()
      or (file.state='ready' and file.validated_at>clock_timestamp()-interval '24 hours') then raise exception using errcode='23514',message='File is not eligible for cleanup.'; end if;
    linked:=exists(select 1 from public.activity_attachments where file_id=file.id) or exists(select 1 from public.submission_version_attachments where file_id=file.id);
    paths:=array_prepend(file.staging_path,array(select x from unnest(file.candidate_paths) x where not linked or x is distinct from file.final_path));
    update public.academic_files set cleanup_token=gen_random_uuid(),cleanup_until=clock_timestamp()+interval '90 seconds',cleanup_kind=case when linked then 'staging' else 'unlinked' end,
      state=case when linked then state else 'deleting' end where id=file.id returning * into file;
    return jsonb_build_object('id',file.id,'bucket',file.bucket,'paths',paths,'token',file.cleanup_token);
  elsif p_operation='finish' then
    if p_token is not null and file.last_cleanup_token=p_token then return jsonb_build_object('id',file.id); end if;
    if p_token is null or file.cleanup_token is null or file.cleanup_until is null or file.cleanup_token is distinct from p_token or file.cleanup_until<=clock_timestamp() then raise exception using errcode='23514',message='Cleanup lease lost.'; end if;
    update public.academic_files set state=case cleanup_kind when 'unlinked' then 'deleted' else state end,cleanup_checked_at=clock_timestamp(),last_cleanup_token=cleanup_token,cleanup_token=null,cleanup_until=null where id=file.id;
    return jsonb_build_object('id',file.id);
  end if;
  raise exception using errcode='22023',message='Invalid cleanup operation.';
end $$;

revoke all on function public.academic_attachment_actor(uuid,uuid),public.academic_attachment_context(uuid,uuid,uuid,text,boolean),public.academic_attachment_submission(uuid,uuid,uuid),public.academic_attachment_metadata(public.academic_files),public.academic_attachment_immutable_version(),public.academic_attachment_activity_deleted() from public,anon,authenticated,service_role;
revoke all on function public.academic_attachment_reserve(uuid,uuid,uuid,text,text,jsonb),public.academic_attachment_upload(uuid,uuid,uuid,text,jsonb),public.academic_attachment_material(uuid,uuid,uuid,text,uuid,integer),public.submit_activity_answer_with_attachments(uuid,uuid,uuid,integer,text,uuid[]),public.academic_attachment_versions(uuid,uuid,jsonb),public.academic_attachment_download(uuid,uuid,uuid),public.academic_attachment_cleanup(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.academic_attachment_reserve(uuid,uuid,uuid,text,text,jsonb),public.academic_attachment_upload(uuid,uuid,uuid,text,jsonb),public.academic_attachment_material(uuid,uuid,uuid,text,uuid,integer),public.submit_activity_answer_with_attachments(uuid,uuid,uuid,integer,text,uuid[]),public.academic_attachment_versions(uuid,uuid,jsonb),public.academic_attachment_download(uuid,uuid,uuid),public.academic_attachment_cleanup(text,uuid,uuid) to service_role;

commit;
