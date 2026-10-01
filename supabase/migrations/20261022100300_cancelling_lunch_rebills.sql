-- Cancelling lunch re-bills its week.
--
-- trg_menu_cancelled cancelled the day's orders and stopped there, so a
-- statement already written for that week went on charging the cancelled
-- meals until something else re-billed it, against "a statement is the sum of
-- its lines" (20261020100000). Somebody holding credit saw it spent on a lunch
-- that did not happen.
--
-- Now the trigger re-bills the day's week in the same transaction, when the
-- week has a period and it is open. No period means nothing was ever billed;
-- a settled week is never re-billed, and a browser cannot cancel a day in one
-- anyway, since enforce_menu_lifecycle allows cancelling only while the day is
-- open.
--
-- Lock order: the cancel already holds the menu row; the week's lock is taken
-- before the orders are written, then run_billing takes the people, payments
-- and statements. So a correction on the same week (menu FOR SHARE, then the
-- week) waits for the menu, and one on another day of the week waits for the
-- week, never the other way round.

create or replace function public.trg_menu_cancelled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_period bigint; v_status text;
begin
  select bp.id into v_period
    from public.billing_periods bp
   where bp.org_id = new.org_id
     and new.service_date between bp.period_start and bp.period_end
     and bp.status <> 'void';

  if v_period is not null then
    perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), v_period::int);
    select bp.status into v_status from public.billing_periods bp where bp.id = v_period;
  end if;

  update public.orders
     set status = 'cancelled', cancelled_at = now()
   where menu_id = new.id and status = 'placed';

  if v_status = 'open' then
    perform public.run_billing(v_period);
  end if;
  return null;
end $fn$;
