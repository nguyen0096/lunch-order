-- Removes the mock office. Unwinds from the money end first, because orders
-- reference memberships and billing_lines reference orders with ON DELETE
-- RESTRICT -- deliberately, so nobody with a bill can be deleted silently.
do $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids
    from auth.users where email like 'mock.%';
  if cardinality(v_ids) = 0 then return; end if;

  delete from public.billing_statements where profile_id = any (v_ids);
  delete from public.billing_lines
   where payer_profile_id = any (v_ids) or original_profile_id = any (v_ids);
  delete from public.meal_transfers
   where from_profile_id = any (v_ids) or to_profile_id = any (v_ids);
  delete from public.order_items          where profile_id = any (v_ids);
  delete from public.orders               where profile_id = any (v_ids);
  delete from public.standing_order_exceptions where profile_id = any (v_ids);
  delete from public.standing_orders      where profile_id = any (v_ids);
  delete from public.telegram_links
   where membership_id in (select id from public.memberships where profile_id = any (v_ids));
  delete from public.memberships          where profile_id = any (v_ids);
  delete from auth.users                  where id = any (v_ids);
end $$;

select count(*) as remaining_mock_users from auth.users where email like 'mock.%';
