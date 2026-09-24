-- Trigger functions in `public` were reachable by `anon`.
--
-- `supabase/tests/function_grants.sql` already states the rule and explains
-- why: `alter default privileges ... revoke execute on functions from public,
-- anon` does NOT remove Postgres's built-in EXECUTE to PUBLIC, so every
-- function added to `public` is granted to everybody unless it carries its own
-- revoke. The test enforces it with an allowlist.
--
-- Four had drifted past it: stamp_join_code_set_at,
-- hold_period_open_while_unpriced, guard_owner_only_settings, and
-- enforce_reopen_window, which this branch added yesterday. Nobody noticed
-- because that test needs psql and CI has none, so it has never run in CI.
--
-- Nothing was exploitable. PostgREST does not expose a function returning
-- `trigger`, and calling one outside a trigger raises anyway. But the rule is
-- worth keeping true rather than nearly true: the reason it exists is that
-- the next function added to `public` might return something else, and an
-- allowlist that already has four unexplained entries is one nobody trusts
-- enough to read.
--
-- So: revoke from the whole class, by shape rather than by name, and keep
-- revoking as functions are added.

do $$
declare v_fn record; v_n int := 0;
begin
  for v_fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and pg_get_function_result(p.oid) = 'trigger'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn.sig);
    v_n := v_n + 1;
  end loop;
  raise notice 'revoked execute on % trigger functions in public', v_n;
end $$;

-- An event trigger would keep this true without anybody remembering, but event
-- triggers need superuser and this project does not have one. The test is the
-- enforcement; this is the fix it was written to catch.
