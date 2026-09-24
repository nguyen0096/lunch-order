-- A settled week could still be written to, and the write never reached a bill.
--
-- `enforce_order_window` exempts `source = 'admin'` from the clock, which is
-- the door 20261003100100 deliberately left open. Nothing stands behind it. So
-- an admin can insert an order into a week that was billed, messaged and paid,
-- and `run_billing` will never see it: the only caller for a closed period is
-- `settle_period`, which does not pass `p_force`, and the hourly tick skips a
-- period that is already closed. The row sits in `orders` for ever, on the
-- Board, in the headcount, and in no statement anybody was sent.
--
-- That is worse than a refusal, because it looks like it worked. Close it.
--
-- Keyed on `billing_periods` by date range, NOT on `billing_lines`. A line
-- exists only for a priced, placed order, so an unpriced or cancelled order has
-- none and a `billing_lines` join would wave exactly the writes through that
-- the week was closed to stop. The week is the fact; the lines are a
-- consequence of it.
--
-- `billing_periods_no_overlap` excludes overlapping non-void periods per org,
-- so at most one row can match a date and the lookup needs no ordering.

create or replace function public.refuse_write_to_settled_week()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_org    bigint;
  v_dates  date[];
  v_date   date;
  v_status text;
begin
  if private.is_service() then return coalesce(new, old); end if;

  v_org := coalesce(new.org_id, old.org_id);

  if tg_table_name = 'orders' then
    -- Both dates, not just the new one. Moving a row OUT of a settled week
    -- changes what that week is a record of, which is the same act.
    v_dates := array_remove(array[new.service_date, old.service_date], null);
  else
    -- `order_items` carries no date of its own, and on a cascading delete the
    -- parent order is already gone, so the menu is the only reliable answer.
    select array_agg(distinct m.service_date) into v_dates
      from public.menus m
     where m.id = any (array_remove(array[new.menu_id, old.menu_id], null));
  end if;

  foreach v_date in array coalesce(v_dates, '{}'::date[]) loop
    select bp.status into v_status
      from public.billing_periods bp
     where bp.org_id = v_org
       and v_date between bp.period_start and bp.period_end
       and bp.status <> 'void';

    if v_status = 'closed' then
      raise exception
        'lunch on % is on a week that has been settled, so the record can no longer be changed',
        to_char(v_date, 'DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;

  return coalesce(new, old);
end $fn$;

comment on function public.refuse_write_to_settled_week() is
  'Refuses any write to an order or its lines once the week covering the service date is closed.';

drop trigger if exists orders_settled_week_frozen on public.orders;
create trigger orders_settled_week_frozen
  before insert or update or delete on public.orders
  for each row execute function public.refuse_write_to_settled_week();

drop trigger if exists order_items_settled_week_frozen on public.order_items;
create trigger order_items_settled_week_frozen
  before insert or update or delete on public.order_items
  for each row execute function public.refuse_write_to_settled_week();

revoke execute on function public.refuse_write_to_settled_week()
  from public, anon, authenticated;

-- The correction screen's own message kind.
--
-- Rewritten in full rather than patched, because a CHECK has no ALTER that adds
-- a value: the nine that were there are restated verbatim so a diff shows one
-- line added and nothing else moved.
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in
    ('menu_published','register_reminder','cutoff_warning',
     'weekly_preview','weekly_bill','payment_reminder','payment_ack',
     'transfer_offer','transfer_decided','bill_correction'));
