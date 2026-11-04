begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The legacy activity state stays draft. Opening grading never opens submissions.
alter table public.activities
  add column exam_grading_opened_at timestamptz,
  add constraint activities_exam_grading_check check (
    exam_grading_opened_at is null or assessment_category is not distinct from 'exam'
  );

alter table public.grades
  add column grade_unit text not null default 'score_0_10',
  add constraint grades_unit_check check (grade_unit in ('score_0_10','exam_points'));

create function public.guard_exam_grading() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op='INSERT' then
    if new.exam_grading_opened_at is not null then
      raise exception using errcode='23514',message='Exams must start with grading closed.';
    end if;
    return new;
  end if;
  if tg_op='DELETE' then
    if old.exam_grading_opened_at is not null then
      raise exception using errcode='23514',message='Preserve exams with open grading.';
    end if;
    return old;
  end if;
  if old.exam_grading_opened_at is not null then
    if (new.tenant_id,new.class_id,new.assessment_stage,new.assessment_category,new.assessment_max_points,new.exam_grading_opened_at)
      is distinct from (old.tenant_id,old.class_id,old.assessment_stage,old.assessment_category,old.assessment_max_points,old.exam_grading_opened_at) then
      raise exception using errcode='23514',message='Exam grading and assessment metadata are immutable after opening.';
    end if;
  elsif new.exam_grading_opened_at is not null and (
    old.assessment_category is distinct from 'exam'
    or current_setting('app.exam_grading',true) is distinct from old.id::text
    or (new.assessment_stage,new.assessment_category,new.assessment_max_points)
      is distinct from (old.assessment_stage,old.assessment_category,old.assessment_max_points)
  ) then
    raise exception using errcode='23514',message='Opening an exam requires the exam workflow.';
  end if;
  return new;
end $$;
create trigger activities_exam_grading_guard before insert or update or delete on public.activities
  for each row execute function public.guard_exam_grading();

create or replace function public.guard_activity_submission() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve submission history.'; end if;
  if current_setting('app.activity_workflow',true) is distinct from new.activity_id::text then
    raise exception using errcode='23514',message='Submission requires a transactional workflow operation.';
  end if;
  if exists(select 1 from public.activities where tenant_id=new.tenant_id and id=new.activity_id and assessment_category='exam') then
    raise exception using errcode='23514',message='Exams do not accept textual submissions.';
  end if;
  if tg_op='UPDATE' and ((new.id,new.tenant_id,new.activity_id,new.class_id,new.student_id)
      is distinct from (old.id,old.tenant_id,old.activity_id,old.class_id,old.student_id)
      or new.current_version<>old.current_version+1) then
    raise exception using errcode='23514',message='Submission identity or version is invalid.';
  end if;
  if tg_op='INSERT' and new.current_version<>1 then raise exception using errcode='23514',message='Initial submission version must be one.'; end if;
  return new;
end $$;

create or replace function public.guard_workflow_grade() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  activity public.activities%rowtype;
  delivery public.activity_submissions%rowtype;
begin
  if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve grade history.'; end if;
  if tg_op='UPDATE' and (new.id,new.tenant_id,new.activity_id,new.student_id,new.submission_id,new.grade_unit)
    is distinct from (old.id,old.tenant_id,old.activity_id,old.student_id,old.submission_id,old.grade_unit) then
    raise exception using errcode='23514',message='Grade ownership is immutable.';
  end if;
  select * into activity from public.activities where tenant_id=new.tenant_id and id=new.activity_id for key share;
  if not found then raise exception using errcode='23514',message='Grade activity is invalid.'; end if;
  if activity.assessment_category='exam' then
    if current_setting('app.exam_grading',true) is distinct from activity.id::text
      or activity.exam_grading_opened_at is null or new.submission_id is not null
      or new.grade_unit<>'exam_points' or new.grade is null or new.grade>activity.assessment_max_points then
      raise exception using errcode='23514',message='Exam points require the authorized exam workflow.';
    end if;
  elsif new.grade_unit<>'score_0_10' then
    raise exception using errcode='23514',message='Only exams accept direct points.';
  elsif activity.workflow_enabled or new.submission_id is not null then
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

-- Keep exam results out of legacy activity notifications. Exam history uses the
-- same revisions, whose unit is determined by the immutable exam category.
create or replace function public.record_communication_event() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare recipients uuid[]; recipient uuid; conversation public.academic_conversations%rowtype;
begin
  if tg_table_name='activities' then
    if new.state='published' and (tg_op='INSERT' or old.state='draft') then
      recipients:=public.communication_recipients(new.tenant_id,'class',null,new.class_id,true);
      insert into public.academic_notifications(tenant_id,user_id,event_type,event_key,activity_id)
        select new.tenant_id,u.id,'activity_published','activity:'||new.id::text,new.id from public.app_users u
        where u.id=any(recipients) and u.tenant_id=new.tenant_id and u.active and u.role='student';
    end if;
  elsif tg_table_name='grade_revisions' then
    if new.publication_state='published' and exists (
      select 1 from public.grades g where g.tenant_id=new.tenant_id and g.id=new.grade_id
        and g.grade_unit='score_0_10'
    ) then
      select id into recipient from public.app_users where tenant_id=new.tenant_id and auth_user_id=new.student_id for share;
      if exists(select 1 from public.app_users where tenant_id=new.tenant_id and id=recipient and active and role='student') then
        insert into public.academic_notifications(tenant_id,user_id,event_type,event_key,grade_revision_id,grade_id)
          values(new.tenant_id,recipient,'activity_result_published','result:'||new.id::text,new.id,new.grade_id);
      end if;
    end if;
  elsif new.conversation_id is not null then
    select * into conversation from public.academic_conversations where tenant_id=new.tenant_id and id=new.conversation_id;
    recipient:=case when new.sender_id=conversation.student_id then conversation.teacher_id else conversation.student_id end;
    perform public.communication_member(new.tenant_id,recipient,true);
    insert into public.academic_notifications(tenant_id,user_id,event_type,event_key,message_id)
      values(new.tenant_id,recipient,'message_received','message:'||new.id::text,new.id);
  end if;
  return new;
end $$;

create function public.exam_grade_result(p_grade public.grades) returns jsonb
language sql stable strict set search_path = pg_catalog, public as $$
  select case when (p_grade).id is not null then jsonb_build_object(
    'points',(p_grade).grade::text,'unit',(p_grade).grade_unit,'revision',(p_grade).revision,
    'publicationState',(p_grade).publication_state,'gradedAt',(p_grade).graded_at
  ) end
$$;

create function public.write_exam_grade(
  p_tenant_id uuid,p_actor_id uuid,p_exam_id uuid,p_action text,p_expected integer,
  p_student_id uuid,p_points text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  exam public.activities%rowtype;
  actor public.app_users%rowtype;
  student_auth uuid;
  result public.grades%rowtype;
  offering_id uuid;
  points numeric;
  previous_exam text:=current_setting('app.exam_grading',true);
  previous_activity text:=current_setting('app.activity_workflow',true);
begin
  if p_action is null or p_action not in ('activate','save','publish')
    or p_expected is null or p_expected not between 0 and 2147483646
    or (p_action='activate' and (p_student_id is not null or p_points is not null or p_expected=0))
    or (p_action<>'activate' and p_student_id is null)
    or (p_action='save' and p_points is null) or (p_action='publish' and p_expected=0) then
    raise exception using errcode='22023',message='Invalid exam operation.';
  end if;

  select a.class_id into offering_id from public.activities a
    where a.tenant_id=p_tenant_id and a.id=p_exam_id;
  if not found then raise exception using errcode='P0002',message='Exam not found.'; end if;
  perform 1 from public.classes where tenant_id=p_tenant_id and id=offering_id for share;
  select * into exam from public.activities where tenant_id=p_tenant_id and id=p_exam_id for no key update;
  if not found or exam.assessment_category is distinct from 'exam' then
    raise exception using errcode='P0002',message='Exam not found.';
  end if;
  actor:=public.workflow_authorize_actor(p_tenant_id,p_actor_id,offering_id,true);

  if p_action='activate' then
    if exam.exam_grading_opened_at is not null or exam.revision<>p_expected then
      raise exception using errcode='23514',message='Exam activation or revision conflict.';
    end if;
    perform public.workflow_require_active_class(p_tenant_id,offering_id);
    perform set_config('app.exam_grading',exam.id::text,true);
    perform set_config('app.activity_workflow',exam.id::text,true);
    update public.activities set exam_grading_opened_at=clock_timestamp(),revision=revision+1
      where tenant_id=p_tenant_id and id=exam.id returning * into exam;
    perform set_config('app.activity_workflow',coalesce(previous_activity,''),true);
    perform set_config('app.exam_grading',coalesce(previous_exam,''),true);
    return jsonb_build_object('examId',exam.id,'revision',exam.revision,'gradingOpenedAt',exam.exam_grading_opened_at);
  end if;

  if exam.exam_grading_opened_at is null then
    raise exception using errcode='23514',message='Open exam grading first.';
  end if;
  if p_points is not null then
    if p_points !~ '^[0-9]([.][0-9]{1,2})?$' then
      raise exception using errcode='22023',message='Use direct points with up to two decimal places.';
    end if;
    points:=p_points::numeric;
    if points>exam.assessment_max_points then
      raise exception using errcode='22023',message='Exam points exceed its maximum.';
    end if;
  end if;

  select u.auth_user_id into student_auth from public.app_users u
    join public.enrollments e on e.tenant_id=u.tenant_id and e.student_id=u.id
    where u.tenant_id=p_tenant_id and u.id=p_student_id and u.active and u.role='student'
      and e.class_id=offering_id and e.status in ('active','completed')
    for share of u,e;
  if not found then raise exception using errcode='42501',message='Eligible enrollment required.'; end if;

  select * into result from public.grades where tenant_id=p_tenant_id and activity_id=exam.id and student_id=student_auth for update;
  if coalesce(result.revision,0)<>p_expected then
    raise exception using errcode='23514',message='Exam grade revision conflict.';
  end if;
  if (p_action='save' and result.publication_state='published')
    or (p_action='publish' and (result.id is null
      or (result.publication_state='draft' and p_points is not null)
      or (result.publication_state='published' and p_points is null))) then
    raise exception using errcode='23514',message='Invalid exam grade publication transition.';
  end if;

  perform set_config('app.exam_grading',exam.id::text,true);
  if result.id is null then
    insert into public.grades(tenant_id,activity_id,student_id,grade,graded_by,graded_at,grade_unit,publication_state)
      values(p_tenant_id,exam.id,student_auth,points,actor.auth_user_id,clock_timestamp(),'exam_points','draft')
      returning * into result;
  else
    update public.grades set grade=coalesce(points,grade),graded_by=actor.auth_user_id,graded_at=clock_timestamp(),
      publication_state=case when p_action='publish' then 'published' else 'draft' end,revision=revision+1
      where tenant_id=p_tenant_id and id=result.id returning * into result;
  end if;
  perform set_config('app.exam_grading',coalesce(previous_exam,''),true);
  return public.exam_grade_result(result);
end $$;

create function public.read_exam_grades(
  p_tenant_id uuid,p_actor_id uuid,p_exam_id uuid,p_student_view boolean,p_offset integer,p_limit integer
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  exam public.activities%rowtype;
  actor_auth uuid;
  result jsonb;
begin
  if p_student_view is null or p_offset is null or p_offset not between 0 and 10000000
    or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='Invalid exam grade query.';
  end if;
  select * into exam from public.activities where tenant_id=p_tenant_id and id=p_exam_id;
  if not found or exam.assessment_category is distinct from 'exam'
    or (p_student_view and exam.exam_grading_opened_at is null) then
    raise exception using errcode='P0002',message='Exam not found.';
  end if;
  if p_student_view then
    select u.auth_user_id into actor_auth from public.app_users u
      join public.enrollments e on e.tenant_id=u.tenant_id and e.student_id=u.id
      where u.tenant_id=p_tenant_id and u.id=p_actor_id and u.active and u.role='student'
        and e.class_id=exam.class_id and e.status in ('active','completed')
      for share of u,e;
    if not found then raise exception using errcode='42501',message='Eligible enrollment required.'; end if;
    select public.exam_grade_result(g) into result from public.grades g
      where g.tenant_id=p_tenant_id and g.activity_id=exam.id and g.student_id=actor_auth
        and g.grade_unit='exam_points' and g.publication_state='published';
    return jsonb_build_object('examId',exam.id,'stage',exam.assessment_stage,
      'maxPoints',exam.assessment_max_points::text,'result',result);
  end if;

  perform public.workflow_authorize_actor(p_tenant_id,p_actor_id,exam.class_id,true);
  with eligible as materialized (
    select u.id,u.name,u.auth_user_id from public.enrollments e
    join public.app_users u on u.tenant_id=e.tenant_id and u.id=e.student_id
    where e.tenant_id=p_tenant_id and e.class_id=exam.class_id
      and e.status in ('active','completed') and u.role='student' and u.active
  ), page as (
    select u.id,u.name,public.exam_grade_result(g) as result
    from (select * from eligible order by name,id offset p_offset limit p_limit) u
    left join public.grades g on g.tenant_id=p_tenant_id and g.activity_id=exam.id and g.student_id=u.auth_user_id
      and g.grade_unit='exam_points'
  )
  select jsonb_build_object('examId',exam.id,'stage',exam.assessment_stage,
    'maxPoints',exam.assessment_max_points::text,'gradingOpenedAt',exam.exam_grading_opened_at,'revision',exam.revision,
    'total',(select count(*) from eligible),
    'data',coalesce(jsonb_agg(jsonb_build_object('studentId',page.id,'studentName',page.name,'result',page.result) order by page.name,page.id),'[]'::jsonb))
    into result from page;
  return result;
end $$;

revoke all on function public.guard_exam_grading(),
  public.exam_grade_result(public.grades),
  public.write_exam_grade(uuid,uuid,uuid,text,integer,uuid,text),
  public.read_exam_grades(uuid,uuid,uuid,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.write_exam_grade(uuid,uuid,uuid,text,integer,uuid,text),
  public.read_exam_grades(uuid,uuid,uuid,boolean,integer,integer) to service_role;

commit;
