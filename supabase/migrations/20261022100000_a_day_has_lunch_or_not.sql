-- A day has lunch or it does not: the draft menu status is gone.
--
-- A menu is now published, locked or cancelled, and a day with no menu row is
-- a day with no lunch. publish_menu inserted a draft and published it in the
-- same transaction, so no draft ever reached anybody; the only ways left to
-- make one were un-publishing (published -> draft with no order yet, which no
-- screen offered) and a direct table write. Production has never held one.
--
-- What publishing does is unchanged, because neither consumer depended on the
-- draft -> published update:
--
--   * Standing orders. menus_materialize_on_insert (20260911180000) already
--     materializes a menu inserted as published, through the same
--     trg_menu_published_materialize the update fires. publish_menu inserts the
--     menu before its dishes, so the orders arrive with no dish and its closing
--     settle_undecided gives a one-dish menu its dish, as it did before. A
--     republish changes no status, so it still materializes nothing.
--   * The menu message. run_hourly_tick picks every published menu before its
--     cutoff and dedupes by date; it never looked at the transition.
--
-- Browsers lose INSERT on menus, so publish_menu is the only way a day begins.
--
-- The rest of this file is every draft branch removed: the status check and
-- default, the lifecycle, the day stage, the RLS that hid drafts from members,
-- the standing exception's "absent or a draft", the sweep's drafts, the dish
-- hold, and assert_menu_correctable. reprice_dish now holds its day's menu and
-- refuses a cancelled one through assert_menu_correctable, like every other
-- correction.
--
-- Fails, rather than guessing, on a database that still holds a draft.

---------------------------------------------------------------- the status

alter table public.menus drop constraint menus_status_check;
alter table public.menus add constraint menus_status_check
  check (status in ('published', 'locked', 'cancelled'));
alter table public.menus alter column status set default 'published';

-- As in 20261003100200, with no draft, and now on insert as well, which
-- stamps what the draft -> published update used to set.
create or replace function public.enforce_menu_lifecycle()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare v_stage text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, (select auth.uid()));
    end if;
    if new.status = 'locked' then
      new.locked_at := coalesce(new.locked_at, now());
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
         ('published','locked'), ('published','cancelled'),
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
      if v_stage <> 'open' then
        raise exception
          'ordering for % has closed, so lunch cannot be called off here; talk to the caterer',
          to_char(new.service_date, 'DD/MM')
          using errcode = 'object_not_in_prerequisite_state';
      end if;
    end if;
  end if;

  if new.service_date is distinct from old.service_date then
    raise exception 'cannot change the service date of a % menu', old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end $function$;

drop trigger menus_lifecycle on public.menus;
create trigger menus_lifecycle before insert or update on public.menus
  for each row execute function public.enforce_menu_lifecycle();

------------------------------------------------------------------ the stage

create or replace function private.day_stage(
  p_org_id bigint, p_service_date date, p_menu_status text,
  p_cutoff_at timestamp with time zone, p_now timestamp with time zone default now())
returns text
language sql
stable
set search_path to ''
as $function$
  select case
    when p_menu_status is null        then 'no_menu'
    when p_menu_status = 'cancelled'  then 'cancelled'
    when p_now >= ((p_service_date::text || ' ' || o.business_day_ends_at::text)::timestamp
                     at time zone o.timezone)                        then 'done'
    when p_now >= ((p_service_date::text || ' ' || o.business_day_starts_at::text)::timestamp
                     at time zone o.timezone)                        then 'closed'
    when p_menu_status = 'locked' or p_now >= p_cutoff_at            then 'locked'
    else 'open'
  end
  from public.organizations o where o.id = p_org_id;
$function$;

create or replace function private.assert_menu_correctable(p_status text, p_service_date date)
returns void
language plpgsql
immutable
set search_path to ''
as $fn$
begin
  if p_status = 'cancelled' then
    raise exception 'lunch on % was cancelled', to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $fn$;

-------------------------------------------------------------------- the RLS

-- Every menu is out, so every member of the office reads every menu and dish.
drop policy menus_select on public.menus;
create policy menus_select on public.menus
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

drop policy menu_items_select on public.menu_items;
create policy menu_items_select on public.menu_items
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

---------------------------------------------------------------- publishing

-- publish_menu is the only way a browser creates a day. A direct insert made a
-- draft nobody saw; without drafts it would be a published day with no dishes,
-- ordered for and announced. The service role (seeds, tests) keeps INSERT.
revoke insert on public.menus from anon, authenticated;

-- As in 20261018100000, inserting the menu as published. The insert's own
-- trigger materializes standing orders before the dishes exist, and the
-- closing settle_undecided gives a one-dish menu its dish. An empty list is
-- refused here, since no status update is left to refuse it.
create or replace function public.publish_menu(
  p_org_id bigint, p_service_date date, p_cutoff_at timestamp with time zone,
  p_dishes jsonb, p_source_text text, p_parse_meta jsonb)
returns table(menu_id bigint, standing_orders integer, was_update boolean)
language plpgsql
security definer
set search_path to ''
as $function$
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
  elsif jsonb_array_length(p_dishes) = 0 then
    raise exception 'cannot publish a menu with no dishes'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_update then
    select count(*)::int into v_before from public.orders o
     where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

    update public.menus m
       set order_cutoff_at = p_cutoff_at, source_text = p_source_text, parse_meta = p_parse_meta
     where m.id = v_menu.id
    returning m.* into v_menu;
  else
    insert into public.menus as m
      (org_id, service_date, order_cutoff_at, created_by, source_text, parse_meta, status)
    values (p_org_id, p_service_date, p_cutoff_at, v_uid, p_source_text, p_parse_meta,
            'published')
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

  perform private.settle_undecided(v_menu.id);

  select count(*)::int into v_after from public.orders o
   where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

  return query select v_menu.id, greatest(0, v_after - v_before), v_update;
end $function$;

------------------------------------------------------------ standing days

-- As in 20260930100000, which is where a published insert started to
-- materialize. Unchanged in effect; restated so the condition reads as what
-- it now is: a new published menu, or a locked one the service reopens.
create or replace function public.trg_menu_published_materialize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_today date;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    select private.today_in(o.timezone) into v_today
      from public.organizations o where o.id = new.org_id;
    if new.service_date >= v_today then
      perform public.materialize_standing_orders(new.id);
    end if;
  end if;
  return null;
end
$function$;

-- As in 20261017100100, without the drafts: the sweep held them only so a
-- draft published straight on the table was waited out, and that update is
-- gone.
create or replace function private.materialize_office(
  p_org_id bigint, p_weekday integer default null, p_service_date date default null)
returns integer
language plpgsql
set search_path to ''
as $function$
declare
  v_today date;
  v_n     integer := 0;
  r       record;
begin
  perform private.lock_office_materialize(p_org_id);

  select private.today_in(o.timezone) into v_today
    from public.organizations o where o.id = p_org_id and o.status = 'active';
  if v_today is null then return 0; end if;

  for r in
    select m.id from public.menus m
     where m.org_id = p_org_id
       and m.service_date >= v_today
       and m.status = 'published' and m.order_cutoff_at > now()
       and (p_weekday is null or extract(isodow from m.service_date)::int = p_weekday)
       and (p_service_date is null or m.service_date = p_service_date)
     order by m.service_date, m.id
       for no key update
  loop
    v_n := v_n + public.materialize_standing_orders(r.id);
  end loop;
  return v_n;
end $function$;

-- As in 20261016100000: a day can be skipped or planned only while it has no
-- menu at all. The order check that stood behind the draft is gone with it.
create or replace function public.set_standing_exception(
  p_org_id bigint, p_service_date date, p_action text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid    uuid := (select auth.uid());
  v_tz     text;
  v_status text;
begin
  if p_action is not null and p_action not in ('skip', 'force') then
    raise exception 'a standing day is skipped or planned, not %', p_action
      using errcode = 'invalid_parameter_value';
  end if;

  if v_uid is null or not (p_org_id = any ((select private.my_org_ids())::bigint[])) then
    raise exception 'you are not a member of that office'
      using errcode = 'insufficient_privilege';
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = p_org_id;
  if p_service_date is null then
    raise exception 'A date is needed.' using errcode = 'invalid_parameter_value';
  end if;
  if p_service_date <= private.today_in(v_tz) then
    raise exception '% is today or already past, so it can no longer be planned ahead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The materialize lock is what a publish takes before inserting the menu,
  -- so a publish in flight is waited out and then seen below.
  perform private.lock_office_materialize(p_org_id);

  select m.status into v_status
    from public.menus m
   where m.org_id = p_org_id and m.service_date = p_service_date
     for share;
  -- No order check after this: orders_menu_date_fk ties every order to its
  -- day's menu, so a day with no menu has no order to contradict.
  if v_status is not null then
    raise exception 'the menu for % is already out, so order or cancel that day instead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_action is null then
    delete from public.standing_order_exceptions e
     where e.org_id = p_org_id and e.profile_id = v_uid and e.service_date = p_service_date;
  else
    insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
    values (p_org_id, v_uid, p_service_date, p_action)
    on conflict (org_id, profile_id, service_date) do update set action = excluded.action;
  end if;

  return p_action;
end $function$;

------------------------------------------------------------------ the dishes

-- As in 20261018100000, holding the menu only while the day is open.
create or replace function public.trg_menu_items_hold_menu()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_menu  public.menus%rowtype;
  v_stage text;
  v_left  text;
begin
  select * into v_menu from public.menus m where m.id = coalesce(new.menu_id, old.menu_id);
  if not found then return coalesce(new, old); end if;
  v_stage := private.day_stage(v_menu.org_id, v_menu.service_date, v_menu.status,
                               v_menu.order_cutoff_at);

  if v_stage = 'open'
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
end $function$;

--------------------------------------------------------------- repricing

-- As in 20261021100000, holding its day's menu FOR SHARE before the week, and
-- refusing a cancelled day in the words the other corrections use. A locked or
-- past day is still repriced: that is most of what the function is for.
create or replace function public.reprice_dish(
  p_menu_item_id bigint, p_price_minor integer, p_reason text default null)
returns table(lines integer, people integer)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_item   public.menu_items%rowtype;
  v_date   date;
  v_status text;
  v_period bigint;
  v_lines  integer;
  v_people integer;
  v_order  bigint;
  v_was    text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that dish is not on any menu' using errcode = 'no_data_found';
  end if;

  if not (v_item.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  if p_price_minor is null or p_price_minor < 0 or p_price_minor >= 1000000000 then
    raise exception 'a price has to be zero or more, and under a billion'
      using errcode = 'check_violation';
  end if;

  select mu.service_date, mu.status into v_date, v_status
    from public.menus mu where mu.id = v_item.menu_id for share;
  perform private.assert_menu_correctable(v_status, v_date);

  v_period := private.correction_period(v_item.org_id, v_date);

  v_was := case when v_item.price_minor is null then null
                else private.money_text(v_item.price_minor::bigint,
                       (select o.currency_minor_units from public.organizations o
                         where o.id = v_item.org_id),
                       (select o.currency from public.organizations o
                         where o.id = v_item.org_id)) end;

  update public.menu_items mi set price_minor = p_price_minor where mi.id = p_menu_item_id;

  with touched as (
    update public.order_items oi
       set menu_item_id = oi.menu_item_id
     where oi.menu_item_id = p_menu_item_id
    returning oi.order_id as oid, oi.profile_id as pid)
  select count(*)::int,
         count(distinct t.pid) filter (where ord.status = 'placed')::int
    into v_lines, v_people
    from touched t
    join public.orders ord on ord.id = t.oid;

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, menu_item_id, summary, reason, made_by)
  values (v_item.org_id, v_date, 'reprice', p_menu_item_id,
          v_item.name || ' on ' || to_char(v_date, 'DD/MM')
            || case when v_was is null then ' priced at ' else ' repriced from ' || v_was || ' to ' end
            || private.money_text(p_price_minor::bigint,
                 (select o.currency_minor_units from public.organizations o where o.id = v_item.org_id),
                 (select o.currency from public.organizations o where o.id = v_item.org_id))
            || ': ' || v_lines  || case when v_lines  = 1 then ' line, '   else ' lines, '   end
            ||         v_people || case when v_people = 1 then ' person.' else ' people.' end,
          v_reason, v_actor);

  for v_order in
    select distinct oi.order_id
      from public.order_items oi
      join public.orders ord on ord.id = oi.order_id and ord.status = 'placed'
     where oi.menu_item_id = p_menu_item_id
  loop
    perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'reprice');
  end loop;

  return query select v_lines, v_people;
end $function$;
