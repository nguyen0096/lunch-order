-- Leaving an office, and deleting one.
--
-- Neither was possible. Leaving was *mechanically* possible and deliberately
-- hidden: memberships_update_self plus the column grant on `status` let anybody
-- deactivate themselves, and the People screen blocks it because one tap with
-- no explanation is an accident, not a decision. Deleting was impossible at any
-- privilege level -- `delete from organizations` cascades into memberships and
-- then fails on `orders_member_fk`, which does not cascade. Measured, not
-- assumed.
--
-- So deleting is a soft delete. This app exists to track what people ate and
-- owed; destroying that to satisfy a button would defeat the point, and the
-- cascade would take every statement and payment with it.

-- 1. An office can be gone without its rows being gone.
alter table public.organizations add column if not exists deleted_at timestamptz;

comment on column public.organizations.deleted_at is
  'Soft delete. Set means the office is gone for everybody: the three private.my_*_org_ids() helpers exclude it, so it disappears from every policy at once. Nothing is erased. To restore: update public.organizations set deleted_at = null where id = ...';

-- 2. One place decides, so the office disappears everywhere at once.
--
-- Every policy in the schema routes through these three. Filtering here rather
-- than in forty policies is the difference between one rule and forty chances
-- to forget one.
create or replace function private.my_org_ids()
returns bigint[] language sql stable security definer set search_path to '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
   where m.profile_id = (select auth.uid()) and m.status = 'active';
$$;

create or replace function private.my_admin_org_ids()
returns bigint[] language sql stable security definer set search_path to '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
   where m.profile_id = (select auth.uid()) and m.status = 'active'
     and m.role in ('admin','owner');
$$;

create or replace function private.my_owner_org_ids()
returns bigint[] language sql stable security definer set search_path to '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
   where m.profile_id = (select auth.uid()) and m.status = 'active'
     and m.role = 'owner';
$$;

-- 3. Only an owner may delete, by any route.
--
-- Withholding a column grant would not do it: `authenticated` holds UPDATE on
-- organizations at table level, and Postgres will not let a column-level REVOKE
-- carve an exception out of that -- the revoke reports success and changes
-- nothing. Learned on telegram_join_code_set_at, measured there, applied here.
-- So the rule lives in a trigger, which every path goes through.
create or replace function public.guard_office_deletion()
returns trigger language plpgsql security invoker set search_path to '' as $fn$
begin
  if new.deleted_at is distinct from old.deleted_at
     and not (old.id = any ((select private.my_owner_org_ids())::bigint[]))
     and not private.is_service()
  then
    raise exception 'only an owner can delete or restore an office'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$fn$;

drop trigger if exists organizations_guard_deletion on public.organizations;
create trigger organizations_guard_deletion
before update on public.organizations
for each row execute function public.guard_office_deletion();

-- 4. Leaving.
--
-- Deactivation, not deletion: the membership row carries the short code that
-- appears in a bank memo, and statements point at the person who owes. Erasing
-- it would erase the fact that a debt has an owner. Re-joining with the code
-- reactivates the same row, which is also what makes "leave and come back"
-- testable.
--
-- Refused while you owe, by request. Refused for the only owner because admins
-- cannot appoint owners: an owner walking out otherwise leaves an office that
-- nobody can ever administer again. That person's route is to hand over or to
-- delete, which is exactly the case this pair of functions exists for.
create or replace function public.leave_office(p_org_id bigint)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_me uuid := (select auth.uid()); v_role text; v_owed bigint; v_owners int;
begin
  select m.role into v_role from public.memberships m
   where m.org_id = p_org_id and m.profile_id = v_me and m.status = 'active';
  if not found then
    raise exception 'you are not a member of that office' using errcode = 'no_data_found';
  end if;

  -- Any week still carrying a balance, not a sum across weeks: carry-forward
  -- rolls an unpaid remainder into the next statement, so adding them up counts
  -- the same debt twice. The question here is only whether anything is owed.
  select coalesce(sum(greatest(st.total_due_minor - st.paid_minor, 0)), 0) into v_owed
    from public.billing_statements st
   where st.org_id = p_org_id and st.profile_id = v_me
     and st.status in ('unpaid','partial');
  if v_owed > 0 then
    raise exception 'you still owe this office money; settle up before you leave'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owners from public.memberships m
     where m.org_id = p_org_id and m.status = 'active' and m.role = 'owner';
    if v_owners <= 1 then
      raise exception 'you are the only owner; make somebody else an owner first, or delete the office'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  update public.memberships set status = 'inactive'
   where org_id = p_org_id and profile_id = v_me;
end
$fn$;

create or replace function public.delete_office(p_org_id bigint)
returns void language plpgsql security definer set search_path to '' as $fn$
begin
  if not (p_org_id = any ((select private.my_owner_org_ids())::bigint[])) then
    raise exception 'only an owner can delete an office' using errcode = 'insufficient_privilege';
  end if;
  update public.organizations set deleted_at = now() where id = p_org_id;
end
$fn$;

revoke execute on function public.leave_office(bigint), public.delete_office(bigint)
  from public, anon;
grant execute on function public.leave_office(bigint), public.delete_office(bigint)
  to authenticated;
