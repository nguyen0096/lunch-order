-- A week with nothing due is paid, and dated.
--
-- A placed order with no dish line (a standing plan, a day nobody picked a
-- dish for) bills at 0. When those are all of somebody's week, its statement
-- needs 0, and `private.reallocate` wrote it as 'paid' with `paid_at` taken
-- from the payment that finished it. No payment finishes a week that needs
-- nothing, so `paid_at` stayed null and `billing_statements_paid_ck` refused
-- the row. That failed `run_billing`: Settle week and every correction on the
-- week raised, and the hourly tick, which runs each office in its own
-- subtransaction, rolled back that office's whole hour, for every hour of the
-- billing day. The week was never billed or closed, nobody got a weekly bill,
-- and the only trace was a WARNING in the Postgres log.
--
-- 'paid' stays the status: it is what the Bill screen already shows for a week
-- with nothing outstanding, and neither the open-statements index nor the
-- weekly bill counts it. `paid_at` keeps the date the week already has, and is
-- otherwise now, the moment it was settled needing nothing; so re-billing the
-- week does not move its "Settled" date.
--
-- No data repair: the CHECK means no such row was ever written, and production
-- has no dishless placed order and no week left unbilled by this.
--
-- Unchanged from 20261011100300 but for `paid_at` in the final UPDATE, so the
-- per-person advisory lock is still the first thing it takes.
create or replace function private.reallocate(p_org_id bigint, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_credit  record;
  v_left    bigint := 0;
  v_at      timestamptz;
  v_take    bigint;
  v_id      bigint[];
  v_need    bigint[];
  v_floor   bigint[];
  v_settled boolean[];
  v_got     bigint[];
  v_when    timestamptz[];
  v_n       int;
  i         int;
  v_credits cursor for
    select p.amount_minor, p.received_at
      from public.payments p
     where p.org_id = p_org_id and p.profile_id = p_profile_id
       and p.voided_at is null
     order by p.received_at, p.id;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('lunch.reallocate:' || p_org_id || ':' || p_profile_id, 0));

  select array_agg(s.id order by s.period_start, s.id),
         array_agg(s.meals_minor order by s.period_start, s.id),
         array_agg(least(s.paid_minor, s.meals_minor) order by s.period_start, s.id),
         array_agg(s.settled order by s.period_start, s.id)
    into v_id, v_need, v_floor, v_settled
    from (
      select st.id, st.meals_minor, st.paid_minor, bp.period_start,
             bp.status = 'closed' as settled
        from public.billing_statements st
        join public.billing_periods bp on bp.id = st.billing_period_id
       where st.org_id = p_org_id and st.profile_id = p_profile_id
         and st.status <> 'waived'
    ) s;

  v_n := coalesce(array_length(v_id, 1), 0);
  if v_n = 0 then return; end if;

  v_got  := array_fill(0::bigint, array[v_n]);
  v_when := array_fill(null::timestamptz, array[v_n]);

  open v_credits;
  fetch v_credits into v_credit;
  if found then v_left := v_credit.amount_minor; v_at := v_credit.received_at; end if;

  for i in 1 .. v_n loop
    while v_settled[i] and v_got[i] < v_floor[i] and v_left > 0 loop
      v_take   := least(v_floor[i] - v_got[i], v_left);
      v_got[i] := v_got[i] + v_take;
      v_left   := v_left - v_take;
      if v_got[i] >= v_need[i] then v_when[i] := v_at; end if;
      if v_left = 0 then
        fetch v_credits into v_credit;
        if found then v_left := v_credit.amount_minor; v_at := v_credit.received_at;
        else exit; end if;
      end if;
    end loop;
  end loop;

  for i in 1 .. v_n loop
    while v_got[i] < v_need[i] and v_left > 0 loop
      v_take   := least(v_need[i] - v_got[i], v_left);
      v_got[i] := v_got[i] + v_take;
      v_left   := v_left - v_take;
      if v_got[i] >= v_need[i] then v_when[i] := v_at; end if;
      if v_left = 0 then
        fetch v_credits into v_credit;
        if found then v_left := v_credit.amount_minor; v_at := v_credit.received_at;
        else exit; end if;
      end if;
    end loop;
  end loop;
  close v_credits;

  -- v_when is null only for a week that needs 0: no payment finished it.
  for i in 1 .. v_n loop
    update public.billing_statements set
      paid_minor = v_got[i],
      status     = case when v_got[i] >= v_need[i] then 'paid'
                        when v_got[i] > 0          then 'partial'
                        else 'unpaid' end,
      paid_at    = case when v_got[i] >= v_need[i]
                        then coalesce(v_when[i], paid_at, now()) end
     where id = v_id[i];
  end loop;
end $function$;

comment on function private.reallocate(bigint, uuid) is
  'Matches payments to weeks, oldest first, settled weeks served first so a later charge cannot unsettle them. A week needing 0 is paid, dated when it was settled. Locks the person.';

revoke execute on function private.reallocate(bigint, uuid) from public, anon, authenticated;
