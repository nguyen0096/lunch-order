-- An office that starts mid-week still wants the days before it started.
--
-- This app is a tracker. Refusing to record a day that has already happened is
-- the tool arguing with reality, and it made onboarding impossible to do
-- honestly: you either lost the first days or invented them somewhere else.
--
-- Three changes, because letting a past menu exist is not enough on its own.

-- 1. An admin may create a menu for a day that has passed. A member may not.
--
-- `private.my_admin_org_ids()` includes owners, so this is admins and owners
-- both -- the same set every admin policy uses. The UPDATE branch is left
-- alone deliberately: moving an existing menu backwards is still refused,
-- because that rewrites a day people have already ordered against, which is a
-- different act from recording one nobody has.
create or replace function public.enforce_menu_not_in_past()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare v_today date;
begin
  if private.is_service() then return new; end if;
  if new.org_id = any ((select private.my_admin_org_ids())::bigint[]) then return new; end if;

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
end
$fn$;

-- 2. Publishing a past day materialises nothing.
--
-- A standing order is a prediction -- "this person eats on Tuesdays". Applying
-- one to a Tuesday that has already happened writes a guess into the record of
-- what was actually eaten, which is the one thing a tracker must not do. An
-- admin recording a day says who ate; the rule does not get a vote.
create or replace function public.trg_menu_published_materialize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_today date;
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    select private.today_in(o.timezone) into v_today
      from public.organizations o where o.id = new.org_id;
    if new.service_date >= v_today then
      perform public.materialize_standing_orders(new.id);
    end if;
  end if;
  return null;
end
$fn$;

-- 3. An admin can open the week they are billing into.
--
-- Billing periods were created only by the hourly tick, on the org's week-start
-- day. So a week recorded after the fact had nowhere to bill into, and --
-- separately -- an
-- admin holding the caterer's Saturday message could not settle last week
-- until Monday morning. One function answers both.
--
-- ensure_billing_period itself stays revoked from every browser role: it takes
-- an org id and would otherwise let any signed-in user open weeks in somebody
-- else's office. Null from it means an older non-void period overlaps the week
-- asked for, which is a real answer rather than a failure, so it is turned into
-- a sentence rather than passed back as a null nobody would know what to do
-- with.
create or replace function public.ensure_period(p_org_id bigint, p_date date)
returns bigint
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_id bigint;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can open a week'
      using errcode = 'insufficient_privilege';
  end if;

  v_id := public.ensure_billing_period(p_org_id, p_date);
  if v_id is null then
    raise exception 'that week overlaps one already on the books'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_id;
end
$fn$;

revoke execute on function public.ensure_period(bigint, date) from public, anon;
grant  execute on function public.ensure_period(bigint, date) to authenticated;
