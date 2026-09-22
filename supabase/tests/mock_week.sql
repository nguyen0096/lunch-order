-- Menus across a whole week in every state, so the board can be exercised
-- without waiting for real days to pass.
--
-- This is the half a fake browser clock CANNOT do. The order-window trigger
-- compares against the database's now(), so to test "ordering is closed" you
-- move the cutoff, not the clock. Shifting the browser only changes what the
-- UI shows.
--
-- States produced, relative to today in the org's timezone:
--   -2  locked   -- a past day, frozen, with orders on it
--   -1  published, cutoff gone -- readable, members cannot change it
--    0  published, cutoff gone -- today, already closed
--   +1  published, cutoff open -- the normal case, orderable
--   +2  published, cutoff open
--   +3  draft                  -- invisible to members, visible to admins
--   +4  (no menu)              -- the empty column
--
-- Re-runnable: it replaces the week each time.

do $$
declare
  v_org bigint; v_tz text; v_today date; v_owner uuid;
  r record; v_menu bigint;
begin
  select id, timezone into v_org, v_tz
    from public.organizations where slug = 'persefoni-vn';
  if v_org is null then raise exception 'org persefoni-vn not found'; end if;

  v_today := private.today_in(v_tz);
  select profile_id into v_owner from public.memberships
   where org_id = v_org and role = 'owner' limit 1;

  -- Clear the window first. Orders must go before menus: orders_menu_fk is
  -- ON DELETE RESTRICT so a menu with orders cannot simply be dropped.
  delete from public.order_items
   where org_id = v_org and menu_id in (
     select id from public.menus where org_id = v_org
       and service_date between v_today - 3 and v_today + 5);
  delete from public.meal_transfers
   where org_id = v_org and order_id in (
     select id from public.orders where org_id = v_org
       and service_date between v_today - 3 and v_today + 5);
  delete from public.orders
   where org_id = v_org and service_date between v_today - 3 and v_today + 5;
  delete from public.menus
   where org_id = v_org and service_date between v_today - 3 and v_today + 5;

  for r in
    select * from (values
      (-2, 'locked',    -3),
      (-1, 'published', -2),
      ( 0, 'published', -1),
      ( 1, 'published',  1),
      ( 2, 'published',  2),
      ( 3, 'draft',      3)
      -- +4 deliberately absent, to exercise the empty column
    ) as t(day_offset, want_status, cutoff_days)
  loop
    insert into public.menus (org_id, service_date, order_cutoff_at, created_by, source_text)
    values (v_org, v_today + r.day_offset,
            ((v_today + r.cutoff_days)::timestamp + time '21:00') at time zone v_tz,
            v_owner, 'seeded by mock_week.sql')
    returning id into v_menu;

    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    select v_menu, v_org, d.name, d.price, d.pos
      from (values
        ('Cơm gà xối mỡ', 45000, 0),
        ('Bún bò Huế',    40000, 1),
        ('Phở bò',        45000, 2)
      ) as d(name, price, pos);

    -- Published or locked both have to pass through published first: the
    -- lifecycle trigger only allows draft -> published -> locked.
    if r.want_status in ('published','locked') then
      update public.menus set status = 'published' where id = v_menu;
      perform public.materialize_standing_orders(v_menu);
    end if;

    -- Past days get real orders with dishes picked, so history and billing
    -- have something to work on.
    if r.day_offset <= 0 then
      insert into public.orders
        (org_id, menu_id, service_date, profile_id, source, created_by)
      select v_org, v_menu, v_today + r.day_offset, m.profile_id, 'member', m.profile_id
        from public.memberships m
       where m.org_id = v_org and m.status = 'active'
         and (abs(r.day_offset) + m.id) % 3 <> 0      -- not everyone, every day
      on conflict (menu_id, profile_id) do nothing;

      insert into public.order_items
        (order_id, org_id, profile_id, menu_id, menu_item_id, item_name_snapshot, unit_price_minor)
      select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, '', 0
        from public.orders o
        join lateral (
          select id from public.menu_items
           where menu_id = o.menu_id order by position offset (o.id % 3) limit 1
        ) mi on true
       where o.menu_id = v_menu
      on conflict (order_id, menu_item_id) do nothing;
    end if;

    if r.want_status = 'locked' then
      update public.menus set status = 'locked' where id = v_menu;
    end if;
  end loop;
end $$;

select m.service_date - private.today_in('Asia/Ho_Chi_Minh') as day_offset,
       m.service_date, m.status,
       m.order_cutoff_at at time zone 'Asia/Ho_Chi_Minh' as cutoff_local,
       m.order_cutoff_at > now() as still_open,
       (select count(*) from public.orders o where o.menu_id = m.id) as orders
from public.menus m
join public.organizations o on o.id = m.org_id
where o.slug = 'persefoni-vn'
order by m.service_date;
