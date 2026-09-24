-- Cancelling lunch left every order standing, and billed.
--
-- The dialog said so out loud: "Cancelling does not cancel their orders: a
-- meal already priced stays on the bill." That sentence was accurate and the
-- behaviour behind it was wrong. Cancelling a day is how an admin says lunch
-- is not happening, and a lunch that is not happening cannot be charged for.
-- It also left nobody able to answer the only question that matters
-- afterwards: who had ordered, and are any of them still expecting food.
--
-- So cancelling now cancels the day's orders, and can only be done while the
-- day is still open for ordering.
--
-- The time limit is the cutoff, and it is the cutoff for a reason the admin
-- gave: the cutoff is when the headcount goes to the caterer. Before it,
-- calling lunch off costs nothing. After it, the food is being made and
-- somebody is paying for it, so "cancelled" would be a claim about the world
-- that is not true. A day that is already locked and has to be called off is a
-- conversation with the caterer, not a button.
--
-- This closes the backlog entry "Cancelling lunch does not cancel the charge".
-- `run_billing` already filters on `order_status = 'placed'`, so cancelling
-- the orders takes them out of billing with no change to the billing code.

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
      if not exists (select 1 from public.menu_items mi
                      where mi.menu_id = new.id and mi.is_available) then
        raise exception 'cannot publish a menu with no available dishes'
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, (select auth.uid()));
    end if;

    if new.status = 'locked' then
      new.locked_at := coalesce(new.locked_at, now());
    end if;

    -- Calling lunch off is only honest while nobody is cooking it. The
    -- service role is exempt so a data fix is still possible, as everywhere.
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

    -- Un-publishing would orphan orders that already exist, including the
    -- standing ones materialized at publish time.
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

/**
 * The orders go with the day.
 *
 * AFTER, not BEFORE, so it runs once the menu row is settled. It writes
 * `orders` directly rather than going through anything member-facing, and
 * `enforce_order_window` would refuse these writes for exactly the right
 * reason from its own point of view, so the whole statement runs as the
 * definer with `private.is_service()` true.
 */
create or replace function public.trg_menu_cancelled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.orders
     set status = 'cancelled', cancelled_at = now()
   where menu_id = new.id and status = 'placed';
  return null;
end $function$;

drop trigger if exists menus_cancel_orders on public.menus;
create trigger menus_cancel_orders
  after update of status on public.menus
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.trg_menu_cancelled();

revoke all on function public.enforce_menu_lifecycle() from public, anon, authenticated;
revoke all on function public.trg_menu_cancelled()     from public, anon, authenticated;
