-- The default-privileges guard in 20260911101100_grants.sql is not in force.
--
-- That file ends with:
--   alter default privileges in schema public revoke execute on functions
--     from public, anon;
-- and the comment above it explains, correctly, that Postgres grants EXECUTE to
-- PUBLIC on every new function and that PostgREST serves `public` at
-- /rest/v1/rpc/<name>. The reasoning is right. The statement does not work.
--
-- Measured on this database, as postgres, with a default-ACL entry for postgres
-- on functions in public that contains no PUBLIC grant:
--
--   create function public.__probe() returns int language sql as $$ select 1 $$;
--   -- resulting acl: =X/postgres | postgres=X/postgres | authenticated=X/postgres
--                                                       | service_role=X/postgres
--
-- `=X` is PUBLIC. So anon and authenticated can both execute it. Adding
-- `authenticated` to the revoke removes that one entry and leaves `=X` behind,
-- which is the one that matters. There is no event trigger re-granting it; the
-- built-in default simply survives.
--
-- Two functions created after the grants migration inherited this:
--   enforce_menu_not_in_past()          executable by anon and authenticated
--   trg_menu_published_materialize()    same, and SECURITY DEFINER
--
-- Neither is exploitable today: both return `trigger`, so a direct call is
-- refused with 0A000, "trigger functions can only be called as triggers". That
-- is luck about their return type, not a control.
--
-- So: revoke these two explicitly, and stop trusting the default. Every function
-- added to `public` from now on must carry its own revoke, and
-- supabase/tests/function_grants.sql fails if one does not. A guard that is
-- checked is worth more than a guard that is merely declared.

revoke execute on function public.enforce_menu_not_in_past()
  from public, anon, authenticated;
revoke execute on function public.trg_menu_published_materialize()
  from public, anon, authenticated;

-- Restated rather than assumed. These three are the deliberate exceptions: the
-- only functions a signed-in person is meant to call directly.
grant execute on function public.create_organization(text, text, text, char, smallint, text)
  to authenticated;
grant execute on function public.accept_invitation(uuid) to authenticated;
grant execute on function public.join_with_code(text, text, bigint) to authenticated;
