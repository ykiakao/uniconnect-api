insert into public.tenants (name, slug, plan, status, active_users)
values ('Universidade Norte', 'universidade-norte', 'growth', 'trialing', 384)
on conflict (slug) do update set
  name = excluded.name,
  plan = excluded.plan,
  status = excluded.status,
  active_users = excluded.active_users;

-- Before running the inserts below, create these users in Supabase Auth:
-- aluno@uni.com / 123456
-- professor@uni.com / 123456
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
  'aluno@uni.com',
  'student',
  'Engenharia de Software',
  '2024021845',
  4
from public.tenants
join auth.users auth_users on auth_users.email = 'aluno@uni.com'
where tenants.slug = 'universidade-norte'
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
  'professor@uni.com',
  'teacher',
  'Engenharia de Software'
from public.tenants
join auth.users auth_users on auth_users.email = 'professor@uni.com'
where tenants.slug = 'universidade-norte'
on conflict (tenant_id, email) do update set
  auth_user_id = excluded.auth_user_id,
  name = excluded.name,
  role = excluded.role,
  course = excluded.course;
