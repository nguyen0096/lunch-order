-- The orders grid is a shared board: every member sees who is eating on which
-- day, like a spreadsheet with dates across the top and people down the side.
--
-- This is a deliberate relaxation. Previously a member could read only their
-- own orders. Org-wide read means anyone can count a colleague's ticks and
-- infer their weekly spend, which is the intended trade for a shared board in
-- a single small office. What someone OWES stays private: billing_statements
-- and billing_lines keep their own-row policies, because a running balance is
-- more sensitive than a lunch choice.
--
-- Writes are unchanged. You may still only create, edit or cancel your own
-- order, so the board is readable by all and writable a row at a time.

create policy orders_select_org on public.orders
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

-- Needed so the board can show WHICH dish, not just that a tick exists. Same
-- reasoning: read-only, org-scoped, no write path added.
create policy order_items_select_org on public.order_items
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

-- orders_select_own and orders_select_incoming are now subsumed by the broader
-- policy. Dropping them keeps the policy set honest about what is enforced --
-- leaving dead policies in place invites someone to "tighten" one later and
-- believe they have changed the outcome.
drop policy orders_select_own on public.orders;
drop policy orders_select_incoming on public.orders;
drop policy order_items_own on public.order_items;

-- order_items writes, restated without the SELECT that moved above.
create policy order_items_write_own on public.order_items
  for insert to authenticated
  with check (org_id = any ((select private.my_org_ids())::bigint[])
              and profile_id = (select auth.uid()));
create policy order_items_update_own on public.order_items
  for update to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[])
              and profile_id = (select auth.uid()))
  with check (org_id = any ((select private.my_org_ids())::bigint[])
              and profile_id = (select auth.uid()));
create policy order_items_delete_own on public.order_items
  for delete to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and profile_id = (select auth.uid()));
