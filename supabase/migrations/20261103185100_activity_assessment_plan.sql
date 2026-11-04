begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.activities
  add column assessment_stage text,
  add column assessment_category text,
  add column assessment_max_points numeric,
  add constraint activities_assessment_metadata_check check (
    num_nonnulls(assessment_stage,assessment_category,assessment_max_points) = 0
    or (num_nonnulls(assessment_stage,assessment_category,assessment_max_points) = 3
      and workflow_enabled
      and assessment_stage in ('N1','N2')
      and assessment_category in ('exam','activity')
      and scale(assessment_max_points) <= 2
      and assessment_max_points between 0 and (case assessment_category when 'exam' then 7 else 3 end))
  ),
  -- A draft cannot reach either legacy write path until the exam workflow exists.
  add constraint activities_assessment_exam_draft_check check (
    assessment_category is distinct from 'exam' or state = 'draft'
  );

create index activities_assessment_plan_idx
  on public.activities (tenant_id,class_id,assessment_stage,assessment_category)
  where assessment_stage is not null;

create function public.guard_activity_assessment_plan() returns trigger
language plpgsql volatile set search_path = pg_catalog, public as $$
declare
  plan_tenant uuid;
  plan_class uuid;
  allocated numeric;
begin
  if tg_op = 'UPDATE' then
    if (old.tenant_id,old.class_id,old.assessment_stage,old.assessment_category,old.assessment_max_points)
      is not distinct from
      (new.tenant_id,new.class_id,new.assessment_stage,new.assessment_category,new.assessment_max_points) then
      return null;
    end if;
    if old.state <> 'draft' and (old.assessment_stage is not null or new.assessment_stage is not null) then
      raise exception using errcode='23514',message='Only draft activities can change assessment metadata.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    if old.assessment_stage is null then return null; end if;
    if old.state <> 'draft' then
      raise exception using errcode='23514',message='Published assessment items cannot be removed.';
    end if;
    plan_tenant := old.tenant_id;
    plan_class := old.class_id;
  else
    if new.assessment_stage is null then
      if tg_op = 'INSERT' then return null; end if;
      if old.assessment_stage is null then return null; end if;
    end if;
    plan_tenant := new.tenant_id;
    plan_class := new.class_id;
  end if;

  -- The separate aggregate statement needs a fresh snapshot after the wait.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode='25000',message='Assessment plan writes require READ COMMITTED.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('uniconnect.assessment_plan:' || plan_tenant || ':' || plan_class,0));
  if tg_op = 'DELETE' then return null; end if;
  if new.assessment_stage is null then return null; end if;

  -- All plan items count, including drafts and closed activities.
  select sum(assessment_max_points) into allocated from public.activities
    where tenant_id=plan_tenant and class_id=plan_class
      and assessment_stage=new.assessment_stage and assessment_category=new.assessment_category;
  if allocated > (case new.assessment_category when 'exam' then 7 else 3 end) then
    raise exception using errcode='23514',message='Assessment allocation exceeds the stage category limit.';
  end if;
  return null;
end $$;

create trigger activities_assessment_plan_guard
  after insert or update or delete on public.activities
  for each row execute function public.guard_activity_assessment_plan();

revoke execute on function public.guard_activity_assessment_plan() from public,anon,authenticated;

-- Preserve the existing workflow and service-only RPC privileges.
create or replace function public.manage_academic_activity(p_tenant_id uuid,p_actor_id uuid,p_operation text,p_activity_id uuid,p_class_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  actor public.app_users%rowtype;
  class_id uuid;
  previous_context text := current_setting('app.activity_workflow',true);
  expected integer;
  field_name text;
  assessment_plan jsonb := p_payload->'assessment';
begin
  if p_operation is null or p_operation not in ('create','update','publish','close','delete') or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='Invalid activity operation.';
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('title','description','type','due_date','instructions','evaluation_criteria','priority','allow_late','expected_version','state','assessment'))
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
  if p_payload ? 'assessment' then
    if not (p_operation='update' and assessment_plan='null'::jsonb) then
      if p_operation not in ('create','update') or jsonb_typeof(assessment_plan)<>'object' then
        raise exception using errcode='22023',message='Invalid assessment metadata.';
      end if;
      if not (assessment_plan ?& array['stage','category','maxPoints'])
        or exists (select 1 from jsonb_object_keys(assessment_plan) k where k not in ('stage','category','maxPoints'))
        or jsonb_typeof(assessment_plan->'stage')<>'string'
        or jsonb_typeof(assessment_plan->'category')<>'string'
        or jsonb_typeof(assessment_plan->'maxPoints')<>'string'
        or (assessment_plan->>'maxPoints') !~ '^[0-9]+([.][0-9]{1,2})?$' then
        raise exception using errcode='22023',message='Invalid assessment metadata.';
      end if;
    end if;
  end if;
  if p_operation='create' then
    if not (p_payload ? 'title') then raise exception using errcode='22023',message='Title required.'; end if;
    insert into public.activities(tenant_id,class_id,title,description,type,due_date,created_by,instructions,evaluation_criteria,priority,allow_late,
      assessment_stage,assessment_category,assessment_max_points)
      values(p_tenant_id,class_id,btrim(p_payload->>'title'),p_payload->>'description',coalesce(btrim(p_payload->>'type'),'assignment'),
        (p_payload->>'due_date')::timestamptz,actor.auth_user_id,p_payload->>'instructions',p_payload->>'evaluation_criteria',
        coalesce(p_payload->>'priority','medium'),coalesce((p_payload->>'allow_late')::boolean,false),
        assessment_plan->>'stage',assessment_plan->>'category',(assessment_plan->>'maxPoints')::numeric)
      returning * into activity;
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
        assessment_stage=case when p_payload ? 'assessment' then assessment_plan->>'stage' else assessment_stage end,
        assessment_category=case when p_payload ? 'assessment' then assessment_plan->>'category' else assessment_category end,
        assessment_max_points=case when p_payload ? 'assessment' then (assessment_plan->>'maxPoints')::numeric else assessment_max_points end,
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

commit;
