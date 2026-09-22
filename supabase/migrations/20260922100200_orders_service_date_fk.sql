-- orders.service_date is proven by foreign key, like every other carried column.
--
-- It is a copy of menus.service_date, but the only thing tying an order to its
-- menu was orders_menu_fk (menu_id, org_id), which says nothing about the date.
-- So the copy could disagree with its source, and run_billing() selects a
-- period's orders on exactly that column: a drifted date moves a meal into the
-- wrong week's bill, or out of every week's bill.
--
-- Everything else denormalized here is proven this way already -- order_items
-- carries org_id/profile_id/menu_id and points at orders_id_org_profile_menu_uk
-- -- and this column was the one exception.
--
-- orders_menu_fk is dropped rather than kept alongside. menus.id is the primary
-- key, so a row matching (menu_id, org_id, service_date) is the same row that
-- matched (menu_id, org_id): the narrow key is implied by the wide one, and
-- keeping both means a second identical lookup on every order write. The wide
-- key also cascades a service_date correction on a draft menu into its orders,
-- which the narrow one could not.
--
-- If any order has already drifted, the ADD fails here. That is the point.

alter table public.menus
  add constraint menus_id_org_date_uk unique (id, org_id, service_date);

alter table public.orders
  drop constraint orders_menu_fk,
  add  constraint orders_menu_date_fk foreign key (menu_id, org_id, service_date)
       references public.menus (id, org_id, service_date)
       on update cascade on delete restrict;

-- No new index: orders_menu_org_idx already leads with (menu_id, org_id) in
-- order, so the cascade lookup stays indexed and service_date is a filter over
-- the handful of rows one menu returns.
