-- A settled week's payment never goes backwards.
--
-- `private.reallocate` re-walks every payment a person has ever made against
-- every non-waived statement they have, oldest first, and rewrites
-- `paid_minor`, `status` and `paid_at` on all of them. A charge added to a week
-- that sorts EARLIER therefore pulls money off the weeks after it, and those
-- can include weeks an admin has already settled and a person has already paid.
--
-- The state that makes it reachable is ordinary, not exotic:
-- `hold_period_open_while_unpriced` refuses to close a week that still has a
-- meal the caterer has not priced, and it looks only inside its own dates. So
-- week N stays open waiting on a price while week N+1 is settled and closed.
-- Price that meal, or correct that week, and week N+1 goes from `paid` to
-- `partial` with `paid_at` back to null. Nobody's balance moves, because a
-- balance is charges minus payments and owes nothing to how they are matched
-- up, but the person is shown a settled week that is suddenly unpaid and an
-- admin is shown somebody to chase who has already paid in full.
--
-- The rule: a settled week is served first. What it already holds comes off the
-- payments before any open week is allowed to take anything, so no later charge
-- can take it away. Money that arrives afterwards still tops it up, which is how
-- a closed week that was left unpaid settles when somebody finally transfers.
--
-- Two passes rather than a reservation off the top, so that `paid_at` is still
-- the date of the payment that completed the week rather than whatever was
-- stored last. The first pass walks the settled weeks in the same order and out
-- of the same payments the single pass used, which is why this is exactly
-- today's arithmetic on today's data: verified by re-running it for every member
-- of every office inside a rolled-back transaction and diffing every statement,
-- zero rows differ. It parts company with today only in the case it exists for,
-- an open week sitting before a closed one.
--
-- Installed ahead of the corrections screen, because a correction to an open
-- week is about to become the ordinary way that gap gets written into.

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
     order by p.received_at, p.id;
begin
  select array_agg(s.id order by s.period_start, s.id),
         array_agg(s.meals_minor order by s.period_start, s.id),
         -- Clamped: a statement holding more than the week is worth cannot
         -- reserve money it has no claim to.
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

  -- First pass: settled weeks, up to what they already hold.
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

  -- Second pass: everything else, oldest first, out of what is left. A settled
  -- week that was short is still in this walk, so a late transfer settles it.
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

  for i in 1 .. v_n loop
    update public.billing_statements set
      paid_minor = v_got[i],
      status     = case when v_got[i] >= v_need[i] then 'paid'
                        when v_got[i] > 0          then 'partial'
                        else 'unpaid' end,
      paid_at    = case when v_got[i] >= v_need[i] then v_when[i] end
     where id = v_id[i];
  end loop;
end $function$;

comment on function private.reallocate(bigint, uuid) is
  'Matches payments to weeks, oldest first, settled weeks served first so a later charge cannot unsettle them.';
