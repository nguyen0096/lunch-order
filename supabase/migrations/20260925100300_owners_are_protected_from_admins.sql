-- An admin could promote a peer to owner, demote the owner, or delete them.
--
-- enforce_membership_role() guards one thing: your own row.
--
--   if new.role is distinct from old.role and new.profile_id = (select auth.uid())
--
-- memberships_admin_all is `for all`, and the column grant includes `role`, so
-- everything about somebody else's row was open to any admin. Reproduced live,
-- acting as a plain admin with the positive controls asserted:
--
--   update memberships set role='owner'  where profile_id=<peer admin>  -> succeeded
--   update memberships set role='member' where profile_id=<owner>       -> succeeded
--   delete from memberships              where profile_id=<owner>       -> 1 row
--   update memberships set role='owner'  where profile_id=<self>        -> 42501
--
-- So one admin cannot promote themselves, but two admins promote each other in
-- two statements, and either can simply delete the owner. The self-guard reads
-- like a privilege boundary and is actually a speed bump.
--
-- The rule now: ownership is the one thing only an owner can hand out or take
-- away. Admins keep everything else, including managing each other, because an
-- office where only the owner can appoint an admin is an office where nothing
-- happens while they are on holiday.
--
-- DELETE needs its own trigger. The old one was BEFORE UPDATE only, so removing
-- the owner outright was never considered.

create or replace function private.my_owner_org_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
   where m.profile_id = (select auth.uid()) and m.status = 'active'
     and m.role = 'owner';
$$;

-- Same reasoning as my_org_ids: zero-argument and stable, so the planner folds
-- it to an InitPlan evaluated once per statement rather than once per row.
grant execute on function private.my_owner_org_ids() to authenticated;
revoke execute on function private.my_owner_org_ids() from public, anon;

create or replace function public.enforce_membership_role() returns trigger
language plpgsql set search_path = '' as $$
declare v_is_owner boolean;
begin
  if private.is_service() then return new; end if;

  -- Unchanged: privilege escalation would otherwise be a single PATCH away.
  if new.role is distinct from old.role and new.profile_id = (select auth.uid()) then
    raise exception 'you cannot change your own role'
      using errcode = 'insufficient_privilege';
  end if;

  v_is_owner := old.org_id = any ((select private.my_owner_org_ids())::bigint[]);

  -- Touching an owner's role, in either direction, is an owner's business.
  if (old.role = 'owner' or new.role = 'owner')
     and new.role is distinct from old.role
     and not v_is_owner then
    raise exception 'only an owner can appoint or stand down another owner'
      using errcode = 'insufficient_privilege';
  end if;

  -- Deactivating an owner is demotion by another name: my_org_ids filters on
  -- status, so an inactive owner has no access at all.
  if old.role = 'owner'
     and new.status is distinct from old.status
     and not v_is_owner then
    raise exception 'only an owner can deactivate an owner'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

create or replace function public.enforce_membership_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.is_service() then return old; end if;
  if old.role = 'owner'
     and not (old.org_id = any ((select private.my_owner_org_ids())::bigint[])) then
    raise exception 'only an owner can remove an owner'
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end $$;

revoke execute on function public.enforce_membership_delete() from public, anon, authenticated;

create trigger memberships_delete_guard before delete on public.memberships
  for each row execute function public.enforce_membership_delete();
