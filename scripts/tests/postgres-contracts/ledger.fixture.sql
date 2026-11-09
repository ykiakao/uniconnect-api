-- SYNTHETIC LOCAL LAB ONLY. Not a migration, not installed or validated against PostgreSQL.
-- Requires separate authorization, a new owned cluster, qualified local session and global lock.
begin;
do $lab$
begin
  if current_database() !~ '^pgc_[a-f0-9]{32}$'
     or current_setting('server_version_num')::integer <> 170011
     or current_setting('uniconnect.pgc_fixture',true) is distinct from 'authorized-local-only-v1' then
    raise exception 'PGC_DISPOSABLE_PRECONDITION_FAILED';
  end if;
  if not exists (select 1 from pg_catalog.pg_locks where pid=pg_catalog.pg_backend_pid()
      and locktype='advisory' and mode='ExclusiveLock' and granted and classid=1431193923::oid and objid=1345336576::oid
      and objsubid=2 and database=(select oid from pg_catalog.pg_database where datname=current_database())) then
    raise exception 'PGC_LOCK_REQUIRED';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname in
      ('pgc_owner','pgc_executor','pgc_reviewer','pgc_api','pgc_reader')) then
    raise exception 'PGC_FRESH_CLUSTER_REQUIRED';
  end if;
end
$lab$;

-- NOLOGIN deliberately: password/login provisioning is a separate unreleased local procedure.
create role pgc_owner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role pgc_executor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role pgc_reviewer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role pgc_api nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role pgc_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create schema uniconnect_migration_control authorization pgc_owner;
create schema pgc_academic_fixture authorization pgc_owner;
revoke all on schema uniconnect_migration_control from public,pgc_api,pgc_reader;
revoke all on schema pgc_academic_fixture from public,pgc_api,pgc_executor,pgc_reviewer;
set local role pgc_owner;
alter default privileges in schema uniconnect_migration_control revoke all on tables from public;
alter default privileges in schema uniconnect_migration_control revoke execute on functions from public;

create table uniconnect_migration_control.migration_catalog (
  scope_id text not null check (scope_id=current_database()),
  migration_id text not null check (migration_id ~ '^[a-z0-9][a-z0-9_./-]{0,159}$' and position('..' in migration_id)=0),
  ordinal integer not null check (ordinal between 1 and 11),
  raw_hash text not null check (raw_hash ~ '^[a-f0-9]{64}$'),
  normalized_hash text not null check (normalized_hash ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz not null default clock_timestamp(),
  primary key(scope_id,migration_id), unique(scope_id,ordinal),
  unique(scope_id,migration_id,raw_hash,normalized_hash)
);
-- A run fence is independent of attempt APPLIED. Normal execution cannot close it.
create table uniconnect_migration_control.migration_runs (
  scope_id text not null check(scope_id=current_database()), run_ref text not null,
  session_nonce uuid not null unique, package_digest text not null check(package_digest ~ '^[a-f0-9]{64}$'),
  session_pid integer not null default pg_backend_pid(),
  backend_start timestamptz not null, server_start timestamptz not null default pg_postmaster_start_time(),
  database_oid oid not null, executor_login name not null default session_user, executor_role name not null default current_user,
  state text not null default 'RUNNING' check(state in ('RUNNING','UNKNOWN','RECONCILED')),
  started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
  resolution_ref text, receipt_ref text, state_history jsonb not null default '[]'::jsonb,
  blocks_scope boolean not null default true,
  primary key(scope_id,run_ref), unique(scope_id,run_ref,session_nonce,package_digest),
  check ((state='RECONCILED')=(finished_at is not null)),
  check (state<>'RECONCILED' or (resolution_ref is not null and receipt_ref is not null))
);
create unique index pgc_one_fenced_run on uniconnect_migration_control.migration_runs(scope_id) where blocks_scope;
create table uniconnect_migration_control.migration_attempts (
  attempt_id uuid primary key,
  scope_id text not null check (scope_id=current_database()), migration_id text not null,
  raw_hash text not null, normalized_hash text not null,
  attempt_no integer not null check (attempt_no>0), run_ref text not null, session_nonce uuid not null,
  package_digest text not null check (package_digest ~ '^[a-f0-9]{64}$'),
  executor_role name not null default current_user,
  state text not null default 'RUNNING' check(state in ('RUNNING','APPLIED','FAILED','UNKNOWN')),
  commit_outcome text not null default 'UNKNOWN' check(commit_outcome in ('UNKNOWN','NOT_DISPATCHED','NOT_COMMITTED','COMMITTED')),
  postcheck text not null default 'NOT_RUN' check(postcheck in ('NOT_RUN','PASS','FAIL','UNKNOWN')),
  failure_kind text check (failure_kind in ('KNOWN_FAILURE','POSTCHECK_FAILED','OUTCOME_UNPROVEN','SESSION_LOST','LEDGER_ACK_LOST')),
  started_at timestamptz not null default clock_timestamp(), finished_at timestamptz, commit_ack_at timestamptz,
  receipt_ref text, reconciliation_receipt_ref text, resolution_ref text, retry_authorization_ref text, consumed_authorization_ref text,
  state_history jsonb not null default '[]'::jsonb,
  blocks_scope boolean not null default true,
  foreign key(scope_id,migration_id,raw_hash,normalized_hash)
    references uniconnect_migration_control.migration_catalog(scope_id,migration_id,raw_hash,normalized_hash),
  foreign key(scope_id,run_ref,session_nonce,package_digest)
    references uniconnect_migration_control.migration_runs(scope_id,run_ref,session_nonce,package_digest),
  unique(scope_id,migration_id,attempt_no),
  check (state <> 'APPLIED' or (commit_outcome='COMMITTED' and postcheck='PASS' and commit_ack_at is not null and coalesce(receipt_ref,reconciliation_receipt_ref) is not null and failure_kind is null)),
  check (state <> 'FAILED' or (commit_outcome <> 'UNKNOWN' and coalesce(receipt_ref,reconciliation_receipt_ref) is not null and failure_kind is not null)),
  check ((state in ('APPLIED','FAILED')) = (finished_at is not null)),
  check (commit_outcome <> 'COMMITTED' or commit_ack_at is not null)
);
create unique index pgc_one_applied on uniconnect_migration_control.migration_attempts(scope_id,migration_id) where state='APPLIED';
create unique index pgc_one_blocker on uniconnect_migration_control.migration_attempts(scope_id) where blocks_scope;
create unique index pgc_retry_issued_once on uniconnect_migration_control.migration_attempts(retry_authorization_ref) where retry_authorization_ref is not null;
create unique index pgc_retry_consumed_once on uniconnect_migration_control.migration_attempts(consumed_authorization_ref) where consumed_authorization_ref is not null;

-- PID alone is insufficient: compare server-derived backend/server starts, database and login/role.
create function uniconnect_migration_control.owns_run(s text,r text) returns boolean
language sql stable security invoker set search_path=pg_catalog as $session$
  select coalesce((select x.session_pid=pg_backend_pid() and x.server_start=pg_postmaster_start_time()
    and x.backend_start=(select backend_start from pg_catalog.pg_stat_activity where pid=pg_backend_pid())
    and x.database_oid=(select oid from pg_catalog.pg_database where datname=current_database())
    and x.executor_login=session_user and x.executor_role=current_user
    from uniconnect_migration_control.migration_runs x where x.scope_id=s and x.run_ref=r),false)
$session$;

create function uniconnect_migration_control.guard_run() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $run$
begin
  -- pg_locks cannot itself prove SESSION versus XACT duration. Driver protocol + real tests required.
  if not exists (select 1 from pg_catalog.pg_locks where pid=pg_backend_pid() and locktype='advisory'
    and mode='ExclusiveLock' and granted and classid=1431193923::oid and objid=1345336576::oid and objsubid=2
    and database=(select oid from pg_catalog.pg_database where datname=current_database())) then raise exception 'PGC_LOCK_REQUIRED'; end if;
  if TG_OP='DELETE' then raise exception 'PGC_RUN_HISTORY_IMMUTABLE'; end if;
  if TG_OP='INSERT' then
    if NEW.state<>'RUNNING' or NEW.resolution_ref is not null or NEW.receipt_ref is not null
      or NEW.finished_at is not null or NEW.state_history<>'[]'::jsonb then raise exception 'PGC_RUN_ADMISSION_REQUIRED'; end if;
    NEW.session_pid:=pg_backend_pid(); NEW.server_start:=pg_postmaster_start_time();
    NEW.backend_start:=(select backend_start from pg_catalog.pg_stat_activity where pid=pg_backend_pid());
    NEW.database_oid:=(select oid from pg_catalog.pg_database where datname=current_database());
    NEW.executor_login:=session_user; NEW.executor_role:=current_user; NEW.started_at:=clock_timestamp();
  else
    if OLD.state='RECONCILED' or row(NEW.scope_id,NEW.run_ref,NEW.session_nonce,NEW.package_digest,NEW.session_pid,
      NEW.backend_start,NEW.server_start,NEW.database_oid,NEW.executor_login,NEW.executor_role,NEW.started_at,NEW.state_history)
      is distinct from row(OLD.scope_id,OLD.run_ref,OLD.session_nonce,OLD.package_digest,OLD.session_pid,
      OLD.backend_start,OLD.server_start,OLD.database_oid,OLD.executor_login,OLD.executor_role,OLD.started_at,OLD.state_history)
      then raise exception 'PGC_RUN_IDENTITY_IMMUTABLE'; end if;
    if current_user='pgc_reviewer' then
      if NEW.resolution_ref is null or NEW.receipt_ref is null or NEW.state not in ('UNKNOWN','RECONCILED')
        then raise exception 'PGC_RUN_REVIEW_REQUIRED'; end if;
      if NEW.state='RECONCILED' and exists(select 1 from uniconnect_migration_control.migration_attempts a
        where a.scope_id=OLD.scope_id and a.run_ref=OLD.run_ref and a.blocks_scope)
        then raise exception 'PGC_UNRESOLVED_ATTEMPTS'; end if;
    elsif not uniconnect_migration_control.owns_run(OLD.scope_id,OLD.run_ref) or OLD.state<>'RUNNING'
      or NEW.state<>'UNKNOWN' or NEW.resolution_ref is distinct from OLD.resolution_ref
      or NEW.receipt_ref is distinct from OLD.receipt_ref then raise exception 'PGC_RUN_REVIEW_REQUIRED'; end if;
    NEW.state_history:=OLD.state_history || jsonb_build_array(jsonb_build_object('from',OLD.state,'to',NEW.state,
      'review',NEW.resolution_ref,'receipt',NEW.receipt_ref,'at',clock_timestamp()));
  end if;
  NEW.blocks_scope:=NEW.state<>'RECONCILED';
  NEW.finished_at:=case when NEW.state='RECONCILED' then clock_timestamp() else null end;
  return NEW;
end
$run$;
create trigger pgc_run_guard before insert or update or delete on uniconnect_migration_control.migration_runs
  for each row execute function uniconnect_migration_control.guard_run();

create function uniconnect_migration_control.guard_ledger() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $guard$
declare previous_attempt record; bound_run record; reviewing boolean;
begin
  if not exists (select 1 from pg_catalog.pg_locks where pid=pg_backend_pid() and locktype='advisory'
      and mode='ExclusiveLock' and granted and classid=1431193923::oid and objid=1345336576::oid and objsubid=2
      and database=(select oid from pg_catalog.pg_database where datname=current_database())) then
    raise exception 'PGC_LOCK_REQUIRED';
  end if;
  if TG_OP='DELETE' then raise exception 'PGC_HISTORY_IMMUTABLE'; end if;
  if TG_TABLE_NAME='migration_catalog' then
    if TG_OP <> 'INSERT' then raise exception 'PGC_CATALOG_IMMUTABLE'; end if;
    return NEW;
  end if;
  if TG_OP='INSERT' then
    select * into bound_run from uniconnect_migration_control.migration_runs
      where scope_id=NEW.scope_id and run_ref=NEW.run_ref;
    if not FOUND or bound_run.state<>'RUNNING' or not uniconnect_migration_control.owns_run(NEW.scope_id,NEW.run_ref)
      then raise exception 'PGC_RUN_OWNER_REQUIRED'; end if;
    if NEW.state <> 'RUNNING' or NEW.commit_outcome <> 'UNKNOWN' or NEW.finished_at is not null
       or NEW.receipt_ref is not null or NEW.resolution_ref is not null or NEW.state_history <> '[]'::jsonb
       or NEW.postcheck <> 'NOT_RUN' or NEW.commit_ack_at is not null or NEW.retry_authorization_ref is not null
       or NEW.reconciliation_receipt_ref is not null
       or NEW.failure_kind is not null
       or NEW.executor_role <> current_user then raise exception 'PGC_ADMISSION_REQUIRED'; end if;
    select * into previous_attempt from uniconnect_migration_control.migration_attempts
      where scope_id=NEW.scope_id and migration_id=NEW.migration_id order by attempt_no desc limit 1;
    if FOUND then
      if previous_attempt.state <> 'FAILED' or previous_attempt.commit_outcome not in ('NOT_DISPATCHED','NOT_COMMITTED')
         or previous_attempt.resolution_ref is null or previous_attempt.retry_authorization_ref is null
         or NEW.attempt_no <> previous_attempt.attempt_no+1
         or NEW.package_digest <> previous_attempt.package_digest then raise exception 'PGC_RETRY_BLOCKED'; end if;
      -- Transfer the already reviewed reference, never accept a generic client approval.
      if NEW.consumed_authorization_ref is distinct from previous_attempt.retry_authorization_ref then
        raise exception 'PGC_RETRY_REFERENCE_REQUIRED';
      end if;
    elsif NEW.attempt_no <> 1 or NEW.consumed_authorization_ref is not null then raise exception 'PGC_ATTEMPT_ORDER';
    end if;
    if (select count(*) from uniconnect_migration_control.migration_catalog where scope_id=NEW.scope_id) <> 11 then
      raise exception 'PGC_COMPLETE_CATALOG_REQUIRED';
    end if;
    if exists (select 1 from uniconnect_migration_control.migration_catalog c
        where c.scope_id=NEW.scope_id and c.ordinal < (select x.ordinal
          from uniconnect_migration_control.migration_catalog x where x.scope_id=NEW.scope_id and x.migration_id=NEW.migration_id)
        and not exists (select 1 from uniconnect_migration_control.migration_attempts a
          where a.scope_id=c.scope_id and a.migration_id=c.migration_id and a.state='APPLIED')) then
      raise exception 'PGC_SOURCE_ORDER';
    end if;
  else
    select * into bound_run from uniconnect_migration_control.migration_runs where scope_id=OLD.scope_id and run_ref=OLD.run_ref;
    if bound_run.state='RECONCILED' then raise exception 'PGC_RUN_CLOSED'; end if;
    reviewing:=current_user='pgc_reviewer' and NEW.resolution_ref is not null and NEW.reconciliation_receipt_ref is not null;
    if not reviewing and (OLD.state<>'RUNNING' or bound_run.state<>'RUNNING'
      or not uniconnect_migration_control.owns_run(OLD.scope_id,OLD.run_ref)) then raise exception 'PGC_ORIGINAL_SESSION_REQUIRED'; end if;
    if row(NEW.attempt_id,NEW.scope_id,NEW.migration_id,NEW.raw_hash,NEW.normalized_hash,NEW.attempt_no,
      NEW.run_ref,NEW.package_digest,NEW.executor_role,NEW.started_at,NEW.consumed_authorization_ref,NEW.session_nonce) is distinct from
      row(OLD.attempt_id,OLD.scope_id,OLD.migration_id,OLD.raw_hash,OLD.normalized_hash,OLD.attempt_no,
      OLD.run_ref,OLD.package_digest,OLD.executor_role,OLD.started_at,OLD.consumed_authorization_ref,OLD.session_nonce) then raise exception 'PGC_IDENTITY_IMMUTABLE'; end if;
    if NEW.state_history is distinct from OLD.state_history then raise exception 'PGC_HISTORY_IMMUTABLE'; end if;
    if (NEW.resolution_ref is distinct from OLD.resolution_ref or
        NEW.reconciliation_receipt_ref is distinct from OLD.reconciliation_receipt_ref) and
       (not reviewing or OLD.state not in ('RUNNING','FAILED','UNKNOWN')) then raise exception 'PGC_REVIEW_REQUIRED'; end if;
    if OLD.state='APPLIED' then raise exception 'PGC_APPLIED_IMMUTABLE'; end if;
    if OLD.commit_outcome='COMMITTED' and (NEW.commit_outcome <> 'COMMITTED' or
      NEW.commit_ack_at is distinct from OLD.commit_ack_at) then raise exception 'PGC_COMMIT_PROOF_IMMUTABLE'; end if;
    if OLD.state='FAILED' and NEW.finished_at is distinct from OLD.finished_at then raise exception 'PGC_FINISH_IMMUTABLE'; end if;
    if OLD.state in ('UNKNOWN','FAILED') or reviewing then
      if not reviewing then raise exception 'PGC_REVIEW_REQUIRED'; end if;
      if NEW.state='RUNNING' then raise exception 'PGC_NO_REENTRY'; end if;
      if OLD.state='UNKNOWN' and NEW.state='RUNNING' then raise exception 'PGC_NO_REENTRY'; end if;
      if OLD.state='FAILED' and NEW.state <> 'FAILED' then raise exception 'PGC_NEW_ATTEMPT_REQUIRED'; end if;
      if NEW.receipt_ref is distinct from OLD.receipt_ref then raise exception 'PGC_ORIGINAL_RECEIPT_IMMUTABLE'; end if;
    elsif NEW.state='RUNNING' then raise exception 'PGC_TERMINAL_RESULT_REQUIRED';
    end if;
    if NEW.retry_authorization_ref is distinct from OLD.retry_authorization_ref and
       (current_user <> 'pgc_reviewer' or OLD.state <> 'FAILED' or
        OLD.commit_outcome not in ('NOT_DISPATCHED','NOT_COMMITTED') or OLD.retry_authorization_ref is not null)
       then raise exception 'PGC_RETRY_REVIEW_REQUIRED'; end if;
    NEW.state_history := OLD.state_history || jsonb_build_array(jsonb_build_object(
      'from',OLD.state,'to',NEW.state,'prior_outcome',OLD.commit_outcome,'prior_failure',OLD.failure_kind,
      'prior_reconciliation_receipt',OLD.reconciliation_receipt_ref,'receipt',NEW.reconciliation_receipt_ref,
      'review',NEW.resolution_ref,'at',clock_timestamp()));
  end if;
  NEW.blocks_scope := NEW.state in ('RUNNING','UNKNOWN') or (NEW.state='FAILED' and NEW.resolution_ref is null);
  return NEW;
end
$guard$;
create trigger pgc_catalog_guard before insert or update or delete on uniconnect_migration_control.migration_catalog
  for each row execute function uniconnect_migration_control.guard_ledger();
create trigger pgc_attempt_guard before insert or update or delete on uniconnect_migration_control.migration_attempts
  for each row execute function uniconnect_migration_control.guard_ledger();

revoke all on all tables in schema uniconnect_migration_control from public,pgc_api,pgc_reader;
revoke all on all functions in schema uniconnect_migration_control from public,pgc_api,pgc_reader;
grant usage on schema uniconnect_migration_control to pgc_executor,pgc_reviewer;
grant select on uniconnect_migration_control.migration_runs to pgc_executor,pgc_reviewer;
grant insert on uniconnect_migration_control.migration_runs to pgc_executor;
grant update(state) on uniconnect_migration_control.migration_runs to pgc_executor;
grant update(state,resolution_ref,receipt_ref) on uniconnect_migration_control.migration_runs to pgc_reviewer;
grant select on uniconnect_migration_control.migration_catalog to pgc_executor,pgc_reviewer;
grant select,insert on uniconnect_migration_control.migration_attempts to pgc_executor;
grant select on uniconnect_migration_control.migration_attempts to pgc_reviewer;
grant update(state,commit_outcome,postcheck,receipt_ref,finished_at,commit_ack_at,failure_kind)
  on uniconnect_migration_control.migration_attempts to pgc_executor;
grant update(state,commit_outcome,postcheck,resolution_ref,reconciliation_receipt_ref,retry_authorization_ref,finished_at,commit_ack_at,failure_kind)
  on uniconnect_migration_control.migration_attempts to pgc_reviewer;
grant execute on function uniconnect_migration_control.guard_ledger() to pgc_executor,pgc_reviewer;
grant execute on function uniconnect_migration_control.guard_run() to pgc_executor,pgc_reviewer;
grant execute on function uniconnect_migration_control.owns_run(text,text) to pgc_executor,pgc_reviewer;

-- Standalone synthetic RLS/concurrency probe, not UniConnect authorization or Auth data.
create table pgc_academic_fixture.probe (id integer primary key, tenant_id uuid not null, marker integer not null);
insert into pgc_academic_fixture.probe values
  (1,'11111111-1111-4111-8111-111111111111',0),(2,'22222222-2222-4222-8222-222222222222',0);
alter table pgc_academic_fixture.probe enable row level security;
create policy pgc_reader_tenant on pgc_academic_fixture.probe for select to pgc_reader
  using (tenant_id::text=current_setting('pgc.fixture_tenant',true));
grant usage on schema pgc_academic_fixture to pgc_reader;
grant select on pgc_academic_fixture.probe to pgc_reader;
reset role;
commit;
