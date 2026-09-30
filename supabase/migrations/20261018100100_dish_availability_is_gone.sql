-- Dish availability is gone from the schema, and a browser writes no dish.
--
-- 20261018100000 stopped every function reading menu_items.is_available, and
-- the web app and the bot stopped selecting it. This migration is pushed only
-- once both are live: a client still selecting the column fails its whole read
-- the moment it is dropped.
--
-- Dishes are written by publish_menu and the corrections, which hold the menu
-- before the dish. A direct delete locks the dish row first and only then
-- reaches the trigger that takes the menu, while a member's choice holds the
-- menu and waits on that row through its foreign key: a deadlock. The web app
-- before 20261017100000 wrote dishes directly, which is why this waits for the
-- same deploy.

alter table public.menu_items drop column is_available;

revoke insert, update, delete on public.menu_items from authenticated, anon;
