-- A write the app makes for one tap is one transaction.
--
-- PostgREST runs every request in its own transaction, so a browser that
-- issues three requests for one action commits three times, and anything that
-- fails or interleaves between them is left half done. Three actions did that:
--
--   * Choosing a dish on the Board (setOrder): insert or revive the order,
--     delete its dish lines, insert one. Two devices, or a member and an
--     admin's correction, interleave as delete, delete, insert, insert and
--     leave two dishes on one order, billed twice. A cutoff passing between
--     the delete and the insert leaves the order with no dish at all.
--   * Publishing a menu (publishMenu): upsert the menu, delete, update and
--     insert dishes one statement at a time, then flip the status. Any refusal
--     part way leaves a published menu with some of its dishes changed, and
--     two admins editing the same day lose each other's dishes.
--   * Pricing the week on Settle week (applyCatererPrices): one request per
--     dish and one per menu row. A refusal part way leaves some dishes priced
--     and some not. And it was refused on every locked menu for member and
--     standing orders, which is every order that week, because the re-snapshot
--     went through enforce_order_window as an admin browser.
--
-- Each is now one SECURITY DEFINER function. Every guard trigger exempts
-- private.is_service(), which is true inside such a function, so each one
-- checks for itself what RLS and the triggers would have checked, in the same
-- words. The one guard that still runs is snapshot_order_item, which has no
-- exemption: names and prices are still copied by the trigger alone.
--
-- Locks are taken in one order everywhere, which is what keeps these from
-- deadlocking with each other, with the corrections and with the hourly tick:
--
--   office's materialize lock -> menu rows (by org, date, id) -> the billing
--   week's lock -> dish rows -> the order row -> its dish lines.
--
-- The corrections take the week's lock first and then reach a menu only
-- through a foreign key, which takes FOR KEY SHARE. So nothing that holds a
-- menu FOR UPDATE may then wait on a dish, a line, an order or a week, and no
-- function here takes a menu FOR UPDATE at all: FOR SHARE to order, FOR NO KEY
-- UPDATE to change it, neither of which blocks FOR KEY SHARE.
-- materialize_standing_orders is brought into line in 20261017100100.
--
-- One case is left: the hourly tick locks an office's due menus with a plain
-- UPDATE in scan order, then bills a week. Against apply_caterer_prices on the
-- same menus that can deadlock; it needs a week's menu still published past its
-- cutoff at billing hour, and the loser is either the admin's Settle week, which
-- can be pressed again, or that office's tick subtransaction, retried an hour
-- later.
--
-- The menu row is taken FOR SHARE when ordering, which is what makes cancelling
-- lunch wait for an order in flight (and cancel it) rather than miss it.
--
-- Direct table writes stay granted, because the web app deployed before this
-- migration still makes them. Revoking them belongs in a later migration, once
-- that app is gone.

---------------------------------------------------------------- the helpers

-- Serialises everything that decides who gets a standing order in one office:
-- publishing, weekday rules and skips. Taken first, before any row lock.
create or replace function private.lock_office_materialize(p_org_id bigint)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lunch.materialize:' || p_org_id::text, 0));
$$;

-- refuse_write_to_settled_week, for callers it exempts. The shared lock waits
-- out a settle or a correction running on the same week, so a week cannot close
-- between this check and the write.
create or replace function private.assert_week_open(p_org_id bigint, p_service_date date)
returns void
language plpgsql
set search_path = ''
as $$
declare v_id bigint; v_status text;
begin
  select bp.id into v_id
    from public.billing_periods bp
   where bp.org_id = p_org_id
     and p_service_date between bp.period_start and bp.period_end
     and bp.status <> 'void';
  if v_id is null then return; end if;

  perform pg_advisory_xact_lock_shared(hashtext('lunch.run_billing'), v_id::int);
  select bp.status into v_status from public.billing_periods bp where bp.id = v_id;

  if v_status = 'closed' then
    raise exception
      'lunch on % is on a week that has been settled, so the record can no longer be changed',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;

-------------------------------------------------------------- set_my_order

-- The Board's and the bot's dish choice. Always the caller's own order: there
-- is no profile parameter. A new order is source 'member'; an existing one
-- keeps its source. The dish line is always deleted and written fresh, never
-- updated in place, so any member write replaces it.
create or replace function public.set_my_order(
  p_menu_id      bigint,
  p_menu_item_id bigint,
  p_note         text default null
) returns table (order_id bigint, item_name_snapshot text, line_total_minor integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_menu  public.menus%rowtype;
  v_order public.orders%rowtype;
  v_tz    text;
  v_note  text := nullif(btrim(p_note), '');
  v_name  text;
  v_total integer;
begin
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
  end if;

  return query select v_order.id, v_name, v_total;
end $$;

-------------------------------------------------------------- publish_menu

-- The Menu screen's Publish, whole: the menu row, its dishes reconciled in
-- place (removals, then updates, then additions, as before), then the status.
-- `p_dishes` is `[{"id": 12 | null, "name": "...", "price_minor": 45000 | null}]`
-- in display order; an id that is not one of this menu's dishes is a new dish.
create or replace function public.publish_menu(
  p_org_id       bigint,
  p_service_date date,
  p_cutoff_at    timestamptz,
  p_dishes       jsonb,
  p_source_text  text,
  p_parse_meta   jsonb
) returns table (menu_id bigint, standing_orders integer, was_update boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid    uuid := (select auth.uid());
  v_menu   public.menus%rowtype;
  v_update boolean;
  v_before integer := 0;
  v_after  integer;
  v_keep   bigint[];
  d        record;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can publish its menu'
      using errcode = 'insufficient_privilege';
  end if;
  if p_dishes is null or jsonb_typeof(p_dishes) <> 'array' then
    raise exception 'the dishes arrive as a list' using errcode = 'invalid_parameter_value';
  end if;

  perform private.lock_office_materialize(p_org_id);

  -- FOR NO KEY UPDATE, not FOR UPDATE: the dish writes below can wait on a
  -- correction, and a correction reaches this menu through a foreign key's
  -- FOR KEY SHARE, which FOR UPDATE would block.
  select * into v_menu from public.menus m
   where m.org_id = p_org_id and m.service_date = p_service_date
     for no key update;
  v_update := found;

  if v_update then
    -- enforce_menu_item_frozen, which the reconcile below would otherwise meet
    -- on its first dish, after the menu row had already changed.
    if v_menu.status in ('locked', 'cancelled') then
      raise exception 'the menu is %; dishes can no longer be changed', v_menu.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;

    select count(*)::int into v_before from public.orders o
     where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

    update public.menus m
       set order_cutoff_at = p_cutoff_at, source_text = p_source_text, parse_meta = p_parse_meta
     where m.id = v_menu.id
    returning m.* into v_menu;
  else
    insert into public.menus as m
      (org_id, service_date, order_cutoff_at, created_by, source_text, parse_meta)
    values (p_org_id, p_service_date, p_cutoff_at, v_uid, p_source_text, p_parse_meta)
    returning m.* into v_menu;
  end if;

  select coalesce(array_agg(mi.id), '{}') into v_keep
    from public.menu_items mi
   where mi.menu_id = v_menu.id
     and mi.id in (select (x ->> 'id')::bigint from jsonb_array_elements(p_dishes) x
                    where x ->> 'id' is not null);

  -- Removals first: a rename that reuses a departing dish's name would collide
  -- with menu_items_name_uk. A dish somebody ordered is refused by its FK.
  delete from public.menu_items mi
   where mi.menu_id = v_menu.id and not (mi.id = any (v_keep));

  for d in
    select (x ->> 'id')::bigint as id, x ->> 'name' as name,
           (x ->> 'price_minor')::integer as price_minor, (n - 1)::int as position
      from jsonb_array_elements(p_dishes) with ordinality as t(x, n)
     order by n
  loop
    if d.id is not null and d.id = any (v_keep) then
      update public.menu_items mi
         set name = d.name, price_minor = d.price_minor, position = d.position
       where mi.id = d.id;
    end if;
  end loop;

  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  select v_menu.id, p_org_id, x ->> 'name', (x ->> 'price_minor')::integer, (n - 1)::int
    from jsonb_array_elements(p_dishes) with ordinality as t(x, n)
   where x ->> 'id' is null or not ((x ->> 'id')::bigint = any (v_keep))
   order by n;

  -- A republish is an edit in place: no status change, so nothing materializes.
  if v_menu.status <> 'published' then
    update public.menus m set status = 'published' where m.id = v_menu.id;
  end if;

  select count(*)::int into v_after from public.orders o
   where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

  return query select v_menu.id, greatest(0, v_after - v_before), v_update;
end $$;

------------------------------------------------------- apply_caterer_prices

-- Settle week's price step. `p_prices` is
-- `[{"price_minor": 50000, "menu_item_ids": [101, 111]}]`, one entry per dish.
-- On a locked menu only a missing price may be filled in, as
-- enforce_menu_item_frozen allows. Every order line on those dishes then takes
-- the price, whoever placed it; that is what billing reads.
--
-- A settled week is refused whole, as reprice_dish refuses it, rather than
-- pricing its dishes and then failing on the first order line.
create or replace function public.apply_caterer_prices(p_org_id bigint, p_prices jsonb)
returns table (dishes integer, menu_items integer, order_items integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_dishes integer := 0;
  v_items  integer := 0;
  v_lines  integer := 0;
  v_n      integer;
  v_all    bigint[];
  v_ids    bigint[];
  v_price  integer;
  p        jsonb;
  r        record;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can bill a week'
      using errcode = 'insufficient_privilege';
  end if;
  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'the prices arrive as a list' using errcode = 'invalid_parameter_value';
  end if;

  for p in select x from jsonb_array_elements(p_prices) x loop
    if jsonb_array_length(coalesce(p -> 'menu_item_ids', '[]')) = 0 then continue; end if;
    v_price := (p ->> 'price_minor')::integer;
    if v_price is null or v_price < 0 or v_price >= 1000000000 then
      raise exception 'a price has to be zero or more, and under a billion'
        using errcode = 'check_violation';
    end if;
  end loop;

  select coalesce(array_agg(distinct v::bigint), '{}') into v_all
    from jsonb_array_elements(p_prices) x,
         jsonb_array_elements_text(coalesce(x -> 'menu_item_ids', '[]')) v;

  -- Every menu touched, in order. FOR NO KEY UPDATE holds off an order being
  -- placed (FOR SHARE), a publish and a cancel, but not a correction's foreign
  -- key check, which is what lets this go on to wait for the week below.
  perform 1
     from public.menus m
    where m.org_id = p_org_id
      and m.id in (select mi.menu_id from public.menu_items mi
                    where mi.org_id = p_org_id and mi.id = any (v_all))
    order by m.org_id, m.service_date, m.id
      for no key update;

  for r in
    select distinct m.service_date
      from public.menus m join public.menu_items mi on mi.menu_id = m.id
     where mi.org_id = p_org_id and mi.id = any (v_all)
     order by m.service_date
  loop
    perform private.assert_week_open(p_org_id, r.service_date);
  end loop;

  -- The dish rows are read locked, so a reprice_dish that got there first is
  -- seen priced rather than overwritten.
  for r in
    select m.status, mi.price_minor
      from public.menu_items mi join public.menus m on m.id = mi.menu_id
     where mi.org_id = p_org_id and mi.id = any (v_all)
     order by mi.id
       for no key update of mi
  loop
    if r.status = 'cancelled' or (r.status = 'locked' and r.price_minor is not null) then
      raise exception 'the menu is %; dishes can no longer be changed', r.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;

  for p in select x from jsonb_array_elements(p_prices) x loop
    select coalesce(array_agg(v::bigint), '{}') into v_ids
      from jsonb_array_elements_text(coalesce(p -> 'menu_item_ids', '[]')) v;
    if cardinality(v_ids) = 0 then continue; end if;
    v_price := (p ->> 'price_minor')::integer;

    update public.menu_items mi set price_minor = v_price
     where mi.org_id = p_org_id and mi.id = any (v_ids);
    get diagnostics v_n = row_count;
    v_items  := v_items + v_n;
    v_dishes := v_dishes + 1;

    -- Naming menu_item_id re-fires order_items_snapshot, which copies the price.
    update public.order_items oi set menu_item_id = oi.menu_item_id
     where oi.org_id = p_org_id and oi.menu_item_id = any (v_ids);
    get diagnostics v_n = row_count;
    v_lines := v_lines + v_n;
  end loop;

  return query select v_dishes, v_items, v_lines;
end $$;

------------------------------------------------- corrections take the order

-- The order row is locked before its lines are replaced, so a correction and
-- a member's own dish choice on the same order run one after the other.
create or replace function private.replace_order_line(
  p_org_id bigint, p_menu_id bigint, p_service_date date, p_profile_id uuid,
  p_menu_item_id bigint, p_quantity smallint, p_note text, p_actor uuid
) returns bigint
language plpgsql
set search_path = ''
as $$
declare v_order public.orders%rowtype;
begin
  select * into v_order from public.orders o
   where o.menu_id = p_menu_id and o.profile_id = p_profile_id
     for update;

  if not found then
    insert into public.orders
      (org_id, menu_id, service_date, profile_id, source, created_by)
    values (p_org_id, p_menu_id, p_service_date, p_profile_id, 'admin', p_actor)
    returning * into v_order;
  elsif v_order.status <> 'placed' then
    update public.orders o
       set status = 'placed', cancelled_at = null
     where o.id = v_order.id
    returning * into v_order;
  end if;

  delete from public.order_items oi where oi.order_id = v_order.id;

  insert into public.order_items
    (order_id, org_id, profile_id, menu_id, menu_item_id, quantity, note)
  values (v_order.id, p_org_id, p_profile_id, p_menu_id, p_menu_item_id,
          p_quantity, p_note);

  return v_order.id;
end $$;

--------------------------------------------------------------------- grants

revoke execute on function private.lock_office_materialize(bigint) from public, anon, authenticated;
revoke execute on function private.assert_week_open(bigint, date)  from public, anon, authenticated;

revoke execute on function public.set_my_order(bigint, bigint, text) from public, anon;
grant  execute on function public.set_my_order(bigint, bigint, text) to authenticated;

revoke execute on function public.publish_menu(bigint, date, timestamptz, jsonb, text, jsonb) from public, anon;
grant  execute on function public.publish_menu(bigint, date, timestamptz, jsonb, text, jsonb) to authenticated;

revoke execute on function public.apply_caterer_prices(bigint, jsonb) from public, anon;
grant  execute on function public.apply_caterer_prices(bigint, jsonb) to authenticated;
