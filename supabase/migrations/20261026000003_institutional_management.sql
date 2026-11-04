begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

lock table public.app_users, public.invites, public.enrollments, public.teaching_assignments
  in share row exclusive mode;

alter table public.app_users
  add column active boolean not null default true,
  add column course_id uuid,
  add constraint app_users_tenant_course_fkey foreign key (tenant_id, course_id)
    references public.courses(tenant_id, id);
create index app_users_tenant_course_idx on public.app_users(tenant_id, course_id);

alter table public.invites
  add column recipient_email text,
  add column accepted_by uuid references auth.users(id);

create function public.accept_institution_invite(
  p_code text,
  p_auth_user_id uuid,
  p_email text,
  p_name text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  invitation public.invites%rowtype;
  issuer public.app_users%rowtype;
  membership public.app_users%rowtype;
  confirmed_email text;
  normalized_email text := lower(btrim(p_email));
  safe_name text := btrim(p_name);
  issuer_rank integer;
  invited_rank integer;
begin
  select * into invitation from public.invites
    where code = upper(btrim(p_code)) and used_at is null and expires_at > clock_timestamp()
    for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Invitation is invalid or expired.';
  end if;
  if invitation.recipient_email is null then
    raise exception using errcode = '42501', message = 'Invitation has no authorized recipient.';
  end if;
  if safe_name is null or safe_name = '' or char_length(safe_name) > 200
    or p_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '23514', message = 'A valid name with at most 200 characters is required.';
  end if;
  if normalized_email is null or normalized_email = ''
    or normalized_email <> lower(btrim(invitation.recipient_email)) then
    raise exception using errcode = '42501', message = 'Invitation recipient is not authorized.';
  end if;

  select lower(btrim(email)) into confirmed_email from auth.users
    where id = p_auth_user_id and email_confirmed_at is not null for share;
  if not found or confirmed_email is null or confirmed_email <> normalized_email then
    raise exception using errcode = '42501', message = 'A confirmed matching Auth identity is required.';
  end if;

  select * into issuer from public.app_users
    where tenant_id = invitation.tenant_id and auth_user_id = invitation.created_by and active
    for share;
  if not found then
    raise exception using errcode = '42501', message = 'Invitation issuer is not authorized.';
  end if;
  issuer_rank := case issuer.role when 'owner' then 3 when 'admin' then 2 when 'coordinator' then 1 else 0 end;
  invited_rank := case invitation.role when 'admin' then 2 when 'coordinator' then 1 when 'teacher' then 0 when 'student' then 0 else 3 end;
  if invited_rank >= issuer_rank then
    raise exception using errcode = '42501', message = 'Invitation exceeds the current issuer authority.';
  end if;

  if exists (select 1 from public.app_users where tenant_id = invitation.tenant_id
    and (auth_user_id = p_auth_user_id or lower(btrim(email)) = normalized_email)) then
    raise exception using errcode = '23505', message = 'Institutional membership already exists.';
  end if;
  if invitation.expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0002', message = 'Invitation is invalid or expired.';
  end if;
  insert into public.app_users(tenant_id, auth_user_id, name, email, role, active)
    values (invitation.tenant_id, p_auth_user_id, safe_name, normalized_email, invitation.role, true)
    returning * into membership;
  update public.invites set used_at = clock_timestamp(), accepted_by = p_auth_user_id where id = invitation.id;
  return jsonb_build_object(
    'id', membership.id, 'tenant_id', membership.tenant_id, 'auth_user_id', membership.auth_user_id,
    'name', membership.name, 'email', membership.email, 'role', membership.role,
    'active', membership.active, 'course_id', membership.course_id
  );
end $$;

revoke all on function public.accept_institution_invite(text, uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.accept_institution_invite(text, uuid, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.accept_institution_invite(text, uuid, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.accept_institution_invite(text, uuid, text, text) to service_role;
  end if;
end $$;

create function public.require_active_institutional_member() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  member_id uuid;
  expected_role text;
begin
  if new.status <> 'active' then return new; end if;
  if tg_table_name = 'enrollments' then
    if tg_op = 'UPDATE' and new.status = old.status and new.student_id = old.student_id then return new; end if;
    member_id := new.student_id;
    expected_role := 'student';
  elsif tg_table_name = 'teaching_assignments' then
    if tg_op = 'UPDATE' and new.status = old.status and new.teacher_id = old.teacher_id
      and new.is_primary is not distinct from old.is_primary then return new; end if;
    member_id := new.teacher_id;
    expected_role := 'teacher';
  else
    raise exception 'Unsupported institutional member target';
  end if;
  perform 1 from public.app_users where tenant_id = new.tenant_id and id = member_id
    and role = expected_role and active for share;
  if not found then
    raise exception using errcode = '23514', message = 'New active academic participation requires an active institutional member.';
  end if;
  return new;
end $$;
create trigger enrollments_require_active_member before insert or update on public.enrollments
  for each row execute function public.require_active_institutional_member();
create trigger teaching_assignments_require_active_member before insert or update on public.teaching_assignments
  for each row execute function public.require_active_institutional_member();

commit;
