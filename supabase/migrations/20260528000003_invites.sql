create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null unique,
  role text not null check (role in ('student', 'teacher', 'coordinator', 'admin')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;

drop policy if exists "service role full access invites" on public.invites;

create policy "service role full access invites"
  on public.invites for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
