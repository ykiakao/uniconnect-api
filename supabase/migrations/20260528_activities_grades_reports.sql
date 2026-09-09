alter table public.activities
  add column if not exists due_date timestamptz,
  add column if not exists type text not null default 'assignment',
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'activities'
      and column_name = 'due_at'
  ) then
    execute 'update public.activities set due_date = due_at where due_date is null';
  end if;
end $$;

alter table public.grades
  add column if not exists activity_id uuid references public.activities(id) on delete cascade,
  add column if not exists grade numeric(5, 2),
  add column if not exists feedback text,
  add column if not exists graded_at timestamptz,
  add column if not exists graded_by uuid references auth.users(id);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'grades'
      and column_name = 'label'
  ) then
    execute 'alter table public.grades alter column label drop not null';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'grades'
      and column_name = 'value'
  ) then
    execute 'alter table public.grades alter column value drop not null';
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'grades'
      and column_name = 'value'
  ) then
    execute 'update public.grades set grade = value where grade is null';
  end if;
end $$;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select tc.constraint_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name = 'grades'
      and tc.constraint_type = 'FOREIGN KEY'
      and kcu.column_name = 'student_id'
  loop
    execute format('alter table public.grades drop constraint if exists %I', constraint_name);
  end loop;
end $$;

update public.grades grades
  set student_id = app_users.auth_user_id
  from public.app_users app_users
  where grades.student_id = app_users.id;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'grades'
      and constraint_name = 'grades_student_id_fkey'
  ) then
    alter table public.grades
      add constraint grades_student_id_fkey
      foreign key (student_id) references auth.users(id) on delete cascade;
  end if;
end $$;

alter table public.activities enable row level security;
alter table public.grades enable row level security;

drop policy if exists "service role full access activities" on public.activities;
drop policy if exists "service role full access grades" on public.grades;

create policy "service role full access activities"
  on public.activities for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access grades"
  on public.grades for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
