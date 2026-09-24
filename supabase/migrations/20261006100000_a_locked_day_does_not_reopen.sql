-- A locked day does not reopen.
--
-- `enforce_reopen_window` allowed locked -> published while the kitchen had not
-- started, on the reading that a cutoff can close a day by mistake. The product
-- owner's rule is narrower: the cutoff is when the headcount goes to the
-- caterer, and after that nobody orders, admins included. A day that can reopen
-- is a day whose count was never final, and reopening let an admin order after
-- the kitchen had been told.
--
-- What actually got eaten is corrected against the day itself, from the admin's
-- own screen, where it reaches the bill directly. That is a correction to a
-- record, which is what it is, rather than a pretence that ordering is open.
--
-- The service role keeps the transition, as it keeps every other one: undoing a
-- genuine mistake by hand is support, not a product feature.

drop trigger if exists menus_reopen_window on public.menus;
drop function if exists public.enforce_reopen_window();

create or replace function public.refuse_reopen()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if private.is_service() then return new; end if;
  if old.status = 'locked' and new.status = 'published' then
    raise exception 'orders for % have gone to the caterer, so ordering does not reopen',
      to_char(new.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end $function$;

drop trigger if exists menus_no_reopen on public.menus;
create trigger menus_no_reopen
  before update of status on public.menus
  for each row execute function public.refuse_reopen();

comment on function public.refuse_reopen() is
  'Refuses locked -> published. The caterer has the count; it does not reopen.';
