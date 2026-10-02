-- A pass ends with its meal.
--
-- A pending pass stayed pending when its order stopped being placed: lunch
-- cancelled (trg_menu_cancelled), the member cancelling their own order, or an
-- admin removing the meal (remove_meal). The recipient could still accept it
-- on the table, since enforce_transfer_rules checked the order only on offer,
-- and transfer_decided then told the giver "took your lunch on 05/10, so it is
-- on their bill rather than yours" for a lunch that was not going to happen.
-- The money was right (a cancelled order bills nothing); the record and the
-- message were not.
--
-- Now an order leaving 'placed', by any path, withdraws its pending pass:
-- status 'cancelled', decided_at and decided_by (whoever cancelled the order),
-- and a reason saying why. Nobody is told, as for any withdrawal and as for
-- cancelling lunch. An order placed again (set_my_order reviving it, an
-- admin's correction, any path) withdraws a pending pass too: the offer was
-- for the meal that was cancelled, and left live it would put the new meal on
-- the recipient's bill.
--
-- Accepting a pass on an order that is not placed is refused, on the table and
-- through answer_pass, in words that say why. The recipient may still decline
-- it and the giver withdraw it, so an offer left waiting can be cleared; a
-- decline on an order that is not placed tells the giver nothing, since
-- "still on your bill" would be false. answer_pass refuses an admin's decline
-- there; the admin withdraws it instead.
--
-- An accepted pass is left alone when its order is cancelled: it happened,
-- and the cancelled order bills nobody, so nobody pays for it.
--
-- Lock order. A member's own cancel locks the order and then the pass, the
-- reverse of a member answering (the pass, then the office-week key). So the
-- withdrawal skips a pass another transaction holds rather than waiting on it
-- (SKIP LOCKED), and does not re-bill: a withdrawn pass bills as a pending one
-- did, and the re-bill would take the office-week key while holding the order.
-- The pass held elsewhere is being answered or withdrawn right then; if it is
-- accepted, it is accepted before the cancel, which leaves it alone anyway.
-- If that answer fails instead, the offer is left waiting on a cancelled order,
-- where it cannot be accepted, and placing the order again withdraws it.
-- remove_meal and trg_menu_cancelled take the pending passes before the key,
-- so neither waits on a pass while holding the week, and each re-bills itself.
--
-- An offer belongs to the placement it was made on. Placing the order again
-- also skips a pass somebody holds, so an admin's answer_pass waiting with the
-- leftover could otherwise accept it onto the new meal. orders.placed_at was
-- written only on insert, never on a revive, so it could not tell the two
-- placements apart; it now stamps every placement (insert, and every move
-- back to 'placed') and is kept as it was on any other update, whoever writes
-- it. Accepting a pass whose order was placed after the offer was made is
-- refused, on the table and in answer_pass, with no new lock: both read the
-- order after the pass. A pass's created_at is the moment of the offer, set
-- by enforce_transfer_rules, so neither stamp can be written to suit.

create or replace function private.withdraw_pending_pass(p_order_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  perform set_config('lunch.pass_withdrawn_with_meal', 'on', true);
  update public.meal_transfers t
     set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()),
         reason = coalesce(t.reason, p_reason)
   where t.id in (select x.id from public.meal_transfers x
                   where x.order_id = p_order_id and x.status = 'pending'
                     for no key update skip locked);
  perform set_config('lunch.pass_withdrawn_with_meal', '', true);
end $fn$;

revoke execute on function private.withdraw_pending_pass(bigint, text) from public, anon, authenticated;

-- A placement's moment, whoever writes the row.
create or replace function public.stamp_order_placement()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if tg_op = 'INSERT' then
    new.placed_at := now();
  elsif new.status = 'placed' and old.status <> 'placed' then
    new.placed_at := now();
  else
    new.placed_at := old.placed_at;
  end if;
  return new;
end $fn$;

revoke all on function public.stamp_order_placement() from public, anon, authenticated;

create trigger orders_placement_stamp
  before insert or update on public.orders
  for each row
  execute function public.stamp_order_placement();

-- On leaving 'placed' and on coming back to it. Coming back, a pending pass
-- can only be one a cancel skipped, so its reason is the cancel's.
create or replace function public.trg_order_withdraws_pass()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  perform private.withdraw_pending_pass(new.id,
    case when exists (select 1 from public.menus m
                       where m.id = new.menu_id and m.status = 'cancelled')
         then 'withdrawn: lunch on ' || to_char(new.service_date, 'DD/MM') || ' was cancelled'
         else 'withdrawn: the meal was cancelled' end);
  return null;
end $fn$;

revoke all on function public.trg_order_withdraws_pass() from public, anon, authenticated;

create trigger orders_withdraw_pass
  after update of status on public.orders
  for each row
  when ((old.status = 'placed') is distinct from (new.status = 'placed'))
  execute function public.trg_order_withdraws_pass();

-- As in 20261021100100; a decline on an order that is not placed tells the
-- giver nothing.
create or replace function public.trg_transfer_notifies()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_to   uuid;
  v_kind text;
  v_key  text;
  v_body text;
begin
  if current_setting('lunch.pass_by_admin', true) = 'on' then return null; end if;

  if tg_op = 'INSERT' then
    v_to   := new.to_profile_id;
    v_kind := 'transfer_offer';
    v_key  := 'org:' || new.org_id || ':transfer_offer:' || new.id;
    v_body := private.transfer_offer_message(new.id);
  else
    if not exists (select 1 from public.orders o
                    where o.id = new.order_id and o.status = 'placed') then
      return null;
    end if;
    v_to   := new.from_profile_id;
    v_kind := 'transfer_decided';
    v_key  := 'org:' || new.org_id || ':transfer_decided:' || new.id || ':' || new.status;
    v_body := private.transfer_decided_message(new.id);
  end if;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
  select new.org_id, v_key, v_kind, tl.chat_id, v_to, v_body, 'none'
    from public.memberships mem
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
   where mem.org_id = new.org_id
     and mem.profile_id = v_to
     and mem.status = 'active'
  on conflict (dedupe_key) do nothing;

  return null;
end $fn$;

-- As in 20261022100300, quiet for a pass withdrawn with its meal.
create or replace function public.trg_transfer_rebills()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_period bigint; o public.orders%rowtype;
begin
  if current_setting('lunch.pass_withdrawn_with_meal', true) = 'on' then return null; end if;

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

-- As in 20261022100300, taking the day's pending passes before the key, and
-- withdrawing any whose order a member cancelled while this waited.
create or replace function public.trg_menu_cancelled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_period bigint; v_status text;
begin
  perform 1 from public.meal_transfers t
    join public.orders o on o.id = t.order_id
   where o.menu_id = new.id and t.status = 'pending'
   order by t.id
     for no key update of t;

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

-- As in 20261022100100; accepting needs a placed order.
create or replace function public.enforce_transfer_rules()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_order public.orders%rowtype;
  v_uid   uuid := (select auth.uid());
  v_stage text;
begin
  if private.is_service() then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'order % not found', new.order_id; end if;

  -- Who first, so an admin on somebody else's pass is told where to go
  -- whatever the day.
  if tg_op = 'INSERT' and v_uid is distinct from v_order.profile_id then
    raise exception 'only the person who ordered can offer this meal; an admin records a pass on the Orders screen'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE'
     and v_uid is distinct from old.from_profile_id and v_uid is distinct from old.to_profile_id then
    raise exception 'only the two people on a pass can change it; an admin answers or undoes it on the Orders screen'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.billing_lines bl
               join public.billing_periods bp on bp.id = bl.billing_period_id
              where bl.order_id = new.order_id and bp.status = 'closed') then
    raise exception 'that meal is already on a closed bill'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_stage := private.order_stage(new.order_id);
  if v_stage = 'done' then
    raise exception 'lunch on % is over, so it can no longer be passed to anybody',
      to_char(v_order.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'INSERT' then
    if v_order.status <> 'placed' then
      raise exception 'cannot transfer a % order', v_order.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.org_id          := v_order.org_id;
    new.from_profile_id := v_order.profile_id;
    new.created_by      := v_uid;
    new.created_at      := now();
    new.status          := 'pending';
    new.decided_at      := null;
    new.decided_by      := null;
    new.undone_at       := null;
    new.undone_by       := null;

  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      -- Before whether it is still pending: a pass withdrawn with its meal
      -- says why, not only that it is cancelled.
      if new.status = 'accepted' and v_uid is not distinct from old.to_profile_id then
        if v_stage = 'cancelled' then
          raise exception 'lunch on % was cancelled', to_char(v_order.service_date, 'DD/MM')
            using errcode = 'object_not_in_prerequisite_state';
        end if;
        if v_order.status <> 'placed' then
          raise exception 'the lunch on % offered to you was cancelled, so there is no meal to accept',
            to_char(v_order.service_date, 'DD/MM')
            using errcode = 'object_not_in_prerequisite_state';
        end if;
        if v_order.placed_at > old.created_at then
          raise exception 'the lunch on % was ordered again after this offer, so the offer no longer stands',
            to_char(v_order.service_date, 'DD/MM')
            using errcode = 'object_not_in_prerequisite_state';
        end if;
      end if;
      if old.status <> 'pending' then
        raise exception 'this transfer is already %', old.status
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      if new.status not in ('accepted', 'declined', 'cancelled') then
        raise exception 'a pass can only be accepted, declined or withdrawn'
          using errcode = 'check_violation';
      end if;
      if new.status in ('accepted', 'declined') and v_uid is distinct from old.to_profile_id then
        raise exception 'only the person receiving the meal can accept or decline it'
          using errcode = 'insufficient_privilege';
      end if;
      if new.status = 'cancelled' and v_uid is distinct from old.from_profile_id then
        raise exception 'only the person who offered the meal can cancel it'
          using errcode = 'insufficient_privilege';
      end if;
      new.decided_at := now();
      new.decided_by := v_uid;
    end if;
  end if;
  return new;
end $function$;


-- As in 20261021100100; declining needs a placed order too.
create or replace function public.answer_pass(
  p_transfer_id bigint, p_answer text, p_reason text default null)
returns table(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  t        public.meal_transfers%rowtype;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
  v_new    text;
  v_event  text;
  v_kind   text;
begin
  select * into t from public.meal_transfers where id = p_transfer_id;
  if not found or not (t.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  case p_answer
    when 'accept'   then v_new := 'accepted';  v_event := 'accepted';  v_kind := 'pass';
    when 'decline'  then v_new := 'declined';  v_event := 'declined';  v_kind := 'pass_declined';
    when 'withdraw' then v_new := 'cancelled'; v_event := 'withdrawn'; v_kind := 'pass_withdrawn';
    else
      raise exception 'an offer is answered with accept, decline or withdraw'
        using errcode = 'check_violation';
  end case;

  select * into o from public.orders where id = t.order_id;
  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  select * into t from public.meal_transfers where id = p_transfer_id for no key update;
  v_period := private.correction_period(t.org_id, o.service_date);
  select * into o from public.orders where id = t.order_id for no key update;

  if t.status <> 'pending' then
    raise exception 'that offer has already been answered: it is %',
      case t.status when 'cancelled' then 'withdrawn' else t.status end
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_new in ('accepted', 'declined') and o.status <> 'placed' then
    raise exception 'nothing is recorded for % on %, so there is no meal to %',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
      case v_new when 'accepted' then 'accept' else 'turn down' end
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_new = 'accepted' then
    if o.placed_at > t.created_at then
      raise exception 'the lunch on % was ordered again after this offer, so the offer no longer stands',
        to_char(o.service_date, 'DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if not exists (select 1 from public.memberships m
                    where m.org_id = t.org_id and m.profile_id = t.to_profile_id
                      and m.status = 'active') then
      raise exception '% is no longer in this office, so the offer cannot be accepted for them',
        private.member_name(t.org_id, t.to_profile_id)
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  perform set_config('lunch.pass_by_admin', 'on', true);
  update public.meal_transfers x
     set status = v_new, decided_at = now(), decided_by = v_actor
   where x.id = p_transfer_id;
  perform set_config('lunch.pass_by_admin', '', true);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (t.org_id, o.service_date, v_kind, o.id, o.profile_id, t.id,
          private.pass_summary(t.id, v_event), v_reason, v_actor);

  perform private.enqueue_pass(t.id, v_period, v_actor, v_reason, v_event);

  return query select t.id,
                      private.account_balance(t.org_id, t.from_profile_id),
                      private.account_balance(t.org_id, t.to_profile_id);
end $fn$;


-- As in 20261021100000, taking the pending pass before the office-week key.
create or replace function public.remove_meal(
  p_order_id bigint, p_reason text default null)
returns table(balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
begin
  -- A missing order and another office's get the same answer, so an id
  -- cannot be probed across offices.
  select * into o from public.orders where id = p_order_id;
  if not found or not (o.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  -- The pass row before the office-week key, as a member answering it takes
  -- them; the withdrawal below then waits on nobody.
  perform 1 from public.meal_transfers t
    where t.order_id = p_order_id and t.status = 'pending'
      for no key update;

  v_period := private.correction_period(o.org_id, o.service_date);

  select * into o from public.orders where id = p_order_id for no key update;
  if o.status <> 'placed' then
    raise exception 'nothing is recorded for that person on %, so there is nothing to remove',
      to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.orders x
     set status = 'cancelled', cancelled_at = now()
   where x.id = p_order_id;

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (o.org_id, o.service_date, 'removal', p_order_id, o.profile_id,
          private.order_summary(p_order_id), v_reason, v_actor);

  perform private.enqueue_correction(p_order_id, v_period, v_actor, v_reason, 'removal');

  return query select private.account_balance(o.org_id, o.profile_id);
end $fn$;

