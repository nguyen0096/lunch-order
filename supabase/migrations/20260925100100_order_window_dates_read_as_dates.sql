-- One sentence, two date formats.
--
-- The cutoff refusal read `ordering for 2026-09-24 closed at 22:08 22/09`: the
-- service date fell out as an ISO timestamp because it was interpolated raw,
-- while the cutoff went through to_char and came out as people write dates.
--
-- These messages are not diagnostics. They are shown to the member verbatim,
-- in Telegram and in the web app, because the database is the only place that
-- knows why the write was refused. So they are copy, and mixing 2026-09-24 with
-- 22/09 in one line is the kind of thing that makes software feel unfinished.
--
-- The cutoff keeps its time-then-date shape (`22:08 22/09`): it is an instant,
-- and the time is the part being argued with. The service date is a day, so it
-- is written as one.
--
-- Body is otherwise unchanged from 20260911100400, including the admin
-- exemption and the reasons for it.

create or replace function public.enforce_order_window() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_menu public.menus%rowtype;
  v_tz   text;
begin
  if private.is_service() then return coalesce(new, old); end if;

  select * into v_menu from public.menus
   where id = coalesce(new.menu_id, old.menu_id);

  if v_menu.status = 'cancelled' then
    raise exception 'the menu for % was cancelled',
      to_char(v_menu.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Admins are exempt from the time window on purpose. After the cutoff they
  -- still have to resolve orders that have no dish chosen, and after locking
  -- they are the ones on the phone to the caterer, so they can add a late
  -- order. Members are held to the clock.
  if v_menu.org_id = any ((select private.my_admin_org_ids())::bigint[]) then
    return coalesce(new, old);
  end if;

  if v_menu.status <> 'published' then
    raise exception 'the menu for % is %, not open for ordering',
      to_char(v_menu.service_date, 'DD/MM'), v_menu.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if now() >= v_menu.order_cutoff_at then
    select o.timezone into v_tz from public.organizations o where o.id = v_menu.org_id;
    raise exception 'ordering for % closed at %',
      to_char(v_menu.service_date, 'DD/MM'),
      to_char(v_menu.order_cutoff_at at time zone v_tz, 'HH24:MI DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end $$;
