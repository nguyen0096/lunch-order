-- Period allocation and the idempotent weekly billing run.

-- The org's week containing a given date, created if absent.
create or replace function public.ensure_billing_period(p_org_id bigint, p_any_date date)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_start date; v_end date; v_dow int; v_id bigint; v_week_start smallint;
begin
  select o.billing_week_starts_on into v_week_start
    from public.organizations o where o.id = p_org_id;
  if v_week_start is null then raise exception 'org % not found', p_org_id; end if;

  v_dow   := extract(isodow from p_any_date)::int;
  v_start := p_any_date - ((v_dow - v_week_start + 7) % 7);
  v_end   := v_start + 6;

  insert into public.billing_periods (org_id, period_start, period_end)
  values (p_org_id, v_start, v_end)
  on conflict do nothing;

  select bp.id into v_id from public.billing_periods bp
   where bp.org_id = p_org_id and bp.period_start = v_start and bp.status <> 'void';
  return v_id;
end $$;

-- Stable, ASCII, unique per org. Bank memos strip diacritics and mangle length,
-- so keep it short and boring.
create or replace function private.payment_ref(p_org_id bigint, p_period_start date, p_profile_id uuid)
returns text language plpgsql stable set search_path = '' as $$
declare v_code text;
begin
  select m.short_code into v_code from public.memberships m
   where m.org_id = p_org_id and m.profile_id = p_profile_id;
  return 'L' || to_char(p_period_start, 'IW') || coalesce(v_code, 'X');
end $$;

-- Idempotent by construction:
--   * pg_advisory_xact_lock serializes concurrent or retried runs for a period
--   * unique (order_id) on billing_lines makes double-billing impossible
--   * step 2 retracts lines whose order was cancelled after a previous run
--   * step 3's do-update set-list omits status/paid_minor/paid_at, so a
--     recompute can never un-pay somebody
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

  -- 1. upsert a line per placed order in the window
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
  on conflict (order_id) do update set
        billing_period_id   = excluded.billing_period_id,
        service_date        = excluded.service_date,
        payer_profile_id    = excluded.payer_profile_id,
        original_profile_id = excluded.original_profile_id,
        transfer_id         = excluded.transfer_id,
        amount_minor        = excluded.amount_minor,
        description         = excluded.description
   -- never yank a line out of a period it already belongs to
   where bl.billing_period_id = excluded.billing_period_id;

  -- 2. retract lines whose order is no longer billable
  delete from public.billing_lines bl
   where bl.billing_period_id = p_period_id
     and not exists (
       select 1 from public.v_order_charges c
        where c.order_id = bl.order_id
          and c.order_status = 'placed'
          and c.service_date between v_p.period_start and v_p.period_end);

  -- 3. roll lines up into statements, carrying forward what is still unpaid
  select bp.id into v_prev from public.billing_periods bp
   where bp.org_id = v_p.org_id and bp.period_end < v_p.period_start and bp.status = 'closed'
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
    line_count  = (select count(*) from public.billing_lines
                    where billing_period_id = p_period_id),
    total_minor = (select coalesce(sum(amount_minor), 0) from public.billing_lines
                    where billing_period_id = p_period_id)
   where p.id = p_period_id;

  return query
    select p.line_count,
           (select count(*)::int from public.billing_statements
             where billing_period_id = p_period_id),
           p.total_minor
      from public.billing_periods p where p.id = p_period_id;
end $$;

-- Applying a payment is the one place statement status changes automatically.
create or replace function public.apply_payment_to_statement(
  p_statement_id bigint, p_amount_minor bigint)
returns public.billing_statements
language plpgsql security definer set search_path = '' as $$
declare v_st public.billing_statements%rowtype;
begin
  update public.billing_statements set paid_minor = paid_minor + p_amount_minor
   where id = p_statement_id returning * into v_st;
  if not found then raise exception 'statement % not found', p_statement_id; end if;

  update public.billing_statements set
    status  = case when v_st.paid_minor >= v_st.total_due_minor then 'paid'
                   when v_st.paid_minor > 0                     then 'partial'
                   else 'unpaid' end,
    paid_at = case when v_st.paid_minor >= v_st.total_due_minor then coalesce(v_st.paid_at, now())
                   else null end
   where id = p_statement_id returning * into v_st;
  return v_st;
end $$;
