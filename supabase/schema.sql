create extension if not exists "pgcrypto";

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'starter'
    check (plan in ('starter', 'growth', 'enterprise')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due')),
  active_users integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('student', 'teacher', 'admin', 'coordinator', 'owner')),
  course text,
  registration text,
  semester integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id),
  unique (tenant_id, email)
);

alter table public.app_users
  drop constraint if exists app_users_role_check;

alter table public.app_users
  add constraint app_users_role_check
  check (role in ('student', 'teacher', 'admin', 'coordinator', 'owner'));

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  course_id uuid references public.courses(id) on delete set null,
  name text not null,
  semester integer,
  created_at timestamptz not null default now()
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  title text not null,
  description text,
  due_at timestamptz,
  priority text not null default 'normal'
    check (priority in ('normal', 'important', 'critical')),
  created_at timestamptz not null default now()
);

create table if not exists public.grades (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.app_users(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  label text not null,
  value numeric(4, 2) not null,
  weight numeric(4, 2) not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sender_id uuid not null references public.app_users(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.tenants enable row level security;
alter table public.app_users enable row level security;
alter table public.courses enable row level security;
alter table public.classes enable row level security;
alter table public.activities enable row level security;
alter table public.grades enable row level security;
alter table public.messages enable row level security;

drop policy if exists "service role full access tenants" on public.tenants;
drop policy if exists "service role full access app users" on public.app_users;
drop policy if exists "service role full access courses" on public.courses;
drop policy if exists "service role full access classes" on public.classes;
drop policy if exists "service role full access activities" on public.activities;
drop policy if exists "service role full access grades" on public.grades;
drop policy if exists "service role full access messages" on public.messages;

create policy "service role full access tenants"
  on public.tenants for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access app users"
  on public.app_users for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access courses"
  on public.courses for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access classes"
  on public.classes for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access activities"
  on public.activities for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access grades"
  on public.grades for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access messages"
  on public.messages for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');