begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.app_users, public.courses, public.classes, public.activities, public.grades
  in share row exclusive mode;

do $$
begin
  if exists (
    select 1 from public.grades
    group by tenant_id, activity_id, student_id having count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'Preflight: duplicate grades; review records manually before applying migration.';
  end if;
  if exists (
    select 1 from public.grades g
    left join public.app_users u on u.tenant_id = g.tenant_id and u.auth_user_id = g.student_id
    left join public.activities a on a.tenant_id = g.tenant_id and a.id = g.activity_id
    where u.id is null or u.role <> 'student' or a.id is null or g.grade < 0 or g.grade > 10
  ) then
    raise exception using errcode = '23514', message = 'Preflight: invalid grade membership, activity or range; review records manually.';
  end if;
  if exists (
    select 1 from public.classes c
    left join public.courses course on course.tenant_id = c.tenant_id and course.id = c.course_id
    left join public.app_users u on u.tenant_id = c.tenant_id and u.auth_user_id = c.teacher_id
    where course.id is null or (c.teacher_id is not null and (u.id is null or u.role <> 'teacher'))
  ) then
    raise exception using errcode = '23514', message = 'Preflight: invalid class course or teacher membership; review records manually.';
  end if;
  if exists (
    select 1 from public.activities a
    left join public.classes c on c.tenant_id = a.tenant_id and c.id = a.class_id
    where c.id is null
  ) then
    raise exception using errcode = '23514', message = 'Preflight: activity refers to a class outside its tenant.';
  end if;
end $$;

alter table public.courses add constraint courses_tenant_id_key unique (tenant_id, id);
alter table public.classes add constraint classes_tenant_id_key unique (tenant_id, id);
alter table public.activities add constraint activities_tenant_id_key unique (tenant_id, id);
alter table public.grades add constraint grades_tenant_activity_student_key unique (tenant_id, activity_id, student_id);
alter table public.grades add constraint grades_value_range check (grade is null or grade between 0 and 10);

alter table public.classes add constraint classes_tenant_course_fkey
  foreign key (tenant_id, course_id) references public.courses(tenant_id, id) on delete cascade;
alter table public.classes add constraint classes_tenant_teacher_fkey
  foreign key (tenant_id, teacher_id) references public.app_users(tenant_id, auth_user_id);
alter table public.activities add constraint activities_tenant_class_fkey
  foreign key (tenant_id, class_id) references public.classes(tenant_id, id) on delete cascade;
alter table public.grades add constraint grades_tenant_activity_fkey
  foreign key (tenant_id, activity_id) references public.activities(tenant_id, id) on delete cascade;
alter table public.grades add constraint grades_tenant_student_fkey
  foreign key (tenant_id, student_id) references public.app_users(tenant_id, auth_user_id);

create function public.validate_academic_member_role() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  member_id uuid;
  expected_role text;
begin
  if tg_table_name = 'grades' then
    member_id := new.student_id;
    expected_role := 'student';
  elsif tg_table_name = 'classes' then
    member_id := new.teacher_id;
    expected_role := 'teacher';
    if member_id is null then return new; end if;
  else
    raise exception 'Unsupported academic member validation target';
  end if;
  perform 1 from public.app_users
    where tenant_id = new.tenant_id and auth_user_id = member_id and role = expected_role
    for share;
  if not found then
    raise exception using errcode = '23514', message = 'Academic member has no authorized role in this tenant.';
  end if;
  return new;
end $$;

create trigger grades_validate_student before insert or update on public.grades
  for each row execute function public.validate_academic_member_role();
create trigger classes_validate_teacher before insert or update on public.classes
  for each row execute function public.validate_academic_member_role();

create function public.protect_linked_academic_role() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.role = new.role then return new; end if;
  if (new.role <> 'student' and exists (
    select 1 from public.grades where tenant_id = old.tenant_id and student_id = old.auth_user_id
  )) or (new.role <> 'teacher' and exists (
    select 1 from public.classes where tenant_id = old.tenant_id and teacher_id = old.auth_user_id
  )) then
    raise exception using errcode = '23514', message = 'Role change would invalidate existing academic records.';
  end if;
  return new;
end $$;

create trigger app_users_protect_academic_role before update of role on public.app_users
  for each row execute function public.protect_linked_academic_role();

commit;
