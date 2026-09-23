-- Let an admin bill a week once the caterer's prices are in.
--
-- Holding a week open until every meal has a price (the migration before this)
-- opened a gap: the hourly tick only bills on the org's week-start day, so a
-- price arriving on Tuesday would have sat unbilled until the following Monday
-- -- by which time the tick is computing a different week, and the old one
-- might never have been billed at all.
--
-- Billing is therefore something an admin can ask for, which is also the
-- honest shape: "the caterer has finally told me what it cost" is a deliberate
-- act, not something to wait a week for.
--
-- run_billing itself stays revoked from every browser role. It takes a period
-- id and would otherwise let any signed-in user recompute another office's
-- bill; this wrapper is the only way in, and it checks the caller first. The
-- check is `private.my_admin_org_ids()`, the same function the policies use, so
-- there is one answer to "is this person an admin here" rather than two.
--
-- Not passing p_force: a closed week stays closed, and run_billing already
-- raises a sentence saying so.
create or replace function public.settle_period(p_period_id bigint)
returns table (lines integer, statements integer, total_minor bigint)
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_org bigint;
begin
  select bp.org_id into v_org from public.billing_periods bp where bp.id = p_period_id;
  if not found then
    raise exception 'that week does not exist' using errcode = 'no_data_found';
  end if;

  if not (v_org = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can bill a week'
      using errcode = 'insufficient_privilege';
  end if;

  return query select * from public.run_billing(p_period_id, false);
end
$fn$;

revoke execute on function public.settle_period(bigint) from public, anon;
grant  execute on function public.settle_period(bigint) to authenticated;
