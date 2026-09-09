insert into public.tenants (name, slug, plan, status, active_users)
values ('EduKMais', 'edukmais', 'growth', 'trialing', 384)
on conflict (slug) do update set
  name = excluded.name,
  plan = excluded.plan,
  status = excluded.status,
  active_users = excluded.active_users;

-- Before running the inserts below, create these users in Supabase Auth:
-- aluno@edukmais.edu.br / 123456
-- professor@edukmais.edu.br / 123456
-- coordenador@edukmais.edu.br / 123456
-- dono@edukmais.edu.br / 123456
--
-- Then replace the subqueries if needed, or keep them if the Auth users
-- already exist with the same e-mails.

insert into public.app_users (
  tenant_id,
  auth_user_id,
  name,
  email,
  role,
  course,
  registration,
  semester
)
select
  tenants.id,
  auth_users.id,
  'Lucas Oliveira',
  'aluno@edukmais.edu.br',
  'student',
  'Engenharia de Software',
  '2024021845',
  4
from public.tenants
join auth.users auth_users on auth_users.email = 'aluno@edukmais.edu.br'
where tenants.slug = 'edukmais'
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role,
  course = excluded.course,
  registration = excluded.registration,
  semester = excluded.semester;

insert into public.app_users (
  tenant_id,
  auth_user_id,
  name,
  email,
  role,
  course
)
select
  tenants.id,
  auth_users.id,
  'Marina Costa',
  'professor@edukmais.edu.br',
  'teacher',
  'Engenharia de Software'
from public.tenants
join auth.users auth_users on auth_users.email = 'professor@edukmais.edu.br'
where tenants.slug = 'edukmais'
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role,
  course = excluded.course;

insert into public.app_users (
  tenant_id,
  auth_user_id,
  name,
  email,
  role,
  course
)
select
  tenants.id,
  auth_users.id,
  'Patricia Almeida',
  'coordenador@edukmais.edu.br',
  'coordinator',
  'Engenharia de Software'
from public.tenants
join auth.users auth_users on auth_users.email = 'coordenador@edukmais.edu.br'
where tenants.slug = 'edukmais'
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role,
  course = excluded.course;

insert into public.app_users (
  tenant_id,
  auth_user_id,
  name,
  email,
  role
)
select
  tenants.id,
  auth_users.id,
  'Rafael Andrade',
  'dono@edukmais.edu.br',
  'owner'
from public.tenants
join auth.users auth_users on auth_users.email = 'dono@edukmais.edu.br'
where tenants.slug = 'edukmais'
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role;
