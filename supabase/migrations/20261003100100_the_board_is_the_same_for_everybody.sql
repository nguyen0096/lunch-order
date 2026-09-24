-- An admin was exempt from the order window everywhere, always.
--
-- `enforce_order_window` returned early for any admin of the office, so an
-- admin could order, change or cancel on any day at any time: after the
-- cutoff, after the kitchen had started, after lunch had been eaten. On the
-- board, which is the screen an admin uses to order their own lunch exactly
-- like everybody else, that is not a power, it is a way to put a meal on a
-- bill for a day that is over and not notice.
--
-- The exemption was written for a real need -- resolving an order with no dish
-- chosen after the cutoff, adding a late order while on the phone to the
-- caterer -- but it granted that need ambiently, to every write an admin makes
-- from any screen. So it now has to be asked for.
--
-- `orders.source` already distinguishes how an order came to exist: 'member'
-- (somebody tapped a cell), 'standing' (a weekday preference materialised it)
-- or 'admin'. The board writes 'member' for everybody, admins included. An
-- admin correcting a past day writes 'admin', and only that is exempt.
--
-- The effect today, with no screen writing 'admin' yet, is exactly what was
-- asked for: nobody orders or changes anything once the cutoff has passed. The
-- door for the admin board stays open, and it is a door somebody has to walk
-- through deliberately rather than one that was never there.

create or replace function public.enforce_order_window()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_menu   public.menus%rowtype;
  v_order  public.orders%rowtype;
  v_tz     text;
  v_source text;
begin
  if private.is_service() then return coalesce(new, old); end if;

  select * into v_menu from public.menus
   where id = coalesce(new.menu_id, old.menu_id);

  if v_menu.status = 'cancelled' then
    raise exception 'the menu for % was cancelled',
      to_char(v_menu.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Which order this write belongs to. On `orders` it is the row itself; on
  -- `order_items`, which has no source of its own, it is the parent's.
  if tg_table_name = 'orders' then
    v_source := coalesce(new.source, old.source);
  else
    select o.source into v_source from public.orders o
     where o.id = coalesce(new.order_id, old.order_id);
  end if;

  -- The one exemption left, and it has to be asked for by name.
  if v_source = 'admin'
     and v_menu.org_id = any ((select private.my_admin_org_ids())::bigint[]) then
    return coalesce(new, old);
  end if;

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
  return coalesce(new, old);
end $function$;

-- `orders.source` decides whether a write is exempt, so it is no longer a
-- label: it is a permission. A member must not be able to write 'admin' on
-- their own order and step outside the clock.
create or replace function public.guard_order_source()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if private.is_service() then return new; end if;
  if new.source is distinct from 'admin' then return new; end if;
  if not (new.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can record an order for a closed day'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $function$;

drop trigger if exists orders_guard_source on public.orders;
create trigger orders_guard_source
  before insert or update of source on public.orders
  for each row execute function public.guard_order_source();

revoke all on function public.enforce_order_window() from public, anon, authenticated;
revoke all on function public.guard_order_source()   from public, anon, authenticated;
