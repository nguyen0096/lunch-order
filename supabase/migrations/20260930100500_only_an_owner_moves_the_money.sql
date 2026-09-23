-- Where the money goes is an owner's decision, not an admin's.
--
-- `organizations_update_admin` lets any admin write any column, which is right
-- for the cutoff and the office name and wrong for the bank account. An office
-- can have several admins; they are appointed casually, and appointing one is
-- not meant to hand somebody the ability to redirect everybody's payments.
--
-- It is worse than deleting the office, which is already owner-only. A deletion
-- is loud -- the office disappears for everyone at once. A changed account
-- number is silent: bills keep printing, QR codes keep scanning, people keep
-- paying, and the money simply arrives somewhere else. Nobody notices until
-- somebody chases a payment that was never missing.
--
-- Same mechanism as the deletion guard, and for the same measured reason:
-- withholding a column grant does not work, because `authenticated` holds
-- UPDATE on organizations at table level and Postgres will not let a
-- column-level REVOKE carve an exception out of it. A trigger is what every
-- path goes through.
--
-- This replaces guard_office_deletion rather than sitting beside it, so there
-- is one place that answers "which columns are the owner's alone".
create or replace function public.guard_owner_only_settings()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $fn$
declare v_owner boolean := old.id = any ((select private.my_owner_org_ids())::bigint[]);
begin
  if private.is_service() then return new; end if;

  if new.deleted_at is distinct from old.deleted_at and not v_owner then
    raise exception 'only an owner can delete or restore an office'
      using errcode = 'insufficient_privilege';
  end if;

  if new.payment_config is distinct from old.payment_config and not v_owner then
    raise exception 'only an owner can change where the money goes'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$fn$;

drop trigger if exists organizations_guard_deletion on public.organizations;
drop trigger if exists organizations_guard_owner_only on public.organizations;
create trigger organizations_guard_owner_only
before update on public.organizations
for each row execute function public.guard_owner_only_settings();

drop function if exists public.guard_office_deletion();
