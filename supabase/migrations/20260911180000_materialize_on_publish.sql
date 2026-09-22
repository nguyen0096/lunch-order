-- Publishing materializes standing orders by itself.
--
-- It used to be the client's job: publishMenu called
-- rpc("materialize_standing_orders"). That was wrong twice over.
--
-- It failed, because EXECUTE on public functions is revoked from
-- authenticated, so the call returned 42501 -- surfacing to the admin as "you
-- don't have permission to do that" while publishing a perfectly valid menu.
--
-- And granting EXECUTE to fix that would have been worse: the function is
-- SECURITY DEFINER and takes any menu_id, so any signed-in user could force
-- materialization in another org. A cross-tenant write triggered by anyone is
-- not a price worth paying for a convenience.
--
-- Materializing is an intrinsic consequence of publishing, not an extra step a
-- caller has to remember. So the database does it, and no client can get it
-- wrong or skip it.

create or replace function public.trg_menu_published_materialize() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    perform public.materialize_standing_orders(new.id);
  end if;
  return null;
end $$;

-- AFTER, so the menu row is committed to its new status before orders point at
-- it, and the FK from orders has something valid to reference.
create trigger menus_materialize_on_publish
  after update of status on public.menus
  for each row execute function public.trg_menu_published_materialize();

-- A menu inserted directly as published (seeds, imports) should behave the same.
create trigger menus_materialize_on_insert
  after insert on public.menus
  for each row when (new.status = 'published')
  execute function public.trg_menu_published_materialize();
