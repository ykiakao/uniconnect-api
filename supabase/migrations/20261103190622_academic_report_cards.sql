begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- An absent row is open. Each existing row is an irreversible closure.
create table public.academic_stage_closures (
  tenant_id uuid not null,
  class_id uuid not null,
  stage text not null check (stage in ('N1','N2')),
  closed_by uuid not null,
  closed_at timestamptz not null default clock_timestamp(),
  eligible_student_ids uuid[] not null check (cardinality(eligible_student_ids)>0),
  primary key (tenant_id,class_id,stage),
  foreign key (tenant_id,class_id) references public.classes(tenant_id,id),
  foreign key (tenant_id,closed_by) references public.app_users(tenant_id,id)
);
alter table public.academic_stage_closures enable row level security;
revoke all on public.academic_stage_closures from public,anon,authenticated,service_role;

create function public.lock_academic_report_card(p_tenant_id uuid,p_class_id uuid) returns void
language plpgsql volatile set search_path = pg_catalog, public as $$
begin
  -- Same offering lock as guard_activity_assessment_plan. Separate statements
  -- after the lock must see commits that finished during the wait.
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='25000',message='Assessment plan writes require READ COMMITTED.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('uniconnect.assessment_plan:' || p_tenant_id || ':' || p_class_id,0));
end $$;

create function public.require_open_academic_stage(p_tenant_id uuid,p_class_id uuid,p_stage text) returns void
language plpgsql volatile set search_path = pg_catalog, public as $$
begin
  perform public.lock_academic_report_card(p_tenant_id,p_class_id);
  if exists(select 1 from public.academic_stage_closures c
    where c.tenant_id=p_tenant_id and c.class_id=p_class_id and c.stage=p_stage) then
    raise exception using errcode='23514',message='Academic stage is closed.';
  end if;
end $$;

create function public.guard_report_card_activity() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op='UPDATE' and (old.assessment_stage,old.assessment_category,old.assessment_max_points,old.state,old.exam_grading_opened_at)
    is not distinct from (new.assessment_stage,new.assessment_category,new.assessment_max_points,new.state,new.exam_grading_opened_at) then
    return new;
  end if;
  if tg_op<>'INSERT' and old.assessment_stage is not null then
    perform public.require_open_academic_stage(old.tenant_id,old.class_id,old.assessment_stage);
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.assessment_stage is not null and (tg_op='INSERT' or new.assessment_stage is distinct from old.assessment_stage) then
    perform public.require_open_academic_stage(new.tenant_id,new.class_id,new.assessment_stage);
  end if;
  return new;
end $$;

create function public.guard_report_card_grade() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  offering_id uuid;
  assessment_stage text;
begin
  select a.class_id,a.assessment_stage into offering_id,assessment_stage
    from public.activities a where a.tenant_id=new.tenant_id and a.id=new.activity_id;
  if assessment_stage is not null then
    perform public.require_open_academic_stage(new.tenant_id,offering_id,assessment_stage);
  end if;
  return new;
end $$;

create trigger activities_report_card_guard before insert or update or delete on public.activities
  for each row execute function public.guard_report_card_activity();
create trigger grades_01_report_card_guard before insert or update on public.grades
  for each row execute function public.guard_report_card_grade();

create function public.academic_report_card_plan(p_tenant_id uuid,p_class_id uuid)
returns table(item_id uuid,title text,stage text,category text,max_points numeric,available boolean,grade_unit text)
language sql stable set search_path = pg_catalog, public as $$
  select a.id,a.title,a.assessment_stage,a.assessment_category,a.assessment_max_points,
    case when a.assessment_category='exam' then a.exam_grading_opened_at is not null
         else a.state in ('published','closed') end,
    case when a.assessment_category='exam' then 'exam_points' else 'score_0_10' end
  from public.activities a
  where a.tenant_id=p_tenant_id and a.class_id=p_class_id and a.assessment_stage is not null
$$;

create function public.manage_academic_stage(
  p_tenant_id uuid,p_actor_id uuid,p_class_id uuid,p_stage text,p_close boolean,p_offset integer,p_limit integer
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  closure public.academic_stage_closures%rowtype;
  eligible_ids uuid[];
  item_count integer;
  issue_count bigint := 0;
  issue_page jsonb := '[]'::jsonb;
  blockers text[] := array[]::text[];
begin
  if p_stage is null or p_stage not in ('N1','N2') or p_close is null
    or p_offset is null or p_offset not between 0 and 10000000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='Invalid academic stage request.';
  end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=p_class_id;
  if not found then raise exception using errcode='P0002',message='Offering not found.'; end if;
  perform public.workflow_authorize_actor(p_tenant_id,p_actor_id,p_class_id,true);
  if p_close then perform public.require_open_academic_stage(p_tenant_id,p_class_id,p_stage); end if;

  select * into closure from public.academic_stage_closures c
    where c.tenant_id=p_tenant_id and c.class_id=p_class_id and c.stage=p_stage;
  select count(*) into item_count from public.academic_report_card_plan(p_tenant_id,p_class_id) p where p.stage=p_stage;

  if closure.closed_at is not null then
    eligible_ids:=closure.eligible_student_ids;
  else
    -- Capture the eligible roster as a single snapshot. Grade and plan mutations
    -- cannot pass their guards while a closing transaction holds the offer lock.
    select array(
      select e.student_id from public.enrollments e
      join public.app_users u on u.tenant_id=e.tenant_id and u.id=e.student_id
      where e.tenant_id=p_tenant_id and e.class_id=p_class_id and e.status in ('active','completed')
        and u.active and u.role='student' order by e.student_id
    ) into eligible_ids;

    with issues as materialized (
      select p.item_id,p.title,u.id as student_id,
        case when not p.available then 'assessment_unavailable'
             when g.publication_state='draft' then 'draft_grade' else 'missing_grade' end as reason
      from public.academic_report_card_plan(p_tenant_id,p_class_id) p
      cross join public.app_users u
      left join public.grades g on g.tenant_id=u.tenant_id and g.activity_id=p.item_id
        and g.student_id=u.auth_user_id and g.grade_unit=p.grade_unit
      where p.stage=p_stage and u.tenant_id=p_tenant_id and u.id=any(eligible_ids)
        and (not p.available or g.grade is null or g.publication_state<>'published')
    )
    select (select count(*) from issues),coalesce(jsonb_agg(jsonb_build_object(
      'itemId',page.item_id,'title',page.title,'studentId',page.student_id,'reason',page.reason
    ) order by page.item_id,page.student_id),'[]'::jsonb) into issue_count,issue_page
    from (select * from issues order by item_id,student_id offset p_offset limit p_limit) page;

    if item_count=0 then blockers:=array_append(blockers,'no_assessments'); end if;
    if cardinality(eligible_ids)=0 then blockers:=array_append(blockers,'no_eligible_students'); end if;
    if issue_count>0 then blockers:=array_append(blockers,'pending_assessments'); end if;
    if p_close then
      if cardinality(blockers)>0 then
        raise exception using errcode='23514',message='Academic stage has closure blockers.';
      end if;
      insert into public.academic_stage_closures(tenant_id,class_id,stage,closed_by,eligible_student_ids)
        values(p_tenant_id,p_class_id,p_stage,p_actor_id,eligible_ids) returning * into closure;
    end if;
  end if;

  return jsonb_build_object('classId',p_class_id,'stage',p_stage,
    'closedAt',closure.closed_at,'closedBy',closure.closed_by,'eligibleCount',cardinality(eligible_ids),
    'assessmentCount',item_count,'blockers',to_jsonb(blockers),'data',issue_page,'total',issue_count);
end $$;

create function public.read_academic_report_cards(
  p_tenant_id uuid,p_actor_id uuid,p_class_id uuid,p_student_id uuid,p_self boolean,p_offset integer,p_limit integer
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  target uuid := case when p_self then p_actor_id else p_student_id end;
  result jsonb;
begin
  if p_self is null or (p_self and p_student_id is not null)
    or p_offset is null or p_offset not between 0 and 10000000 or p_limit is null or p_limit not between 1 and 100
    or (target is not null and (p_offset<>0 or p_limit<>1)) then
    raise exception using errcode='22023',message='Invalid academic report card request.';
  end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=p_class_id;
  if not found then raise exception using errcode='P0002',message='Offering not found.'; end if;
  if p_self then
    perform 1 from public.app_users where tenant_id=p_tenant_id and id=p_actor_id and active and role='student' for share;
    if not found then raise exception using errcode='42501',message='Active institutional student required.'; end if;
  else
    perform public.workflow_authorize_actor(p_tenant_id,p_actor_id,p_class_id,true);
  end if;

  with closures as materialized (
    select c.stage,c.closed_at,c.eligible_student_ids from public.academic_stage_closures c
    where c.tenant_id=p_tenant_id and c.class_id=p_class_id
  ), member_ids as (
    select e.student_id as id from public.enrollments e
    where e.tenant_id=p_tenant_id and e.class_id=p_class_id and e.status in ('active','completed')
    union
    select unnest(c.eligible_student_ids) from closures c
  ), members as materialized (
    select u.id,u.name,u.auth_user_id,
      (u.active and exists(select 1 from public.enrollments e where e.tenant_id=u.tenant_id
        and e.class_id=p_class_id and e.student_id=u.id and e.status in ('active','completed'))) as eligible,
      exists(select 1 from closures c where c.stage='N1' and u.id=any(c.eligible_student_ids)) as closed_n1,
      exists(select 1 from closures c where c.stage='N2' and u.id=any(c.eligible_student_ids)) as closed_n2
    from member_ids m join public.app_users u on u.tenant_id=p_tenant_id and u.id=m.id
    where u.role='student' and (target is null or u.id=target)
  ), plans as materialized (
    select p.* from public.academic_report_card_plan(p_tenant_id,p_class_id) p
  ), page as (
    select m.id,m.name,m.eligible,m.closed_n1,m.closed_n2,
      coalesce((
        select jsonb_agg(jsonb_build_object('id',p.item_id,'stage',p.stage,'category',p.category,
          'maxPoints',p.max_points::text,'available',p.available,'publishedValue',g.grade::text) order by p.item_id)
        from plans p
        left join closures c on c.stage=p.stage
        left join public.grades g on g.tenant_id=p_tenant_id and g.activity_id=p.item_id
          and g.student_id=m.auth_user_id and g.grade_unit=p.grade_unit and g.publication_state='published' and p.available
        where (c.stage is null and m.eligible) or m.id=any(c.eligible_student_ids)
      ),'[]'::jsonb) as items
    from (select * from members where eligible or closed_n1 or closed_n2 order by name,id offset p_offset limit p_limit) m
  )
  select jsonb_build_object('classId',p_class_id,
    'closedAt',jsonb_build_object('N1',(select c.closed_at from closures c where c.stage='N1'),
      'N2',(select c.closed_at from closures c where c.stage='N2')),
    'total',(select count(*) from members where eligible or closed_n1 or closed_n2),
    'data',coalesce(jsonb_agg(jsonb_build_object('studentId',page.id,'studentName',page.name,'eligible',page.eligible,
      'closedStages',jsonb_build_object('N1',page.closed_n1,'N2',page.closed_n2),'items',page.items) order by page.name,page.id),'[]'::jsonb))
    into result from page;

  if target is not null and jsonb_array_length(result->'data')=0 then
    raise exception using errcode='P0002',message='Student not found in offering.';
  end if;
  return result;
end $$;

revoke all on function public.lock_academic_report_card(uuid,uuid),public.require_open_academic_stage(uuid,uuid,text),
  public.guard_report_card_activity(),public.guard_report_card_grade(),public.academic_report_card_plan(uuid,uuid),
  public.manage_academic_stage(uuid,uuid,uuid,text,boolean,integer,integer),
  public.read_academic_report_cards(uuid,uuid,uuid,uuid,boolean,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.manage_academic_stage(uuid,uuid,uuid,text,boolean,integer,integer),
  public.read_academic_report_cards(uuid,uuid,uuid,uuid,boolean,integer,integer) to service_role;

commit;
