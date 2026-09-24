-- A day is not open or shut. It goes through five stages, and until now the
-- app knew two of them.
--
--   no menu -> open -> locked -> closed -> done
--
-- `open`   the menu is published and the cutoff has not passed.
-- `locked` the cutoff passed. The headcount went to the caterer. Nobody but
--          an admin changes an order, which `enforce_order_window` already
--          enforced and still does.
-- `closed` the kitchen started cooking, at the office's own start of day.
--          The count is spent. An admin can no longer reopen ordering,
--          because there is nothing left to reopen it for.
-- `done`   the office's end of day. Lunch happened. Nobody records a meal
--          passed to somebody else any more.
--
-- The two new ones are the ones the app was missing, and the gap showed:
-- `enforce_transfer_rules` bounded a member's meal pass by the BILLING PERIOD
-- and nothing else, so on a Friday a member could still hand Monday's lunch
-- to a colleague -- a lunch three days eaten. The week being open for billing
-- is not the same fact as the day being open for changes, and one was standing
-- in for the other.
--
-- The stages are derived, never stored. A stored one needs a job to advance
-- it, the hourly tick is the only job there is, and an hour is long enough for
-- a member to pass on a meal that is already on a plate. `menus.status` stays
-- what it is -- draft, published, locked, cancelled -- and remains the thing
-- an admin sets; these two stages are the clock's, and the clock needs no
-- column.

alter table public.organizations
  add column if not exists business_day_starts_at time not null default '08:30',
  add column if not exists business_day_ends_at   time not null default '17:30';

comment on column public.organizations.business_day_starts_at is
  'When the kitchen starts cooking. After this a day cannot be reopened for ordering.';
comment on column public.organizations.business_day_ends_at is
  'When lunch is over. After this a member cannot record a meal passed to somebody else.';

alter table public.organizations
  add constraint organizations_business_day_order
  check (business_day_starts_at < business_day_ends_at);

/**
 * The stage a day is in, for one office, at one instant.
 *
 * Every rule below asks this rather than comparing timestamps itself, so
 * "after the kitchen starts" means one thing in the whole schema.
 */
create or replace function private.day_stage(
  p_org_id bigint,
  p_service_date date,
  p_menu_status text,
  p_cutoff_at timestamptz,
  p_now timestamptz default now()
) returns text
language sql
stable
set search_path to ''
as $$
  select case
    when p_menu_status is null        then 'no_menu'
    when p_menu_status = 'cancelled'  then 'cancelled'
    when p_menu_status = 'draft'      then 'draft'
    when p_now >= ((p_service_date::text || ' ' || o.business_day_ends_at::text)::timestamp
                     at time zone o.timezone)                        then 'done'
    when p_now >= ((p_service_date::text || ' ' || o.business_day_starts_at::text)::timestamp
                     at time zone o.timezone)                        then 'closed'
    when p_menu_status = 'locked' or p_now >= p_cutoff_at            then 'locked'
    else 'open'
  end
  from public.organizations o where o.id = p_org_id;
$$;

grant execute on function private.day_stage(bigint, date, text, timestamptz, timestamptz)
  to authenticated;

/** The stage of the day an order belongs to. */
create or replace function private.order_stage(p_order_id bigint, p_now timestamptz default now())
returns text
language sql
stable
set search_path to ''
as $$
  select private.day_stage(o.org_id, o.service_date, m.status, m.order_cutoff_at, p_now)
    from public.orders o join public.menus m on m.id = o.menu_id
   where o.id = p_order_id;
$$;

grant execute on function private.order_stage(bigint, timestamptz) to authenticated;

/**
 * A member's meal pass now ends with the day, not with the billing week.
 *
 * Admins keep the whole open period, deliberately: correcting what was
 * recorded for a past day is most of why an admin touches a transfer at all,
 * and it is the case this app exists to make possible. What they are doing is
 * bookkeeping about a lunch that happened; what a member would be doing is
 * changing who ate a lunch that is over.
 */
create or replace function public.enforce_transfer_rules()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_order public.orders%rowtype;
  v_uid   uuid := (select auth.uid());
  v_admin boolean;
  v_stage text;
begin
  if private.is_service() then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'order % not found', new.order_id; end if;
  v_admin := v_order.org_id = any ((select private.my_admin_org_ids())::bigint[]);

  if exists (select 1 from public.billing_lines bl
               join public.billing_periods bp on bp.id = bl.billing_period_id
              where bl.order_id = new.order_id and bp.status = 'closed') then
    raise exception 'that meal is already on a closed bill'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not v_admin then
    v_stage := private.order_stage(new.order_id);
    if v_stage = 'done' then
      raise exception 'lunch on % is over, so it can no longer be passed to anybody',
        to_char(v_order.service_date, 'DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if v_order.status <> 'placed' then
      raise exception 'cannot transfer a % order', v_order.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.org_id          := v_order.org_id;
    new.from_profile_id := v_order.profile_id;

    if new.created_by <> v_order.profile_id and not v_admin then
      raise exception 'only the person who ordered, or an admin, can pass this meal on'
        using errcode = 'insufficient_privilege';
    end if;

    -- Recording someone else's arrangement, not giving away your own meal.
    if v_admin and new.created_by <> v_order.profile_id then
      new.status := 'accepted'; new.decided_at := now(); new.decided_by := v_uid;
    end if;

  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'this transfer is already %', old.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.status in ('accepted','declined')
       and v_uid is distinct from old.to_profile_id and not v_admin then
      raise exception 'only the person receiving the meal can accept or decline it'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'cancelled'
       and v_uid is distinct from old.from_profile_id and not v_admin then
      raise exception 'only the person who offered the meal can cancel it'
        using errcode = 'insufficient_privilege';
    end if;
    new.decided_at := now();
    new.decided_by := v_uid;
  end if;
  return new;
end $function$;

/**
 * Reopening ordering stops once the kitchen has started.
 *
 * The screen already hides the control on a day that has passed; this is the
 * rule underneath it, which a screen cannot be. `locked -> published` is the
 * transition `enforce_menu_lifecycle` permits and goes on permitting, right
 * up to the office's own start of day.
 */
create or replace function public.enforce_reopen_window()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare v_stage text;
begin
  if private.is_service() then return new; end if;
  if not (old.status = 'locked' and new.status = 'published') then return new; end if;

  v_stage := private.day_stage(new.org_id, new.service_date, old.status,
                               new.order_cutoff_at);
  if v_stage in ('closed', 'done') then
    raise exception 'lunch on % is already being cooked, so ordering cannot reopen',
      to_char(new.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end $function$;

drop trigger if exists menus_reopen_window on public.menus;
create trigger menus_reopen_window
  before update of status on public.menus
  for each row execute function public.enforce_reopen_window();
