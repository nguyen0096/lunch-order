-- Materializing standing orders stays in its office, and in its order.
--
-- A weekday rule or an exception written anywhere ran materialize_open_menus,
-- which locked every open menu of every office FOR UPDATE, ordered by date
-- alone. Two such writes in two offices took menus of the same date in
-- whatever order the scan produced, which can deadlock, and every member
-- toggling a weekday held up every admin in every other office editing a menu.
--
-- And it could miss. A rule turned on while a menu was being published saw the
-- menu still as a draft, and the publish did not yet see the rule, so neither
-- created the order. publish_menu (20261017100000) inserts and publishes in one
-- transaction, which made the same true of a skip written while a brand new
-- menu was being published: the skip checked for a menu, found none, and the
-- publish ordered for somebody who had just said no.
--
-- Now:
--
--   * a rule change sweeps only its own office, and only menus of its weekday;
--     an exception, only its own date.
--   * both take the office's materialize lock first, as publish_menu and
--     set_standing_exception do, so each sees what the other committed.
--   * the sweep also takes that office's draft menus from today on, in
--     (date, id) order, so a publish made straight on the table (the web app
--     deployed before this, or a data fix) is waited out rather than missed.
--   * a rule turned off sweeps nothing, as before in effect: it creates no
--     orders and cancels none.
--   * menus are held FOR NO KEY UPDATE, here and in materialize_standing_orders,
--     never FOR UPDATE. Its inserts can wait on a correction's order for the
--     same person, and that correction reaches the menu through a foreign key's
--     FOR KEY SHARE, which FOR UPDATE would block: a deadlock.

create or replace function private.materialize_office(
  p_org_id       bigint,
  p_weekday      integer default null,
  p_service_date date    default null
) returns integer
language plpgsql
set search_path = ''
as $$
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
       and (m.status = 'draft' or (m.status = 'published' and m.order_cutoff_at > now()))
       and (p_weekday is null or extract(isodow from m.service_date)::int = p_weekday)
       and (p_service_date is null or m.service_date = p_service_date)
     order by m.service_date, m.id
       for no key update
  loop
    v_n := v_n + public.materialize_standing_orders(r.id);
  end loop;
  return v_n;
end $$;

revoke execute on function private.materialize_office(bigint, integer, date) from public, anon, authenticated;

-- As in 20260911100500, with the menu held FOR NO KEY UPDATE.
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
  return v_n;
end $$;

-- Kept for a data fix by hand. Office by office, in id order.
create or replace function public.materialize_open_menus() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_total int := 0; r record;
begin
  for r in select o.id from public.organizations o where o.status = 'active' order by o.id loop
    v_total := v_total + private.materialize_office(r.id);
  end loop;
  return v_total;
end $$;

create or replace function public.trg_standing_materialize() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'standing_orders' then
    perform private.materialize_office(new.org_id, new.weekday::int, null);
  else
    perform private.materialize_office(new.org_id, null, new.service_date);
  end if;
  return null;
end $$;

drop trigger standing_orders_materialize on public.standing_orders;
create trigger standing_orders_materialize
  after insert or update of is_enabled on public.standing_orders
  for each row when (new.is_enabled)
  execute function public.trg_standing_materialize();

drop trigger standing_exceptions_materialize on public.standing_order_exceptions;
create trigger standing_exceptions_materialize
  after insert or update of action on public.standing_order_exceptions
  for each row
  execute function public.trg_standing_materialize();

-- As in 20261016100000, with the office's materialize lock taken before the
-- menu is read, so a publish in flight is either waited out or waits for this.
create or replace function public.set_standing_exception(
  p_org_id       bigint,
  p_service_date date,
  p_action       text
) returns text
language plpgsql
security definer
set search_path to ''
as $fn$
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

  perform private.lock_office_materialize(p_org_id);

  -- FOR SHARE also holds off a publish made straight on the table.
  select m.status into v_status
    from public.menus m
   where m.org_id = p_org_id and m.service_date = p_service_date
     for share;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'the menu for % is already out, so order or cancel that day instead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (select 1 from public.orders o
              where o.org_id = p_org_id and o.profile_id = v_uid
                and o.service_date = p_service_date) then
    raise exception 'you already have an order on %, so change that instead',
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
end $fn$;
