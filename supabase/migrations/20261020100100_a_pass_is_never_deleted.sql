-- A pass is never deleted.
--
-- `authenticated` held DELETE on `meal_transfers`, and `transfers_admin_all`
-- is `for all`, so an admin could delete a pass. No trigger fires on delete:
-- `meal_transfers_rules` and `meal_transfers_rebill` are insert and update
-- only. Deleting an accepted pass therefore moved the meal back onto the giver
-- in `v_order_charges` with no re-bill, no settled-week check and nothing on
-- the record, and the two people's bills disagreed with who was charged.
--
-- A pass ends by being declined or withdrawn, which the rules check and the
-- re-bill follows. The app never deletes one. An order's own delete still
-- takes its passes with it: a foreign key's cascade runs as the table owner,
-- not as the caller.

revoke delete on public.meal_transfers from authenticated, anon;
