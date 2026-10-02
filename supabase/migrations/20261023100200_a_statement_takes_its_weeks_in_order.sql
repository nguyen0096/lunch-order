-- One statement touching two weeks takes both weeks' keys up front.
--
-- trg_menu_cancelled and trg_transfer_rebills are row triggers, and each took
-- its own row's office-week key. One UPDATE cancelling days in two weeks, or
-- answering passes in two weeks, so re-billed the first week (holding its
-- week lock and its people) and only then asked for the second week's key. A
-- correction in the second week holds that key and then waits on the same
-- people: a deadlock (40P01), and Postgres rolled one side back. Only a
-- hand-made API request makes such a statement; the app writes one day or one
-- pass at a time.
--
-- Now each trigger sees the whole statement through a transition table and,
-- on its first row, takes every key the statement needs in (office, date)
-- order, before any week lock. Later rows find them held, and taking a held
-- key is a no-op. So the statement waits for a correction in either week
-- while holding no week, and two such statements take their keys in one
-- order. A single-row statement takes the one key it always took, at the same
-- point.
--
-- Transition tables need a trigger with one event and no column list, so
-- meal_transfers_rebill becomes two triggers (insert, update) and both lose
-- `of status`; their WHEN conditions are unchanged. menus_cancel_orders loses
-- `of status` too, with the same WHEN. trg_menu_cancelled likewise takes the
-- pending passes of every day the statement cancels before the keys.

drop trigger menus_cancel_orders on public.menus;
drop trigger meal_transfers_rebill on public.meal_transfers;

-- As in 20261023100100, with the whole statement's passes and keys first.
create or replace function public.trg_menu_cancelled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_period bigint; v_status text; r record;
begin
  perform 1 from public.meal_transfers t
    join public.orders o on o.id = t.order_id
   where o.menu_id in (select c.id from cancelled_menus c where c.status = 'cancelled')
     and t.status = 'pending'
   order by t.id
     for no key update of t;

  for r in
    select c.org_id, c.service_date from cancelled_menus c
     where c.status = 'cancelled'
     order by c.org_id, c.service_date
  loop
    perform private.lock_office_week(r.org_id, r.service_date);
  end loop;

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

  perform private.withdraw_pending_pass(o.id,
            'withdrawn: lunch on ' || to_char(new.service_date, 'DD/MM') || ' was cancelled')
     from public.orders o
    where o.menu_id = new.id
      and exists (select 1 from public.meal_transfers t
                   where t.order_id = o.id and t.status = 'pending');

  if v_status = 'open' then
    perform public.run_billing(v_period);
  end if;
  return null;
end $fn$;

create trigger menus_cancel_orders
  after update on public.menus
  referencing new table as cancelled_menus
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.trg_menu_cancelled();

-- As in 20261023100100, with the whole statement's keys first.
create or replace function public.trg_transfer_rebills()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_period bigint; o public.orders%rowtype; r record;
begin
  if current_setting('lunch.pass_withdrawn_with_meal', true) = 'on' then return null; end if;

  for r in
    select distinct x.org_id, x.service_date
      from changed_passes c
      join public.orders x on x.id = c.order_id
     where c.status in ('accepted', 'declined', 'cancelled', 'undone')
     order by x.org_id, x.service_date
  loop
    perform private.lock_office_week(r.org_id, r.service_date);
  end loop;

  select * into o from public.orders where id = new.order_id;

  select bp.id into v_period
    from public.billing_periods bp
   where bp.org_id = o.org_id
     and o.service_date between bp.period_start and bp.period_end
     and bp.status not in ('closed', 'void');
  if v_period is null then return null; end if;

  perform public.run_billing(v_period);
  return null;
end $function$;

create trigger meal_transfers_rebill_insert
  after insert on public.meal_transfers
  referencing new table as changed_passes
  for each row
  when (new.status in ('accepted', 'declined', 'cancelled', 'undone'))
  execute function public.trg_transfer_rebills();

create trigger meal_transfers_rebill
  after update on public.meal_transfers
  referencing new table as changed_passes
  for each row
  when (new.status in ('accepted', 'declined', 'cancelled', 'undone'))
  execute function public.trg_transfer_rebills();
