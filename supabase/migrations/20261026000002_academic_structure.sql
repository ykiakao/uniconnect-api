begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.app_users, public.courses, public.classes, public.activities, public.grades
  in share row exclusive mode;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.classes'::regclass and conname = 'classes_tenant_course_fkey') then
    raise exception using errcode = '23514', message = 'Preflight: apply security integrity migration before academic structure.';
  end if;
  if exists (
    select 1 from public.classes c
    left join public.courses course on course.tenant_id = c.tenant_id and course.id = c.course_id
    left join public.app_users u on u.tenant_id = c.tenant_id and u.auth_user_id = c.teacher_id
    where course.id is null or (c.teacher_id is not null and (u.id is null or u.role <> 'teacher'))
  ) then
    raise exception using errcode = '23514', message = 'Preflight: invalid existing course or teacher membership; review manually.';
  end if;
end $$;

alter table public.app_users add constraint app_users_tenant_id_key unique (tenant_id, id);

create table public.academic_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  start_date date,
  end_date date,
  status text not null default 'planned' check (status in ('planned', 'active', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id),
  check (start_date is null or end_date is null or start_date <= end_date)
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  course_id uuid not null,
  code text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id),
  unique (tenant_id, id, course_id),
  foreign key (tenant_id, course_id) references public.courses(tenant_id, id)
);
create index subjects_tenant_course_idx on public.subjects(tenant_id, course_id);

alter table public.classes
  add column subject_id uuid,
  add column academic_period_id uuid,
  add column academic_status text not null default 'active' check (academic_status in ('active', 'closed', 'archived')),
  add constraint classes_academic_mapping_pair check ((subject_id is null) = (academic_period_id is null)),
  add constraint classes_tenant_subject_course_fkey foreign key (tenant_id, subject_id, course_id)
    references public.subjects(tenant_id, id, course_id),
  add constraint classes_tenant_academic_period_fkey foreign key (tenant_id, academic_period_id)
    references public.academic_periods(tenant_id, id);
create index classes_tenant_period_idx on public.classes(tenant_id, academic_period_id);
create index classes_tenant_subject_idx on public.classes(tenant_id, subject_id);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  class_id uuid not null,
  student_id uuid not null,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, class_id, student_id),
  unique (tenant_id, id),
  foreign key (tenant_id, class_id) references public.classes(tenant_id, id),
  foreign key (tenant_id, student_id) references public.app_users(tenant_id, id)
);
create index enrollments_tenant_student_idx on public.enrollments(tenant_id, student_id);

create table public.enrollment_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  enrollment_id uuid not null,
  status text not null check (status in ('active', 'completed', 'cancelled', 'suspended')),
  changed_at timestamptz not null default now(),
  foreign key (tenant_id, enrollment_id) references public.enrollments(tenant_id, id)
);
create index enrollment_status_history_enrollment_idx on public.enrollment_status_history(tenant_id, enrollment_id, changed_at);

create table public.teaching_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  class_id uuid not null,
  teacher_id uuid not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, class_id, teacher_id),
  unique (tenant_id, id),
  check (not is_primary or status = 'active'),
  foreign key (tenant_id, class_id) references public.classes(tenant_id, id),
  foreign key (tenant_id, teacher_id) references public.app_users(tenant_id, id)
);
create unique index teaching_assignments_one_active_primary on public.teaching_assignments(tenant_id, class_id)
  where is_primary and status = 'active';
create index teaching_assignments_tenant_teacher_idx on public.teaching_assignments(tenant_id, teacher_id);

insert into public.teaching_assignments(tenant_id, class_id, teacher_id, is_primary)
  select c.tenant_id, c.id, u.id, true
  from public.classes c join public.app_users u on u.tenant_id = c.tenant_id and u.auth_user_id = c.teacher_id and u.role = 'teacher';

create function public.validate_enrollment() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'UPDATE' and (new.id, new.tenant_id, new.class_id, new.student_id) is distinct from (old.id, old.tenant_id, old.class_id, old.student_id) then
    raise exception using errcode = '23514', message = 'Enrollment identity is immutable; preserve academic history.';
  end if;
  perform 1 from public.classes where tenant_id = new.tenant_id and id = new.class_id
    and subject_id is not null and academic_period_id is not null for share;
  if not found then
    raise exception using errcode = '23514', message = 'Enrollment requires a mapped class in the same tenant.';
  end if;
  perform 1 from public.app_users where tenant_id = new.tenant_id and id = new.student_id and role = 'student' for share;
  if not found then
    raise exception using errcode = '23514', message = 'Enrollment requires an institutional student in the same tenant.';
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
create trigger enrollments_validate before insert or update on public.enrollments
  for each row execute function public.validate_enrollment();

create function public.record_enrollment_status() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.enrollment_status_history(tenant_id, enrollment_id, status) values (new.tenant_id, new.id, new.status);
  end if;
  return new;
end $$;
create trigger enrollments_record_status after insert or update on public.enrollments
  for each row execute function public.record_enrollment_status();

create function public.guard_enrollment_history() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op <> 'INSERT' or pg_trigger_depth() < 2 then
    raise exception using errcode = '23514', message = 'Enrollment status history is append-only and recorded by enrollment changes.';
  end if;
  return new;
end $$;
create trigger enrollment_history_guard before insert or update or delete on public.enrollment_status_history
  for each row execute function public.guard_enrollment_history();

create function public.validate_teaching_assignment() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Preserve teaching history by setting additional assignments inactive.';
  end if;
  if tg_op = 'UPDATE' and (new.id, new.tenant_id, new.class_id, new.teacher_id) is distinct from (old.id, old.tenant_id, old.class_id, old.teacher_id) then
    raise exception using errcode = '23514', message = 'Teaching assignment identity is immutable.';
  end if;
  if pg_trigger_depth() < 2 and (
    new.is_primary or (tg_op = 'UPDATE' and old.is_primary)
  ) then
    raise exception using errcode = '23514', message = 'Primary teacher changes must update classes.teacher_id.';
  end if;
  perform 1 from public.classes where tenant_id = new.tenant_id and id = new.class_id for share;
  if not found then
    raise exception using errcode = '23514', message = 'Teaching assignment requires a class in the same tenant.';
  end if;
  perform 1 from public.app_users where tenant_id = new.tenant_id and id = new.teacher_id and role = 'teacher' for share;
  if not found then
    raise exception using errcode = '23514', message = 'Teaching assignment requires an institutional teacher in the same tenant.';
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
create trigger teaching_assignments_validate before insert or update or delete on public.teaching_assignments
  for each row execute function public.validate_teaching_assignment();

create function public.mirror_class_primary_teacher() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare member_id uuid;
begin
  if tg_op = 'UPDATE' and new.teacher_id is not distinct from old.teacher_id then return new; end if;
  update public.teaching_assignments set is_primary = false, status = 'inactive'
    where tenant_id = new.tenant_id and class_id = new.id and is_primary;
  if new.teacher_id is not null then
    select id into member_id from public.app_users where tenant_id = new.tenant_id and auth_user_id = new.teacher_id and role = 'teacher' for share;
    if member_id is null then
      raise exception using errcode = '23514', message = 'Class primary teacher is not a teacher in this tenant.';
    end if;
    insert into public.teaching_assignments(tenant_id, class_id, teacher_id, is_primary)
      values (new.tenant_id, new.id, member_id, true)
      on conflict (tenant_id, class_id, teacher_id) do update set status = 'active', is_primary = true;
  end if;
  return new;
end $$;
create trigger classes_mirror_primary_teacher after insert or update of teacher_id on public.classes
  for each row execute function public.mirror_class_primary_teacher();

create function public.protect_class_academic_mapping() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if (new.tenant_id, new.course_id, new.subject_id, new.academic_period_id) is not distinct from (old.tenant_id, old.course_id, old.subject_id, old.academic_period_id) then return new; end if;
  if exists (select 1 from public.enrollments where tenant_id = old.tenant_id and class_id = old.id)
    or exists (select 1 from public.activities where tenant_id = old.tenant_id and class_id = old.id) then
    if old.subject_id is null and old.academic_period_id is null
      and new.subject_id is not null and new.academic_period_id is not null
      and new.tenant_id = old.tenant_id and new.course_id = old.course_id then return new; end if;
    raise exception using errcode = '23514', message = 'Classes with academic records cannot change their academic mapping.';
  end if;
  return new;
end $$;
create trigger classes_protect_academic_mapping before update on public.classes
  for each row execute function public.protect_class_academic_mapping();

create function public.lock_activity_class() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  perform 1 from public.classes where tenant_id = new.tenant_id and id = new.class_id for share;
  return new;
end $$;
create trigger activities_lock_class before insert or update on public.activities
  for each row execute function public.lock_activity_class();

create function public.protect_academic_history_delete() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'activities' then
    if exists (select 1 from public.grades where tenant_id = old.tenant_id and activity_id = old.id) then
      raise exception using errcode = '23514', message = 'Activities with grades cannot be deleted; preserve academic history.';
    end if;
  elsif tg_table_name = 'classes' then
    if exists (select 1 from public.activities where tenant_id = old.tenant_id and class_id = old.id)
      or exists (select 1 from public.enrollments where tenant_id = old.tenant_id and class_id = old.id)
      or exists (select 1 from public.teaching_assignments where tenant_id = old.tenant_id and class_id = old.id) then
      raise exception using errcode = '23514', message = 'Classes with academic records cannot be deleted; archive them instead.';
    end if;
  elsif tg_table_name = 'courses' then
    if exists (select 1 from public.classes where tenant_id = old.tenant_id and course_id = old.id)
      or exists (select 1 from public.subjects where tenant_id = old.tenant_id and course_id = old.id) then
      raise exception using errcode = '23514', message = 'Courses with classes or subjects cannot be deleted; preserve academic history.';
    end if;
  else
    raise exception 'Unsupported academic history deletion target';
  end if;
  return old;
end $$;
create trigger activities_protect_history_delete before delete on public.activities
  for each row execute function public.protect_academic_history_delete();
create trigger classes_protect_history_delete before delete on public.classes
  for each row execute function public.protect_academic_history_delete();
create trigger courses_protect_history_delete before delete on public.courses
  for each row execute function public.protect_academic_history_delete();

create function public.require_grade_enrollment() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  perform 1 from public.activities a
    join public.app_users u on u.tenant_id = a.tenant_id and u.auth_user_id = new.student_id and u.role = 'student'
    join public.enrollments e on e.tenant_id = a.tenant_id and e.class_id = a.class_id and e.student_id = u.id
    where a.tenant_id = new.tenant_id and a.id = new.activity_id and e.status in ('active', 'completed')
    for share of a, u, e;
  if not found then
    raise exception using errcode = '23514', message = 'Grade requires an active or completed formal enrollment in the activity class.';
  end if;
  return new;
end $$;
create trigger grades_require_enrollment before insert or update on public.grades
  for each row execute function public.require_grade_enrollment();

create or replace function public.protect_linked_academic_role() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.role = new.role then return new; end if;
  if (new.role <> 'student' and (
    exists (select 1 from public.grades where tenant_id = old.tenant_id and student_id = old.auth_user_id)
    or exists (select 1 from public.enrollments where tenant_id = old.tenant_id and student_id = old.id)
  )) or (new.role <> 'teacher' and (
    exists (select 1 from public.classes where tenant_id = old.tenant_id and teacher_id = old.auth_user_id)
    or exists (select 1 from public.teaching_assignments where tenant_id = old.tenant_id and teacher_id = old.id)
  )) then
    raise exception using errcode = '23514', message = 'Role change would invalidate current or historical academic records.';
  end if;
  return new;
end $$;

alter table public.academic_periods enable row level security;
alter table public.subjects enable row level security;
alter table public.enrollments enable row level security;
alter table public.enrollment_status_history enable row level security;
alter table public.teaching_assignments enable row level security;
create policy "service role full access academic periods" on public.academic_periods for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "service role full access subjects" on public.subjects for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "service role full access enrollments" on public.enrollments for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "service role full access enrollment history" on public.enrollment_status_history for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "service role full access teaching assignments" on public.teaching_assignments for all
  using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

commit;
