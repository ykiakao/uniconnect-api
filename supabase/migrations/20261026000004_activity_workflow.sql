begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.classes, public.activities, public.grades, public.app_users,
  public.enrollments, public.teaching_assignments in share row exclusive mode;

alter table public.activities
  add column state text not null default 'published' check (state in ('draft','published','closed')),
  add column instructions text,
  add column evaluation_criteria text,
  add column priority text not null default 'medium' check (priority in ('low','medium','high')),
  add column allow_late boolean not null default false,
  add column workflow_enabled boolean not null default false,
  add column revision integer not null default 1 check (revision > 0),
  add column published_at timestamptz,
  add column closed_at timestamptz,
  add constraint activities_tenant_class_id_key unique (tenant_id,class_id,id);
alter table public.activities alter column state set default 'draft';
alter table public.activities alter column workflow_enabled set default true;

create table public.activity_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  activity_id uuid not null,
  class_id uuid not null,
  student_id uuid not null,
  current_version integer not null check (current_version > 0),
  answer text not null check (char_length(btrim(answer)) between 1 and 20000 and char_length(answer) <= 20000),
  submitted_at timestamptz not null,
  is_late boolean not null,
  unique (tenant_id,activity_id,student_id),
  unique (tenant_id,id),
  foreign key (tenant_id,class_id,activity_id) references public.activities(tenant_id,class_id,id),
  foreign key (tenant_id,class_id,student_id) references public.enrollments(tenant_id,class_id,student_id)
);
create index activity_submissions_activity_time_idx on public.activity_submissions(tenant_id,activity_id,submitted_at,id);
create index activity_submissions_student_idx on public.activity_submissions(tenant_id,student_id,activity_id);

create table public.activity_submission_versions (
  tenant_id uuid not null,
  submission_id uuid not null,
  version integer not null check (version > 0),
  answer text not null check (char_length(btrim(answer)) between 1 and 20000 and char_length(answer) <= 20000),
  submitted_at timestamptz not null,
  is_late boolean not null,
  primary key (tenant_id,submission_id,version),
  foreign key (tenant_id,submission_id) references public.activity_submissions(tenant_id,id)
);
alter table public.grades
  add column publication_state text not null default 'published' check (publication_state in ('draft','published')),
  add column revision integer not null default 1 check (revision > 0),
  add column submission_id uuid,
  add column submission_version integer,
  add constraint grades_tenant_id_key unique (tenant_id,id),
  add constraint grades_submission_pair check ((submission_id is null) = (submission_version is null)),
  add constraint grades_submission_version_fkey foreign key (tenant_id,submission_id,submission_version)
    references public.activity_submission_versions(tenant_id,submission_id,version);
create unique index grades_submission_unique on public.grades(tenant_id,submission_id) where submission_id is not null;

create table public.grade_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grade_id uuid not null,
  revision integer not null check (revision > 0),
  activity_id uuid not null,
  student_id uuid not null,
  grade numeric(5,2) check (grade is null or grade between 0 and 10),
  feedback text,
  publication_state text not null check (publication_state in ('draft','published')),
  graded_by uuid references auth.users(id),
  graded_at timestamptz,
  submission_id uuid,
  submission_version integer,
  captured_at timestamptz not null default clock_timestamp(),
  unique (tenant_id,grade_id,revision),
  foreign key (tenant_id,grade_id) references public.grades(tenant_id,id),
  foreign key (tenant_id,activity_id) references public.activities(tenant_id,id),
  foreign key (tenant_id,student_id) references public.app_users(tenant_id,auth_user_id),
  foreign key (tenant_id,submission_id,submission_version) references public.activity_submission_versions(tenant_id,submission_id,version),
  check ((submission_id is null) = (submission_version is null))
);
insert into public.grade_revisions(tenant_id,grade_id,revision,activity_id,student_id,grade,feedback,publication_state,graded_by,graded_at,submission_id,submission_version)
  select tenant_id,id,revision,activity_id,student_id,grade,feedback,publication_state,graded_by,graded_at,submission_id,submission_version from public.grades;

create function public.guard_activity_workflow() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.activity_submissions where tenant_id=old.tenant_id and activity_id=old.id) then
      raise exception using errcode='23514',message='Activity has submissions.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.workflow_enabled is not true or new.state <> 'draft' or new.revision <> 1
      or new.published_at is not null or new.closed_at is not null then
      raise exception using errcode='23514',message='New activity must start as a workflow draft.';
    end if;
    perform public.workflow_require_active_class(new.tenant_id,new.class_id);
    return new;
  end if;
  if (new.id,new.tenant_id,new.class_id,new.created_by,new.created_at,new.workflow_enabled)
    is distinct from (old.id,old.tenant_id,old.class_id,old.created_by,old.created_at,old.workflow_enabled) then
    raise exception using errcode='23514',message='Activity ownership is immutable.';
  end if;
  if old.workflow_enabled then
    if current_setting('app.activity_workflow',true) is distinct from old.id::text or new.revision <> old.revision+1 then
      raise exception using errcode='23514',message='Workflow activity requires a versioned operation.';
    end if;
  else
    new.revision := old.revision+1;
  end if;
  if old.state='closed' or (old.state='draft' and new.state='closed') or (old.state='published' and new.state='draft') then
    raise exception using errcode='23514',message='Activity cannot return to an earlier state.';
  end if;
  if exists (select 1 from public.activity_submissions where tenant_id=old.tenant_id and activity_id=old.id) then
    if (new.title,new.description,new.type,new.instructions,new.evaluation_criteria,new.priority,new.allow_late)
      is distinct from (old.title,old.description,old.type,old.instructions,old.evaluation_criteria,old.priority,old.allow_late)
      or (old.due_date is null and new.due_date is not null)
      or (new.due_date < old.due_date) then
      raise exception using errcode='23514',message='Submitted activity content is frozen; deadline may only extend.';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger activities_workflow_guard before insert or update or delete on public.activities for each row execute function public.guard_activity_workflow();

create function public.guard_workflow_history() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op <> 'INSERT' or pg_trigger_depth() < 2 then
    raise exception using errcode='23514',message='Workflow history is append-only and generated by current records.';
  end if;
  return new;
end $$;
create trigger submission_versions_guard before insert or update or delete on public.activity_submission_versions for each row execute function public.guard_workflow_history();
create trigger grade_revisions_guard before insert or update or delete on public.grade_revisions for each row execute function public.guard_workflow_history();

create function public.guard_activity_submission() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve submission history.'; end if;
  if current_setting('app.activity_workflow',true) is distinct from new.activity_id::text then
    raise exception using errcode='23514',message='Submission requires a transactional workflow operation.';
  end if;
  if tg_op='UPDATE' and ((new.id,new.tenant_id,new.activity_id,new.class_id,new.student_id)
      is distinct from (old.id,old.tenant_id,old.activity_id,old.class_id,old.student_id)
      or new.current_version<>old.current_version+1) then
    raise exception using errcode='23514',message='Submission identity or version is invalid.';
  end if;
  if tg_op='INSERT' and new.current_version<>1 then raise exception using errcode='23514',message='Initial submission version must be one.'; end if;
  return new;
end $$;
create trigger activity_submissions_guard before insert or update or delete on public.activity_submissions for each row execute function public.guard_activity_submission();
create function public.record_activity_submission_version() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into public.activity_submission_versions(tenant_id,submission_id,version,answer,submitted_at,is_late)
    values(new.tenant_id,new.id,new.current_version,new.answer,new.submitted_at,new.is_late);
  return new;
end $$;
create trigger activity_submissions_record_version after insert or update on public.activity_submissions for each row execute function public.record_activity_submission_version();

create or replace function public.require_grade_enrollment() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  perform 1 from public.activities a
    join public.app_users u on u.tenant_id=a.tenant_id and u.auth_user_id=new.student_id and u.role='student'
    join public.enrollments e on e.tenant_id=a.tenant_id and e.class_id=a.class_id and e.student_id=u.id
    where a.tenant_id=new.tenant_id and a.id=new.activity_id
      and (e.status in ('active','completed') or new.submission_id is not null)
    for key share of a for share of u,e;
  if not found then raise exception using errcode='23514',message='Grade requires a formal enrollment.'; end if;
  return new;
end $$;

create function public.guard_workflow_grade() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  delivery public.activity_submissions%rowtype;
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve grade history.'; end if;
  if tg_op='UPDATE' and (new.id,new.tenant_id,new.activity_id,new.student_id,new.submission_id)
    is distinct from (old.id,old.tenant_id,old.activity_id,old.student_id,old.submission_id) then
    raise exception using errcode='23514',message='Grade ownership is immutable.';
  end if;
  select * into activity from public.activities where tenant_id=new.tenant_id and id=new.activity_id for key share;
  if not found then raise exception using errcode='23514',message='Grade activity is invalid.'; end if;
  if activity.workflow_enabled or new.submission_id is not null then
    if current_setting('app.activity_workflow',true) is distinct from activity.id::text then
      raise exception using errcode='23514',message='Review must use the submission workflow.';
    end if;
    if new.submission_id is null and (current_setting('app.activity_manual_grade',true) is distinct from activity.id::text
      or new.publication_state<>'published' or activity.state not in ('published','closed')) then
      raise exception using errcode='23514',message='Workflow grade requires a submission or an authorized published manual grade.';
    end if;
  else
    if tg_op='INSERT' then
      select * into activity from public.activities where tenant_id=new.tenant_id and id=new.activity_id for no key update;
    end if;
    if new.publication_state<>'published' then raise exception using errcode='23514',message='Legacy grade must be published.'; end if;
    if tg_op='UPDATE' then new.revision:=old.revision+1; end if;
  end if;
  select s.* into delivery from public.activity_submissions s
    join public.app_users u on u.tenant_id=s.tenant_id and u.id=s.student_id and u.auth_user_id=new.student_id
    where s.tenant_id=new.tenant_id and s.activity_id=new.activity_id;
  if found then
    if new.submission_id is distinct from delivery.id or new.submission_version is distinct from delivery.current_version then
      raise exception using errcode='23514',message='Grade must bind to the student current submission version.';
    end if;
  elsif new.submission_id is not null then
    raise exception using errcode='23514',message='Grade submission has a different student or activity.';
  end if;
  if tg_op='UPDATE' then
    if new.revision<>old.revision+1 or (old.publication_state='published' and new.publication_state<>'published') then
      raise exception using errcode='23514',message='Grade revision or publication transition is invalid.';
    end if;
  elsif new.revision<>1 then raise exception using errcode='23514',message='Initial grade revision must be one.';
  end if;
  return new;
end $$;
create trigger grades_00_workflow_guard before insert or update or delete on public.grades for each row execute function public.guard_workflow_grade();
create function public.record_grade_revision() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  insert into public.grade_revisions(tenant_id,grade_id,revision,activity_id,student_id,grade,feedback,publication_state,graded_by,graded_at,submission_id,submission_version)
    values(new.tenant_id,new.id,new.revision,new.activity_id,new.student_id,new.grade,new.feedback,new.publication_state,new.graded_by,new.graded_at,new.submission_id,new.submission_version);
  return new;
end $$;
create trigger grades_record_revision after insert or update on public.grades for each row execute function public.record_grade_revision();

create function public.protect_workflow_member_identity() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if (new.id,new.tenant_id,new.auth_user_id) is distinct from (old.id,old.tenant_id,old.auth_user_id)
    and (exists(select 1 from public.enrollments where tenant_id=old.tenant_id and student_id=old.id)
      or exists(select 1 from public.teaching_assignments where tenant_id=old.tenant_id and teacher_id=old.id)
      or exists(select 1 from public.grades where tenant_id=old.tenant_id and student_id=old.auth_user_id)
      or exists(select 1 from public.activities where tenant_id=old.tenant_id and created_by=old.auth_user_id)) then
    raise exception using errcode='23514',message='Academic member identity is immutable.';
  end if;
  return new;
end $$;
create trigger app_users_workflow_identity before update of id,tenant_id,auth_user_id on public.app_users for each row execute function public.protect_workflow_member_identity();

create function public.workflow_authorize_actor(p_tenant_id uuid,p_actor_id uuid,p_class_id uuid,p_teacher_only boolean)
returns public.app_users language plpgsql set search_path = pg_catalog, public as $$
declare actor public.app_users%rowtype;
begin
  select * into actor from public.app_users where tenant_id=p_tenant_id and id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Active institutional membership required.'; end if;
  if actor.role='teacher' then
    perform 1 from public.teaching_assignments where tenant_id=p_tenant_id and class_id=p_class_id
      and teacher_id=actor.id and status='active' for share;
    if not found then raise exception using errcode='42501',message='Active teaching assignment required.'; end if;
  elsif p_teacher_only or actor.role not in ('owner','admin','coordinator') then
    raise exception using errcode='42501',message='Institutional authority required.';
  end if;
  return actor;
end $$;
create function public.workflow_require_active_class(p_tenant_id uuid,p_class_id uuid) returns void
language plpgsql set search_path = pg_catalog, public as $$
begin
  perform 1 from public.classes c
    join public.subjects s on s.tenant_id=c.tenant_id and s.id=c.subject_id
    join public.academic_periods p on p.tenant_id=c.tenant_id and p.id=c.academic_period_id
    where c.tenant_id=p_tenant_id and c.id=p_class_id and c.academic_status='active' and s.status='active' and p.status='active'
    for share of c,s,p;
  if not found then raise exception using errcode='23514',message='Active mapped class and academic period required.'; end if;
end $$;

create function public.manage_academic_activity(p_tenant_id uuid,p_actor_id uuid,p_operation text,p_activity_id uuid,p_class_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  actor public.app_users%rowtype;
  class_id uuid;
  previous_context text := current_setting('app.activity_workflow',true);
  expected integer;
  field_name text;
begin
  if p_operation is null or p_operation not in ('create','update','publish','close','delete') or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='Invalid activity operation.';
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('title','description','type','due_date','instructions','evaluation_criteria','priority','allow_late','expected_version','state'))
    or (p_payload ? 'state' and (p_operation<>'create' or p_payload->>'state' is distinct from 'draft')) then
    raise exception using errcode='22023',message='Unsupported activity fields.';
  end if;
  if p_operation='create' then class_id:=p_class_id;
  else
    select a.class_id into class_id from public.activities a where tenant_id=p_tenant_id and id=p_activity_id;
    if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=class_id for share;
  if not found then raise exception using errcode='P0002',message='Class not found.'; end if;
  if p_operation<>'create' then
    select * into activity from public.activities where tenant_id=p_tenant_id and id=p_activity_id for no key update;
    if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  end if;
  actor:=public.workflow_authorize_actor(p_tenant_id,p_actor_id,class_id,p_operation='publish');
  if p_operation in ('create','publish') or (p_operation='update' and activity.workflow_enabled) then
    perform public.workflow_require_active_class(p_tenant_id,class_id);
  end if;
  if p_operation<>'create' and p_operation<>'delete' and activity.workflow_enabled then
    if not (p_payload ? 'expected_version') or jsonb_typeof(p_payload->'expected_version')<>'number' or (p_payload->>'expected_version') !~ '^[0-9]+$' then
      raise exception using errcode='22023',message='Expected activity version required.';
    end if;
    expected:=(p_payload->>'expected_version')::integer;
    if expected<>activity.revision then raise exception using errcode='23514',message='Activity version conflict.'; end if;
  end if;
  if p_payload ? 'title' and (jsonb_typeof(p_payload->'title')<>'string' or char_length(btrim(p_payload->>'title')) not between 1 and 102400) then
    raise exception using errcode='22023',message='Invalid activity title.';
  end if;
  if p_payload ? 'type' and (jsonb_typeof(p_payload->'type')<>'string' or char_length(btrim(p_payload->>'type')) not between 1 and 102400) then
    raise exception using errcode='22023',message='Invalid activity type.';
  end if;
  if p_payload ? 'priority' and (p_payload->>'priority' is null or p_payload->>'priority' not in ('low','medium','high')) then
    raise exception using errcode='22023',message='Invalid activity priority.';
  end if;
  if p_payload ? 'allow_late' and jsonb_typeof(p_payload->'allow_late')<>'boolean' then raise exception using errcode='22023',message='Invalid late policy.'; end if;
  foreach field_name in array array['description','instructions','evaluation_criteria'] loop
    if p_payload ? field_name and (jsonb_typeof(p_payload->field_name) not in ('string','null') or char_length(p_payload->>field_name)>102400) then
      raise exception using errcode='22023',message='Invalid activity text field.';
    end if;
  end loop;
  if p_payload ? 'due_date' and jsonb_typeof(p_payload->'due_date') not in ('string','null') then
    raise exception using errcode='22023',message='Invalid activity deadline.';
  end if;
  if p_operation='create' then
    if not (p_payload ? 'title') then raise exception using errcode='22023',message='Title required.'; end if;
    insert into public.activities(tenant_id,class_id,title,description,type,due_date,created_by,instructions,evaluation_criteria,priority,allow_late)
      values(p_tenant_id,class_id,btrim(p_payload->>'title'),p_payload->>'description',coalesce(btrim(p_payload->>'type'),'assignment'),
        (p_payload->>'due_date')::timestamptz,actor.auth_user_id,p_payload->>'instructions',p_payload->>'evaluation_criteria',
        coalesce(p_payload->>'priority','medium'),coalesce((p_payload->>'allow_late')::boolean,false)) returning * into activity;
  else
    perform set_config('app.activity_workflow',activity.id::text,true);
    if p_operation='update' then
      if activity.state='closed' then raise exception using errcode='23514',message='Closed activity is immutable.'; end if;
      update public.activities set
        title=case when p_payload ? 'title' then btrim(p_payload->>'title') else title end,
        description=case when p_payload ? 'description' then p_payload->>'description' else description end,
        type=case when p_payload ? 'type' then btrim(p_payload->>'type') else type end,
        due_date=case when p_payload ? 'due_date' then (p_payload->>'due_date')::timestamptz else due_date end,
        instructions=case when p_payload ? 'instructions' then p_payload->>'instructions' else instructions end,
        evaluation_criteria=case when p_payload ? 'evaluation_criteria' then p_payload->>'evaluation_criteria' else evaluation_criteria end,
        priority=case when p_payload ? 'priority' then p_payload->>'priority' else priority end,
        allow_late=case when p_payload ? 'allow_late' then (p_payload->>'allow_late')::boolean else allow_late end,
        revision=revision+1 where tenant_id=p_tenant_id and id=activity.id returning * into activity;
    elsif p_operation='publish' then
      if activity.state<>'draft' then raise exception using errcode='23514',message='Only drafts can be published.'; end if;
      update public.activities set state='published',published_at=clock_timestamp(),revision=revision+1
        where tenant_id=p_tenant_id and id=activity.id returning * into activity;
    elsif p_operation='close' then
      if activity.state<>'published' then raise exception using errcode='23514',message='Only published activities can be closed.'; end if;
      update public.activities set state='closed',closed_at=clock_timestamp(),revision=revision+1
        where tenant_id=p_tenant_id and id=activity.id returning * into activity;
    else
      delete from public.activities where tenant_id=p_tenant_id and id=activity.id;
    end if;
    perform set_config('app.activity_workflow',coalesce(previous_context,''),true);
  end if;
  return to_jsonb(activity);
exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode='22023',message='Invalid activity input.';
end $$;

create function public.submit_activity_answer(p_tenant_id uuid,p_actor_id uuid,p_activity_id uuid,p_expected_version integer,p_answer text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  actor public.app_users%rowtype;
  delivery public.activity_submissions%rowtype;
  class_id uuid;
  submitted timestamptz;
  previous_context text:=current_setting('app.activity_workflow',true);
begin
  if p_expected_version is null or p_expected_version<0 or p_answer is null or char_length(btrim(p_answer))<1 or char_length(p_answer)>20000 then
    raise exception using errcode='22023',message='Valid answer and expected version required.';
  end if;
  select a.class_id into class_id from public.activities a where tenant_id=p_tenant_id and id=p_activity_id;
  if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=class_id for share;
  select * into activity from public.activities where tenant_id=p_tenant_id and id=p_activity_id for no key update;
  if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  select * into actor from public.app_users where tenant_id=p_tenant_id and id=p_actor_id and active and role='student' for share;
  if not found then raise exception using errcode='42501',message='Active institutional student required.'; end if;
  perform 1 from public.enrollments e where e.tenant_id=p_tenant_id and e.class_id=activity.class_id and e.student_id=actor.id and e.status='active' for share;
  if not found then raise exception using errcode='42501',message='Active enrollment required.'; end if;
  perform public.workflow_require_active_class(p_tenant_id,activity.class_id);
  if exists(select 1 from public.grades where tenant_id=p_tenant_id and activity_id=activity.id and student_id=actor.auth_user_id) then
    raise exception using errcode='23514',message='Submission is locked by an existing review.';
  end if;
  select * into delivery from public.activity_submissions where tenant_id=p_tenant_id and activity_id=activity.id and student_id=actor.id for update;
  if (found and p_expected_version<>delivery.current_version) or (not found and p_expected_version<>0) then
    raise exception using errcode='23514',message='Submission version conflict.';
  end if;
  submitted:=clock_timestamp();
  if activity.state<>'published' or (activity.due_date is not null and submitted>activity.due_date and not activity.allow_late) then
    raise exception using errcode='23514',message='Activity is not receiving submissions.';
  end if;
  perform set_config('app.activity_workflow',activity.id::text,true);
  if delivery.id is null then
    insert into public.activity_submissions(tenant_id,activity_id,class_id,student_id,current_version,answer,submitted_at,is_late)
      values(p_tenant_id,activity.id,activity.class_id,actor.id,1,p_answer,submitted,coalesce(submitted>activity.due_date,false)) returning * into delivery;
  else
    update public.activity_submissions set current_version=current_version+1,answer=p_answer,submitted_at=submitted,is_late=coalesce(submitted>activity.due_date,false)
      where tenant_id=p_tenant_id and id=delivery.id returning * into delivery;
  end if;
  perform set_config('app.activity_workflow',coalesce(previous_context,''),true);
  return to_jsonb(delivery);
end $$;

create function public.review_activity_submission(p_tenant_id uuid,p_actor_id uuid,p_submission_id uuid,p_expected_revision integer,p_submission_version integer,p_grade numeric,p_feedback text,p_publish boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  delivery public.activity_submissions%rowtype;
  activity public.activities%rowtype;
  actor public.app_users%rowtype;
  result public.grades%rowtype;
  student_auth uuid;
  class_id uuid;
  activity_id uuid;
  previous_context text:=current_setting('app.activity_workflow',true);
begin
  if p_expected_revision is null or p_expected_revision<0 or p_submission_version is null or p_submission_version<1
    or p_publish is null or (p_grade is not null and (p_grade<0 or p_grade>10 or p_grade='NaN'::numeric))
    or char_length(p_feedback)>20000 then raise exception using errcode='22023',message='Invalid review input.'; end if;
  select s.class_id,s.activity_id into class_id,activity_id from public.activity_submissions s where tenant_id=p_tenant_id and id=p_submission_id;
  if not found then raise exception using errcode='P0002',message='Submission not found.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=class_id for share;
  select * into activity from public.activities where tenant_id=p_tenant_id and id=activity_id for no key update;
  actor:=public.workflow_authorize_actor(p_tenant_id,p_actor_id,class_id,true);
  select * into delivery from public.activity_submissions where tenant_id=p_tenant_id and id=p_submission_id for update;
  if delivery.current_version<>p_submission_version then raise exception using errcode='23514',message='Submission version conflict.'; end if;
  select auth_user_id into student_auth from public.app_users where tenant_id=p_tenant_id and id=delivery.student_id and role='student' for share;
  if not found then raise exception using errcode='23514',message='Submission student is invalid.'; end if;
  select * into result from public.grades where tenant_id=p_tenant_id and public.grades.activity_id=activity.id and student_id=student_auth for update;
  if (found and result.revision<>p_expected_revision) or (not found and p_expected_revision<>0) then
    raise exception using errcode='23514',message='Grade revision conflict.';
  end if;
  if result.id is not null and (result.submission_id is distinct from delivery.id or (result.publication_state='published' and not p_publish)) then
    raise exception using errcode='23514',message='Published grade cannot return to draft or change submission.';
  end if;
  perform set_config('app.activity_workflow',activity.id::text,true);
  if result.id is null then
    insert into public.grades(tenant_id,activity_id,student_id,grade,feedback,graded_by,graded_at,publication_state,revision,submission_id,submission_version)
      values(p_tenant_id,activity.id,student_auth,p_grade,p_feedback,actor.auth_user_id,clock_timestamp(),case when p_publish then 'published' else 'draft' end,1,delivery.id,delivery.current_version)
      returning * into result;
  else
    update public.grades set grade=p_grade,feedback=p_feedback,graded_by=actor.auth_user_id,graded_at=clock_timestamp(),
      publication_state=case when p_publish then 'published' else 'draft' end,revision=revision+1,submission_version=delivery.current_version
      where tenant_id=p_tenant_id and id=result.id returning * into result;
  end if;
  perform set_config('app.activity_workflow',coalesce(previous_context,''),true);
  return to_jsonb(result);
end $$;

create function public.publish_activity_review(p_tenant_id uuid,p_actor_id uuid,p_submission_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  delivery public.activity_submissions%rowtype;
  result public.grades%rowtype;
  actor public.app_users%rowtype;
begin
  select * into delivery from public.activity_submissions where tenant_id=p_tenant_id and id=p_submission_id;
  if not found then raise exception using errcode='P0002',message='Submission not found.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=delivery.class_id for share;
  perform 1 from public.activities where tenant_id=p_tenant_id and id=delivery.activity_id for no key update;
  actor:=public.workflow_authorize_actor(p_tenant_id,p_actor_id,delivery.class_id,true);
  select * into delivery from public.activity_submissions where tenant_id=p_tenant_id and id=p_submission_id for update;
  select * into result from public.grades where tenant_id=p_tenant_id and submission_id=delivery.id for update;
  if not found then raise exception using errcode='P0002',message='Review not found.'; end if;
  if result.publication_state<>'draft' then raise exception using errcode='23514',message='Review is already published.'; end if;
  return public.review_activity_submission(p_tenant_id,p_actor_id,delivery.id,p_expected_revision,delivery.current_version,result.grade,result.feedback,true);
end $$;

create function public.record_activity_grade(p_tenant_id uuid,p_actor_id uuid,p_activity_id uuid,p_student_id uuid,p_grade numeric,p_feedback text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  actor public.app_users%rowtype;
  student public.app_users%rowtype;
  result public.grades%rowtype;
  class_id uuid;
  previous_context text:=current_setting('app.activity_workflow',true);
  previous_manual text:=current_setting('app.activity_manual_grade',true);
begin
  if (p_grade is not null and (p_grade<0 or p_grade>10 or p_grade='NaN'::numeric)) or char_length(p_feedback)>102400 then
    raise exception using errcode='22023',message='Invalid manual grade input.';
  end if;
  select a.class_id into class_id from public.activities a where tenant_id=p_tenant_id and id=p_activity_id;
  if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=class_id for share;
  select * into activity from public.activities where tenant_id=p_tenant_id and id=p_activity_id for no key update;
  if not found then raise exception using errcode='P0002',message='Activity not found.'; end if;
  actor:=public.workflow_authorize_actor(p_tenant_id,p_actor_id,class_id,false);
  if activity.state not in ('published','closed') then raise exception using errcode='23514',message='Manual grade requires a published activity.'; end if;
  select * into student from public.app_users where tenant_id=p_tenant_id and id=p_student_id and active and role='student' for share;
  if not found then raise exception using errcode='42501',message='Active institutional student required.'; end if;
  perform 1 from public.enrollments e where e.tenant_id=p_tenant_id and e.class_id=activity.class_id and e.student_id=student.id and e.status in ('active','completed') for share;
  if not found then raise exception using errcode='23514',message='Manual grade requires an active or completed enrollment.'; end if;
  if exists(select 1 from public.activity_submissions where tenant_id=p_tenant_id and activity_id=activity.id and student_id=student.id) then
    raise exception using errcode='23514',message='Existing submission must use the review workflow.';
  end if;
  select * into result from public.grades where tenant_id=p_tenant_id and activity_id=activity.id and student_id=student.auth_user_id for update;
  perform set_config('app.activity_workflow',activity.id::text,true);
  perform set_config('app.activity_manual_grade',activity.id::text,true);
  if result.id is null then
    insert into public.grades(tenant_id,activity_id,student_id,grade,feedback,graded_by,graded_at,publication_state)
      values(p_tenant_id,activity.id,student.auth_user_id,p_grade,p_feedback,actor.auth_user_id,clock_timestamp(),'published') returning * into result;
  else
    update public.grades set grade=p_grade,feedback=p_feedback,graded_by=actor.auth_user_id,graded_at=clock_timestamp(),publication_state='published',revision=revision+1
      where tenant_id=p_tenant_id and id=result.id returning * into result;
  end if;
  perform set_config('app.activity_manual_grade',coalesce(previous_manual,''),true);
  perform set_config('app.activity_workflow',coalesce(previous_context,''),true);
  return to_jsonb(result);
end $$;

create function public.list_academic_activities(p_tenant_id uuid,p_actor_id uuid,p_class_id uuid,p_offset integer,p_limit integer,p_activity_id uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare actor public.app_users%rowtype;
  result jsonb;
begin
  if p_offset is null or p_offset<0 or p_offset>10000000 or p_limit is null or p_limit<1 or p_limit>100 then
    raise exception using errcode='22023',message='Invalid pagination.';
  end if;
  select * into actor from public.app_users where tenant_id=p_tenant_id and id=p_actor_id and active and role='student';
  if not found then raise exception using errcode='42501',message='Active institutional student required.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=p_class_id;
  if not found then raise exception using errcode='P0002',message='Class not found.'; end if;
  with visible as materialized (
    select a.id,a.due_date from public.activities a
    join public.enrollments e on e.tenant_id=a.tenant_id and e.class_id=a.class_id and e.student_id=actor.id
    where a.tenant_id=p_tenant_id and a.class_id=p_class_id and a.state in ('published','closed')
      and (p_activity_id is null or a.id=p_activity_id)
      and (e.status in ('active','completed')
        or exists(select 1 from public.activity_submissions s where s.tenant_id=a.tenant_id and s.activity_id=a.id and s.student_id=actor.id)
        or exists(select 1 from public.grades g where g.tenant_id=a.tenant_id and g.activity_id=a.id and g.student_id=actor.auth_user_id and g.publication_state='published'))
  ), page_ids as materialized (
    select * from visible order by due_date asc nulls last,id asc offset p_offset limit p_limit
  ), page as (
    select a.* from public.activities a join page_ids p on p.id=a.id
    where a.tenant_id=p_tenant_id and a.class_id=p_class_id
  )
  select jsonb_build_object('activities',coalesce((select jsonb_agg(to_jsonb(page) order by due_date asc nulls last,id asc) from page),'[]'::jsonb),
    'total',(select count(*) from visible)) into result;
  return result;
end $$;

alter table public.activity_submissions enable row level security;
alter table public.activity_submission_versions enable row level security;
alter table public.grade_revisions enable row level security;
create policy activity_submissions_service on public.activity_submissions for all to service_role using (true) with check (true);
create policy activity_submission_versions_service on public.activity_submission_versions for all to service_role using (true) with check (true);
create policy grade_revisions_service on public.grade_revisions for all to service_role using (true) with check (true);
revoke all on public.activity_submissions,public.activity_submission_versions,public.grade_revisions from public,anon,authenticated;
grant select,insert,update,delete on public.activity_submissions,public.activity_submission_versions,public.grade_revisions to service_role;
revoke all on function public.manage_academic_activity(uuid,uuid,text,uuid,uuid,jsonb),
  public.submit_activity_answer(uuid,uuid,uuid,integer,text),
  public.review_activity_submission(uuid,uuid,uuid,integer,integer,numeric,text,boolean),
  public.publish_activity_review(uuid,uuid,uuid,integer),
  public.list_academic_activities(uuid,uuid,uuid,integer,integer,uuid),
  public.record_activity_grade(uuid,uuid,uuid,uuid,numeric,text),
  public.workflow_authorize_actor(uuid,uuid,uuid,boolean),public.workflow_require_active_class(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.manage_academic_activity(uuid,uuid,text,uuid,uuid,jsonb),
  public.submit_activity_answer(uuid,uuid,uuid,integer,text),
  public.review_activity_submission(uuid,uuid,uuid,integer,integer,numeric,text,boolean),
  public.publish_activity_review(uuid,uuid,uuid,integer),
  public.list_academic_activities(uuid,uuid,uuid,integer,integer,uuid),
  public.record_activity_grade(uuid,uuid,uuid,uuid,numeric,text) to service_role;
commit;
