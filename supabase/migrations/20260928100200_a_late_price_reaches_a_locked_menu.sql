-- The one change a frozen menu must still accept.
--
-- 20260928100000 let a dish be published with no price so the caterer could
-- name it at the weekend. It missed that by then the menu is `locked`: the
-- hourly tick locks every published menu the moment its `order_cutoff_at`
-- passes, ungated by hour, so every day of the week being settled is locked
-- before anybody sits down to settle it. enforce_menu_item_frozen then refuses
-- the price write outright, and the whole feature is unreachable in production.
--
-- What the freeze is actually for is that a dish cannot be renamed or re-priced
-- under people who already ordered it. Filling in a price that was NULL breaks
-- neither: nobody agreed to a price, because there was not one. That is the
-- exemption, and nothing wider.
--
-- Authorization is deliberately not repeated here. menu_items_admin_all already
-- decides who may write a dish; policies answer "who", triggers answer "is this
-- a legal change", and saying it twice means two places to keep in step.
--
-- `locked` only. A cancelled menu's orders are not billed at all, so a price
-- arriving for one is not a late price, it is a mistake.
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
     and new.name         = old.name
     and new.menu_id      = old.menu_id
     and new.position     = old.position
     and new.is_available = old.is_available
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
