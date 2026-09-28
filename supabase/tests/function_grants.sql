-- Which functions in `public` a signed-in person can call. Rolls itself back.
--
--   psql "$DATABASE_URL" -f supabase/tests/function_grants.sql
--
-- This exists because the guard in 20260911101100_grants.sql does not work.
-- `alter default privileges in schema public revoke execute on functions from
-- public, anon` does not remove Postgres's built-in EXECUTE to PUBLIC, so every
-- function added to `public` is callable by anon through PostgREST at
-- /rest/v1/rpc/<name> unless it carries its own revoke. Two already had.
--
-- A default that silently fails is worse than no default, because the file says
-- it is handled. So the rule is enforced here instead: add a function to
-- `public` without revoking, and this fails.
--
-- If you are adding a genuinely member-callable RPC, add it to `intended` below
-- in the same commit. That edit is the review point: it is the moment somebody
-- decides a stranger with the publishable key may reach this code.

begin;

create temp table expected (name text primary key, anon_may boolean);
insert into expected (name, anon_may) values
  ('create_organization', false),
  ('accept_invitation',   false),
  ('join_with_code',      false),
  -- Admin-only, and it checks that itself rather than relying on this grant:
  -- the grant says "a signed-in browser may call it", the function decides
  -- whether this particular signed-in browser gets an answer.
  ('settle_period',       false),
  ('leave_office',        false),
  ('delete_office',       false),
  ('ensure_period',       false),
  -- The corrections screen. Each one repeats the admin check itself, which is
  -- what the grant does not say.
  ('correct_meal',          false),
  ('correct_meal_off_menu', false),
  ('remove_meal',           false),
  ('reprice_dish',          false),
  -- The settings screen. Same shape again: the grant says a signed-in browser
  -- may ask, and each one decides for itself whether this admin gets an answer.
  ('send_announcement',      false),
  ('send_test_notification', false),
  -- The Payments screen's three doors into money. Each checks for an admin or
  -- owner of the office and writes payment_corrections.
  ('move_payment',    false),
  ('void_payment',    false),
  ('waive_statement', false);

create temp table found as
select p.proname::text as name,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       p.prosecdef as secdef,
       pg_get_function_result(p.oid) = 'trigger' as is_trigger
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE'));

-- 1. Nothing reachable that is not on the list.
select case when count(*) = 0 then 'PASS: no unexpected callable functions'
            else 'FAIL: callable but not intended -> ' || string_agg(name, ', ')
       end as check_1_no_strays
  from found where name not in (select name from expected);

-- 2. Everything on the list is still reachable. A revoke that goes too far
--    breaks sign-up or joining, and does it silently until somebody tries.
select case when count(*) = 0 then 'PASS: every intended function is callable'
            else 'FAIL: intended but not callable -> ' || string_agg(name, ', ')
       end as check_2_no_missing
  from expected where name not in (select name from found where authed);

-- 3. anon reaches nothing. Every one of these needs a signed-in caller, and
--    anon holding EXECUTE means an unauthenticated browser can reach it.
select case when count(*) = 0 then 'PASS: anon can execute nothing'
            else 'FAIL: anon can execute -> ' || string_agg(f.name, ', ')
       end as check_3_anon_blocked
  from found f join expected e on e.name = f.name
 where f.anon and not e.anon_may;

select case when count(*) = 0 then 'PASS: anon can execute nothing unlisted'
            else 'FAIL: anon can execute unlisted -> ' || string_agg(name, ', ')
       end as check_4_anon_no_strays
  from found where anon and name not in (select name from expected);

-- 5. No trigger function is reachable by anybody.
--
--    These are the ones that drift, because adding one feels like adding
--    internals rather than adding an endpoint. Four had: stamp_join_code_set_at,
--    hold_period_open_while_unpriced, guard_owner_only_settings and
--    enforce_reopen_window. Checked by shape rather than by name, so the next
--    one is caught the day it is written.
select case when count(*) = 0 then 'PASS: no trigger function is granted'
            else 'FAIL: trigger function granted -> ' || string_agg(name, ', ')
       end as check_5_no_trigger_functions
  from found where is_trigger;

rollback;
