-- Money belonged to a week. It belongs to a person.
--
-- `trg_payment_apply` read the memo, found the one statement whose
-- `payment_ref` was inside it, and added the whole amount to that week's
-- `paid_minor`. Everything followed from that one decision:
--
--   * Pay more than a week asks for and the excess is destroyed. `paid_minor`
--     goes above `total_due_minor`, the next week carries in
--     `greatest(total_due - paid, 0)`, and `greatest` turns the credit into a
--     zero. Measured against production: a 397.000 statement paid 794.000
--     carries 0 forward and the other 397.000 is gone from the books.
--   * Pay three weeks at once and only one of them is settled.
--   * Pay before you have eaten and there is no statement to attach to, so
--     there is no such thing as a top-up.
--   * The reference changes every week, so nobody can save the transfer in
--     their banking app.
--
-- The week is a charge. A payment is a credit. What somebody owes is the sum
-- of one minus the sum of the other, and a negative answer is money in hand
-- rather than an error.
--
-- `paid_minor` and `status` survive as an ALLOCATION of the person's credits
-- across their weeks, oldest first, recomputed whenever either side moves.
-- Every screen that reads them goes on working, and "which weeks are settled"
-- goes on having an answer. What changes is that the allocation is derived
-- and may move. The money may not: `payments` is still append-only, still
-- never deleted, and that is the invariant that was ever worth having. It was
-- previously stated as "nothing decrements `paid_minor`", which confused the
-- record of a payment with the story told about it.

-- ---------------------------------------------------------------- the person

/**
 * One reference per person, for good.
 *
 * `LUNCH` plus their short code. It was `LUNCH` + ISO week + short code, which
 * meant a new reference every Monday: nobody can save a repeating transfer in
 * a banking app against a reference that changes, and the commonest way to get
 * it wrong is to reuse last week's. A stable one is both easier to use and
 * harder to get wrong, and now that money attaches to a person rather than a
 * week there is nothing left for the week number to do.
 */
alter table public.memberships add column if not exists payment_ref text;

update public.memberships
   set payment_ref = 'LUNCH' || short_code
 where payment_ref is null and short_code is not null;

create unique index if not exists memberships_payment_ref_uk
  on public.memberships (org_id, payment_ref)
  where payment_ref is not null;

/** Keep it in step with the short code, which a rename can move. */
create or replace function public.set_membership_payment_ref()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.short_code is not null then
    new.payment_ref := 'LUNCH' || new.short_code;
  end if;
  return new;
end $function$;

drop trigger if exists memberships_payment_ref on public.memberships;
create trigger memberships_payment_ref
  before insert or update of short_code on public.memberships
  for each row execute function public.set_membership_payment_ref();

-- ---------------------------------------------------------------- the credit

alter table public.payments
  add column if not exists profile_id uuid references public.profiles(id);

comment on column public.payments.profile_id is
  'Whose money this is. Null means it matched nobody and is waiting on an admin.';

-- Everything already matched belongs to the person that statement was for.
update public.payments p
   set profile_id = st.profile_id
  from public.billing_statements st
 where p.matched_statement_id = st.id and p.profile_id is null;

create index if not exists payments_person_idx
  on public.payments (org_id, profile_id, received_at);

/**
 * Whose money a memo is carrying.
 *
 * The person's own reference first, then any statement reference, because
 * references issued before this migration are printed on bills people are
 * holding and have to go on working. Longest match wins either way: one
 * reference can be a prefix of another.
 */
create or replace function private.payer_from_memo(p_org_id bigint, p_memo text)
returns uuid
language plpgsql
stable
set search_path to ''
as $function$
declare v_memo text; v_profile uuid;
begin
  v_memo := upper(regexp_replace(
              public.unaccent_fallback(coalesce(p_memo, '')), '[^A-Za-z0-9]', '', 'g'));
  if v_memo = '' then return null; end if;

  select m.profile_id into v_profile
    from public.memberships m
   where m.org_id = p_org_id
     and m.payment_ref is not null
     and position(m.payment_ref in v_memo) > 0
   order by length(m.payment_ref) desc
   limit 1;
  if v_profile is not null then return v_profile; end if;

  select st.profile_id into v_profile
    from public.billing_statements st
   where st.org_id = p_org_id
     and position(st.payment_ref in v_memo) > 0
   order by length(st.payment_ref) desc, st.billing_period_id desc
   limit 1;
  return v_profile;
end $function$;

-- ------------------------------------------------------------ the allocation

/**
 * Spread one person's credits across their weeks, oldest week first.
 *
 * Walks both sides in time order, so `paid_at` is the moment the payment that
 * actually finished a week arrived rather than the moment this function last
 * ran. Waived weeks are skipped entirely: waiving says nobody is being asked
 * for the money, so it consumes none of it.
 *
 * Leftover credit is not written anywhere. It is the difference between what
 * came in and what was allocated, which `v_account_balance` reads back as a
 * negative balance, and storing a second copy of a subtraction is how two
 * numbers start disagreeing.
 */
create or replace function private.reallocate(p_org_id bigint, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_credit   record;
  v_st       record;
  v_left     bigint := 0;   -- unspent part of the credit in hand
  v_at       timestamptz;   -- when that credit arrived
  v_need     bigint;
  v_take     bigint;
  v_got      bigint;
  v_finished timestamptz;
  v_credits  cursor for
    select p.amount_minor, p.received_at
      from public.payments p
     where p.org_id = p_org_id and p.profile_id = p_profile_id
     order by p.received_at, p.id;
begin
  open v_credits;
  fetch v_credits into v_credit;
  if found then v_left := v_credit.amount_minor; v_at := v_credit.received_at; end if;

  for v_st in
    select st.id, st.meals_minor
      from public.billing_statements st
      join public.billing_periods bp on bp.id = st.billing_period_id
     where st.org_id = p_org_id and st.profile_id = p_profile_id
       and st.status <> 'waived'
     order by bp.period_start, st.id
  loop
    v_need := v_st.meals_minor;
    v_got := 0;
    v_finished := null;

    while v_got < v_need and v_left > 0 loop
      v_take := least(v_need - v_got, v_left);
      v_got  := v_got + v_take;
      v_left := v_left - v_take;
      if v_got >= v_need then v_finished := v_at; end if;
      if v_left = 0 then
        fetch v_credits into v_credit;
        if found then v_left := v_credit.amount_minor; v_at := v_credit.received_at;
        else exit; end if;
      end if;
    end loop;

    update public.billing_statements set
      paid_minor = v_got,
      status     = case when v_got >= v_need then 'paid'
                        when v_got > 0       then 'partial'
                        else 'unpaid' end,
      paid_at    = case when v_got >= v_need then v_finished else null end
     where id = v_st.id;
  end loop;
  close v_credits;
end $function$;

/**
 * A payment now finds a person, and the person's weeks are redrawn.
 *
 * `matched_statement_id` is still written, because the Payments screen uses it
 * to say roughly where a payment landed and because a null there is how
 * "matched nobody" is asked for. A payment now spreads over several weeks, so
 * no single week is the honest answer: this picks the newest week the money
 * reached, preferring one it finished off. Read it as "how far this got", not
 * as "where this went".
 */
create or replace function public.trg_payment_apply()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_profile uuid; v_st bigint;
begin
  v_profile := private.payer_from_memo(new.org_id, new.memo);
  if v_profile is null then return null; end if;

  update public.payments set profile_id = v_profile where id = new.id;
  perform private.reallocate(new.org_id, v_profile);

  select st.id into v_st
    from public.billing_statements st
    join public.billing_periods bp on bp.id = st.billing_period_id
   where st.org_id = new.org_id and st.profile_id = v_profile
     and st.status <> 'waived'
   order by (st.status = 'paid') desc, bp.period_start desc, st.id desc
   limit 1;
  update public.payments set matched_statement_id = v_st where id = new.id;
  return null;
end $function$;

-- ------------------------------------------------------------- the statement

/**
 * A week now costs what that week's meals cost, and nothing else.
 *
 * `carried_in_minor` folded every earlier unpaid week into the newest one, so
 * the same debt sat on two statements at once and any sum over weeks counted
 * it twice. `leave_office` said as much in a comment and worked around it. The
 * carry is what the account balance is for, so the column goes to zero and
 * stays there; it is kept rather than dropped because `total_due_minor` is
 * generated from it and a generated column cannot be changed in place.
 */
update public.billing_statements set carried_in_minor = 0 where carried_in_minor <> 0;

create or replace function public.guard_no_carry_forward()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  -- Not a permission check. This is a column nothing should write again, and
  -- silently zeroing it is kinder than a constraint that fails a whole
  -- re-bill because one code path has not caught up.
  new.carried_in_minor := 0;
  return new;
end $function$;

drop trigger if exists billing_statements_no_carry on public.billing_statements;
create trigger billing_statements_no_carry
  before insert or update of carried_in_minor on public.billing_statements
  for each row execute function public.guard_no_carry_forward();

-- ------------------------------------------------------------- the balance

/**
 * What each person owes their office, or is owed by it.
 *
 * Positive is a debt. Negative is credit, which is what a top-up looks like
 * and needs no other machinery: money arrives, nothing is charged against it
 * yet, the balance goes below zero and next week's meals eat into it.
 */
create or replace view public.v_account_balance
with (security_invoker = true)
as
select
  m.org_id,
  m.profile_id,
  coalesce(c.charged_minor, 0) as charged_minor,
  coalesce(p.credited_minor, 0) as credited_minor,
  coalesce(c.charged_minor, 0) - coalesce(p.credited_minor, 0) as balance_minor
from public.memberships m
left join lateral (
  select sum(st.meals_minor) as charged_minor
    from public.billing_statements st
   where st.org_id = m.org_id and st.profile_id = m.profile_id
     and st.status <> 'waived'
) c on true
left join lateral (
  select sum(pay.amount_minor) as credited_minor
    from public.payments pay
   where pay.org_id = m.org_id and pay.profile_id = m.profile_id
) p on true;

grant select on public.v_account_balance to authenticated;

-- ------------------------------------------------- keeping it all in step

/**
 * Waiving a week changes what the person's credits have to cover, so the rest
 * of their weeks have to be redrawn.
 *
 * No recursion guard is needed and none is used: `reallocate` skips waived
 * rows, so it can never move a row into or out of `waived`, which is the only
 * thing this fires on.
 */
create or replace function public.trg_statement_waived()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform private.reallocate(new.org_id, new.profile_id);
  return null;
end $function$;

drop trigger if exists billing_statements_waived on public.billing_statements;
create trigger billing_statements_waived
  after update of status on public.billing_statements
  for each row
  when ((new.status = 'waived') is distinct from (old.status = 'waived'))
  execute function public.trg_statement_waived();

/**
 * What `run_billing` always did, minus the carry-forward.
 *
 * Moved behind a wrapper so the public function can redraw the allocation
 * afterwards without this long body growing a second concern. The carry
 * lookup is gone rather than zeroed: it walked to the previous period on
 * every statement and the answer is now discarded.
 */
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

  -- 3. roll lines up into statements. No carry: an older week that is still
  --    unpaid stays unpaid and the account balance adds it up once.
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
end $function$;

/**
 * Re-billing a week changes what it costs, so the allocation has to follow.
 *
 * Wrapped rather than rewritten: `run_billing` is long, every line of it is
 * about lines and statements, and the only thing this change asks of it is
 * one more step at the end.
 */
create or replace function public.run_billing(p_period_id bigint, p_force boolean default false)
returns table(lines integer, statements integer, total_minor bigint)
language plpgsql
security definer
set search_path to ''
as $function$
declare v_org bigint; v_person uuid;
begin
  return query select * from private.run_billing_inner(p_period_id, p_force);

  select bp.org_id into v_org from public.billing_periods bp where bp.id = p_period_id;
  for v_person in
    select distinct st.profile_id from public.billing_statements st
     where st.billing_period_id = p_period_id
  loop
    perform private.reallocate(v_org, v_person);
  end loop;
end $function$;

/**
 * Leaving is blocked by the account, not by a week.
 *
 * The old sum walked unpaid statements and had a comment explaining that it
 * could not add them up, because carry-forward put the same debt on two rows.
 * There is one number now.
 */
create or replace function public.leave_office(p_org_id bigint)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare v_me uuid := (select auth.uid()); v_role text; v_owed bigint; v_owners int;
begin
  select m.role into v_role from public.memberships m
   where m.org_id = p_org_id and m.profile_id = v_me and m.status = 'active';
  if not found then
    raise exception 'you are not a member of that office' using errcode = 'no_data_found';
  end if;

  select b.balance_minor into v_owed from public.v_account_balance b
   where b.org_id = p_org_id and b.profile_id = v_me;
  if coalesce(v_owed, 0) > 0 then
    raise exception 'you still owe this office money; settle up before you leave'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owners from public.memberships m
     where m.org_id = p_org_id and m.status = 'active' and m.role = 'owner';
    if v_owners <= 1 then
      raise exception 'you are the only owner; make somebody else an owner first, or delete the office'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  update public.memberships set status = 'inactive'
   where org_id = p_org_id and profile_id = v_me;
end $function$;

