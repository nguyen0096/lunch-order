-- Founding an office is a switch, and the database holds it.
--
-- The app is going into one company first, so anybody signing in should be able
-- to join an office and not to found one. Hiding the button would not be that:
-- `create_organization` is granted to `authenticated` and anonymous sign-in is
-- on, so anybody at all could still call it over PostgREST and appear in the
-- project as the owner of an office nobody asked for.
--
-- A row rather than a build-time constant, so it can be flipped without a
-- deploy and read by the app in the same breath as everything else it loads.
-- Nobody can flip it from a browser: `select` is the only grant and there is no
-- write policy, so it takes the service role, which means the dashboard or a
-- migration.
--
--   update public.app_settings set enabled = true where key = 'office_creation';
--
-- Keyed rather than a boolean column per feature: the next switch is a row, not
-- a migration to this table's shape.

create table public.app_settings (
  key        text primary key,
  enabled    boolean not null,
  -- Why it is the way it is, for whoever finds the switch later and has no idea
  -- whether flipping it is safe.
  note       text,
  updated_at timestamptz not null default now()
);

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function moddatetime('updated_at');

insert into public.app_settings (key, enabled, note) values
  ('office_creation', false,
   'Off while the app is used inside one company. On means anybody who can sign in can found an office.');

alter table public.app_settings enable row level security;

-- Supabase grants ALL on a new public table to anon and authenticated, and the
-- blanket revoke in 20260911101100_grants.sql ran long before this table
-- existed, so this is load-bearing rather than tidying.
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to anon, authenticated;

-- Readable by everybody, `anon` included: the screen that offers to found an
-- office is the one somebody sees before they belong anywhere. There is nothing
-- private here, the value is a fact about the product rather than about a
-- person.
create policy app_settings_select on public.app_settings
  for select to anon, authenticated using (true);

comment on table public.app_settings is
  'Switches the whole deployment reads. Flipped by the service role only.';

-- The switch, where it actually bites. Reprinted in full rather than patched:
-- the body is six statements and a reader should see what it now is.
--
-- Defaults to allowed when the row is missing, so a database without this table
-- populated behaves as it did before rather than locking everybody out of a
-- product they just installed.
create or replace function public.create_organization(
  p_slug text, p_name text,
  p_timezone text default 'Asia/Ho_Chi_Minh',
  p_currency character default 'VND',
  p_currency_minor_units smallint default 0,
  p_locale text default 'vi-VN')
returns public.organizations
language plpgsql
security definer
set search_path to ''
as $function$
declare v_org public.organizations; v_uid uuid := (select auth.uid());
begin
  if not coalesce((select s.enabled from public.app_settings s
                    where s.key = 'office_creation'), true) then
    raise exception 'founding an office is turned off here; ask a colleague for a join code'
      using errcode = 'insufficient_privilege';
  end if;
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.organizations (slug, name, timezone, currency, currency_minor_units, locale)
  values (lower(btrim(p_slug)), btrim(p_name), p_timezone, p_currency,
          p_currency_minor_units, p_locale)
  returning * into v_org;
  insert into public.memberships (org_id, profile_id, role, short_code)
  values (v_org.id, v_uid, 'owner', private.suggest_short_code(v_org.id, v_uid));
  return v_org;
end $function$;
