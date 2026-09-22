-- Least privilege. Supabase grants ALL on new public tables to anon and
-- authenticated by default; undo that and re-grant narrowly.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

grant select on
  public.organizations, public.profiles, public.memberships, public.invitations,
  public.telegram_links, public.menus, public.menu_items,
  public.orders, public.order_items,
  public.standing_orders, public.standing_order_exceptions, public.meal_transfers,
  public.billing_periods, public.billing_lines, public.billing_statements,
  public.payments, public.notification_outbox, public.v_order_charges
to authenticated;

grant insert, update, delete on
  public.orders, public.order_items,
  public.standing_orders, public.standing_order_exceptions,
  public.meal_transfers, public.telegram_links,
  public.menus, public.menu_items, public.invitations,
  public.billing_periods, public.billing_lines, public.billing_statements,
  public.payments, public.notification_outbox, public.memberships
to authenticated;

grant insert on public.organizations to authenticated;
grant update on public.organizations to authenticated;

-- Identity columns need no sequence grants, unlike serial.

-- PRICE SNAPSHOT, LAYER 2 of 3.
-- Column privileges are checked INDEPENDENTLY of RLS, so this holds even if the
-- snapshot trigger is ever broken or dropped: a member simply cannot write a
-- price. Layer 1 is the trigger; layer 3 is billing_lines.amount_minor.
revoke update on public.order_items from authenticated;
grant  update (menu_item_id, quantity) on public.order_items to authenticated;

-- Members cancel by setting status; they never touch pricing or ownership.
revoke update on public.orders from authenticated;
grant  update (status, cancelled_at) on public.orders to authenticated;

-- Role changes go through an admin. The role-guard trigger is the backstop.
revoke update on public.memberships from authenticated;
grant  update (display_name, role, status, short_code) on public.memberships to authenticated;

revoke update on public.profiles from authenticated;
grant  update (full_name, avatar_url) on public.profiles to authenticated;

revoke update on public.meal_transfers from authenticated;
grant  update (status, reason) on public.meal_transfers to authenticated;

-- anon gets nothing at all: the publishable key can read no application data.
revoke all on all tables in schema public from anon;

-- RPCs the SPA calls. Everything else in public is reachable only through a table.
grant execute on function public.create_organization(text, text, text, char, smallint, text)
  to authenticated;

-- Postgres grants EXECUTE on every new function to PUBLIC, and PostgREST
-- exposes anything in `public` at /rest/v1/rpc/<name>. Without this, anon could
-- call run_billing, settle_outbox, or apply_payment_to_statement -- the last of
-- which would let a stranger mark any bill paid.
--
-- Trigger functions do not need a runtime EXECUTE grant: the privilege is
-- checked at CREATE TRIGGER time, not when the trigger fires. So revoking here
-- does not break the snapshot, lifecycle, window, or materialize triggers.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;

-- The only RPC the SPA is allowed to call. Everything else is service_role or
-- trigger-internal.
grant execute on function public.create_organization(text, text, text, char, smallint, text)
  to authenticated;
