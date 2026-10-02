-- A standing slot the system creates on a one-dish menu gets the dish.
--
-- materialize_standing_orders creates slots while the cutoff is ahead, but it
-- left the dish to private.settle_undecided, which converts only while the
-- day's stage is 'open'. The stage turns 'closed' (Cooking) at the office's
-- start of day even when the cutoff is later, so a one-dish menu published
-- for today after 08:30 gave its standing orders no dish, while the menu
-- message, sent because the cutoff was ahead, said "Standing orders are down
-- for <dish>." The system never leaves a slot it has just created undecided,
-- so those slots now get the one dish, marked as the system's, whatever the
-- stage, short of a settled week: in materialize_standing_orders for a slot
-- made later (a rule turned on, a plan), and in publish_menu for a new day,
-- whose insert materializes before its dishes exist. Only the new slots:
-- converting or reverting anybody else's order stays an 'open'-stage rule
-- (settle_undecided, unchanged).
--
-- The menu message says standing orders are down for the dish only when it is
-- true of the orders: a day today or later (the only days publishing creates
-- standing orders; an admin can give a past day a cutoff still ahead through
-- the API) whose placed standing orders all have a dish line. A two-dish menu
-- published while cooking and then cut to one leaves its standing slots
-- undecided, since nothing converts outside 'open', and the line is left out.

-- The one dish for slots the system has just created, whatever the day's
-- stage. Nothing in a settled week, as in settle_undecided. The caller holds
-- the menu FOR NO KEY UPDATE.
create or replace function private.assign_new_slots(p_menu_id bigint, p_order_ids bigint[])
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if coalesce(cardinality(p_order_ids), 0) = 0 then return; end if;
  if exists (select 1 from public.menus m
               join public.billing_periods bp
                 on bp.org_id = m.org_id and bp.status = 'closed'
                and m.service_date between bp.period_start and bp.period_end
              where m.id = p_menu_id) then
    return;
  end if;
  perform private.assign_only_dish(p_menu_id, n.id) from unnest(p_order_ids) as n(id);
end $fn$;

revoke execute on function private.assign_new_slots(bigint, bigint[]) from public, anon, authenticated;

-- As in 20261018100000, giving the slots it inserts the dish.
create or replace function public.materialize_standing_orders(p_menu_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_menu public.menus%rowtype;
  v_dow  int;
  v_new  bigint[];
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
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_new from inserted;

  perform private.settle_undecided(v_menu.id);
  -- settle_undecided converts only while the day is 'open'.
  perform private.assign_new_slots(v_menu.id, v_new);

  return cardinality(v_new);
end $$;

-- As in 20261022100000; a new day's standing slots get the one dish once its
-- dishes are written.
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

  -- A new day's orders are all the standing slots its insert just created,
  -- and the dishes exist only now.
  if not v_update then
    perform private.assign_new_slots(v_menu.id,
      (select array_agg(o.id order by o.id) from public.orders o where o.menu_id = v_menu.id));
  end if;

  select count(*)::int into v_after from public.orders o
   where o.menu_id = v_menu.id and o.source = 'standing' and o.status = 'placed';

  return query select v_menu.id, greatest(0, v_after - v_before), v_update;
end $function$;

-- As in 20261018100000, the standing line only when the orders bear it out.
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
         || case when d.total = 1 and m.service_date >= private.today_in(o.timezone)
                      and not exists (select 1 from public.orders x
                                       where x.menu_id = m.id and x.source = 'standing'
                                         and x.status = 'placed'
                                         and not exists (select 1 from public.order_items i
                                                          where i.order_id = x.id))
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
