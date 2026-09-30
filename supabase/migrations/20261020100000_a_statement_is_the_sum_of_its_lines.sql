-- A statement is the sum of its lines, including when no line is left.
--
-- Re-billing a week upserted statements only for payers who still had a line
-- in it, so a person whose last meal of the week went (a correction removing
-- it, a pass accepted, lunch cancelled, a price taken away) was never
-- recalculated. Their statement kept its old `meals_minor`. The clean-up that
-- follows deleted a line-less statement only when `paid_minor = 0`, and a
-- person in credit had already had that credit allocated to it, so it
-- survived. `v_account_balance` adds up `meals_minor`, so the meal nobody ate
-- went on being owed. Seen on the Test Office: 203.000 in credit, a 300.000
-- meal added by correction and then removed, balance 97.000 owed instead of
-- 203.000 in credit.
--
-- Now every statement in the week is recalculated, to zero when no line is
-- left; everybody holding one is reallocated; and only then is a statement
-- with no lines deleted, since by then it holds no money. A waived statement
-- with no lines goes too: `payment_corrections.statement_id` is ON DELETE SET
-- NULL so that the waiver's record outlives it. A payment that pointed at a
-- deleted statement is re-pointed at the person's frontier, the same rule
-- `trg_payment_apply` uses.
--
-- Locks, in the order `move_payment` and `void_payment` already take them: a
-- payment, then each person (`lunch.reallocate:` advisory key, profile
-- order), then statement rows. The re-bill used to write statement rows first
-- and take people after, so a payment arriving, a payment moved and a
-- correction on the same person's week deadlocked (40P01). It now holds the
-- week, then the payments on the week's statements (the delete below updates
-- them through the FK), then every person with a statement, a line or a
-- billable order in the week, and only then touches a statement.
-- `waive_statement` locked the statement before the person; it now takes the
-- person first too.
--
-- A settled week is unchanged: `run_billing` still refuses it without
-- `p_force`, and the guards still refuse every write that would change it.

create or replace function private.run_billing_inner(p_period_id bigint, p_force boolean default false)
returns table(lines integer, statements integer, total_minor bigint)
language plpgsql
security definer
set search_path to ''
as $function$
declare v_p public.billing_periods%rowtype;
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

  -- 3. roll lines up into statements, one per payer
  insert into public.billing_statements as st (
    org_id, billing_period_id, profile_id, meal_count, meals_minor,
    carried_in_minor, payment_ref)
  select v_p.org_id, p_period_id, bl.payer_profile_id, count(*)::int,
         sum(bl.amount_minor)::bigint, 0,
         private.payment_ref(v_p.org_id, v_p.period_start, bl.payer_profile_id)
    from public.billing_lines bl
   where bl.billing_period_id = p_period_id
   group by bl.payer_profile_id
  on conflict (billing_period_id, profile_id) do update set
        meal_count  = excluded.meal_count,
        meals_minor = excluded.meals_minor;
        -- status / paid_minor / paid_at are the allocation's, not this function's

  -- and a statement with no line left is worth nothing. `public.run_billing`
  -- deletes it once the allocation has taken its money back.
  update public.billing_statements st
     set meal_count = 0, meals_minor = 0
   where st.billing_period_id = p_period_id
     and (st.meal_count, st.meals_minor) <> (0, 0)
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
end $function$;

revoke execute on function private.run_billing_inner(bigint, boolean) from public, anon, authenticated;

create or replace function public.run_billing(p_period_id bigint, p_force boolean default false)
returns table(lines integer, statements integer, total_minor bigint)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_p      public.billing_periods%rowtype;
  v_org    bigint;
  v_person uuid;
  v_empty  bigint[];
  v_pays   bigint[];
begin
  -- The week first, as every caller that holds it already has.
  perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), p_period_id::int);

  -- Then the payments, then the people, then (in the inner function) the
  -- statement rows: the order move_payment and void_payment take them in.
  perform 1 from public.payments p
    join public.billing_statements st on st.id = p.matched_statement_id
   where st.billing_period_id = p_period_id
   order by p.id
     for no key update of p;

  select * into v_p from public.billing_periods bp where bp.id = p_period_id;
  v_org := v_p.org_id;

  -- Everybody the inner function can write a statement for. The key is the
  -- one private.reallocate takes, so its own lock later is a re-entry.
  for v_person in
    select st.profile_id from public.billing_statements st
     where st.billing_period_id = p_period_id
    union
    select bl.payer_profile_id from public.billing_lines bl
     where bl.billing_period_id = p_period_id
    union
    select c.payer_profile_id from public.v_order_charges c
     where c.org_id = v_p.org_id
       and c.order_status = 'placed'
       and c.service_date between v_p.period_start and v_p.period_end
       and not c.unpriced
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('lunch.reallocate:' || v_org || ':' || v_person, 0));
  end loop;

  perform * from private.run_billing_inner(p_period_id, p_force);

  for v_person in
    select distinct st.profile_id from public.billing_statements st
     where st.billing_period_id = p_period_id
     order by 1
  loop
    perform private.reallocate(v_org, v_person);
  end loop;

  -- A waived week holds none of the allocation, so its `paid_minor` is not
  -- money anybody is counting; any other holds none once it needs nothing.
  select array_agg(st.id) into v_empty
    from public.billing_statements st
   where st.billing_period_id = p_period_id
     and st.meal_count = 0
     and (st.status = 'waived' or st.paid_minor = 0);

  if v_empty is not null then
    select array_agg(p.id) into v_pays
      from public.payments p
     where p.matched_statement_id = any (v_empty);

    delete from public.billing_statements st where st.id = any (v_empty);

    update public.payments p
       set matched_statement_id = private.payment_frontier(p.org_id, p.profile_id)
     where p.id = any (coalesce(v_pays, '{}'::bigint[]))
       and p.profile_id is not null;
  end if;

  return query
    select p.line_count,
           (select count(*)::int from public.billing_statements where billing_period_id = p_period_id),
           p.total_minor
      from public.billing_periods p where p.id = p_period_id;
end $function$;

revoke execute on function public.run_billing(bigint, boolean) from public, anon, authenticated;

-- As in 20261011100300, but the person is locked before their statement, the
-- order run_billing and private.reallocate take them in. Locking the row
-- first and the person in `trg_statement_waived` after deadlocked with a
-- re-bill of the same week.
create or replace function public.waive_statement(p_statement_id bigint, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_st     public.billing_statements%rowtype;
  v_org    public.organizations%rowtype;
  v_start  date;
begin
  select * into v_st from public.billing_statements s where s.id = p_statement_id;
  if not found or not (v_st.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can waive a week'
      using errcode = 'insufficient_privilege';
  end if;
  v_reason := private.short_text(p_reason, 200, 'reason');

  perform pg_advisory_xact_lock(
    hashtextextended('lunch.reallocate:' || v_st.org_id || ':' || v_st.profile_id, 0));

  -- Read again under the lock: a re-bill may have changed or deleted it.
  select * into v_st from public.billing_statements s where s.id = p_statement_id for update;
  if not found then
    raise exception 'that week has nothing on it any more, so there is nothing to waive'
      using errcode = 'no_data_found';
  end if;
  if v_st.status = 'waived' then
    raise exception 'that week is already waived' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.billing_statements s
     set status = 'waived', paid_at = null, marked_paid_by = v_actor
   where s.id = v_st.id;

  select * into v_org from public.organizations o where o.id = v_st.org_id;
  select bp.period_start into v_start from public.billing_periods bp where bp.id = v_st.billing_period_id;
  insert into public.payment_corrections
    (org_id, kind, statement_id, from_profile_id, amount_minor, summary, reason, made_by)
  values (v_st.org_id, 'waive', v_st.id, v_st.profile_id, v_st.meals_minor,
          'Waived ' || private.member_name(v_st.org_id, v_st.profile_id) || '''s week of '
            || to_char(v_start, 'DD/MM') || ', '
            || private.money_text(v_st.meals_minor, v_org.currency_minor_units, v_org.currency),
          v_reason, v_actor);
end $fn$;

revoke execute on function public.waive_statement(bigint, text) from public, anon;
grant  execute on function public.waive_statement(bigint, text) to authenticated;
