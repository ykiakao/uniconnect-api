begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.messages,public.app_users,public.activities,public.grades in share row exclusive mode;

create table public.academic_notices (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id),
  author_id uuid not null, title text not null check(char_length(btrim(title)) between 1 and 200 and char_length(title)<=200),
  content text not null check(char_length(btrim(content)) between 1 and 10000 and char_length(content)<=10000),
  audience_type text not null check(audience_type in ('institution','course','class')),
  course_id uuid, class_id uuid, priority text not null default 'medium' check(priority in ('low','medium','high')),
  state text not null default 'draft' check(state in ('draft','published','archived')),
  revision integer not null default 1 check(revision>0), published_at timestamptz, expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,id), foreign key(tenant_id,author_id) references public.app_users(tenant_id,id),
  foreign key(tenant_id,course_id) references public.courses(tenant_id,id),
  foreign key(tenant_id,class_id) references public.classes(tenant_id,id),
  check((audience_type='institution' and course_id is null and class_id is null) or
    (audience_type='course' and course_id is not null and class_id is null) or
    (audience_type='class' and class_id is not null and course_id is null)),
  check((state='draft' and published_at is null) or (state in ('published','archived') and published_at is not null))
);
create index academic_notices_tenant_time_idx on public.academic_notices(tenant_id,created_at desc,id);
create index academic_notices_class_idx on public.academic_notices(tenant_id,class_id);
create index academic_notices_course_idx on public.academic_notices(tenant_id,course_id);
create table public.academic_notice_revisions (
  tenant_id uuid not null, notice_id uuid not null, revision integer not null check(revision>0),
  title text not null, content text not null, priority text not null, state text not null,
  expires_at timestamptz, changed_by uuid not null, changed_at timestamptz not null default clock_timestamp(), captured_at timestamptz not null default clock_timestamp(),
  foreign key(tenant_id,changed_by) references public.app_users(tenant_id,id),
  primary key(tenant_id,notice_id,revision), foreign key(tenant_id,notice_id) references public.academic_notices(tenant_id,id)
);
create table public.academic_notice_recipients (
  tenant_id uuid not null, notice_id uuid not null, user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(), read_at timestamptz, read_revision integer,
  primary key(tenant_id,notice_id,user_id),
  foreign key(tenant_id,notice_id) references public.academic_notices(tenant_id,id),
  foreign key(tenant_id,user_id) references public.app_users(tenant_id,id),
  foreign key(tenant_id,notice_id,read_revision) references public.academic_notice_revisions(tenant_id,notice_id,revision),
  check((read_at is null)=(read_revision is null))
);
create index academic_notice_recipients_user_idx on public.academic_notice_recipients(tenant_id,user_id,notice_id);
create table public.academic_notice_reads (
  tenant_id uuid not null, notice_id uuid not null, user_id uuid not null, revision integer not null,
  read_at timestamptz not null default clock_timestamp(), primary key(tenant_id,notice_id,user_id,revision),
  foreign key(tenant_id,notice_id,user_id) references public.academic_notice_recipients(tenant_id,notice_id,user_id),
  foreign key(tenant_id,notice_id,revision) references public.academic_notice_revisions(tenant_id,notice_id,revision)
);
create table public.academic_conversations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id),
  class_id uuid not null, student_id uuid not null, teacher_id uuid not null,
  last_sequence integer not null default 0 check(last_sequence>=0),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,id), unique(tenant_id,id,class_id), unique(tenant_id,class_id,student_id,teacher_id),
  foreign key(tenant_id,class_id) references public.classes(tenant_id,id),
  foreign key(tenant_id,class_id,student_id) references public.enrollments(tenant_id,class_id,student_id),
  foreign key(tenant_id,class_id,teacher_id) references public.teaching_assignments(tenant_id,class_id,teacher_id),
  check(student_id<>teacher_id)
);
create index academic_conversations_student_idx on public.academic_conversations(tenant_id,student_id,created_at desc,id);
create index academic_conversations_teacher_idx on public.academic_conversations(tenant_id,teacher_id,created_at desc,id);
create table public.academic_conversation_reads (
  tenant_id uuid not null, conversation_id uuid not null, user_id uuid not null,
  last_read_sequence integer not null check(last_read_sequence>=0), read_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id,conversation_id,user_id),
  foreign key(tenant_id,conversation_id) references public.academic_conversations(tenant_id,id),
  foreign key(tenant_id,user_id) references public.app_users(tenant_id,id)
);
alter table public.messages add column conversation_id uuid, add column client_message_id uuid, add column sequence integer,
  add constraint messages_communication_shape check((conversation_id is null and client_message_id is null and sequence is null) or
    (conversation_id is not null and client_message_id is not null and sequence is not null and sequence>0 and class_id is not null and char_length(btrim(content)) between 1 and 10000 and char_length(content)<=10000)),
  add constraint messages_conversation_fkey foreign key(tenant_id,conversation_id,class_id) references public.academic_conversations(tenant_id,id,class_id),
  add constraint messages_sender_tenant_fkey foreign key(tenant_id,sender_id) references public.app_users(tenant_id,id) not valid,
  add constraint messages_tenant_id_key unique(tenant_id,id),
  add constraint messages_sequence_key unique(tenant_id,conversation_id,sequence),
  add constraint messages_client_key unique(tenant_id,conversation_id,sender_id,client_message_id);
alter table public.grade_revisions add constraint grade_revisions_tenant_id_key unique(tenant_id,id),
  add constraint grade_revisions_notification_key unique(tenant_id,id,grade_id);
create table public.academic_notifications (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id), user_id uuid not null,
  event_type text not null check(event_type in ('notice_published','activity_published','activity_result_published','message_received','activity_due_soon')),
  event_key text not null, notice_id uuid, activity_id uuid, grade_revision_id uuid, grade_id uuid, message_id uuid,
  resource_type text generated always as (case when notice_id is not null then 'notice' when activity_id is not null then 'activity' when grade_revision_id is not null then 'grade' else 'message' end) stored,
  resource_id uuid generated always as (coalesce(notice_id,activity_id,grade_id,message_id)) stored,
  created_at timestamptz not null default clock_timestamp(), read_at timestamptz,
  unique(tenant_id,user_id,event_key),
  foreign key(tenant_id,user_id) references public.app_users(tenant_id,id),
  foreign key(tenant_id,notice_id) references public.academic_notices(tenant_id,id),
  foreign key(tenant_id,activity_id) references public.activities(tenant_id,id),
  foreign key(tenant_id,grade_revision_id) references public.grade_revisions(tenant_id,id),
  foreign key(tenant_id,grade_revision_id,grade_id) references public.grade_revisions(tenant_id,id,grade_id),
  foreign key(tenant_id,message_id) references public.messages(tenant_id,id),
  check((event_type='notice_published' and notice_id is not null and num_nonnulls(notice_id,activity_id,grade_revision_id,message_id)=1) or
    (event_type in ('activity_published','activity_due_soon') and activity_id is not null and num_nonnulls(notice_id,activity_id,grade_revision_id,message_id)=1) or
    (event_type='activity_result_published' and grade_revision_id is not null and num_nonnulls(notice_id,activity_id,grade_revision_id,message_id)=1) or
    (event_type='message_received' and message_id is not null and num_nonnulls(notice_id,activity_id,grade_revision_id,message_id)=1)),
  check((grade_revision_id is null)=(grade_id is null))
);
create index academic_notifications_user_time_idx on public.academic_notifications(tenant_id,user_id,created_at desc,id);
create index academic_notifications_unread_idx on public.academic_notifications(tenant_id,user_id,created_at desc,id) where read_at is null;
create index academic_activities_deadline_idx on public.activities(tenant_id,id,due_date) where state='published';

create function public.communication_member(p_tenant uuid,p_user uuid,p_lock boolean default false) returns public.app_users
language plpgsql set search_path = pg_catalog, public as $$
declare member public.app_users%rowtype;
begin
  if p_lock then perform 1 from public.app_users where tenant_id=p_tenant and id=p_user for share; end if;
  select * into member from public.app_users where tenant_id=p_tenant and id=p_user and active;
  if not found then raise exception using errcode='42501',message='Active institutional membership required.'; end if;
  return member;
end $$;
create function public.communication_can_manage(p_tenant uuid,p_actor uuid,p_role text,p_audience text,p_class uuid) returns boolean
language sql stable set search_path = pg_catalog, public as $$
  select p_role in ('owner','admin','coordinator') or (p_role='teacher' and p_audience='class' and exists(
    select 1 from public.teaching_assignments where tenant_id=p_tenant and teacher_id=p_actor and class_id=p_class and status='active'))
$$;
create function public.communication_manager(p_tenant uuid,p_actor uuid,p_audience text,p_class uuid) returns void
language plpgsql set search_path = pg_catalog, public as $$
declare actor public.app_users%rowtype;
begin
  actor:=public.communication_member(p_tenant,p_actor,true);
  if actor.role='teacher' then
    perform 1 from public.teaching_assignments where tenant_id=p_tenant and class_id=p_class and teacher_id=p_actor for share;
  end if;
  actor:=public.communication_member(p_tenant,p_actor,false);
  if not public.communication_can_manage(p_tenant,p_actor,actor.role,p_audience,p_class) then
    raise exception using errcode='42501',message='Notice authority required.';
  end if;
end $$;
create function public.communication_require_pair(p_tenant uuid,p_class uuid,p_student uuid,p_teacher uuid) returns void
language plpgsql set search_path = pg_catalog, public as $$
begin
  perform public.workflow_require_active_class(p_tenant,p_class);
  perform 1 from public.app_users where tenant_id=p_tenant and id in (p_student,p_teacher) order by id for share;
  perform 1 from public.enrollments where tenant_id=p_tenant and class_id=p_class and student_id=p_student for share;
  perform 1 from public.teaching_assignments where tenant_id=p_tenant and class_id=p_class and teacher_id=p_teacher for share;
  if not exists(select 1 from public.app_users where tenant_id=p_tenant and id=p_student and active and role='student')
    or not exists(select 1 from public.app_users where tenant_id=p_tenant and id=p_teacher and active and role='teacher')
    or not exists(select 1 from public.enrollments where tenant_id=p_tenant and class_id=p_class and student_id=p_student and status='active')
    or not exists(select 1 from public.teaching_assignments where tenant_id=p_tenant and class_id=p_class and teacher_id=p_teacher and status='active') then
    raise exception using errcode='42501',message='Active academic relationship required.';
  end if;
end $$;
create function public.communication_recipients(p_tenant uuid,p_audience text,p_course uuid,p_class uuid,p_students_only boolean default false,p_incomplete_activity uuid default null) returns uuid[]
language plpgsql set search_path = pg_catalog, public as $$
declare recipients uuid[];
begin
  perform 1 from public.app_users u where u.tenant_id=p_tenant order by u.id for share;
  if p_audience<>'institution' then
    perform 1 from public.enrollments e join public.classes c on c.tenant_id=e.tenant_id and c.id=e.class_id
      where e.tenant_id=p_tenant and ((p_audience='class' and c.id=p_class) or (p_audience='course' and c.course_id=p_course)) order by e.id for share of e;
    perform 1 from public.teaching_assignments t join public.classes c on c.tenant_id=t.tenant_id and c.id=t.class_id
      where t.tenant_id=p_tenant and ((p_audience='class' and c.id=p_class) or (p_audience='course' and c.course_id=p_course)) order by t.id for share of t;
  end if;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into recipients from (
    select u.id from public.app_users u where u.tenant_id=p_tenant and u.active and (not p_students_only or u.role='student')
      and (p_incomplete_activity is null or (not exists(select 1 from public.activity_submissions where tenant_id=p_tenant and activity_id=p_incomplete_activity and student_id=u.id)
        and not exists(select 1 from public.grades where tenant_id=p_tenant and activity_id=p_incomplete_activity and student_id=u.auth_user_id))) and (p_audience='institution' or
      (u.role='student' and exists(select 1 from public.enrollments e join public.classes c on c.tenant_id=e.tenant_id and c.id=e.class_id
        where e.tenant_id=p_tenant and e.student_id=u.id and e.status='active' and
        ((p_audience='class' and c.id=p_class) or (p_audience='course' and c.course_id=p_course)))) or
      (u.role='teacher' and exists(select 1 from public.teaching_assignments t join public.classes c on c.tenant_id=t.tenant_id and c.id=t.class_id
        where t.tenant_id=p_tenant and t.teacher_id=u.id and t.status='active' and
        ((p_audience='class' and c.id=p_class) or (p_audience='course' and c.course_id=p_course))))) limit 10001
  ) eligible;
  if cardinality(recipients)>10000 then raise exception using errcode='54000',message='Notification recipient limit exceeded.'; end if;
  return recipients;
end $$;

create function public.guard_communication_record() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_table_name='messages' then
    if tg_op='INSERT' and new.conversation_id is null then return new; end if;
    if tg_op<>'INSERT' and old.conversation_id is null then
      if tg_op='DELETE' then return old; end if;
      if new.conversation_id is not null or new.client_message_id is not null or new.sequence is not null then
        raise exception using errcode='23514',message='Legacy messages cannot acquire inferred participants.';
      end if;
      return new;
    end if;
    if tg_op<>'INSERT' then raise exception using errcode='23514',message='Messages are append-only.'; end if;
    if current_setting('app.communication',true) is distinct from new.conversation_id::text then raise exception using errcode='23514',message='Message requires authorized workflow.'; end if;
    perform 1 from public.academic_conversations where tenant_id=new.tenant_id and id=new.conversation_id
      and new.sender_id in (student_id,teacher_id) and last_sequence=new.sequence;
    if not found then raise exception using errcode='23514',message='Message sender or sequence invalid.'; end if;
  elsif tg_table_name='academic_notices' then
    if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve notices.'; end if;
    if current_setting('app.communication',true) is distinct from new.id::text then raise exception using errcode='23514',message='Notice requires authorized workflow.'; end if;
    if tg_op='INSERT' and (new.state<>'draft' or new.revision<>1) then raise exception using errcode='23514',message='Notice must start as draft.'; end if;
    if tg_op='UPDATE' and ((new.id,new.tenant_id,new.author_id,new.audience_type,new.course_id,new.class_id,new.created_at)
      is distinct from (old.id,old.tenant_id,old.author_id,old.audience_type,old.course_id,old.class_id,old.created_at)
      or new.revision<>old.revision+1 or old.state='archived' or (old.state='published' and new.state='draft')
      or (old.state='draft' and new.state='archived') or (old.published_at is not null and new.published_at is distinct from old.published_at)) then
      raise exception using errcode='23514',message='Notice identity, revision or transition invalid.';
    end if;
  elsif tg_table_name='academic_conversations' then
    if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve conversations.'; end if;
    if tg_op='UPDATE' and ((new.id,new.tenant_id,new.class_id,new.student_id,new.teacher_id,new.created_at)
      is distinct from (old.id,old.tenant_id,old.class_id,old.student_id,old.teacher_id,old.created_at)
      or new.last_sequence<>old.last_sequence+1 or current_setting('app.communication',true) is distinct from new.id::text) then
      raise exception using errcode='23514',message='Conversation identity or sequence invalid.';
    end if;
  elsif tg_table_name='academic_notice_recipients' then
    if tg_op='DELETE' or (tg_op='UPDATE' and ((new.tenant_id,new.notice_id,new.user_id,new.created_at) is distinct from
      (old.tenant_id,old.notice_id,old.user_id,old.created_at) or new.read_revision<old.read_revision or new.read_revision is null or
      (new.read_revision=old.read_revision and new.read_at is distinct from old.read_at))) then
      raise exception using errcode='23514',message='Preserve notice recipients and receipts.';
    end if;
    if current_setting('app.communication',true) is distinct from new.notice_id::text then raise exception using errcode='23514',message='Recipient requires authorized workflow.'; end if;
  elsif tg_table_name='academic_conversation_reads' then
    if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve read watermarks.'; end if;
    if current_setting('app.communication',true) is distinct from new.conversation_id::text then raise exception using errcode='23514',message='Receipt requires authorized workflow.'; end if;
    perform 1 from public.academic_conversations where tenant_id=new.tenant_id and id=new.conversation_id and new.user_id in(student_id,teacher_id) and new.last_read_sequence<=last_sequence;
    if not found or (tg_op='UPDATE' and ((new.tenant_id,new.conversation_id,new.user_id) is distinct from (old.tenant_id,old.conversation_id,old.user_id) or new.last_read_sequence<old.last_read_sequence)) then
      raise exception using errcode='23514',message='Invalid message read watermark.';
    end if;
  elsif tg_table_name='academic_notifications' then
    if tg_op='DELETE' then raise exception using errcode='23514',message='Preserve notification history.'; end if;
    if tg_op='UPDATE' and ((new.id,new.tenant_id,new.user_id,new.event_type,new.event_key,new.notice_id,new.activity_id,new.grade_revision_id,new.grade_id,new.message_id,new.created_at)
      is distinct from (old.id,old.tenant_id,old.user_id,old.event_type,old.event_key,old.notice_id,old.activity_id,old.grade_revision_id,old.grade_id,old.message_id,old.created_at)
      or (old.read_at is not null and new.read_at is distinct from old.read_at) or current_setting('app.communication',true) is distinct from new.id::text) then
      raise exception using errcode='23514',message='Notification identity is immutable.';
    end if;
    if tg_op='INSERT' and pg_trigger_depth()<2 and (new.event_type<>'activity_due_soon' or new.activity_id is null or current_setting('app.communication_deadline',true) is distinct from new.activity_id::text) then
      raise exception using errcode='23514',message='Notification requires transactional origin.';
    end if;
  else
    if tg_op<>'INSERT' or (tg_table_name='academic_notice_revisions' and pg_trigger_depth()<2) then
      raise exception using errcode='23514',message='Communication history is append-only.';
    end if;
    if tg_table_name='academic_notice_reads' and current_setting('app.communication',true) is distinct from new.notice_id::text then raise exception using errcode='23514',message='Receipt requires authorized workflow.'; end if;
  end if;
  return new;
end $$;
create trigger messages_communication_guard before insert or update or delete on public.messages for each row execute function public.guard_communication_record();
create trigger academic_notices_guard before insert or update or delete on public.academic_notices for each row execute function public.guard_communication_record();
create trigger academic_notice_revisions_guard before insert or update or delete on public.academic_notice_revisions for each row execute function public.guard_communication_record();
create trigger academic_notice_recipients_guard before insert or update or delete on public.academic_notice_recipients for each row execute function public.guard_communication_record();
create trigger academic_notice_reads_guard before insert or update or delete on public.academic_notice_reads for each row execute function public.guard_communication_record();
create trigger academic_conversations_guard before insert or update or delete on public.academic_conversations for each row execute function public.guard_communication_record();
create trigger academic_conversation_reads_guard before insert or update or delete on public.academic_conversation_reads for each row execute function public.guard_communication_record();
create trigger academic_notifications_guard before insert or update or delete on public.academic_notifications for each row execute function public.guard_communication_record();

create function public.record_communication_notice() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare recipients uuid[];
begin
  insert into public.academic_notice_revisions(tenant_id,notice_id,revision,title,content,priority,state,expires_at,changed_by)
    values(new.tenant_id,new.id,new.revision,new.title,new.content,new.priority,new.state,new.expires_at,
      nullif(current_setting('app.communication_actor',true),'')::uuid);
  if tg_op='UPDATE' and old.state='draft' and new.state='published' then
    recipients:=public.communication_recipients(new.tenant_id,new.audience_type,new.course_id,new.class_id);
    if new.expires_at is not null and new.expires_at<=clock_timestamp() then raise exception using errcode='23514',message='Expired notice cannot publish.'; end if;
    insert into public.academic_notice_recipients(tenant_id,notice_id,user_id) select new.tenant_id,new.id,unnest(recipients);
    insert into public.academic_notifications(tenant_id,user_id,event_type,event_key,notice_id)
      select new.tenant_id,unnest(recipients),'notice_published','notice:'||new.id::text,new.id;
  end if;
  return new;
end $$;
create trigger academic_notices_record after insert or update on public.academic_notices for each row execute function public.record_communication_notice();
create function public.record_communication_event() returns trigger
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
    if new.publication_state='published' then
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
create trigger activities_communication_event after insert or update on public.activities for each row execute function public.record_communication_event();
create trigger grade_revisions_communication_event after insert on public.grade_revisions for each row execute function public.record_communication_event();
create trigger messages_communication_event after insert on public.messages for each row execute function public.record_communication_event();

create function public.protect_communication_member() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op='DELETE' or (new.id,new.tenant_id,new.auth_user_id) is distinct from (old.id,old.tenant_id,old.auth_user_id) then
    if exists(select 1 from public.academic_notices where tenant_id=old.tenant_id and author_id=old.id)
      or exists(select 1 from public.academic_notice_recipients where tenant_id=old.tenant_id and user_id=old.id)
      or exists(select 1 from public.academic_conversations where tenant_id=old.tenant_id and old.id in(student_id,teacher_id))
      or exists(select 1 from public.academic_notifications where tenant_id=old.tenant_id and user_id=old.id)
      or exists(select 1 from public.messages where tenant_id=old.tenant_id and sender_id=old.id and conversation_id is not null) then
      raise exception using errcode='23514',message='Preserve communication member identity.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger app_users_communication_identity before update of id,tenant_id,auth_user_id or delete on public.app_users for each row execute function public.protect_communication_member();

create function public.academic_communication(p_tenant_id uuid,p_actor_id uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  actor public.app_users%rowtype; other_member public.app_users%rowtype;
  notice public.academic_notices%rowtype; conversation public.academic_conversations%rowtype;
  msg public.messages%rowtype; notification public.academic_notifications%rowtype;
  result jsonb; allowed text[]; resource uuid; expected integer; page_offset integer:=0; page_limit integer:=20;
  after_sequence integer:=0; upto integer; audience text; target_class uuid; target_course uuid; student uuid; teacher uuid;
  previous_context text:=current_setting('app.communication',true); previous_actor text:=current_setting('app.communication_actor',true); managed boolean; receipt_time timestamptz;
begin
  if p_tenant_id is null or p_actor_id is null or p_operation is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception using errcode='22023',message='Invalid communication input.'; end if;
  allowed:=case p_operation
    when 'notice_create' then array['title','content','audienceType','courseId','classId','priority','expiresAt']
    when 'notice_update' then array['id','expectedRevision','title','content','priority','expiresAt']
    when 'notice_publish' then array['id','expectedRevision'] when 'notice_archive' then array['id','expectedRevision']
    when 'notice_read' then array['id','expectedRevision'] when 'notice_get' then array['id']
    when 'notice_list' then array['view','offset','limit'] when 'notice_history' then array['id','offset','limit']
    when 'conversation_create' then array['classId','participantId'] when 'conversation_list' then array['offset','limit']
    when 'conversation_get' then array['id'] when 'message_send' then array['id','content','clientMessageId']
    when 'message_list' then array['id','afterSequence','limit'] when 'message_read' then array['id','upToSequence']
    when 'notification_list' then array['offset','limit','unreadOnly'] when 'notification_count' then array[]::text[]
    when 'notification_read' then array['id'] else null end;
  if allowed is null or exists(select 1 from jsonb_object_keys(p_payload) k where not(k=any(allowed))) then raise exception using errcode='22023',message='Unsupported communication fields.'; end if;
  perform set_config('app.communication_actor',p_actor_id::text,true);
  if p_payload ? 'offset' then
    if jsonb_typeof(p_payload->'offset')<>'number' or (p_payload->>'offset')!~'^[0-9]+$' then raise exception using errcode='22023',message='Invalid offset.'; end if;
    page_offset:=(p_payload->>'offset')::integer;
  end if;
  if p_payload ? 'limit' then
    if jsonb_typeof(p_payload->'limit')<>'number' or (p_payload->>'limit')!~'^[0-9]+$' then raise exception using errcode='22023',message='Invalid limit.'; end if;
    page_limit:=(p_payload->>'limit')::integer;
  end if;
  if page_offset>10000000 or page_limit not between 1 and 100 then raise exception using errcode='22023',message='Invalid pagination.'; end if;
  if p_payload ? 'id' then resource:=(p_payload->>'id')::uuid; if resource is null then raise exception using errcode='22023',message='Resource required.'; end if; end if;
  if p_operation in ('notice_update','notice_publish','notice_archive','notice_read') then
    if jsonb_typeof(p_payload->'expectedRevision') is distinct from 'number' or (p_payload->>'expectedRevision')!~'^[0-9]+$' then raise exception using errcode='22023',message='Expected revision required.'; end if;
    expected:=(p_payload->>'expectedRevision')::integer;
  end if;
  if p_operation in ('notice_create','notice_update','message_send') then
    if p_payload ? 'title' and (jsonb_typeof(p_payload->'title')<>'string' or char_length(btrim(p_payload->>'title'))<1 or char_length(p_payload->>'title')>200) then raise exception using errcode='22023',message='Invalid title.'; end if;
    if p_payload ? 'content' and (jsonb_typeof(p_payload->'content')<>'string' or char_length(btrim(p_payload->>'content'))<1 or char_length(p_payload->>'content')>10000) then raise exception using errcode='22023',message='Invalid content.'; end if;
    if p_payload ? 'priority' and (p_payload->>'priority' is null or p_payload->>'priority' not in('low','medium','high')) then raise exception using errcode='22023',message='Invalid priority.'; end if;
    if p_payload ? 'expiresAt' and jsonb_typeof(p_payload->'expiresAt') not in('string','null') then raise exception using errcode='22023',message='Invalid expiry.'; end if;
  end if;
  if p_operation='notice_create' then
    audience:=p_payload->>'audienceType'; target_class:=(p_payload->>'classId')::uuid; target_course:=(p_payload->>'courseId')::uuid;
    if audience is null or audience not in('institution','course','class') or not(p_payload ? 'title' and p_payload ? 'content') or
      not((audience='institution' and target_class is null and target_course is null) or (audience='course' and target_course is not null and target_class is null) or (audience='class' and target_class is not null and target_course is null)) then raise exception using errcode='22023',message='Invalid notice audience.'; end if;
    if audience='class' then perform 1 from public.classes where tenant_id=p_tenant_id and id=target_class for share;
      if not found then raise exception using errcode='P0002',message='Class not found.'; end if;
    elsif audience='course' then perform 1 from public.courses where tenant_id=p_tenant_id and id=target_course for share;
      if not found then raise exception using errcode='P0002',message='Course not found.'; end if;
    end if;
    perform public.communication_manager(p_tenant_id,p_actor_id,audience,target_class);
    resource:=gen_random_uuid(); perform set_config('app.communication',resource::text,true);
    insert into public.academic_notices(id,tenant_id,author_id,title,content,audience_type,class_id,course_id,priority,expires_at)
      values(resource,p_tenant_id,p_actor_id,btrim(p_payload->>'title'),p_payload->>'content',audience,target_class,target_course,coalesce(p_payload->>'priority','medium'),(p_payload->>'expiresAt')::timestamptz) returning to_jsonb(academic_notices.*) into result;
  elsif p_operation in('notice_update','notice_publish','notice_archive','notice_read') then
    select * into notice from public.academic_notices where tenant_id=p_tenant_id and id=resource for update;
    if not found then raise exception using errcode='P0002',message='Notice not found.'; end if;
    actor:=public.communication_member(p_tenant_id,p_actor_id,true);
    if p_operation='notice_read' then
      if notice.state='draft' or not exists(select 1 from public.academic_notice_recipients where tenant_id=p_tenant_id and notice_id=resource and user_id=p_actor_id) then raise exception using errcode='P0002',message='Notice not found.'; end if;
    else perform public.communication_manager(p_tenant_id,p_actor_id,notice.audience_type,notice.class_id); end if;
    if notice.revision<>expected then raise exception using errcode='23514',message='Notice revision conflict.'; end if;
    perform set_config('app.communication',resource::text,true);
    if p_operation='notice_read' then
      insert into public.academic_notice_reads(tenant_id,notice_id,user_id,revision) values(p_tenant_id,resource,p_actor_id,expected) on conflict do nothing;
      select read_at into receipt_time from public.academic_notice_reads where tenant_id=p_tenant_id and notice_id=resource and user_id=p_actor_id and revision=expected;
      update public.academic_notice_recipients set read_at=receipt_time,read_revision=expected where tenant_id=p_tenant_id and notice_id=resource and user_id=p_actor_id;
      result:=jsonb_build_object('notice_id',resource,'read_revision',expected,'read_at',receipt_time);
    elsif p_operation='notice_update' then
      update public.academic_notices set title=case when p_payload ? 'title' then btrim(p_payload->>'title') else title end,
        content=case when p_payload ? 'content' then p_payload->>'content' else content end,
        priority=coalesce(p_payload->>'priority',priority),expires_at=case when p_payload ? 'expiresAt' then (p_payload->>'expiresAt')::timestamptz else expires_at end,
        revision=revision+1,updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=resource returning to_jsonb(academic_notices.*) into result;
    elsif p_operation='notice_publish' then
      if notice.state<>'draft' then raise exception using errcode='23514',message='Only drafts may publish.'; end if;
      if notice.audience_type='class' then perform public.workflow_require_active_class(p_tenant_id,notice.class_id); end if;
      update public.academic_notices set state='published',published_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=resource returning to_jsonb(academic_notices.*) into result;
    else
      if notice.state<>'published' then raise exception using errcode='23514',message='Only published notices may archive.'; end if;
      update public.academic_notices set state='archived',revision=revision+1,updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=resource returning to_jsonb(academic_notices.*) into result;
    end if;
  elsif p_operation in('notice_list','notice_get','notice_history') then
    actor:=public.communication_member(p_tenant_id,p_actor_id,true);
    if p_operation in('notice_get','notice_history') then
      select * into notice from public.academic_notices n where n.tenant_id=p_tenant_id and n.id=resource;
      if not found then raise exception using errcode='P0002',message='Notice not found.'; end if;
      managed:=public.communication_can_manage(p_tenant_id,p_actor_id,actor.role,notice.audience_type,notice.class_id);
      if p_operation='notice_history' then
        if not managed then raise exception using errcode='42501',message='Notice history authority required.'; end if;
        select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(r)) from(select * from public.academic_notice_revisions where tenant_id=p_tenant_id and notice_id=resource order by revision desc offset page_offset limit page_limit)r),'[]'::jsonb),
          'total',(select count(*) from public.academic_notice_revisions where tenant_id=p_tenant_id and notice_id=resource)) into result;
      else
        if not managed and (notice.state='draft' or not exists(select 1 from public.academic_notice_recipients where tenant_id=p_tenant_id and notice_id=resource and user_id=p_actor_id)) then raise exception using errcode='P0002',message='Notice not found.'; end if;
        select to_jsonb(notice)||jsonb_build_object('read_at',r.read_at,'read_revision',r.read_revision) into result from (select 1)dummy left join public.academic_notice_recipients r on r.tenant_id=p_tenant_id and r.notice_id=resource and r.user_id=p_actor_id;
      end if;
    else
      if p_payload->>'view' is null or p_payload->>'view' not in('active','history','managed') then raise exception using errcode='22023',message='Invalid notice view.'; end if;
      if p_payload->>'view'='managed' and actor.role not in('owner','admin','coordinator','teacher') then raise exception using errcode='42501',message='Notice management required.'; end if;
      with visible as (
        select n.*,r.read_at,r.read_revision from public.academic_notices n left join public.academic_notice_recipients r on r.tenant_id=n.tenant_id and r.notice_id=n.id and r.user_id=p_actor_id
        where n.tenant_id=p_tenant_id and ((p_payload->>'view'='managed' and public.communication_can_manage(p_tenant_id,p_actor_id,actor.role,n.audience_type,n.class_id)) or
          (p_payload->>'view'<>'managed' and r.user_id is not null and n.state<>'draft' and (p_payload->>'view'='history' or(n.state='published' and (n.expires_at is null or n.expires_at>clock_timestamp())))))
      ) select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(v)) from(select * from visible order by created_at desc,id offset page_offset limit page_limit)v),'[]'::jsonb),'total',(select count(*) from visible)) into result;
    end if;
  elsif p_operation='conversation_create' then
    target_class:=(p_payload->>'classId')::uuid; resource:=(p_payload->>'participantId')::uuid;
    if target_class is null or resource is null then raise exception using errcode='22023',message='Conversation participants required.'; end if;
    perform 1 from public.classes where tenant_id=p_tenant_id and id=target_class for share;
    if not found then raise exception using errcode='P0002',message='Class not found.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||target_class::text||least(resource,p_actor_id)::text||greatest(resource,p_actor_id)::text,0));
    perform 1 from public.app_users where tenant_id=p_tenant_id and id in(p_actor_id,resource) order by id for share;
    if not exists(select 1 from public.app_users where tenant_id=p_tenant_id and id=resource) then raise exception using errcode='P0002',message='Participant not found.'; end if;
    actor:=public.communication_member(p_tenant_id,p_actor_id,false); other_member:=public.communication_member(p_tenant_id,resource,false);
    if actor.role='student' and other_member.role='teacher' then student:=actor.id;teacher:=other_member.id;
    elsif actor.role='teacher' and other_member.role='student' then teacher:=actor.id;student:=other_member.id;
    else raise exception using errcode='42501',message='Student and teacher required.'; end if;
    perform public.communication_require_pair(p_tenant_id,target_class,student,teacher);
    insert into public.academic_conversations(tenant_id,class_id,student_id,teacher_id) values(p_tenant_id,target_class,student,teacher)
      on conflict(tenant_id,class_id,student_id,teacher_id) do nothing;
    select to_jsonb(c) into result from public.academic_conversations c where tenant_id=p_tenant_id and class_id=target_class and student_id=student and teacher_id=teacher;
  elsif p_operation in('conversation_list','conversation_get','message_list') then
    actor:=public.communication_member(p_tenant_id,p_actor_id,true);
    if p_operation='conversation_list' then
      with visible as(select * from public.academic_conversations where tenant_id=p_tenant_id and p_actor_id in(student_id,teacher_id))
      select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(v)) from(select * from visible order by created_at desc,id offset page_offset limit page_limit)v),'[]'::jsonb),'total',(select count(*) from visible)) into result;
    else
      select * into conversation from public.academic_conversations where tenant_id=p_tenant_id and id=resource and p_actor_id in(student_id,teacher_id);
      if not found then raise exception using errcode='P0002',message='Conversation not found.'; end if;
      if p_operation='conversation_get' then result:=to_jsonb(conversation);
      else
        if p_payload ? 'afterSequence' then
          if jsonb_typeof(p_payload->'afterSequence')<>'number' or (p_payload->>'afterSequence')!~'^[0-9]+$' then raise exception using errcode='22023',message='Invalid message cursor.'; end if;
          after_sequence:=(p_payload->>'afterSequence')::integer;
        end if;
        if after_sequence>2147483646 then raise exception using errcode='22023',message='Invalid message cursor.'; end if;
        with page as(select m.*,coalesce(r.last_read_sequence>=m.sequence,false) as read_by_recipient from public.messages m
          left join public.academic_conversation_reads r on r.tenant_id=m.tenant_id and r.conversation_id=m.conversation_id and r.user_id=case when m.sender_id=conversation.student_id then conversation.teacher_id else conversation.student_id end
          where m.tenant_id=p_tenant_id and m.conversation_id=resource and m.sequence>after_sequence order by m.sequence limit page_limit)
        select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(p) order by sequence) from page p),'[]'::jsonb),
          'has_more',exists(select 1 from public.messages where tenant_id=p_tenant_id and conversation_id=resource and sequence>coalesce((select max(sequence) from page),after_sequence)),
          'next_after_sequence',coalesce((select max(sequence) from page),after_sequence)) into result;
      end if;
    end if;
  elsif p_operation in('message_send','message_read') then
    select c.class_id into target_class from public.academic_conversations c where c.tenant_id=p_tenant_id and c.id=resource and p_actor_id in(c.student_id,c.teacher_id);
    if not found then raise exception using errcode='P0002',message='Conversation not found.'; end if;
    if p_operation='message_send' then perform 1 from public.classes where tenant_id=p_tenant_id and id=target_class for share; end if;
    select * into conversation from public.academic_conversations where tenant_id=p_tenant_id and id=resource for update;
    perform 1 from public.app_users where tenant_id=p_tenant_id and id in(conversation.student_id,conversation.teacher_id) order by id for share;
    actor:=public.communication_member(p_tenant_id,p_actor_id,false);
    perform set_config('app.communication',resource::text,true);
    if p_operation='message_send' then
      if not(p_payload ? 'content') or (p_payload->>'clientMessageId')::uuid is null then raise exception using errcode='22023',message='Message identity and content required.'; end if;
      perform public.communication_require_pair(p_tenant_id,conversation.class_id,conversation.student_id,conversation.teacher_id);
      select * into msg from public.messages where tenant_id=p_tenant_id and conversation_id=resource and sender_id=p_actor_id and client_message_id=(p_payload->>'clientMessageId')::uuid;
      if found then
        if msg.content is distinct from p_payload->>'content' then raise exception using errcode='23514',message='Message idempotency conflict.'; end if;
      else
        if conversation.last_sequence=2147483647 then raise exception using errcode='54000',message='Conversation sequence exhausted.'; end if;
        update public.academic_conversations set last_sequence=last_sequence+1,updated_at=clock_timestamp() where tenant_id=p_tenant_id and id=resource returning * into conversation;
        insert into public.messages(tenant_id,conversation_id,class_id,sender_id,client_message_id,sequence,content,created_at)
          values(p_tenant_id,resource,conversation.class_id,p_actor_id,(p_payload->>'clientMessageId')::uuid,conversation.last_sequence,p_payload->>'content',clock_timestamp()) returning * into msg;
      end if;
      result:=to_jsonb(msg);
    else
      if jsonb_typeof(p_payload->'upToSequence') is distinct from 'number' or (p_payload->>'upToSequence')!~'^[0-9]+$' then raise exception using errcode='22023',message='Read sequence required.'; end if;
      upto:=(p_payload->>'upToSequence')::integer;
      if upto>conversation.last_sequence then raise exception using errcode='23514',message='Read exceeds message history.'; end if;
      insert into public.academic_conversation_reads(tenant_id,conversation_id,user_id,last_read_sequence) values(p_tenant_id,resource,p_actor_id,upto)
        on conflict(tenant_id,conversation_id,user_id) do update set last_read_sequence=excluded.last_read_sequence,read_at=clock_timestamp()
        where academic_conversation_reads.last_read_sequence<excluded.last_read_sequence;
      select jsonb_build_object('conversation_id',conversation_id,'last_read_sequence',last_read_sequence,'read_at',read_at) into result from public.academic_conversation_reads where tenant_id=p_tenant_id and conversation_id=resource and user_id=p_actor_id;
    end if;
  elsif p_operation='notification_read' then
    select * into notification from public.academic_notifications where tenant_id=p_tenant_id and id=resource and user_id=p_actor_id for update;
    if not found then raise exception using errcode='P0002',message='Notification not found.'; end if;
    actor:=public.communication_member(p_tenant_id,p_actor_id,true);
    perform set_config('app.communication',resource::text,true);
    update public.academic_notifications set read_at=coalesce(read_at,clock_timestamp()) where tenant_id=p_tenant_id and id=resource returning to_jsonb(academic_notifications.*)-'user_id'||jsonb_build_object('recipient_id',user_id) into result;
  else
    actor:=public.communication_member(p_tenant_id,p_actor_id,true);
    if p_operation='notification_count' then select jsonb_build_object('unread_count',count(*)) into result from public.academic_notifications where tenant_id=p_tenant_id and user_id=p_actor_id and read_at is null;
    else
      if p_payload ? 'unreadOnly' and jsonb_typeof(p_payload->'unreadOnly')<>'boolean' then raise exception using errcode='22023',message='Invalid unread filter.'; end if;
      with visible as(select * from public.academic_notifications where tenant_id=p_tenant_id and user_id=p_actor_id and (not coalesce((p_payload->>'unreadOnly')::boolean,false) or read_at is null))
      select jsonb_build_object('data',coalesce((select jsonb_agg(to_jsonb(v)-'user_id'||jsonb_build_object('recipient_id',v.user_id)) from(select * from visible order by created_at desc,id offset page_offset limit page_limit)v),'[]'::jsonb),'total',(select count(*) from visible)) into result;
    end if;
  end if;
  perform set_config('app.communication',coalesce(previous_context,''),true);
  perform set_config('app.communication_actor',coalesce(previous_actor,''),true);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode='22023',message='Invalid communication input.';
end $$;

create function public.generate_academic_deadline_notifications(p_tenant_id uuid,p_window_minutes integer,p_limit integer,p_after_id uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare activity public.activities%rowtype; candidate uuid; recipients uuid[]; processed integer:=0; created integer:=0;
  inserted integer; last_id uuid:=p_after_id; has_more boolean:=false; deadline timestamptz;
  previous_context text:=current_setting('app.communication_deadline',true);
begin
  if p_tenant_id is null or p_window_minutes is null or p_window_minutes not between 1 and 10080 or p_limit is null or p_limit not between 1 and 100 then raise exception using errcode='22023',message='Invalid deadline notification arguments.'; end if;
  deadline:=clock_timestamp()+make_interval(mins=>p_window_minutes);
  for candidate in select id from public.activities where tenant_id=p_tenant_id and state='published' and due_date>clock_timestamp() and due_date<=deadline and (p_after_id is null or id>p_after_id) order by id limit p_limit+1 loop
    if processed=p_limit then has_more:=true; exit; end if;
    processed:=processed+1;last_id:=candidate;
    select * into activity from public.activities where tenant_id=p_tenant_id and id=candidate for share;
    if activity.state<>'published' or activity.due_date<=clock_timestamp() or activity.due_date>deadline then continue; end if;
    perform 1 from public.classes c join public.subjects s on s.tenant_id=c.tenant_id and s.id=c.subject_id join public.academic_periods p on p.tenant_id=c.tenant_id and p.id=c.academic_period_id
      where c.tenant_id=p_tenant_id and c.id=activity.class_id for share of c,s,p;
    if not exists(select 1 from public.classes c join public.subjects s on s.tenant_id=c.tenant_id and s.id=c.subject_id join public.academic_periods p on p.tenant_id=c.tenant_id and p.id=c.academic_period_id
      where c.tenant_id=p_tenant_id and c.id=activity.class_id and c.academic_status='active' and s.status='active' and p.status='active') then continue; end if;
    recipients:=public.communication_recipients(p_tenant_id,'class',null,activity.class_id,true,activity.id);
    perform set_config('app.communication_deadline',activity.id::text,true);
    insert into public.academic_notifications(tenant_id,user_id,event_type,event_key,activity_id)
      select p_tenant_id,u.id,'activity_due_soon','due:'||activity.id::text||':'||extract(epoch from activity.due_date)::text,activity.id from public.app_users u
      where u.tenant_id=p_tenant_id and u.id=any(recipients) and u.role='student' and u.active
        and not exists(select 1 from public.activity_submissions where tenant_id=p_tenant_id and activity_id=activity.id and student_id=u.id)
        and not exists(select 1 from public.grades where tenant_id=p_tenant_id and activity_id=activity.id and student_id=u.auth_user_id)
        and activity.due_date>clock_timestamp()
      on conflict(tenant_id,user_id,event_key) do nothing;
    get diagnostics inserted=row_count;created:=created+inserted;
  end loop;
  perform set_config('app.communication_deadline',coalesce(previous_context,''),true);
  return jsonb_build_object('processed_activities',processed,'created_notifications',created,'has_more',has_more,'next_after_id',last_id);
end $$;

do $$ declare relation text; signature text; begin
  foreach relation in array array['academic_notices','academic_notice_revisions','academic_notice_recipients','academic_notice_reads','academic_conversations','academic_conversation_reads','academic_notifications'] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format('revoke all on public.%I from public',relation);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on public.%I from anon',relation); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on public.%I from authenticated',relation); end if;
  end loop;
  foreach signature in array array['communication_member(uuid,uuid,boolean)','communication_can_manage(uuid,uuid,text,text,uuid)','communication_manager(uuid,uuid,text,uuid)',
    'communication_require_pair(uuid,uuid,uuid,uuid)','communication_recipients(uuid,text,uuid,uuid,boolean,uuid)','guard_communication_record()',
    'record_communication_notice()','record_communication_event()','protect_communication_member()',
    'academic_communication(uuid,uuid,text,jsonb)','generate_academic_deadline_notifications(uuid,integer,integer,uuid)'] loop
    execute format('revoke all on function public.%s from public',signature);
    if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on function public.%s from anon',signature); end if;
    if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on function public.%s from authenticated',signature); end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function public.academic_communication(uuid,uuid,text,jsonb),public.generate_academic_deadline_notifications(uuid,integer,integer,uuid) to service_role;
  end if;
end $$;
commit;
