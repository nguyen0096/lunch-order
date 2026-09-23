-- The caterer prices the week at the weekend, not when the menu goes up.
--
-- The real message is "cơm tấm 50k, tuần rồi em ăn 5 phần, bún bò 60k, tổng
-- cộng là...": one price per dish for the whole week, plus the caterer's own
-- count, arriving after everybody has already eaten. Until now a menu could not
-- be published without a number, so the only way to run the week was to invent
-- one -- and `0` is a real price, indistinguishable on a bill from a free meal.
--
-- So "not priced yet" becomes representable, and a meal nobody can cost yet is
-- held out of the bill entirely rather than billed at zero. The rest of the
-- week still goes out: people owe what can be worked out, and no more.

-- 1. Absence of a price, said properly.
--
-- Both CHECKs survive untouched: a CHECK is satisfied by NULL, so `price_minor
-- >= 0` still refuses a negative price and now permits an unknown one.
alter table public.menu_items  alter column price_minor      drop not null;
alter table public.order_items alter column unit_price_minor drop not null;

comment on column public.menu_items.price_minor is
  'NULL means the caterer has not said yet. Orders for it are held out of billing until it is set, never billed as zero.';
comment on column public.order_items.unit_price_minor is
  'Snapshotted from menu_items when the dish is chosen. NULL means it was unpriced at the time; re-snapshot by naming menu_item_id in an UPDATE once the price arrives.';

-- 2. A charge says whether it can be worked out at all.
--
-- `amount_minor` already coalesced a missing sum to 0, which is right for an
-- order with no items and wrong for one whose dish has no price. Without this
-- flag the two are the same number and billing cannot tell them apart.
create or replace view public.v_order_charges as
 select o.id as order_id,
        o.org_id,
        o.service_date,
        o.status as order_status,
        o.profile_id as placed_by_profile_id,
        t.id as transfer_id,
        coalesce(t.to_profile_id, o.profile_id) as payer_profile_id,
        coalesce(i.amount_minor, 0) as amount_minor,
        coalesce(i.description, ''::text) as description,
        coalesce(i.unpriced, false) as unpriced
   from public.orders o
   left join public.meal_transfers t on t.order_id = o.id and t.status = 'accepted'
   left join lateral (
     select sum(oi.line_total_minor)::integer as amount_minor,
            bool_or(oi.unit_price_minor is null) as unpriced,
            string_agg(oi.item_name_snapshot ||
                       case when oi.quantity > 1 then ' x'::text || oi.quantity else ''::text end,
                       ', '::text order by oi.id) as description
       from public.order_items oi
      where oi.order_id = o.id) i on true;

-- 3. Bill what can be billed.
--
-- Two places, not one. Step 1 must not take an unpriced order in, and step 2's
-- retraction must agree with it -- otherwise a dish whose price were removed
-- would leave its line behind and keep charging the old amount.
create or replace function public.run_billing(p_period_id bigint, p_force boolean default false)
returns table (lines integer, statements integer, total_minor bigint)
language plpgsql security definer set search_path = '' as $$
declare v_p public.billing_periods%rowtype; v_prev bigint;
begin
  perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), p_period_id::int);

  select * into v_p from public.billing_periods where id = p_period_id for update;
  if not found          then raise exception 'billing period % not found', p_period_id; end if;
  if v_p.status = 'void' then raise exception 'period % is void', p_period_id; end if;
  if v_p.status = 'closed' and not p_force then
    raise exception 'period % is closed; pass p_force to recompute', p_period_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.billing_periods set status = 'computing' where id = p_period_id;

  -- 1. a line per placed order in the window whose price is known
  insert into public.billing_lines as bl (
    org_id, billing_period_id, order_id, service_date,
    payer_profile_id, original_profile_id, transfer_id, amount_minor, description)
  select c.org_id, p_period_id, c.order_id, c.service_date,
         c.payer_profile_id, c.placed_by_profile_id, c.transfer_id,
         c.amount_minor, c.description
    from public.v_order_charges c
   where c.org_id = v_p.org_id
     and c.order_status = 'placed'
     and c.service_date between v_p.period_start and v_p.period_end
     and not c.unpriced
  on conflict (order_id) do update set
        billing_period_id   = excluded.billing_period_id,
        service_date        = excluded.service_date,
        payer_profile_id    = excluded.payer_profile_id,
        original_profile_id = excluded.original_profile_id,
        transfer_id         = excluded.transfer_id,
        amount_minor        = excluded.amount_minor,
        description         = excluded.description
   where bl.billing_period_id = excluded.billing_period_id;

  -- 2. retract lines whose order is no longer billable, unpriced included
  delete from public.billing_lines bl
   where bl.billing_period_id = p_period_id
     and not exists (
       select 1 from public.v_order_charges c
        where c.order_id = bl.order_id
          and c.order_status = 'placed'
          and not c.unpriced
          and c.service_date between v_p.period_start and v_p.period_end);

  -- 3. roll lines up into statements, carrying forward what is still unpaid
  select bp.id into v_prev from public.billing_periods bp
   where bp.org_id = v_p.org_id and bp.period_end < v_p.period_start and bp.status <> 'void'
   order by bp.period_end desc limit 1;

  insert into public.billing_statements as st (
    org_id, billing_period_id, profile_id, meal_count, meals_minor,
    carried_in_minor, payment_ref)
  select v_p.org_id, p_period_id, bl.payer_profile_id, count(*)::int,
         sum(bl.amount_minor)::bigint,
         coalesce((select greatest(ps.total_due_minor - ps.paid_minor, 0)
                     from public.billing_statements ps
                    where ps.billing_period_id = v_prev
                      and ps.profile_id = bl.payer_profile_id
                      and ps.status <> 'waived'), 0),
         private.payment_ref(v_p.org_id, v_p.period_start, bl.payer_profile_id)
    from public.billing_lines bl
   where bl.billing_period_id = p_period_id
   group by bl.payer_profile_id
  on conflict (billing_period_id, profile_id) do update set
        meal_count       = excluded.meal_count,
        meals_minor      = excluded.meals_minor,
        carried_in_minor = excluded.carried_in_minor;
        -- status / paid_minor / paid_at / marked_paid_by deliberately untouched

  delete from public.billing_statements st
   where st.billing_period_id = p_period_id
     and st.paid_minor = 0
     and not exists (select 1 from public.billing_lines bl
                      where bl.billing_period_id = st.billing_period_id
                        and bl.payer_profile_id = st.profile_id);

  -- 4. roll up the period
  update public.billing_periods p set
    status      = case when v_p.status = 'closed' then 'closed' else 'open' end,
    computed_at = now(),
    line_count  = (select count(*) from public.billing_lines where billing_period_id = p_period_id),
    total_minor = (select coalesce(sum(amount_minor), 0) from public.billing_lines
                    where billing_period_id = p_period_id)
   where p.id = p_period_id;

  return query
    select p.line_count,
           (select count(*)::int from public.billing_statements where billing_period_id = p_period_id),
           p.total_minor
      from public.billing_periods p where p.id = p_period_id;
end $$;

revoke execute on function public.run_billing(bigint, boolean) from public, anon, authenticated;

-- 4. A week waiting on the caterer does not close.
--
-- Closing is what makes a week final: after it, transfers are refused and
-- run_billing demands p_force. Closing over an unpriced meal would strand that
-- meal unbilled forever, which is the one outcome worse than a late bill.
--
-- A trigger rather than an edit to the hourly tick, for two reasons. It guards
-- every path that closes a period, not just the one that exists today. And
-- editing the tick means restating 181 lines in this file, which is how the
-- last dollar-quoting bug got in.
--
-- It holds the week open rather than raising: a late caterer is an ordinary
-- Monday, not a fault, and an exception here would abort the tick mid-run for
-- every other org behind it. The Payments screen is where a human is told.
create or replace function public.hold_period_open_while_unpriced()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if new.status = 'closed' and old.status <> 'closed'
     and exists (
       select 1
         from public.orders o
         join public.order_items oi on oi.order_id = o.id
        where o.org_id = new.org_id
          and o.status = 'placed'
          and o.service_date between new.period_start and new.period_end
          and oi.unit_price_minor is null)
  then
    new.status    := old.status;
    new.closed_at := old.closed_at;
    new.closed_by := old.closed_by;
  end if;
  return new;
end
$fn$;

drop trigger if exists billing_periods_hold_open on public.billing_periods;
create trigger billing_periods_hold_open
before update on public.billing_periods
for each row execute function public.hold_period_open_while_unpriced();
