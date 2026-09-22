-- Explicit ordering is required, not incidental: orders reference memberships
-- and billing_lines reference orders with ON DELETE RESTRICT, deliberately, so
-- that nobody who has ever ordered can be deleted out from under a bill.
-- Teardown therefore has to unwind from the money end first.
do $$
declare v_orgs bigint[];
begin
  select coalesce(array_agg(id), '{}') into v_orgs
    from public.organizations where slug in ('org-a','org-b');
  if cardinality(v_orgs) = 0 then return; end if;

  delete from public.payments            where org_id = any (v_orgs);
  delete from public.billing_statements  where org_id = any (v_orgs);
  delete from public.billing_lines       where org_id = any (v_orgs);
  delete from public.billing_periods     where org_id = any (v_orgs);
  delete from public.notification_outbox where org_id = any (v_orgs);
  delete from public.meal_transfers      where org_id = any (v_orgs);
  delete from public.order_items         where org_id = any (v_orgs);
  delete from public.orders              where org_id = any (v_orgs);
  delete from public.organizations       where id     = any (v_orgs);
end $$;

delete from auth.users where email in ('anh@orga.test','binh@orga.test','chi@orgb.test');
