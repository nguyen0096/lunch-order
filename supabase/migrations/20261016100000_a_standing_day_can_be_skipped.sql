-- A standing day can be skipped, and a day off the rule can be planned.
--
-- standing_order_exceptions has existed since 20260911100500 and
-- materialize_standing_orders has honoured it since then: a 'skip' keeps the
-- rule from creating an order on that date, a 'force' creates one the rule
-- would not. Nothing wrote it. The Board now does, from a member's own row,
-- on a day whose menu is not out yet.
--
-- The write goes through one function rather than through the table, because
-- the rules that make an exception mean anything are not rules RLS can say:
--
--   * the date is after today in the office's zone. Today and earlier are
--     whatever the order rows say.
--   * the date's menu is absent or a draft. Once it is published the
--     materializer has already run, and a skip written afterwards would read
--     as "you are off" beside an order that says otherwise. From then on the
--     member cancels or orders like anybody else.
--   * the caller has no order row for that date, in any status. An order is
--     the thing a skip would be skipping; it is changed on its own.
--
-- The caller is always auth.uid() and the office always one they are an
-- active member of. There is no profile parameter, so there is no way to name
-- somebody else.
--
-- Direct writes to the table are revoked. Nothing in the app or the bot used
-- them, and leaving them open would let a browser write a skip on a published
-- day and skip every check above.
--
-- Exceptions outlive changes to the weekday rule on purpose. A skip says "not
-- on 14/10", which stays true if Tuesday is later dropped and re-added; a force
-- says "yes on 14/10", which stays true if the rule later covers it and then
-- stops. Deleting them as redundant would lose that intent the moment the rule
-- changes back, so they stay, and they cost nothing while redundant.

create or replace function public.set_standing_exception(
  p_org_id       bigint,
  p_service_date date,
  p_action       text
) returns text
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_tz     text;
  v_status text;
begin
  if p_action is not null and p_action not in ('skip', 'force') then
    raise exception 'a standing day is skipped or planned, not %', p_action
      using errcode = 'invalid_parameter_value';
  end if;

  if v_uid is null or not (p_org_id = any ((select private.my_org_ids())::bigint[])) then
    raise exception 'you are not a member of that office'
      using errcode = 'insufficient_privilege';
  end if;

  select o.timezone into v_tz from public.organizations o where o.id = p_org_id;
  if p_service_date is null then
    raise exception 'A date is needed.' using errcode = 'invalid_parameter_value';
  end if;
  if p_service_date <= private.today_in(v_tz) then
    raise exception '% is today or already past, so it can no longer be planned ahead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- FOR SHARE holds off a publish of this day until the exception is
  -- committed, so the materializer that publish runs is certain to see it.
  select m.status into v_status
    from public.menus m
   where m.org_id = p_org_id and m.service_date = p_service_date
     for share;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'the menu for % is already out, so order or cancel that day instead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (select 1 from public.orders o
              where o.org_id = p_org_id and o.profile_id = v_uid
                and o.service_date = p_service_date) then
    raise exception 'you already have an order on %, so change that instead',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_action is null then
    delete from public.standing_order_exceptions e
     where e.org_id = p_org_id and e.profile_id = v_uid and e.service_date = p_service_date;
  else
    insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
    values (p_org_id, v_uid, p_service_date, p_action)
    on conflict (org_id, profile_id, service_date) do update set action = excluded.action;
  end if;

  return p_action;
end $fn$;

revoke execute on function public.set_standing_exception(bigint, date, text) from public, anon;
grant  execute on function public.set_standing_exception(bigint, date, text) to authenticated;

revoke insert, update, delete on public.standing_order_exceptions from anon, authenticated;
