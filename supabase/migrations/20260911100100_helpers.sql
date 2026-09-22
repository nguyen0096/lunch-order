-- Extensions, the private schema, and the helpers every later migration leans on.

create extension if not exists moddatetime with schema extensions;
create extension if not exists btree_gist  with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- "Today" is per-org: the database session runs in UTC, so current_date is wrong
-- for seven hours a day in ICT and meaningless for a customer in another zone.
-- Never use current_date in this codebase.
create or replace function private.today_in(p_tz text) returns date
language sql stable set search_path = '' as $$
  select (pg_catalog.now() at time zone p_tz)::date;
$$;

-- Local wall-clock time for an org, used by the hourly cron jobs to decide
-- which orgs have just crossed a threshold.
create or replace function private.local_now(p_tz text) returns timestamp
language sql stable set search_path = '' as $$
  select pg_catalog.now() at time zone p_tz;
$$;

-- True for the owner, service_role, and pg_cron background jobs. Used by
-- business-rule triggers to exempt machinery from user-facing restrictions.
create or replace function private.is_service() returns boolean
language sql stable set search_path = '' as $$
  select current_user::text in ('postgres','service_role','supabase_admin');
$$;

-- NOTE: EXECUTE is granted to authenticated deliberately. RLS policy expressions
-- are evaluated in the caller's permission context, so a policy calling a helper
-- the caller cannot execute fails with "permission denied for function". These
-- are all zero-argument and self-referential, so they leak nothing.
grant execute on function
  private.today_in(text), private.local_now(text), private.is_service()
to authenticated;
