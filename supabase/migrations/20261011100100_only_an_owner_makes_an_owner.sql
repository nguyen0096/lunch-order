-- Only an owner makes an owner, on every path into memberships.
--
-- 20260925100300 closed UPDATE and DELETE: an admin can no longer promote a
-- peer to owner, demote the owner or remove them. INSERT was never considered.
-- `memberships_admin_all` is `for all` and `authenticated` held INSERT on every
-- column, so an admin could skip the guard entirely:
--
--   insert into memberships (org_id, profile_id, role, short_code)
--   values (<office>, <anybody>, 'owner', 'XX')
--
-- and, for somebody already in the office, delete the row and insert it back
-- as an owner. Both are closed twice. No screen inserts a membership (joining
-- goes through join_with_code, accept_invitation and create_organization, all
-- SECURITY DEFINER), so the grant goes; and the guard fires on INSERT as well,
-- so a grant restored by accident one day still meets it.
--
-- The rule it enforces is the one already written down: ownership is the one
-- thing only an owner hands out or takes away. Owners hold every right an
-- admin does, because my_admin_org_ids() counts role in ('admin','owner');
-- nothing below narrows that.
--
-- One more hole of the same family, found while reading the guard:
-- `memberships_update_self` plus the column grant on `status` let a member
-- PATCH their own status. Setting it to 'inactive' walks out without
-- leave_office's two checks (a debt still owed; the last owner leaving), and
-- setting it back to 'active' undoes an admin's removal. Your own status now
-- changes only through those functions.

revoke insert on public.memberships from authenticated;

create or replace function public.enforce_membership_role() returns trigger
language plpgsql set search_path = '' as $$
declare v_is_owner boolean;
begin
  if private.is_service() then return new; end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner'
       and not (new.org_id = any ((select private.my_owner_org_ids())::bigint[])) then
      raise exception 'only an owner can appoint another owner'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- Privilege escalation would otherwise be a single PATCH away.
  if new.role is distinct from old.role and new.profile_id = (select auth.uid()) then
    raise exception 'you cannot change your own role'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is distinct from old.status and new.profile_id = (select auth.uid()) then
    raise exception 'leave an office from Settings; your own membership cannot be switched on or off directly'
      using errcode = 'insufficient_privilege';
  end if;

  v_is_owner := old.org_id = any ((select private.my_owner_org_ids())::bigint[]);

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

  -- The composite key every other table points at. Moving a row to another
  -- office would carry its orders' and bills' identity with it.
  if new.org_id is distinct from old.org_id or new.profile_id is distinct from old.profile_id then
    raise exception 'a membership cannot move to another office or person'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

revoke execute on function public.enforce_membership_role() from public, anon, authenticated;

drop trigger if exists memberships_role_guard on public.memberships;
create trigger memberships_role_guard before insert or update on public.memberships
  for each row execute function public.enforce_membership_role();
