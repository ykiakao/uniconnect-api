alter table public.courses
  add column if not exists description text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.classes
  add column if not exists teacher_id uuid references auth.users(id),
  add column if not exists updated_at timestamptz not null default now();

alter table public.courses enable row level security;
alter table public.classes enable row level security;

drop policy if exists "service role full access courses" on public.courses;
drop policy if exists "service role full access classes" on public.classes;

create policy "service role full access courses"
  on public.courses for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access classes"
  on public.classes for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
