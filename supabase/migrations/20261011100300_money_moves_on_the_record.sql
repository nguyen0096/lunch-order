-- Money moves on the record, through three doors, and nowhere else.
--
-- `payments_admin`, `billing_statements_admin` and `billing_lines_admin` were
-- `for all`, and `authenticated` held INSERT, UPDATE and DELETE on all three.
-- An admin could therefore PATCH `paid_minor` on a statement, reassign a
-- payment's `profile_id`, or delete one outright: no row in any audit table,
-- no reallocation, and every other number on the screen silently disagreeing
-- with the one they changed. They could also INSERT a payment claiming to be
-- `provider = 'sepay'` with a `provider_txn_id` of their choosing; when SePay
-- later delivered the real transfer with that id, `on conflict do nothing`
-- swallowed it as a redelivery, and the money that actually arrived was never
-- recorded. `billing_periods_admin` was the same, and deleting a period
-- cascades to every statement in it.
--
-- What an admin legitimately does to money is now three RPCs, each checking
-- that the caller is an admin (or owner) of the office, each writing a row to
-- `payment_corrections`, and each leaving the allocation redrawn:
--
--   move_payment     a payment belongs to somebody else in the office, or to
--                    somebody at all when it matched nobody
--   void_payment     a payment an admin recorded by hand was a mistake
--   waive_statement  the office stops asking for one person's week
--
-- Recording cash stays a direct INSERT, because it is already the one write
-- that goes through `trg_payment_apply` like the bank's own; but only as
-- `provider = 'manual'`, only for somebody in the office, and only in the
-- columns a manual payment has.
--
-- Not `order_corrections`. That table is about a meal on a day: `service_date`
-- is NOT NULL, `kind` is a meal-shaped CHECK and the Corrections screen reads
-- every row of it as one. A payment has no service date, and folding it in
-- would teach that screen about money it does not show.
--
-- Also here, because it is the same arithmetic: `private.reallocate` takes a
-- lock per person (two writers redrawing the same person's weeks at once each
-- wrote a complete allocation from a stale read, and the later one won), and
-- the private helpers that move money stop being executable by PUBLIC.

------------------------------------------------------------------- void

alter table public.payments
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.payments drop constraint if exists payments_void_ck;
alter table public.payments add constraint payments_void_ck check (
  (voided_at is null and voided_by is null and void_reason is null)
  or (voided_at is not null and voided_by is not null and void_reason is not null));

comment on column public.payments.voided_at is
  'Set by void_payment. A voided payment stays on record and counts towards nobody.';

create index if not exists payments_voided_by_idx on public.payments (voided_by)
  where voided_by is not null;

------------------------------------------------------------- the record

create table if not exists public.payment_corrections (
  id              bigint generated always as identity primary key,
  org_id          bigint not null references public.organizations(id) on delete cascade,
  kind            text   not null check (kind in ('move','void','waive')),
  payment_id      bigint references public.payments(id),
  -- A waived statement can later be deleted by the billing run if every line
  -- under it goes, and the record of the waiver outlives it.
  statement_id    bigint references public.billing_statements(id) on delete set null,
  from_profile_id uuid   references public.profiles(id),
  to_profile_id   uuid   references public.profiles(id),
  amount_minor    bigint not null,
  summary         text   not null,
  reason          text check (reason is null
                              or (length(btrim(reason)) >= 1 and length(btrim(reason)) <= 200)),
  made_by         uuid   not null references public.profiles(id),
  made_at         timestamptz not null default now(),
  constraint payment_corrections_shape_ck check (
    case kind
      when 'waive' then payment_id is null
      else payment_id is not null
    end)
);

create index if not exists payment_corrections_org_idx
  on public.payment_corrections (org_id, made_at desc);
create index if not exists payment_corrections_payment_idx
  on public.payment_corrections (payment_id);
create index if not exists payment_corrections_statement_idx
  on public.payment_corrections (statement_id);
create index if not exists payment_corrections_from_idx
  on public.payment_corrections (from_profile_id);
create index if not exists payment_corrections_to_idx
  on public.payment_corrections (to_profile_id);
create index if not exists payment_corrections_made_by_idx
  on public.payment_corrections (made_by);

alter table public.payment_corrections enable row level security;

revoke all on public.payment_corrections from anon, authenticated;
grant select on public.payment_corrections to authenticated;

drop policy if exists payment_corrections_admin_select on public.payment_corrections;
create policy payment_corrections_admin_select on public.payment_corrections
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

comment on table public.payment_corrections is
  'One row per admin change to money: move_payment, void_payment, waive_statement. Written only by those RPCs.';

------------------------------------------------------ the doors that close

revoke insert, update, delete on
  public.payments, public.billing_statements, public.billing_lines, public.billing_periods
  from authenticated;

grant insert (org_id, provider, provider_txn_id, profile_id, amount_minor, memo, received_at, raw)
  on public.payments to authenticated;

drop policy if exists payments_admin on public.payments;
drop policy if exists payments_admin_select on public.payments;
drop policy if exists payments_admin_insert_manual on public.payments;

create policy payments_admin_select on public.payments
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

create policy payments_admin_insert_manual on public.payments
  for insert to authenticated
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[])
              and provider = 'manual'
              and (profile_id is null
                   or exists (select 1 from public.memberships m
                               where m.org_id = public.payments.org_id
                                 and m.profile_id = public.payments.profile_id)));

drop policy if exists billing_statements_admin on public.billing_statements;
create policy billing_statements_admin on public.billing_statements
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

drop policy if exists billing_lines_admin on public.billing_lines;
create policy billing_lines_admin on public.billing_lines
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

drop policy if exists billing_periods_admin on public.billing_periods;
create policy billing_periods_admin on public.billing_periods
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

---------------------------------------------------------- the arithmetic

-- Unchanged from 20261007090000 but for two things: the lock at the top, and
-- a voided payment no longer counting as money in hand.
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
  'Matches payments to weeks, oldest first, settled weeks served first so a later charge cannot unsettle them. Locks the person.';

-- In profile order, so that it takes the per-person locks in the same order
-- move_payment does and the two cannot deadlock on each other.
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
     order by 1
  loop
    perform private.reallocate(v_org, v_person);
  end loop;
end $function$;

/**
 * The newest week a person's money has reached, for `matched_statement_id`.
 *
 * The old pick was `order by (status = 'paid') desc, period_start desc`: any
 * paid week beat the week the money actually got to, so a payment that
 * finished off March and half of April pointed at a paid week from January if
 * that was the newest paid one. The frontier is the newest week holding any of
 * the money. None at all, for a top-up, is null.
 */
create or replace function private.payment_frontier(p_org_id bigint, p_profile_id uuid)
returns bigint
language sql
stable
set search_path to ''
as $fn$
  select st.id
    from public.billing_statements st
    join public.billing_periods bp on bp.id = st.billing_period_id
   where st.org_id = p_org_id and st.profile_id = p_profile_id
     and st.status <> 'waived' and st.paid_minor > 0
   order by bp.period_start desc, st.id desc
   limit 1;
$fn$;

revoke execute on function private.payment_frontier(bigint, uuid) from public, anon, authenticated;

-- The memo still decides first. What changed: when it names nobody, the person
-- the admin named on the row is who the money belongs to, and their weeks are
-- redrawn. Before, that row kept its `profile_id` and counted on the balance
-- while the allocation never heard about it.
create or replace function public.trg_payment_apply()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_profile uuid;
begin
  v_profile := coalesce(private.payer_from_memo(new.org_id, new.memo), new.profile_id);
  if v_profile is null then return null; end if;

  if new.profile_id is distinct from v_profile then
    update public.payments set profile_id = v_profile where id = new.id;
  end if;
  perform private.reallocate(new.org_id, v_profile);
  update public.payments
     set matched_statement_id = private.payment_frontier(new.org_id, v_profile)
   where id = new.id;
  return null;
end $function$;

revoke execute on function public.trg_payment_apply() from public, anon, authenticated;

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
     and pay.voided_at is null
) p on true;

-- Supabase's default privileges handed anon and authenticated everything on
-- this view when it was created, TRUNCATE and TRIGGER included.
revoke all on public.v_account_balance from anon, authenticated;
grant select on public.v_account_balance to authenticated;

--------------------------------------------------------------- the doors

create or replace function public.move_payment(
  p_payment_id bigint, p_to_profile_id uuid, p_reason text default null)
returns table(payment_id bigint, profile_id uuid, matched_statement_id bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_pay    public.payments%rowtype;
  v_org    public.organizations%rowtype;
  v_from   uuid;
  v_st     bigint;
  v_money  text;
begin
  select * into v_pay from public.payments p where p.id = p_payment_id for update;
  if not found or not (v_pay.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can move a payment'
      using errcode = 'insufficient_privilege';
  end if;
  v_reason := private.short_text(p_reason, 200, 'reason');

  if v_pay.voided_at is not null then
    raise exception 'that payment was voided, so there is no money in it to move'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.org_id = v_pay.org_id and m.profile_id = p_to_profile_id) then
    raise exception 'that person is not in this office' using errcode = 'no_data_found';
  end if;
  if v_pay.profile_id is not distinct from p_to_profile_id then
    raise exception 'that payment is already on %', private.member_name(v_pay.org_id, p_to_profile_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Before this function existed, applying a stray recorded a second, manual
  -- row carrying the stray's id and left the stray on nobody. Moving the stray
  -- as well would count that one arrival twice.
  if exists (select 1 from public.payments r
              where r.org_id = v_pay.org_id and r.provider = 'manual'
                and r.voided_at is null
                and r.raw ->> 'resolves_payment_id' = v_pay.id::text) then
    raise exception 'that payment was already applied by recording a copy of it; move the copy instead'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_from := v_pay.profile_id;
  select * into v_org from public.organizations o where o.id = v_pay.org_id;
  v_money := private.money_text(v_pay.amount_minor, v_org.currency_minor_units, v_org.currency);

  if v_from is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'lunch.reallocate:' || v_pay.org_id || ':' || least(v_from, p_to_profile_id), 0));
    perform pg_advisory_xact_lock(hashtextextended(
      'lunch.reallocate:' || v_pay.org_id || ':' || greatest(v_from, p_to_profile_id), 0));
  end if;

  update public.payments p set profile_id = p_to_profile_id where p.id = v_pay.id;
  if v_from is not null then perform private.reallocate(v_pay.org_id, v_from); end if;
  perform private.reallocate(v_pay.org_id, p_to_profile_id);

  v_st := private.payment_frontier(v_pay.org_id, p_to_profile_id);
  update public.payments p set matched_statement_id = v_st where p.id = v_pay.id;

  insert into public.payment_corrections
    (org_id, kind, payment_id, from_profile_id, to_profile_id, amount_minor, summary, reason, made_by)
  values (v_pay.org_id, 'move', v_pay.id, v_from, p_to_profile_id, v_pay.amount_minor,
          case when v_from is null
               then 'Applied ' || v_money || ' that matched nobody to '
                    || private.member_name(v_pay.org_id, p_to_profile_id)
               else 'Moved ' || v_money || ' from ' || private.member_name(v_pay.org_id, v_from)
                    || ' to ' || private.member_name(v_pay.org_id, p_to_profile_id)
          end,
          v_reason, v_actor);

  return query select v_pay.id, p_to_profile_id, v_st;
end $fn$;

create or replace function public.void_payment(p_payment_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_pay    public.payments%rowtype;
  v_org    public.organizations%rowtype;
begin
  select * into v_pay from public.payments p where p.id = p_payment_id for update;
  if not found or not (v_pay.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can void a payment'
      using errcode = 'insufficient_privilege';
  end if;
  v_reason := private.short_text(p_reason, 200, 'reason');
  if v_reason is null then
    raise exception 'say why this payment is being voided; the next admin to read the record will ask'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_pay.provider <> 'manual' then
    raise exception 'only a payment recorded by hand can be voided; money the bank reported did arrive, so move it to the right person instead'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_pay.voided_at is not null then
    raise exception 'that payment is already voided' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.payments p
     set voided_at = now(), voided_by = v_actor, void_reason = v_reason,
         matched_statement_id = null
   where p.id = v_pay.id;
  if v_pay.profile_id is not null then
    perform private.reallocate(v_pay.org_id, v_pay.profile_id);
  end if;

  select * into v_org from public.organizations o where o.id = v_pay.org_id;
  insert into public.payment_corrections
    (org_id, kind, payment_id, from_profile_id, amount_minor, summary, reason, made_by)
  values (v_pay.org_id, 'void', v_pay.id, v_pay.profile_id, v_pay.amount_minor,
          'Voided ' || private.money_text(v_pay.amount_minor, v_org.currency_minor_units, v_org.currency)
            || ' recorded by hand'
            || coalesce(' for ' || private.member_name(v_pay.org_id, v_pay.profile_id), ''),
          v_reason, v_actor);
end $fn$;

-- `paid_at` goes back to null because `billing_statements_paid_ck` ties it to
-- status 'paid'. `trg_statement_waived` redraws the person's other weeks.
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
  select * into v_st from public.billing_statements s where s.id = p_statement_id for update;
  if not found or not (v_st.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can waive a week'
      using errcode = 'insufficient_privilege';
  end if;
  v_reason := private.short_text(p_reason, 200, 'reason');
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

revoke execute on function public.move_payment(bigint, uuid, text) from public, anon;
grant  execute on function public.move_payment(bigint, uuid, text) to authenticated;
revoke execute on function public.void_payment(bigint, text)       from public, anon;
grant  execute on function public.void_payment(bigint, text)       to authenticated;
revoke execute on function public.waive_statement(bigint, text)    from public, anon;
grant  execute on function public.waive_statement(bigint, text)    to authenticated;

------------------------------------------------------ nothing else is an API

-- NULL ACLs, which mean PUBLIC holds EXECUTE. `private` is not exposed by
-- PostgREST, but `authenticated` has USAGE on it, and a function that rewrites
-- somebody's bill should not be one schema setting away from a browser.
revoke execute on function private.reallocate(bigint, uuid)             from public, anon, authenticated;
revoke execute on function private.run_billing_inner(bigint, boolean)   from public, anon, authenticated;
revoke execute on function private.payer_from_memo(bigint, text)        from public, anon, authenticated;
revoke execute on function private.payment_ref(bigint, date, uuid)      from public, anon, authenticated;
revoke execute on function private.menu_message(bigint)                 from public, anon, authenticated;
revoke execute on function private.cutoff_message(bigint)               from public, anon, authenticated;

-- A trigger function, reachable at /rest/v1/rpc/refuse_reopen since
-- 20261006100000 because that migration carried no revoke.
revoke execute on function public.refuse_reopen() from public, anon, authenticated;
