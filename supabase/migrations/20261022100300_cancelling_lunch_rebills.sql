-- Cancelling lunch re-bills its week.
--
-- trg_menu_cancelled cancelled the day's orders and stopped there, so a
-- statement already written for that week went on charging the cancelled
-- meals until something else re-billed it, against "a statement is the sum of
-- its lines" (20261020100000). Somebody holding credit saw it spent on a lunch
-- that did not happen.
--
-- Now the trigger re-bills the day's week in the same transaction, when the
-- week has a period and it is open. A settled week is never re-billed, and a
-- browser cannot cancel a day in one anyway, since enforce_menu_lifecycle
-- allows cancelling only while the day is open. A cancel creates no period.
--
-- The week may have no period yet while a correction is creating its first
-- one: correction_period makes the period and bills the week, reading the
-- day's orders as placed, and an unlocked lookup here would not see that
-- period and would re-bill nothing, leaving lines on cancelled orders. The
-- week's own lock is keyed on the period's id, which does not exist yet, so
-- both take an office-week key first, by (office, week start), before looking
-- the period up. Whichever is second then sees the other's work: a cancel
-- after the correction finds the period and re-bills it; a correction after
-- the cancel bills the orders already cancelled.
--
-- A member answering an offer has the same gap: trg_transfer_rebills looked
-- the period up unlocked, so an accept racing the week's first correction left
-- the line on the giver while the pass read accepted. It takes the key too,
-- after the pass row it is fired from. The admin pass RPCs already hold the
-- key through correction_period, and taking it again is a no-op.
--
-- Lock order: the menu (the cancel's own update; a correction's FOR SHARE),
-- a pass row, then the office-week key, then the week, then the orders, then
-- run_billing's people, payments and statements. Nothing in the app takes the
-- office-week key while holding a week lock. The one exception is a single
-- UPDATE cancelling days in two weeks, which takes the second week's key
-- while holding the first's week lock and can deadlock (40P01) with a
-- correction in the second week; the app cancels one day per statement. The
-- hourly tick creates and bills only the week that ended yesterday, which has
-- no day a browser can still cancel or pass, and ensure_period creates a
-- period without billing, so neither needs the key.

create or replace function private.lock_office_week(p_org_id bigint, p_date date)
returns void
language sql
set search_path to ''
as $fn$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lunch.office_week:' || o.id::text || ':'
      || (p_date - ((extract(isodow from p_date)::int - o.billing_week_starts_on + 7) % 7))::text,
    0))
    from public.organizations o where o.id = p_org_id;
$fn$;

revoke execute on function private.lock_office_week(bigint, date) from public, anon, authenticated;

-- As in 20261007100200, taking the office-week key before it can create the
-- period.
create or replace function private.correction_period(p_org_id bigint, p_service_date date)
returns bigint
language plpgsql
set search_path to ''
as $function$
declare v_id bigint; v_status text;
begin
  perform private.lock_office_week(p_org_id, p_service_date);

  v_id := public.ensure_billing_period(p_org_id, p_service_date);
  if v_id is null then
    raise exception 'that week overlaps one already on the books'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), v_id::int);

  select bp.status into v_status from public.billing_periods bp where bp.id = v_id;

  if v_status = 'closed' then
    raise exception
      'the week of % has been settled, so it can no longer be corrected',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_status = 'void' then
    raise exception 'the week of % is void, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return v_id;
end $function$;

create or replace function public.trg_menu_cancelled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_period bigint; v_status text;
begin
  perform private.lock_office_week(new.org_id, new.service_date);

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

-- As in 20261004100000, taking the office-week key before the lookup.
create or replace function public.trg_transfer_rebills()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_period bigint; o public.orders%rowtype;
begin
  select * into o from public.orders where id = new.order_id;
  perform private.lock_office_week(o.org_id, o.service_date);

  select bp.id into v_period
    from public.billing_periods bp
   where bp.org_id = o.org_id
     and o.service_date between bp.period_start and bp.period_end
     and bp.status not in ('closed', 'void');
  if v_period is null then return null; end if;

  perform public.run_billing(v_period);
  return null;
end $function$;
