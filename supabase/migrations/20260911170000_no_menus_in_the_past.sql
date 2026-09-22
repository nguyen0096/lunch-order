-- A menu cannot be created for a day that has already happened.
--
-- Enforced here rather than only in the UI, for the usual reason: the browser
-- is a suggestion and the database is the rule. It cannot be a CHECK
-- constraint, because "today" depends on the org's timezone and resolving that
-- is not IMMUTABLE.
--
-- Deliberately narrow. It blocks:
--   * creating a menu for a past service date
--   * moving an existing menu's service date into the past
-- It does NOT block editing a menu that is already in the past, because an
-- admin still needs to correct a dish or a price for billing after the fact.

create or replace function public.enforce_menu_not_in_past() returns trigger
language plpgsql set search_path = '' as $$
declare v_today date;
begin
  if private.is_service() then return new; end if;

  select private.today_in(o.timezone) into v_today
    from public.organizations o where o.id = new.org_id;

  if tg_op = 'INSERT' and new.service_date < v_today then
    raise exception 'Cannot create a menu for %, which has already passed. Today is %.',
      to_char(new.service_date, 'DD/MM'), to_char(v_today, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'UPDATE'
     and new.service_date is distinct from old.service_date
     and new.service_date < v_today then
    raise exception 'Cannot move a menu to %, which has already passed.',
      to_char(new.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return new;
end $$;

create trigger menus_not_in_past
  before insert or update of service_date on public.menus
  for each row execute function public.enforce_menu_not_in_past();
