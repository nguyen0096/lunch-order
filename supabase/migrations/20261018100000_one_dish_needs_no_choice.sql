-- A menu with one dish needs no choice.
--
-- An undecided slot is a placed order with no dish line, from a standing rule,
-- a planned day, or a member who said they eat without saying what. While a
-- day is open and its menu has exactly one dish, every undecided slot is an
-- order for that dish, written by the system and marked
-- `order_items.auto_assigned`. When the menu gains a second dish, every marked
-- line goes again, those orders are undecided once more, and each person with
-- Telegram is asked to choose. A line anybody else writes is never marked, so
-- a member who chose, even the one dish, keeps it.
--
-- `private.settle_undecided` does both, from the dish count as it stands,
-- which is what makes it safe to run from every place the answer can change:
-- a dish added or removed, a publish (publish_menu, or a status flip on the
-- table), and a standing slot materialized later. set_my_order with no dish
-- fills its own slot the same way. A dish whose only lines are the system's
-- can be removed; those lines go with it. It holds the menu FOR NO KEY
-- UPDATE, the same lock publish_menu and the materialize sweep take and the
-- one set_my_order's FOR SHARE waits on, so a choice in flight is either seen
-- or waits. It never takes the office's materialize lock: a publish made
-- straight on the table already holds its menu when it reaches here, and
-- taking the office lock after that is the deadlock the lock order forbids.
--
-- Nothing converts or reverts outside stage 'open'. The settled-week check is
-- a plain read, not assert_week_open's lock: a day still open cannot be in a
-- finished week, and a correction holds that lock before it reaches a menu.
--
-- Dish availability is gone. No screen ever set it, and it would have been a
-- second answer to "how many dishes". Every reader stops here; the column is
-- dropped in 20261018100100, once no deployed client selects it.

-------------------------------------------------------------------- the mark

alter table public.order_items
  add column auto_assigned boolean not null default false;

-- A browser holds INSERT on order_items, so the mark is cleared rather than
-- trusted. Any write of its own line by a person is a decision.
create or replace function public.guard_auto_assigned()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if not private.is_service() then
    new.auto_assigned := false;
  end if;
  return new;
end $fn$;

create trigger order_items_auto_assigned
  before insert or update on public.order_items
  for each row execute function public.guard_auto_assigned();

revoke all on function public.guard_auto_assigned() from public, anon, authenticated;

------------------------------------------------ availability leaves the rules

-- As in 20260911100400, without the availability check.
create or replace function public.snapshot_order_item() returns trigger
language plpgsql set search_path = '' as $$
declare v_item public.menu_items%rowtype;
begin
  select * into v_item from public.menu_items
   where id = new.menu_item_id and menu_id = new.menu_id;
  if not found then
    raise exception 'dish % is not on this menu', new.menu_item_id
      using errcode = 'foreign_key_violation';
  end if;
  new.item_name_snapshot := v_item.name;
  new.unit_price_minor   := v_item.price_minor;
  return new;
end $$;

-- As in 20261003100200; a menu needs one dish to publish.
create or replace function public.enforce_menu_lifecycle()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare v_stage text;
begin
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
         ('draft','published'), ('draft','cancelled'),
         ('published','locked'), ('published','cancelled'), ('published','draft'),
         ('locked','published'), ('locked','cancelled'))
    then
      raise exception 'illegal menu status transition % -> %', old.status, new.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;

    if new.status = 'published' then
      if not exists (select 1 from public.menu_items mi where mi.menu_id = new.id) then
        raise exception 'cannot publish a menu with no dishes'
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, (select auth.uid()));
    end if;

    if new.status = 'locked' then
      new.locked_at := coalesce(new.locked_at, now());
    end if;

    if new.status = 'cancelled' and not private.is_service() then
      v_stage := private.day_stage(new.org_id, new.service_date, old.status,
                                   new.order_cutoff_at);
      if v_stage not in ('draft', 'open') then
        raise exception
          'ordering for % has closed, so lunch cannot be called off here; talk to the caterer',
          to_char(new.service_date, 'DD/MM')
          using errcode = 'object_not_in_prerequisite_state';
      end if;
    end if;

    if new.status = 'draft'
       and exists (select 1 from public.orders o where o.menu_id = new.id) then
      raise exception 'cannot un-publish: orders already exist for this menu'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  if new.service_date is distinct from old.service_date and old.status <> 'draft' then
    raise exception 'cannot change the service date of a % menu', old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end $function$;

-- As in 20260928100200, without availability among the columns compared.
create or replace function public.enforce_menu_item_frozen()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare v_status text;
begin
  if private.is_service() then return coalesce(new, old); end if;

  select m.status into v_status from public.menus m
   where m.id = coalesce(new.menu_id, old.menu_id);

  if v_status = 'locked'
     and tg_op = 'UPDATE'
     and old.price_minor is null
     and new.price_minor is not null
     and new.name     = old.name
     and new.menu_id  = old.menu_id
     and new.position = old.position
  then
    return new;
  end if;

  if v_status in ('locked','cancelled') then
    raise exception 'the menu is %; dishes can no longer be changed', v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return coalesce(new, old);
end
$fn$;

---------------------------------------------------------------- the messages

-- As in 20261015100000, every dish listed, and a one-dish menu says who is
-- already down for it. One dish is one line, so the cap never reaches it.
create or replace function private.menu_message(p_menu_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select 'Menu for ' || to_char(m.service_date, 'DD/MM') || E'\n'
         || coalesce(d.listed, '')
         || case when d.left_out = 0 then ''
                 else E'\nAnd ' || d.left_out
                      || case when d.left_out = 1 then ' more dish' else ' more dishes' end
                      || '. See the app for the full menu.'
            end
         || case when d.total = 1
                 then E'\nStanding orders are down for ' || d.only_name || '.'
                 else '' end
         || E'\nOrders close '
         || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '.'
    from public.menus m
    join public.organizations o on o.id = m.org_id
    cross join lateral (
      select string_agg(r.line, E'\n' order by r.n) filter (where r.upto <= 3800) as listed,
             count(*) filter (where r.upto > 3800) as left_out,
             count(*) as total,
             min(r.name) as only_name
        from (
          -- `upto` only grows, so once a line passes the cap every later line
          -- does too, and no dish is skipped in favour of a shorter one after it.
          select l.line, l.n, l.name,
                 sum(length(l.line) + 1) over (order by l.n) as upto
            from (
              select '- ' || mi.name || '  '
                       || coalesce(private.money_text(mi.price_minor,
                                     o.currency_minor_units, o.currency),
                                   'price to come') as line,
                     mi.name,
                     row_number() over (order by mi.position, mi.id) as n
                from public.menu_items mi
               where mi.menu_id = m.id
            ) l
        ) r
    ) d
   where m.id = p_menu_id;
$fn$;

revoke execute on function private.menu_message(bigint) from public, anon, authenticated;

alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in
    ('menu_published','register_reminder','cutoff_warning',
     'weekly_preview','weekly_bill','payment_reminder','payment_ack',
     'transfer_offer','transfer_decided','bill_correction','announcement',
     'bug_report','payment_unmatched','dish_choice'));

create or replace function private.dish_choice_message(p_menu_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select 'The menu for ' || to_char(m.service_date, 'DD/MM') || ' now has '
         || (select count(*) from public.menu_items mi where mi.menu_id = m.id)
         || ' dishes. Choose yours before '
         || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '.'
    from public.menus m
    join public.organizations o on o.id = m.org_id
   where m.id = p_menu_id;
$fn$;

revoke execute on function private.dish_choice_message(bigint) from public, anon, authenticated;

------------------------------------------------------------ the one function

-- Writes a one-dish menu's dish into its undecided slots, or into one order's.
-- The caller holds the menu against a dish change and has checked the stage
-- and the week.
create or replace function private.assign_only_dish(
  p_menu_id bigint, p_order_id bigint default null)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_only bigint;
begin
  select min(mi.id) into v_only from public.menu_items mi
   where mi.menu_id = p_menu_id having count(*) = 1;
  if v_only is null then return; end if;

  -- The orders are locked in one statement and read again in the next, so a
  -- correction that held one is seen with the line it wrote.
  perform 1 from public.orders o
    where o.menu_id = p_menu_id and o.status = 'placed'
      and o.source in ('standing', 'member')
      and (p_order_id is null or o.id = p_order_id)
      and not exists (select 1 from public.order_items oi where oi.order_id = o.id)
    order by o.id
      for update;

  insert into public.order_items
    (order_id, org_id, profile_id, menu_id, menu_item_id, auto_assigned,
     item_name_snapshot, unit_price_minor)
  select o.id, o.org_id, o.profile_id, o.menu_id, v_only,
         not exists (select 1 from public.meal_transfers t
                      where t.order_id = o.id and t.status in ('pending', 'accepted')),
         '', 0
    from public.orders o
   where o.menu_id = p_menu_id and o.status = 'placed'
     and o.source in ('standing', 'member')
     and (p_order_id is null or o.id = p_order_id)
     and not exists (select 1 from public.order_items oi where oi.order_id = o.id)
   order by o.id;
end $fn$;

revoke execute on function private.assign_only_dish(bigint, bigint) from public, anon, authenticated;

create or replace function private.settle_undecided(p_menu_id bigint)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_menu   public.menus%rowtype;
  v_dishes integer;
  v_event  text := to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  v_key    text := 'lunch.unassigned_' || p_menu_id;
  v_left   bigint[];
begin
  -- Orders whose auto line went with a removed dish in this transaction.
  v_left := coalesce(string_to_array(nullif(current_setting(v_key, true), ''), ',')::bigint[],
                     '{}');
  perform set_config(v_key, '', true);

  -- Read unlocked first, so a day that is not open, which is every day a
  -- correction or the week's pricing touches, takes no menu lock here at all.
  select * into v_menu from public.menus m where m.id = p_menu_id;
  if not found or private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                                    v_menu.order_cutoff_at) <> 'open' then
    return;
  end if;

  select * into v_menu from public.menus m where m.id = p_menu_id for no key update;
  if not found or private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                                    v_menu.order_cutoff_at) <> 'open' then
    return;
  end if;
  if exists (select 1 from public.billing_periods bp
              where bp.org_id = v_menu.org_id and bp.status = 'closed'
                and v_menu.service_date between bp.period_start and bp.period_end) then
    return;
  end if;

  select count(*)::int into v_dishes from public.menu_items mi where mi.menu_id = v_menu.id;

  if v_dishes = 1 then
    perform private.assign_only_dish(v_menu.id);

  elsif v_dishes > 1 then
    perform 1 from public.orders o
      where o.menu_id = v_menu.id
        and exists (select 1 from public.order_items oi
                     where oi.order_id = o.id and oi.auto_assigned)
      order by o.id
        for update;

    -- A cancelled order loses the line too and stays cancelled; only those
    -- still eating are asked to choose.
    with gone as (
      delete from public.order_items oi
       where oi.menu_id = v_menu.id and oi.auto_assigned
      returning oi.order_id
    )
    insert into public.notification_outbox
      (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
       related_menu_id)
    select o.org_id,
           'org:' || o.org_id || ':dish_choice:menu:' || o.menu_id
             || ':profile:' || o.profile_id::text || ':' || v_event,
           'dish_choice',
           tl.chat_id,
           o.profile_id,
           private.dish_choice_message(o.menu_id),
           'none',
           o.menu_id
      from (select g.order_id from gone g
            union
            select l.id from unnest(v_left) as l(id)
             where not exists (select 1 from public.order_items oi
                                where oi.order_id = l.id)) g
      join public.orders o
        on o.id = g.order_id and o.menu_id = v_menu.id and o.status = 'placed'
      join public.memberships mem
        on mem.org_id = o.org_id and mem.profile_id = o.profile_id
      join public.telegram_links tl
        on tl.membership_id = mem.id and tl.chat_id is not null
    on conflict (dedupe_key) do nothing;
  end if;
end $fn$;

revoke execute on function private.settle_undecided(bigint) from public, anon, authenticated;

------------------------------------------------------------ the dish triggers

-- Holds the menu on any day a publish could still be racing. For an insert
-- that is before the dish row, as the lock order has it. A delete has locked
-- its row before a row trigger runs, so every delete goes through publish_menu,
-- which holds the menu first and sets lunch.dish_count_later to settle once
-- when its dishes are all written; 20261018100100 revokes direct writes.
--
-- A dish the system wrote into undecided slots is not one anybody ordered, so
-- it can still be removed: its lines go first, and settle_undecided decides
-- from the dishes left whether those orders get the new one dish or a message.
create or replace function public.trg_menu_items_hold_menu()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_menu  public.menus%rowtype;
  v_stage text;
  v_left  text;
begin
  select * into v_menu from public.menus m where m.id = coalesce(new.menu_id, old.menu_id);
  if not found then return coalesce(new, old); end if;
  v_stage := private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                               v_menu.order_cutoff_at);

  if v_stage in ('draft', 'open')
     and current_setting('lunch.dish_count_later', true) is distinct from 'on' then
    select * into v_menu from public.menus m where m.id = v_menu.id for no key update;
    v_stage := private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                                 v_menu.order_cutoff_at);
  end if;

  if tg_op = 'DELETE' and v_stage = 'open' then
    perform 1 from public.orders o
      where o.menu_id = v_menu.id
        and exists (select 1 from public.order_items oi
                     where oi.order_id = o.id and oi.menu_item_id = old.id
                       and oi.auto_assigned)
      order by o.id
        for update;

    with gone as (
      delete from public.order_items oi
       where oi.menu_item_id = old.id and oi.auto_assigned
      returning oi.order_id
    )
    select string_agg(g.order_id::text, ',') into v_left from gone g;

    if v_left is not null then
      perform set_config('lunch.unassigned_' || v_menu.id,
        concat_ws(',', nullif(current_setting('lunch.unassigned_' || v_menu.id, true), ''),
                  v_left),
        true);
    end if;
  end if;
  return coalesce(new, old);
end $fn$;

-- Per statement, so a publish that removes and adds in one go is judged on
-- where it ends, not on a count it passed through.
create or replace function public.trg_menu_items_count_changed()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare r record;
begin
  if current_setting('lunch.dish_count_later', true) = 'on' then return null; end if;
  for r in
    select m.id from public.menus m
     where m.id in (select c.menu_id from changed c)
     order by m.org_id, m.service_date, m.id
  loop
    perform private.settle_undecided(r.id);
  end loop;
  return null;
end $fn$;

create trigger menu_items_hold_menu
  before insert or delete on public.menu_items
  for each row execute function public.trg_menu_items_hold_menu();

create trigger menu_items_added_settle
  after insert on public.menu_items
  referencing new table as changed
  for each statement execute function public.trg_menu_items_count_changed();

create trigger menu_items_removed_settle
  after delete on public.menu_items
  referencing old table as changed
  for each statement execute function public.trg_menu_items_count_changed();

revoke all on function public.trg_menu_items_hold_menu()     from public, anon, authenticated;
revoke all on function public.trg_menu_items_count_changed() from public, anon, authenticated;

---------------------------------------------------- materialize, then settle

-- As in 20261017100100; a slot created on a one-dish menu gets its dish.
create or replace function public.materialize_standing_orders(p_menu_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_menu public.menus%rowtype;
  v_dow  int;
  v_n    int := 0;
begin
  select * into v_menu from public.menus where id = p_menu_id for no key update;
  if not found                       then raise exception 'menu % not found', p_menu_id; end if;
  if v_menu.status <> 'published'    then return 0; end if;
  if now() >= v_menu.order_cutoff_at then return 0; end if;

  v_dow := extract(isodow from v_menu.service_date)::int;

  with candidate as (
      select so.profile_id
        from public.standing_orders so
        join public.memberships m
          on m.org_id = so.org_id and m.profile_id = so.profile_id and m.status = 'active'
       where so.org_id = v_menu.org_id and so.weekday = v_dow and so.is_enabled
         and not exists (
               select 1 from public.standing_order_exceptions e
                where e.org_id = so.org_id and e.profile_id = so.profile_id
                  and e.service_date = v_menu.service_date and e.action = 'skip')
    union
      select e.profile_id
        from public.standing_order_exceptions e
        join public.memberships m
          on m.org_id = e.org_id and m.profile_id = e.profile_id and m.status = 'active'
       where e.org_id = v_menu.org_id and e.service_date = v_menu.service_date
         and e.action = 'force'
  ),
  inserted as (
    insert into public.orders
      (org_id, menu_id, service_date, profile_id, source, status, placed_at, created_by)
    select v_menu.org_id, v_menu.id, v_menu.service_date, c.profile_id,
           'standing', 'placed', now(), c.profile_id
      from candidate c
    on conflict (menu_id, profile_id) do nothing
    returning 1
  )
  select count(*)::int into v_n from inserted;

  perform private.settle_undecided(v_menu.id);
  return v_n;
end $$;

------------------------------------------------------------- publish_menu

-- As in 20261017100000, with the dish count settled once, after every dish is
-- written, whether or not the status changed.
--
-- The Menu screen's Publish, whole: the menu row, its dishes reconciled in
-- place (removals, then updates, then additions), then the status.
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

  perform set_config('lunch.dish_count_later', 'on', true);

  select coalesce(array_agg(mi.id), '{}') into v_keep
    from public.menu_items mi
   where mi.menu_id = v_menu.id
     and mi.id in (select (x ->> 'id')::bigint from jsonb_array_elements(p_dishes) x
                    where x ->> 'id' is not null);

  -- Removals first: a rename that reuses a departing dish's name would collide
  -- with menu_items_name_uk. A dish somebody chose is refused by its FK; the
  -- system's lines go with their dish (trg_menu_items_hold_menu).
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

  perform set_config('lunch.dish_count_later', '', true);

  -- A republish is an edit in place: no status change, so nothing materializes.
  if v_menu.status <> 'published' then
    update public.menus m set status = 'published' where m.id = v_menu.id;
  end if;

  perform private.settle_undecided(v_menu.id);

  select count(*)::int into v_after from public.orders o
   where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

  return query select v_menu.id, greatest(0, v_after - v_before), v_update;
end $$;

------------------------------------------------------------- set_my_order

-- As in 20261017100000. Eating without naming a dish on a one-dish menu is an
-- undecided slot like any other, so it gets the dish; the menu's FOR SHARE
-- already holds off a dish being added.
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
  elsif private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                          v_menu.order_cutoff_at) = 'open' then
    perform private.assign_only_dish(v_menu.id, v_order.id);
    select oi.item_name_snapshot, oi.line_total_minor into v_name, v_total
      from public.order_items oi where oi.order_id = v_order.id;
  end if;

  return query select v_order.id, v_name, v_total;
end $$;

------------------------------------------------ a correction adds a dish

-- As in 20261007100200, with the menu held before the week. Adding a dish now
-- takes its menu, and a member's choice holds the menu and then waits on the
-- week, so taking the week first was a deadlock.
create or replace function public.correct_meal_off_menu(
  p_org_id bigint, p_service_date date, p_profile_id uuid,
  p_dish_name text, p_price_minor integer, p_quantity smallint default 1,
  p_note text default null, p_reason text default null)
returns table(order_id bigint, menu_item_id bigint, balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_note   text;
  v_name   text := private.dish_name(p_dish_name);
  v_menu   bigint;
  v_period bigint;
  v_item   bigint;
  v_order  bigint;
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
  if not exists (select 1 from public.memberships m
                  where m.org_id = p_org_id and m.profile_id = p_profile_id) then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select mu.id into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date
     for no key update;
  if v_menu is null then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  select mi.id into v_item from public.menu_items mi
   where mi.menu_id = v_menu and lower(btrim(mi.name)) = lower(btrim(v_name));

  if v_item is null then
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu, p_org_id, v_name, p_price_minor,
            coalesce((select max(mi.position) from public.menu_items mi
                       where mi.menu_id = v_menu), -1) + 1)
    returning id into v_item;
  else
    update public.menu_items mi set price_minor = p_price_minor
     where mi.id = v_item and mi.price_minor is null;
  end if;

  v_order := private.replace_order_line(p_org_id, v_menu, p_service_date,
               p_profile_id, v_item, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, menu_item_id, profile_id,
     summary, reason, made_by)
  values (p_org_id, p_service_date, 'off_menu', v_order, v_item, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason);

  return query select v_order, v_item, private.account_balance(p_org_id, p_profile_id);
end $fn$;

----------------------------------------------------- a handover is a choice

-- Offering a meal, or an admin recording one accepted, is the member acting on
-- it, so the line is theirs from then on and a second dish leaves it alone. A
-- slot handed over while undecided gets the one dish unmarked for the same
-- reason (private.assign_only_dish).
create or replace function public.trg_transfer_decides()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  update public.order_items oi set auto_assigned = false
   where oi.order_id = new.order_id and oi.auto_assigned;
  return null;
end $fn$;

create trigger meal_transfers_decide
  after insert on public.meal_transfers
  for each row when (new.status in ('pending', 'accepted'))
  execute function public.trg_transfer_decides();

revoke all on function public.trg_transfer_decides() from public, anon, authenticated;

------------------------------------------------------------ days already out

-- A one-dish day published before this and still open gets the same answer
-- as one published after it.
do $$
declare r record;
begin
  for r in
    select m.id from public.menus m
     where m.status = 'published' and m.order_cutoff_at > now()
     order by m.org_id, m.service_date, m.id
  loop
    perform private.settle_undecided(r.id);
  end loop;
end $$;
