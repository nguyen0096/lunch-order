-- Leaving an office, or being removed from it, cancels the person's open orders.
--
-- A membership going inactive left every order already created placed. The
-- Board lists active members only, but its day total, the caterer's count and
-- the bill all read the orders, so the meal of somebody who had gone was
-- cooked and charged with nobody seeing it.
--
-- The owner's rule: an order is cancelled when its day is still open for
-- ordering, which is the window the person could have cancelled it in
-- themselves (`enforce_order_window`: the menu published and its cutoff
-- ahead). Past the cutoff the caterer may already have the count, so those
-- orders stay placed and billed, as before.
--
-- Not cancelled either: an order the person passed on and somebody accepted.
-- That meal is the recipient's now, and they are still here to eat it.
--
-- Every path that makes a membership inactive goes through one trigger on
-- `memberships`: `leave_office`, an admin's Remove (a PATCH on the row), and
-- the service role by hand. `leave_office` also cancels before it checks what
-- is owed, so a meal that leaving takes off the bill is not a debt that keeps
-- the person from leaving; a refusal rolls the cancellation back with it.
-- `my_balance_after_leaving` answers the same question for Settings, by doing
-- the same thing and rolling it back.
--
-- The cancellation is the ordinary one: `status = cancelled`, the pending pass
-- on the meal withdrawn, the week re-billed so every statement is still the sum
-- of its lines. Rejoining reactivates the row and revives nothing:
-- `materialize_standing_orders` never writes into a slot that has a row.
--
-- Nothing may place an order for somebody while they go, or after. Leaving
-- holds the membership row, so every path that places or revives an order
-- holds it too, FOR SHARE, before anything else, and refuses somebody who is no
-- longer active: `set_my_order`, the two corrections, an accepted pass in
-- `record_pass` and `answer_pass`, `undo_pass` putting a meal back on its giver
-- while the day is open, and a browser's own write to `orders`. A
-- publish needs no row lock: it holds the publish lock, which leaving takes.

-- The membership's status, its row held FOR SHARE until the transaction ends;
-- null when there is none. Leaving holds the row FOR NO KEY UPDATE, so this
-- waits for a leaving in flight and then reads what it left.
create or replace function private.hold_membership(p_org_id bigint, p_profile_id uuid)
returns text
language sql security definer set search_path to '' as $fn$
  select m.status from public.memberships m
   where m.org_id = p_org_id and m.profile_id = p_profile_id
     for share;
$fn$;

-- `guard_order_member` runs as the browser, so the browser role executes this;
-- `private` is not exposed through the API, so no request can call it.
revoke execute on function private.hold_membership(bigint, uuid) from public, anon;
grant execute on function private.hold_membership(bigint, uuid) to authenticated;

create or replace function private.cancel_leavers_open_orders(
  p_org_ids bigint[], p_profile_ids uuid[])
returns integer
language plpgsql security definer set search_path to '' as $fn$
declare
  v_orders  bigint[];
  v_periods bigint[];
  v_n       integer;
  r         record;
begin
  -- The publish lock first, so a publish in flight finishes (and its standing
  -- orders become visible here) or waits until the membership is inactive.
  for r in select distinct w.org_id from unnest(p_org_ids) as w(org_id) order by 1 loop
    perform private.lock_office_materialize(r.org_id);
  end loop;

  perform 1 from public.menus m
   where m.id in (select o.menu_id
                    from public.orders o
                    join unnest(p_org_ids, p_profile_ids) as w(org_id, profile_id)
                      on w.org_id = o.org_id and w.profile_id = o.profile_id
                   where o.status = 'placed')
     and m.status = 'published' and m.order_cutoff_at > now()
   order by m.org_id, m.service_date, m.id
     for share;

  select array_agg(o.id order by o.id) into v_orders
    from public.orders o
    join unnest(p_org_ids, p_profile_ids) as w(org_id, profile_id)
      on w.org_id = o.org_id and w.profile_id = o.profile_id
    join public.menus m on m.id = o.menu_id
   where o.status = 'placed'
     and m.status = 'published' and m.order_cutoff_at > now();
  if v_orders is null then return 0; end if;

  perform 1 from public.meal_transfers t
   where t.order_id = any (v_orders) and t.status = 'pending'
   order by t.id
     for no key update;

  for r in
    select distinct o.org_id, o.service_date from public.orders o
     where o.id = any (v_orders) order by 1, 2
  loop
    perform private.lock_office_week(r.org_id, r.service_date);
  end loop;

  for r in
    select distinct bp.id, bp.org_id, bp.period_start
      from public.billing_periods bp
      join public.orders o
        on o.org_id = bp.org_id and o.service_date between bp.period_start and bp.period_end
     where o.id = any (v_orders) and bp.status <> 'void'
     order by bp.org_id, bp.period_start
  loop
    perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), r.id::int);
  end loop;

  perform 1 from public.orders o where o.id = any (v_orders) order by o.id for no key update;

  -- Read again under the locks. The guards exempt this function, so it keeps
  -- out of a settled week itself, though an open day cannot be in one today.
  select array_agg(o.id order by o.id) into v_orders
    from public.orders o
   where o.id = any (v_orders)
     and o.status = 'placed'
     and not exists (select 1 from public.meal_transfers t
                      where t.order_id = o.id and t.status = 'accepted')
     and not exists (select 1 from public.billing_periods bp
                      where bp.org_id = o.org_id and bp.status = 'closed'
                        and o.service_date between bp.period_start and bp.period_end);
  if v_orders is null then return 0; end if;

  perform private.withdraw_pending_pass(o.id,
            case when ms.removed_at is null
                 then 'withdrawn: the meal was cancelled when its owner left the office'
                 else 'withdrawn: the meal was cancelled when its owner was removed from the office'
            end)
     from public.orders o
     join public.memberships ms on ms.org_id = o.org_id and ms.profile_id = o.profile_id
    where o.id = any (v_orders)
      and exists (select 1 from public.meal_transfers t
                   where t.order_id = o.id and t.status = 'pending');

  update public.orders o
     set status = 'cancelled', cancelled_at = now()
   where o.id = any (v_orders);
  get diagnostics v_n = row_count;

  select array_agg(x.id order by x.org_id, x.period_start) into v_periods
    from (select distinct bp.id, bp.org_id, bp.period_start
            from public.billing_periods bp
            join public.orders o
              on o.org_id = bp.org_id and o.service_date between bp.period_start and bp.period_end
           where o.id = any (v_orders) and bp.status not in ('closed', 'void')) x;

  for r in select p.id from unnest(coalesce(v_periods, '{}'::bigint[])) with ordinality as p(id, n)
            order by p.n loop
    perform public.run_billing(r.id);
  end loop;

  return v_n;
end $fn$;

revoke execute on function private.cancel_leavers_open_orders(bigint[], uuid[])
  from public, anon, authenticated;

-- Statement-level, so a hand-made UPDATE removing several people takes every
-- lock in one pass and in one order. A transition table rules out `UPDATE OF
-- status`, so it fires on every update and finds nobody most of the time.
create or replace function public.trg_membership_leaves()
returns trigger
language plpgsql security definer set search_path to '' as $fn$
declare v_orgs bigint[]; v_people uuid[];
begin
  select array_agg(n.org_id order by n.org_id, n.profile_id),
         array_agg(n.profile_id order by n.org_id, n.profile_id)
    into v_orgs, v_people
    from gone_new n
    join gone_old o on o.id = n.id
   where o.status = 'active' and n.status = 'inactive';
  if v_orgs is not null then
    perform private.cancel_leavers_open_orders(v_orgs, v_people);
  end if;
  return null;
end $fn$;

revoke execute on function public.trg_membership_leaves() from public, anon, authenticated;

-- A browser placing an order, or placing a cancelled one again, straight on
-- the table: the member's own row, or an admin's. The functions that do it run
-- as the owner and hold the membership themselves, earlier, in lock order.
create or replace function public.guard_order_member()
returns trigger
language plpgsql set search_path to '' as $fn$
begin
  if private.is_service() then return new; end if;
  -- Another office's row is for RLS to refuse, in its own words, before this
  -- reads or holds anybody's membership there.
  if not (new.org_id = any ((select private.my_org_ids())::bigint[])) then return new; end if;
  if new.status = 'placed' and (tg_op = 'INSERT' or old.status is distinct from 'placed')
     and private.hold_membership(new.org_id, new.profile_id) is distinct from 'active' then
    raise exception 'that person is not a member of this office'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $fn$;

revoke execute on function public.guard_order_member() from public, anon, authenticated;

drop trigger if exists orders_for_a_member on public.orders;
create trigger orders_for_a_member
  before insert or update of status on public.orders
  for each row execute function public.guard_order_member();

drop trigger if exists memberships_leaving_cancels on public.memberships;
create trigger memberships_leaving_cancels
  after update on public.memberships
  referencing old table as gone_old new table as gone_new
  for each statement execute function public.trg_membership_leaves();

-- Unchanged but for the order: the membership row is held first, as an admin's
-- Remove holds it, and the open orders are cancelled before the debt is read.
-- It answers how many it cancelled, so the bot can say so.
drop function if exists public.leave_office(bigint);
create function public.leave_office(p_org_id bigint)
returns integer language plpgsql security definer set search_path to '' as $fn$
declare v_me uuid := (select auth.uid()); v_role text; v_owed bigint; v_owners int; v_n int;
begin
  select m.role into v_role from public.memberships m
   where m.org_id = p_org_id and m.profile_id = v_me and m.status = 'active'
     for no key update;
  if not found then
    raise exception 'you are not a member of that office' using errcode = 'no_data_found';
  end if;

  if v_role = 'owner' then
    select count(*) into v_owners from public.memberships m
     where m.org_id = p_org_id and m.status = 'active' and m.role = 'owner';
    if v_owners <= 1 then
      raise exception 'you are the only owner; make somebody else an owner first, or delete the office'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  v_n := private.cancel_leavers_open_orders(array[p_org_id], array[v_me]);

  select b.balance_minor into v_owed from public.v_account_balance b
   where b.org_id = p_org_id and b.profile_id = v_me;
  if coalesce(v_owed, 0) > 0 then
    raise exception 'you still owe this office money; settle up before you leave'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.memberships set status = 'inactive'
   where org_id = p_org_id and profile_id = v_me;
  return v_n;
end $fn$;

revoke execute on function public.leave_office(bigint) from public, anon;
grant execute on function public.leave_office(bigint) to authenticated;

-- What leave_office would find you owe: the balance once your open orders are
-- cancelled and their weeks re-billed. It does exactly that and rolls it back,
-- so the number is the one the refusal reads, stale lines in the week included.
create or replace function public.my_balance_after_leaving(p_org_id bigint)
returns bigint language plpgsql security definer set search_path to '' as $fn$
declare v_me uuid := (select auth.uid()); v_balance bigint;
begin
  perform 1 from public.memberships m
   where m.org_id = p_org_id and m.profile_id = v_me and m.status = 'active';
  if not found then
    raise exception 'you are not a member of that office' using errcode = 'no_data_found';
  end if;

  begin
    perform 1 from public.memberships m
     where m.org_id = p_org_id and m.profile_id = v_me
       for no key update;
    perform private.cancel_leavers_open_orders(array[p_org_id], array[v_me]);
    v_balance := private.account_balance(p_org_id, v_me);
    raise exception using errcode = 'LDRY1';
  exception when sqlstate 'LDRY1' then
    null;
  end;
  return v_balance;
end $fn$;

revoke execute on function public.my_balance_after_leaving(bigint) from public, anon;
grant execute on function public.my_balance_after_leaving(bigint) to authenticated;

-- From here, the paths that place an order, each holding the membership first.
-- Each is its previous definition with that added.

create or replace function public.set_my_order(p_menu_id bigint, p_menu_item_id bigint, p_note text DEFAULT NULL::text)
 RETURNS TABLE(order_id bigint, item_name_snapshot text, line_total_minor integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_menu  public.menus%rowtype;
  v_order public.orders%rowtype;
  v_tz    text;
  v_note  text := nullif(btrim(p_note), '');
  v_name  text;
  v_total integer;
  v_org   bigint;
begin
  -- The caller's membership before the menu, as leaving holds it: an order
  -- placed while its owner is leaving would otherwise land after the
  -- cancellation looked, on somebody who is no longer here.
  select m.org_id into v_org from public.menus m where m.id = p_menu_id;
  if v_uid is not null and v_org is not null
     and private.hold_membership(v_org, v_uid) is distinct from 'active' then
    raise exception 'you are not a member of that office'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_menu from public.menus m where m.id = p_menu_id for share;
  if not found then
    raise exception 'that menu is gone' using errcode = 'no_data_found';
  end if;
  if v_uid is null or not (v_menu.org_id = any ((select private.my_org_ids())::bigint[])) then
    raise exception 'you are not a member of that office'
      using errcode = 'insufficient_privilege';
  end if;

  if v_menu.status = 'cancelled' then
    raise exception 'the menu for % was cancelled',
      to_char(v_menu.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform private.assert_week_open(v_menu.org_id, v_menu.service_date);

  select * into v_order from public.orders o
   where o.menu_id = v_menu.id and o.profile_id = v_uid
     for update;

  -- enforce_order_window: only an admin's own 'admin' order is off the clock.
  if not (v_order.source is not distinct from 'admin'
          and v_menu.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    if v_menu.status <> 'published' then
      raise exception 'the menu for % is %, not open for ordering',
        to_char(v_menu.service_date, 'DD/MM'), v_menu.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if now() >= v_menu.order_cutoff_at then
      select o.timezone into v_tz from public.organizations o where o.id = v_menu.org_id;
      raise exception 'ordering for % closed at %',
        to_char(v_menu.service_date, 'DD/MM'),
        to_char(v_menu.order_cutoff_at at time zone v_tz, 'HH24:MI DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  if v_order.id is null then
    insert into public.orders as o
      (org_id, menu_id, service_date, profile_id, created_by, source)
    values (v_menu.org_id, v_menu.id, v_menu.service_date, v_uid, v_uid, 'member')
    on conflict (menu_id, profile_id) do nothing
    returning o.* into v_order;

    -- A standing order materialized between the read and the insert.
    if v_order.id is null then
      select * into v_order from public.orders o
       where o.menu_id = v_menu.id and o.profile_id = v_uid
         for update;
    end if;
  end if;

  if v_order.status = 'cancelled' then
    update public.orders o
       set status = 'placed', cancelled_at = null
     where o.id = v_order.id;
  end if;

  delete from public.order_items oi where oi.order_id = v_order.id;

  if p_menu_item_id is not null then
    insert into public.order_items as oi
      (order_id, org_id, profile_id, menu_id, menu_item_id, note,
       item_name_snapshot, unit_price_minor)
    values (v_order.id, v_menu.org_id, v_uid, v_menu.id, p_menu_item_id, v_note, '', 0)
    returning oi.item_name_snapshot, oi.line_total_minor into v_name, v_total;
  elsif private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                          v_menu.order_cutoff_at) = 'open' then
    perform private.assign_only_dish(v_menu.id, v_order.id);
    select oi.item_name_snapshot, oi.line_total_minor into v_name, v_total
      from public.order_items oi where oi.order_id = v_order.id;
  end if;

  return query select v_order.id, v_name, v_total;
end $function$;

create or replace function public.correct_meal(p_org_id bigint, p_service_date date, p_profile_id uuid, p_menu_item_id bigint, p_quantity smallint DEFAULT 1, p_note text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(order_id bigint, balance_minor bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_note   text;
  v_menu   public.menus%rowtype;
  v_period bigint;
  v_order  bigint;
  v_member text;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');
  v_note   := private.short_text(p_note, 120, 'note');

  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'a portion count has to be between 1 and 20'
      using errcode = 'check_violation';
  end if;
  -- Held before the menu, as leaving holds it, so a meal is not recorded for
  -- somebody in the middle of going.
  v_member := private.hold_membership(p_org_id, p_profile_id);
  if v_member is null then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select * into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date
     for share;
  if not found then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;
  perform private.assert_menu_correctable(v_menu.status, p_service_date);

  -- Somebody who has gone keeps the meals they had, which can still be put
  -- right, but is given none.
  if v_member <> 'active'
     and not exists (select 1 from public.orders o
                      where o.menu_id = v_menu.id and o.profile_id = p_profile_id
                        and o.status = 'placed') then
    raise exception '% is no longer in this office, so no lunch can be recorded for them on %',
      private.member_name(p_org_id, p_profile_id), to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (select 1 from public.menu_items mi
                  where mi.id = p_menu_item_id and mi.menu_id = v_menu.id) then
    raise exception 'that dish is not on the menu for %',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  v_order := private.replace_order_line(p_org_id, v_menu.id, p_service_date,
               p_profile_id, p_menu_item_id, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (p_org_id, p_service_date, 'meal', v_order, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'meal');

  return query select v_order, private.account_balance(p_org_id, p_profile_id);
end $function$;

create or replace function public.correct_meal_off_menu(p_org_id bigint, p_service_date date, p_profile_id uuid, p_dish_name text, p_price_minor integer, p_quantity smallint DEFAULT 1, p_note text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(order_id bigint, menu_item_id bigint, balance_minor bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_note   text;
  v_name   text := private.dish_name(p_dish_name);
  v_menu   public.menus%rowtype;
  v_period bigint;
  v_item   bigint;
  v_same   text;
  v_same_price integer;
  v_order  bigint;
  v_member text;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');
  v_note   := private.short_text(p_note, 120, 'note');

  if v_name is null or length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'a dish needs a name of at most 200 characters'
      using errcode = 'check_violation';
  end if;
  if p_price_minor is null or p_price_minor < 0 or p_price_minor >= 1000000000 then
    raise exception 'a price has to be zero or more, and under a billion'
      using errcode = 'check_violation';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'a portion count has to be between 1 and 20'
      using errcode = 'check_violation';
  end if;
  -- Held before the menu, as leaving holds it, so a meal is not recorded for
  -- somebody in the middle of going.
  v_member := private.hold_membership(p_org_id, p_profile_id);
  if v_member is null then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select * into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date
     for no key update;
  if not found then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;
  perform private.assert_menu_correctable(v_menu.status, p_service_date);

  -- Somebody who has gone keeps the meals they had, which can still be put
  -- right, but is given none.
  if v_member <> 'active'
     and not exists (select 1 from public.orders o
                      where o.menu_id = v_menu.id and o.profile_id = p_profile_id
                        and o.status = 'placed') then
    raise exception '% is no longer in this office, so no lunch can be recorded for them on %',
      private.member_name(p_org_id, p_profile_id), to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  select mi.id, mi.name, mi.price_minor into v_item, v_same, v_same_price
    from public.menu_items mi
   where mi.menu_id = v_menu.id and lower(btrim(mi.name)) = lower(btrim(v_name));

  if v_item is null then
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu.id, p_org_id, v_name, p_price_minor,
            coalesce((select max(mi.position) from public.menu_items mi
                       where mi.menu_id = v_menu.id), -1) + 1)
    returning id into v_item;
  elsif v_same_price is null then
    -- Pricing the dish here would reach this person's line alone and leave
    -- everybody else's on it unpriced, while the day showed the new price.
    -- Repricing is reprice_dish, which reaches every line at once.
    raise exception '"%" is already on the menu with no price yet. Set its price with Reprice, then record this meal',
      v_same
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A priced dish of the same name is that dish, at its own price.

  v_order := private.replace_order_line(p_org_id, v_menu.id, p_service_date,
               p_profile_id, v_item, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, menu_item_id, profile_id,
     summary, reason, made_by)
  values (p_org_id, p_service_date, 'off_menu', v_order, v_item, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'off_menu');

  return query select v_order, v_item, private.account_balance(p_org_id, p_profile_id);
end $function$;

create or replace function public.record_pass(p_order_id bigint, p_to_profile_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_reason   text;
  o          public.orders%rowtype;
  v_status   text;
  v_period   bigint;
  v_live     public.meal_transfers%rowtype;
  v_transfer bigint;
begin
  -- A missing order and another office's get the same answer, so an id
  -- cannot be probed across offices.
  select * into o from public.orders where id = p_order_id;
  if not found or not (o.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  if p_to_profile_id is not distinct from o.profile_id then
    raise exception 'a meal cannot be passed to the person whose meal it is'
      using errcode = 'check_violation';
  end if;
  if private.hold_membership(o.org_id, p_to_profile_id) is distinct from 'active' then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  v_period := private.correction_period(o.org_id, o.service_date);

  select * into o from public.orders where id = p_order_id for no key update;
  if o.status <> 'placed' then
    raise exception 'nothing is recorded for % on %, so there is no meal to pass',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- No chains: one live pass per meal. A plain read, because a pass row is
  -- never taken after the week; the unique index is the backstop for a member
  -- offering it in the same instant.
  select * into v_live from public.meal_transfers t
   where t.order_id = o.id and t.status in ('pending', 'accepted');
  if found then
    if v_live.status = 'pending' then
      raise exception '%''s lunch on % is already offered to %, so answer or withdraw that offer first',
        private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
        private.member_name(o.org_id, v_live.to_profile_id)
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    raise exception '%''s lunch on % is already passed to %, so undo that pass first',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
      private.member_name(o.org_id, v_live.to_profile_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  begin
    insert into public.meal_transfers
      (org_id, order_id, from_profile_id, to_profile_id, status, reason,
       created_by, decided_at, decided_by)
    values (o.org_id, o.id, o.profile_id, p_to_profile_id, 'accepted', v_reason,
            v_actor, now(), v_actor)
    returning id into v_transfer;
  exception when unique_violation then
    -- A member's offer took the slot while this waited on it. Read again, as
    -- that offer has committed, and say whose it is.
    select * into v_live from public.meal_transfers t
     where t.order_id = o.id and t.status in ('pending', 'accepted');
    raise exception '%''s lunch on % is already offered to %, so answer or withdraw that offer first',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
      coalesce(private.member_name(o.org_id, v_live.to_profile_id), 'somebody')
      using errcode = 'object_not_in_prerequisite_state';
  end;

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (o.org_id, o.service_date, 'pass', o.id, o.profile_id, v_transfer,
          private.pass_summary(v_transfer, 'recorded'), v_reason, v_actor);

  perform private.enqueue_pass(v_transfer, v_period, v_actor, v_reason, 'recorded');

  return query select v_transfer,
                      private.account_balance(o.org_id, o.profile_id),
                      private.account_balance(o.org_id, p_to_profile_id);
end $function$;

create or replace function public.answer_pass(p_transfer_id bigint, p_answer text, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- The recipient's membership before the menu, as leaving holds it.
  if v_new = 'accepted' then
    perform private.hold_membership(t.org_id, t.to_profile_id);
  end if;

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
      case v_new when 'accepted' then 'accept'
                 else 'turn down; withdraw the offer instead' end
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
end $function$;


create or replace function public.undo_pass(p_transfer_id bigint, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  t        public.meal_transfers%rowtype;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
  v_giver  text;
  v_menu   public.menus%rowtype;
begin
  select * into t from public.meal_transfers where id = p_transfer_id;
  if not found or not (t.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  -- The giver's membership before the menu, as leaving holds it: an undo puts
  -- the meal back on them.
  v_giver := private.hold_membership(t.org_id, t.from_profile_id);

  select * into o from public.orders where id = t.order_id;
  select * into v_menu from public.menus mu where mu.id = o.menu_id for share;
  v_status := v_menu.status;
  perform private.assert_menu_correctable(v_status, o.service_date);

  -- Somebody who has gone is given no meal while the day is still open, as
  -- leaving would have cancelled it; past the cutoff the meal was theirs to pay
  -- for anyway.
  if v_giver is distinct from 'active'
     and v_menu.status = 'published' and v_menu.order_cutoff_at > now() then
    raise exception '% has left the office, so the meal cannot go back to them on %',
      private.member_name(t.org_id, t.from_profile_id), to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select * into t from public.meal_transfers where id = p_transfer_id for no key update;
  v_period := private.correction_period(t.org_id, o.service_date);
  select * into o from public.orders where id = t.order_id for no key update;

  if t.status = 'pending' then
    raise exception 'that offer has not been accepted, so there is nothing to undo'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if t.status <> 'accepted' then
    raise exception 'that pass is already %',
      case t.status when 'cancelled' then 'withdrawn' else t.status end
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.meal_transfers x
     set status = 'undone', undone_at = now(), undone_by = v_actor
   where x.id = p_transfer_id;

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (t.org_id, o.service_date, 'pass_undone', o.id, o.profile_id, t.id,
          private.pass_summary(t.id, 'undone'), v_reason, v_actor);

  perform private.enqueue_pass(t.id, v_period, v_actor, v_reason, 'undone');

  return query select t.id,
                      private.account_balance(t.org_id, t.from_profile_id),
                      private.account_balance(t.org_id, t.to_profile_id);
end $function$;
