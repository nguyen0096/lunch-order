-- Covering indexes for the composite foreign keys.
--
-- Postgres does not index a foreign key automatically, and an index only helps
-- if the FK's columns are its LEADING columns in order. Several of ours are
-- composite (the org_id-carrying pattern), so the existing unique constraints
-- do not line up. Without these, every cascading delete and every join across
-- one of these keys is a sequential scan.

create index if not exists billing_lines_period_org_idx
  on public.billing_lines (billing_period_id, org_id);
create index if not exists billing_statements_period_org_idx
  on public.billing_statements (billing_period_id, org_id);
create index if not exists invitations_invited_by_idx
  on public.invitations (invited_by);
create index if not exists transfers_order_org_idx
  on public.meal_transfers (order_id, org_id);
create index if not exists transfers_org_to_idx
  on public.meal_transfers (org_id, to_profile_id);
create index if not exists menu_items_menu_org_idx
  on public.menu_items (menu_id, org_id);
create index if not exists order_items_item_menu_idx
  on public.order_items (menu_item_id, menu_id);
create index if not exists order_items_order_fk_idx
  on public.order_items (order_id, org_id, profile_id, menu_id);
create index if not exists orders_org_profile_idx
  on public.orders (org_id, profile_id);
create index if not exists orders_menu_org_idx
  on public.orders (menu_id, org_id);
