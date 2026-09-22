-- The entire security model, in one file so it can be audited in a single read.
--
-- Conventions, all deliberate:
--   * auth calls are wrapped as (select ...) so the planner hoists them into an
--     InitPlan evaluated once per statement, not once per row
--   * the ::bigint[] cast on my_org_ids() is load-bearing, not decoration:
--     `x = any ((select f()))` parses as the SUBQUERY form of ANY and fails with
--     "operator does not exist: bigint = bigint[]". The cast makes it an array
--     expression instead. Verified via EXPLAIN: InitPlan 1, index still used.
--   * every policy names `to authenticated`, so it is skipped entirely for anon
--   * separate policies per command; the predicates genuinely differ
--   * admin is a separate permissive policy, and because my_admin_org_ids() is
--     zero-argument and stable it folds to a constant, leaving sibling indexes usable
--   * FORCE ROW LEVEL SECURITY is deliberately NOT used: it would subject the
--     table owner to its own policies, breaking every SECURITY DEFINER function
--     and every cron job, and v_order_charges relies on exactly that asymmetry

------------------------------------------------------------------ organizations
create policy organizations_select on public.organizations
  for select to authenticated
  using (id = any ((select private.my_org_ids())::bigint[]));

-- Open to any authenticated user: this is how an org comes into existence.
-- create_organization() makes the caller its owner in the same transaction.
create policy organizations_insert on public.organizations
  for insert to authenticated with check (true);

create policy organizations_update_admin on public.organizations
  for update to authenticated
  using      (id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ profiles
-- Your own profile, plus anyone who shares an org with you: the transfer
-- picker and every "who ordered" list needs names.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (select 1 from public.memberships m
                where m.profile_id = public.profiles.id
                  and m.org_id = any ((select private.my_org_ids())::bigint[])));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

------------------------------------------------------------------ memberships
create policy memberships_select on public.memberships
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

create policy memberships_admin_all on public.memberships
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

-- Members may edit their own display name. The role column is withheld by
-- column grant, and the role-guard trigger is the backstop.
create policy memberships_update_self on public.memberships
  for update to authenticated
  using      (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

------------------------------------------------------------------ invitations
-- Admin-only. An invitee is by definition not yet a member, so no policy could
-- let them see their own row; accept_invitation(token) is the sole path in.
create policy invitations_admin_all on public.invitations
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ telegram_links
-- Own row plus org admin. This table exists separately from memberships
-- precisely because RLS cannot hide a column: a link token on a row everyone
-- in the org can read would be readable by every colleague.
create policy telegram_links_own on public.telegram_links
  for all to authenticated
  using      (exists (select 1 from public.memberships m
                       where m.id = public.telegram_links.membership_id
                         and m.profile_id = (select auth.uid())))
  with check (exists (select 1 from public.memberships m
                       where m.id = public.telegram_links.membership_id
                         and m.profile_id = (select auth.uid())));

create policy telegram_links_admin on public.telegram_links
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ menus
create policy menus_select on public.menus
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and (status <> 'draft' or org_id = any ((select private.my_admin_org_ids())::bigint[])));

create policy menus_admin_all on public.menus
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ menu_items
create policy menu_items_select on public.menu_items
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and (org_id = any ((select private.my_admin_org_ids())::bigint[])
              or exists (select 1 from public.menus m
                          where m.id = public.menu_items.menu_id and m.status <> 'draft')));

create policy menu_items_admin_all on public.menu_items
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ orders
create policy orders_select_own on public.orders
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

-- You can also see an order somebody is trying to hand to you.
-- This MUST go through a SECURITY DEFINER helper rather than reading
-- meal_transfers inline. Inline, it forms a cycle: the meal_transfers INSERT
-- policy reads orders, orders' SELECT policies read meal_transfers, and
-- Postgres aborts with "infinite recursion detected in policy for relation
-- meal_transfers". The helper bypasses RLS on the inner read and breaks it.
create policy orders_select_incoming on public.orders
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and private.order_offered_to_me(public.orders.id));

create policy orders_insert_own on public.orders
  for insert to authenticated
  with check (org_id = any ((select private.my_org_ids())::bigint[])
              and profile_id = (select auth.uid())
              and created_by = (select auth.uid()));

create policy orders_update_own on public.orders
  for update to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()))
  with check (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

-- Deliberately no member DELETE: cancelling is status='cancelled', which keeps
-- the audit trail and holds the one-order-per-day slot so a republish cannot
-- silently resurrect it.
create policy orders_admin_all on public.orders
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ order_items
create policy order_items_own on public.order_items
  for all to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()))
  with check (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

create policy order_items_admin_all on public.order_items
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ standing orders
create policy standing_orders_own on public.standing_orders
  for all to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()))
  with check (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

create policy standing_orders_admin on public.standing_orders
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

create policy standing_exc_own on public.standing_order_exceptions
  for all to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()))
  with check (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

create policy standing_exc_admin on public.standing_order_exceptions
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ meal_transfers
create policy transfers_select_party on public.meal_transfers
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and ((select auth.uid()) in (from_profile_id, to_profile_id)));

create policy transfers_insert_own on public.meal_transfers
  for insert to authenticated
  with check (org_id = any ((select private.my_org_ids())::bigint[])
              and created_by = (select auth.uid())
              and exists (select 1 from public.orders o
                           where o.id = public.meal_transfers.order_id
                             and o.profile_id = (select auth.uid())));

-- RLS grants both parties access; the trigger decides which of them may make
-- which transition. Same split as the cutoff rule, and for the same reason:
-- index-friendly policies, legible errors.
create policy transfers_update_party on public.meal_transfers
  for update to authenticated
  using      (org_id = any ((select private.my_org_ids())::bigint[])
              and ((select auth.uid()) in (from_profile_id, to_profile_id)))
  with check (org_id = any ((select private.my_org_ids())::bigint[])
              and ((select auth.uid()) in (from_profile_id, to_profile_id)));

create policy transfers_admin_all on public.meal_transfers
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ billing
create policy billing_periods_select on public.billing_periods
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]));

create policy billing_periods_admin on public.billing_periods
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

create policy billing_lines_select_payer on public.billing_lines
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and payer_profile_id = (select auth.uid()));

-- Someone who gave their meal away must still see the line, marked as owed by
-- the recipient. Without this the meal simply vanishes from their view and they
-- cannot verify they were not charged for it.
create policy billing_lines_select_placer on public.billing_lines
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and original_profile_id = (select auth.uid()));

create policy billing_lines_admin on public.billing_lines
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));
-- No member write policy at all: billing_lines are written only by run_billing().

create policy billing_statements_select_own on public.billing_statements
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[]) and profile_id = (select auth.uid()));

create policy billing_statements_admin on public.billing_statements
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

create policy payments_admin on public.payments
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

------------------------------------------------------------------ outbox
create policy outbox_admin on public.notification_outbox
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));
