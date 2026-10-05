-- Deleting an office cancels every order it has not served, and sends nothing more.
--
-- `delete_office` only set `organizations.deleted_at`. Every policy then hid the
-- office, but its orders stayed placed, and the scheduled work did not look at
-- `deleted_at` at all: the hourly tick (which reads `organizations.status`)
-- went on locking its menus and queueing its menu, cutoff and weekly-bill
-- messages, materializing still ordered for its weekday rules, and the outbox
-- drain sent whatever was queued.
--
-- The owner's rule (2026-10-05), so nothing reaches a caterer for an office
-- that is gone, should ordering ever be sent on automatically:
--
-- * Deleting cancels every placed order on a day not yet over (the office's
--   end of day has not passed, `private.day_stage` short of `done`), today and
--   later, before or after the cutoff. A past day, and a settled week, keep
--   their orders.
-- * Every pending pass in the office is withdrawn, first, so it says why.
-- * Every message still waiting in the outbox for the office is marked
--   failed, and the drain claims nothing for a deleted office from then on.
-- * The hourly tick and materializing skip a deleted office.
-- * Nothing is changed in it afterwards: every correction RPC (through
--   `private.correction_period`) re-reads the office under a lock that waits
--   for a deletion in flight, and refuses a deleted one. A join code and an
--   invitation no longer bring anybody into one.
--
-- The drain also stops sending a private message that no longer applies to
-- somebody who has left or been removed since it was queued, and marks it
-- failed, saying why, as a deleted office's are. Which kinds reach a person
-- who has gone, by design:
--
-- * `weekly_bill`: the tick writes it to anybody with a balance above 0,
--   whatever their status, because money owed stays owed after leaving.
-- * `bill_correction`: `enqueue_correction` writes it to a meal's owner and
--   payer whatever their status, because a meal kept past its cutoff can
--   still be corrected and moves their money. Except the one that asks the
--   reader to act, `... is yours again ... Cancel it before ...` (a meal given
--   back when its recipient left): somebody gone can no longer act in the app,
--   and their own leaving has cancelled that meal anyway.
--
-- Every other kind is written only for active members (`menu_published`,
-- `cutoff_warning`, `transfer_offer`, `transfer_decided`, `dish_choice`,
-- `payment_ack`, `payment_unmatched`, `announcement`, `bug_report`, the test
-- message), so one whose recipient has gone since is out of date and is not
-- sent. `register_reminder`, `weekly_preview` and `payment_reminder` have no
-- writer. Group messages have no recipient and are judged by the office alone.
--
-- The weeks are re-billed, though nobody can read a deleted office's bills:
-- every policy hides them and the weekly bill is no longer sent. It costs
-- one `run_billing` per open week and keeps the invariants true everywhere (a
-- statement is the sum of its lines, a cancelled order bills nobody), so an
-- office restored by hand (`deleted_at = null`, see the column comment) opens
-- on bills that match its orders rather than on charges for meals nobody ate.
--
-- Locks, in the documented order: the publish lock, the office's menus on the
-- days concerned FOR NO KEY UPDATE, every pending pass, each office-week key,
-- each billing week, the orders, and the office row last. The menus are held
-- FOR NO KEY UPDATE rather than FOR SHARE so a member's order in flight on one
-- of those days (which holds the menu FOR SHARE) finishes first and is then
-- cancelled here, or waits and is refused by its own office check once the
-- deletion commits. An admin's correction that passed its admin check before
-- the deletion committed reaches `correction_period`, whose lock on the office
-- row waits for the deletion and then refuses: on a day this deletion holds,
-- it waits at the menu first; on any other day, at the office row.

create or replace function public.delete_office(p_org_id bigint)
returns void
language plpgsql security definer set search_path to '' as $fn$
declare
  v_orders  bigint[];
  v_periods bigint[];
  r         record;
begin
  if not (p_org_id = any ((select private.my_owner_org_ids())::bigint[])) then
    raise exception 'only an owner can delete an office' using errcode = 'insufficient_privilege';
  end if;

  perform private.lock_office_materialize(p_org_id);

  perform 1 from public.menus m
   where m.org_id = p_org_id
     and m.status in ('published', 'locked')
     and private.day_stage(m.org_id, m.service_date, m.status, m.order_cutoff_at)
           not in ('done', 'cancelled')
   order by m.org_id, m.service_date, m.id
     for no key update;

  perform 1 from public.meal_transfers t
   where t.org_id = p_org_id and t.status = 'pending'
   order by t.id
     for no key update;

  select array_agg(o.id order by o.id) into v_orders
    from public.orders o
    join public.menus m on m.id = o.menu_id
   where o.org_id = p_org_id
     and o.status = 'placed'
     and m.status in ('published', 'locked')
     and private.day_stage(m.org_id, m.service_date, m.status, m.order_cutoff_at)
           not in ('done', 'cancelled')
     and not exists (select 1 from public.billing_periods bp
                      where bp.org_id = o.org_id and bp.status = 'closed'
                        and o.service_date between bp.period_start and bp.period_end);

  for r in
    select distinct o.org_id, o.service_date from public.orders o
     where o.id = any (coalesce(v_orders, '{}')) order by 1, 2
  loop
    perform private.lock_office_week(r.org_id, r.service_date);
  end loop;

  select array_agg(x.id order by x.period_start) into v_periods
    from (select distinct bp.id, bp.period_start
            from public.billing_periods bp
            join public.orders o
              on o.org_id = bp.org_id and o.service_date between bp.period_start and bp.period_end
           where o.id = any (coalesce(v_orders, '{}')) and bp.status not in ('closed', 'void')) x;

  for r in select p.id from unnest(coalesce(v_periods, '{}'::bigint[])) with ordinality as p(id, n)
            order by p.n loop
    perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), r.id::int);
  end loop;

  perform 1 from public.orders o where o.id = any (coalesce(v_orders, '{}')) order by o.id
     for no key update;

  -- Withdrawn before the orders go, so each says the office was deleted
  -- rather than that its meal was cancelled. Nobody is told, as for any
  -- withdrawal, and nothing is re-billed by it.
  perform set_config('lunch.pass_withdrawn_with_meal', 'on', true);
  update public.meal_transfers t
     set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()),
         reason = coalesce(t.reason, 'withdrawn: the office was deleted')
   where t.org_id = p_org_id and t.status = 'pending';
  perform set_config('lunch.pass_withdrawn_with_meal', '', true);

  update public.orders o
     set status = 'cancelled', cancelled_at = now()
   where o.id = any (coalesce(v_orders, '{}')) and o.status = 'placed';

  for r in select p.id from unnest(coalesce(v_periods, '{}'::bigint[])) with ordinality as p(id, n)
            order by p.n loop
    perform public.run_billing(r.id);
  end loop;

  update public.notification_outbox n
     set status = 'failed', last_error = 'the office was deleted'
   where n.org_id = p_org_id and n.status = 'pending';

  update public.organizations set deleted_at = now() where id = p_org_id;
end
$fn$;

-- Why the drain must not send a queued message, or null to send it: nothing
-- for a deleted office, and nothing to somebody gone that is not meant for
-- them (see the header for which kinds are).
create or replace function private.outbox_held_back(
  p_org_id bigint, p_kind text, p_dedupe_key text, p_recipient uuid)
returns text
language sql stable set search_path to '' as $fn$
  select case
    when exists (select 1 from public.organizations o
                  where o.id = p_org_id and o.deleted_at is not null)
      then 'the office was deleted'
    when p_recipient is null then null
    when exists (select 1 from public.memberships m
                  where m.org_id = p_org_id and m.profile_id = p_recipient
                    and m.status = 'active') then null
    when p_kind = 'weekly_bill' then null
    when p_kind = 'bill_correction'
         and p_dedupe_key not like 'org:%:bill_correction:transfer:%:returned:profile:%' then null
    else 'the recipient is no longer in the office'
  end;
$fn$;

revoke execute on function private.outbox_held_back(bigint, text, text, uuid)
  from public, anon, authenticated;

-- Marks what must not be sent failed as it falls due, and claims the rest.
-- Only the rows being failed are locked here: a lock on every due row would
-- hold them from a second drain until this one commits.
create or replace function public.claim_outbox(p_limit integer default 20)
returns setof public.notification_outbox
language plpgsql security definer set search_path to '' as $fn$
begin
  update public.notification_outbox n
     set status = 'failed',
         last_error = private.outbox_held_back(n.org_id, n.kind, n.dedupe_key, n.recipient_profile_id)
   where n.id in (select c.id from public.notification_outbox c
                   where c.status = 'pending' and c.next_attempt_at <= now()
                     and private.outbox_held_back(c.org_id, c.kind, c.dedupe_key,
                                                  c.recipient_profile_id) is not null
                     for update skip locked);

  return query
  update public.notification_outbox o
     set status = 'sending', attempts = o.attempts + 1
   where o.id in (
     select c.id from public.notification_outbox c
      where c.status = 'pending' and c.next_attempt_at <= now()
        and private.outbox_held_back(c.org_id, c.kind, c.dedupe_key, c.recipient_profile_id) is null
      order by c.next_attempt_at, c.id
      limit p_limit
      for update skip locked)
  returning o.*;
end $fn$;

-- Every correction RPC takes its week here, after its menu: correct_meal,
-- correct_meal_off_menu, remove_meal, reprice_dish and the three pass RPCs.
-- Unchanged but for holding the office row FOR SHARE last, which waits for a
-- deletion in flight (it updates the row) and then refuses. Taken after the
-- week, as the deletion takes the row after its weeks, so the two cannot wait
-- on each other.
create or replace function private.correction_period(p_org_id bigint, p_service_date date)
returns bigint
language plpgsql set search_path to '' as $fn$
declare v_id bigint; v_status text;
begin
  perform private.lock_office_week(p_org_id, p_service_date);

  v_id := public.ensure_billing_period(p_org_id, p_service_date);
  if v_id is null then
    raise exception 'that week overlaps one already on the books'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform pg_advisory_xact_lock(hashtext('lunch.run_billing'), v_id::int);

  select bp.status into v_status from public.billing_periods bp where bp.id = v_id;

  if v_status = 'closed' then
    raise exception
      'the week of % has been settled, so it can no longer be corrected',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_status = 'void' then
    raise exception 'the week of % is void, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform 1 from public.organizations o
   where o.id = p_org_id and o.deleted_at is null
     for share;
  if not found then
    raise exception 'this office has been deleted, so nothing in it can be changed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return v_id;
end $fn$;

-- Joining with a code: unchanged but for a deleted office, which the code
-- opens no more than a code that does not exist. The office row is already
-- held FOR UPDATE, so a deletion in flight is waited for.
create or replace function private.join_office_with_code(
  p_profile_id uuid, p_code text, p_display_name text,
  p_short_code text default null, p_chat_id bigint default null)
returns table(org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path to '' as $fn$
declare
  v_org   public.organizations%rowtype;
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_code  text := nullif(upper(btrim(coalesce(p_short_code, ''))), '');
  v_mem   public.memberships%rowtype;
  v_had   boolean;
  v_taken bigint;
begin
  if p_profile_id is null
     or not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'You need to sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if v_name = '' then
    raise exception 'Tell me your name first, so people can see who ordered.'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) > 80 then
    raise exception 'That name is too long. Keep it under 80 characters.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_code is not null and v_code !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'A short code is 2 to 8 letters or digits.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_org from public.organizations o
   where o.telegram_join_code = upper(btrim(coalesce(p_code, '')))
   for update;
  if not found or v_org.deleted_at is not null then
    raise exception 'That join code is not valid.' using errcode = 'no_data_found';
  end if;
  if v_org.status <> 'active' then
    raise exception 'That group is not taking new members right now.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select * into v_mem from public.memberships m
   where m.org_id = v_org.id and m.profile_id = p_profile_id for update;
  v_had := found;
  if v_had and v_mem.status <> 'active' and v_mem.removed_at is not null then
    raise exception 'An admin removed you from %, so its join code will not bring you back. Ask an admin there to add you back.',
      v_org.name using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.profiles p set full_name = v_name where p.id = p_profile_id;

  if not v_had then
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_org.id, p_profile_id, 'member',
            coalesce(v_code, private.suggest_short_code(v_org.id, p_profile_id)))
    returning * into v_mem;
  elsif v_mem.status <> 'active' then
    update public.memberships m set status = 'active', role = 'member'
     where m.id = v_mem.id
    returning * into v_mem;
  end if;

  if p_chat_id is not null then
    select tl.membership_id into v_taken from public.telegram_links tl
     where tl.org_id = v_org.id and tl.chat_id = p_chat_id
       and tl.membership_id <> v_mem.id;
    if found then
      raise exception 'This Telegram chat is already linked to somebody else in %. An admin has to unlink it first.',
        v_org.name using errcode = 'unique_violation';
    end if;

    begin
      insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
      values (v_mem.id, v_org.id, p_chat_id, now())
      on conflict (membership_id) do update
        set chat_id = excluded.chat_id, linked_at = now();
    exception when unique_violation then
      raise exception 'This Telegram chat is already linked to somebody else in %. An admin has to unlink it first.',
        v_org.name using errcode = 'unique_violation';
    end;
  end if;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = p_profile_id
     where o.id = v_org.id;
end $fn$;

-- Accepting an invitation: unchanged but for a deleted office, which an
-- invitation leads into no more than one that does not exist
-- (`invitation_preview` already says so). The office row is held FOR SHARE,
-- so a deletion in flight is waited for.
create or replace function public.accept_invitation(p_token uuid)
returns table(org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path to '' as $fn$
declare
  v_inv   public.invitations%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_existing public.memberships%rowtype;
  v_had   boolean;
  v_rank  jsonb := '{"member":1,"admin":2,"owner":3}'::jsonb;
begin
  if v_uid is null then
    raise exception 'You need to sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select lower(p.email) into v_email from public.profiles p where p.id = v_uid;

  select * into v_inv from public.invitations i where i.token = p_token for update;
  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'no_data_found';
  end if;
  perform 1 from public.organizations o
   where o.id = v_inv.org_id and o.deleted_at is null
     for share;
  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'no_data_found';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'That invitation has already been used.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'That invitation has expired. Ask an admin for a new one.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_email is null then
    raise exception 'This invitation was sent to %, and your account has no email address. Ask for a join code instead.',
      v_inv.email using errcode = 'insufficient_privilege';
  end if;
  if lower(v_inv.email) <> v_email then
    raise exception 'This invitation was sent to %. You are signed in as %.',
      v_inv.email, v_email using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing from public.memberships m
   where m.org_id = v_inv.org_id and m.profile_id = v_uid for update;
  v_had := found;

  if v_had and v_existing.status <> 'active' and v_existing.removed_at is not null
     and v_inv.issued_at < v_existing.removed_at then
    raise exception 'This invitation was sent before an admin removed you from %. Ask an admin there to add you back, or to invite you again.',
      (select o.name from public.organizations o where o.id = v_inv.org_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_had then
    update public.memberships m set
      status = 'active',
      role = case
               when m.role = 'owner' then m.role
               when (v_rank ->> v_inv.role)::int > (v_rank ->> m.role)::int
                 then v_inv.role
               else m.role
             end
     where m.org_id = v_inv.org_id and m.profile_id = v_uid;
  else
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_inv.org_id, v_uid, v_inv.role,
            private.suggest_short_code(v_inv.org_id, v_uid));
  end if;

  update public.invitations set accepted_at = now() where id = v_inv.id;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = v_uid
     where o.id = v_inv.org_id;
end $fn$;

-- Materializing orders nothing in a deleted office. Read after the publish
-- lock, so a deletion that held it is seen.
create or replace function private.materialize_office(
  p_org_id bigint, p_weekday integer default null, p_service_date date default null)
returns integer
language plpgsql set search_path to '' as $fn$
declare
  v_today date;
  v_n     integer := 0;
  r       record;
begin
  perform private.lock_office_materialize(p_org_id);

  select private.today_in(o.timezone) into v_today
    from public.organizations o
   where o.id = p_org_id and o.status = 'active' and o.deleted_at is null;
  if v_today is null then return 0; end if;

  for r in
    select m.id from public.menus m
     where m.org_id = p_org_id
       and m.service_date >= v_today
       and m.status = 'published' and m.order_cutoff_at > now()
       and (p_weekday is null or extract(isodow from m.service_date)::int = p_weekday)
       and (p_service_date is null or m.service_date = p_service_date)
     order by m.service_date, m.id
       for no key update
  loop
    v_n := v_n + public.materialize_standing_orders(r.id);
  end loop;
  return v_n;
end $fn$;

create or replace function public.materialize_open_menus()
returns integer
language plpgsql security definer set search_path to '' as $fn$
declare v_total int := 0; r record;
begin
  for r in select o.id from public.organizations o
            where o.status = 'active' and o.deleted_at is null
            order by o.id loop
    v_total := v_total + private.materialize_office(r.id);
  end loop;
  return v_total;
end $fn$;

-- The one function every path materializes through: a publish, a menu
-- inserted by hand, a weekday rule or a plan. Unchanged but for orders
-- nothing in a deleted office.
create or replace function public.materialize_standing_orders(p_menu_id bigint)
returns integer
language plpgsql security definer set search_path to '' as $fn$
declare
  v_menu public.menus%rowtype;
  v_dow  int;
  v_new  bigint[];
begin
  select * into v_menu from public.menus where id = p_menu_id for no key update;
  if not found                       then raise exception 'menu % not found', p_menu_id; end if;
  if v_menu.status <> 'published'    then return 0; end if;
  if now() >= v_menu.order_cutoff_at then return 0; end if;
  if exists (select 1 from public.organizations o
              where o.id = v_menu.org_id and o.deleted_at is not null) then
    return 0;
  end if;

  v_dow := extract(isodow from v_menu.service_date)::int;

  with candidate as (
      select so.profile_id
        from public.standing_orders so
        join public.memberships m
          on m.org_id = so.org_id and m.profile_id = so.profile_id and m.status = 'active'
       where so.org_id = v_menu.org_id and so.weekday = v_dow and so.is_enabled
         and not exists (
               select 1 from public.standing_order_exceptions e
                where e.org_id = so.org_id and e.profile_id = so.profile_id
                  and e.service_date = v_menu.service_date and e.action = 'skip')
    union
      select e.profile_id
        from public.standing_order_exceptions e
        join public.memberships m
          on m.org_id = e.org_id and m.profile_id = e.profile_id and m.status = 'active'
       where e.org_id = v_menu.org_id and e.service_date = v_menu.service_date
         and e.action = 'force'
  ),
  inserted as (
    insert into public.orders
      (org_id, menu_id, service_date, profile_id, source, status, placed_at, created_by)
    select v_menu.org_id, v_menu.id, v_menu.service_date, c.profile_id,
           'standing', 'placed', now(), c.profile_id
      from candidate c
    on conflict (menu_id, profile_id) do nothing
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_new from inserted;

  perform private.settle_undecided(v_menu.id);
  -- settle_undecided converts only while the day is 'open'.
  perform private.assign_new_slots(v_menu.id, v_new);

  return cardinality(v_new);
end $fn$;

-- The hourly tick, unchanged but for skipping a deleted office: it neither
-- locks its menus nor queues its messages nor closes its weeks.
create or replace function private.run_hourly_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  o            public.organizations%rowtype;
  v_today      date;
  v_hour       integer;
  v_period_id  bigint;
  v_period     public.billing_periods%rowtype;
  v_menu_on    boolean;
  v_cutoff_on  boolean;
  v_cutoff_min integer;
  v_bill_on    boolean;
  v_bill_hour  smallint;
begin
  for o in select org.* from public.organizations org
            where org.status = 'active' and org.deleted_at is null
            order by org.id
  loop
    -- One tenant's bad data must not cost every other tenant their hour, so
    -- each org is its own subtransaction. The warning reaches the Postgres log
    -- and the next tick retries; inside the billing window the `>=` test below
    -- means that retry is an hour away rather than a week.
    begin
      v_today := private.today_in(o.timezone);
      v_hour  := extract(hour from private.local_now(o.timezone))::integer;

      -- Read once per office, not once per insert. An office with no row in
      -- org_notifications gets true/70/9 here, which is what this function did
      -- before the table existed.
      select c.enabled into v_menu_on
        from private.notification_config(o.id, 'menu_published') c;
      select c.enabled, c.minutes_before into v_cutoff_on, v_cutoff_min
        from private.notification_config(o.id, 'cutoff_warning') c;
      select c.enabled, c.at_local_hour into v_bill_on, v_bill_hour
        from private.notification_config(o.id, 'weekly_bill') c;

      ------------------------------------------------------------ a. lock menus
      -- Not hour-gated: a cutoff is an instant per menu, not an hour of the
      -- day, and the update erases its own precondition.
      --
      -- Deliberately outside every switch above. Locking a menu whose cutoff
      -- has passed is the ordering rule, not a message, and an office that
      -- turned off the cutoff warning has not asked to keep ordering all night.
      update public.menus m
         set status = 'locked'
       where m.org_id = o.id
         and m.status = 'published'
         and m.order_cutoff_at <= now();

      --------------------------------------------------------- b. notifications
      -- parse_mode is 'none' throughout: dish names and people's names go into
      -- the body verbatim, and Telegram rejects an unescaped & or < in HTML.
      if o.telegram_group_chat_id is not null then

        -- Enqueued from the tick rather than from a publish trigger: with no
        -- sender, up to an hour of scheduling latency is invisible, and holding
        -- every dedupe key in one function is what makes them auditable in one
        -- read. Worth moving to a trigger once the drain lands.
        if v_menu_on then
          insert into public.notification_outbox
            (org_id, dedupe_key, kind, chat_id, body, parse_mode, related_menu_id)
          select o.id,
                 'org:' || o.id || ':menu_published:'
                   || to_char(m.service_date, 'YYYY-MM-DD') || ':group',
                 'menu_published',
                 o.telegram_group_chat_id,
                 private.menu_message(m.id),
                 'none',
                 m.id
            from public.menus m
           where m.org_id = o.id
             and m.status = 'published'
             and m.order_cutoff_at > now()
          on conflict (dedupe_key) do nothing;
        end if;

        if v_cutoff_on then
          insert into public.notification_outbox
            (org_id, dedupe_key, kind, chat_id, body, parse_mode, related_menu_id)
          select o.id,
                 'org:' || o.id || ':cutoff_warning:'
                   || to_char(m.service_date, 'YYYY-MM-DD') || ':group',
                 'cutoff_warning',
                 o.telegram_group_chat_id,
                 private.cutoff_message(m.id),
                 'none',
                 m.id
            from public.menus m
           where m.org_id = o.id
             and m.status = 'published'
             and m.order_cutoff_at >  now()
             and m.order_cutoff_at <= now() + make_interval(mins => v_cutoff_min)
          on conflict (dedupe_key) do nothing;
        end if;
      end if;

      -- The same two announcements, to everybody who finished /start.
      --
      -- Outside the group guard on purpose. A private chat exists the moment
      -- somebody links; the group id is a fallback an admin may never set, and
      -- while it is null these two were the only rows the tick ever produced,
      -- so nothing reached anybody at all. The group copy stays where a group
      -- exists, because one message in the room beats five identical ones.
      --
      -- One switch covers both copies of a kind. An office that wants the menu
      -- in the room but not in five private chats is asking for a different
      -- setting than this one, and half-honouring the switch is worse than
      -- refusing it.
      if v_menu_on then
        insert into public.notification_outbox
          (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
           parse_mode, related_menu_id)
        select o.id,
               'org:' || o.id || ':menu_published:'
                 || to_char(m.service_date, 'YYYY-MM-DD')
                 || ':profile:' || mm.profile_id::text,
               'menu_published',
               tl.chat_id,
               mm.profile_id,
               private.menu_message(m.id),
               'none',
               m.id
          from public.menus m
          join public.memberships mm
            on mm.org_id = o.id and mm.status = 'active'
          join public.telegram_links tl
            on tl.membership_id = mm.id and tl.chat_id is not null
         where m.org_id = o.id
           and m.status = 'published'
           and m.order_cutoff_at > now()
        on conflict (dedupe_key) do nothing;
      end if;

      if v_cutoff_on then
        insert into public.notification_outbox
          (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
           parse_mode, related_menu_id)
        select o.id,
               'org:' || o.id || ':cutoff_warning:'
                 || to_char(m.service_date, 'YYYY-MM-DD')
                 || ':profile:' || mm.profile_id::text,
               'cutoff_warning',
               tl.chat_id,
               mm.profile_id,
               private.cutoff_message(m.id),
               'none',
               m.id
          from public.menus m
          join public.memberships mm
            on mm.org_id = o.id and mm.status = 'active'
          join public.telegram_links tl
            on tl.membership_id = mm.id and tl.chat_id is not null
         where m.org_id = o.id
           and m.status = 'published'
           and m.order_cutoff_at >  now()
           and m.order_cutoff_at <= now() + make_interval(mins => v_cutoff_min)
        on conflict (dedupe_key) do nothing;
      end if;

      -------------------------------------------------------------- c. billing
      -- The org's local week has turned over. `at_local_hour` rather than
      -- midnight because this is when the bill is delivered, and `>=` rather
      -- than `=` so a tick missed at that hour is made good at the next one
      -- instead of a week later.
      if extract(isodow from v_today)::integer = o.billing_week_starts_on
         and v_hour >= v_bill_hour then
        -- the week that just ended is the one containing yesterday
        v_period_id := public.ensure_billing_period(o.id, v_today - 1);

        -- NULL only when an older non-void period overlaps the week asked for,
        -- i.e. the org's week boundary was moved mid-history. Skip rather than
        -- bill the wrong seven days.
        if v_period_id is not null then
          select bp.* into v_period from public.billing_periods bp where bp.id = v_period_id;

          -- No `v_bill_on` here, and that is the point of the comment above the
          -- function: switching off the message does not stop the billing.
          if v_period.status <> 'closed' then
            perform public.run_billing(v_period_id);
            update public.billing_periods bp
               set status = 'closed', closed_at = now()
             where bp.id = v_period_id;
          end if;

          -- Outside that guard on purpose: a tick that closed the period and
          -- then died still owes everybody a message, and the dedupe keys make
          -- the second attempt free.
          if v_bill_on and o.telegram_group_chat_id is not null then
            insert into public.notification_outbox
              (org_id, dedupe_key, kind, chat_id, body, parse_mode,
               related_billing_period_id)
            select o.id,
                   'org:' || o.id || ':weekly_bill:'
                     || to_char(v_period.period_start, 'YYYY-MM-DD') || ':group',
                   'weekly_bill',
                   o.telegram_group_chat_id,
                   'Lunch for ' || to_char(v_period.period_start, 'DD/MM') || ' to '
                     || to_char(v_period.period_end, 'DD/MM') || ' is settled: '
                     || count(*)::text || ' people, '
                     || private.money_text(sum(st.total_due_minor)::bigint,
                          o.currency_minor_units, o.currency)
                     || ' in total. Your own statement is in the app.',
                   'none',
                   v_period_id
              from public.billing_statements st
             where st.billing_period_id = v_period_id
            having count(*) > 0
            on conflict (dedupe_key) do nothing;
          end if;

          -- Only people who still owe, and only where the link was actually
          -- completed: telegram_links.chat_id stays null until the member
          -- finishes /start, and chat_id on the outbox is NOT NULL.
          --
          -- The body moved to `private.weekly_bill_message` unchanged. `mem`
          -- and `bal` stay in the join list because the chat lookup and the
          -- `still owes` test need them, not because the text does.
          if v_bill_on then
            insert into public.notification_outbox
              (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
               parse_mode, related_billing_period_id)
            select o.id,
                   'org:' || o.id || ':weekly_bill:'
                     || to_char(v_period.period_start, 'YYYY-MM-DD')
                     || ':profile:' || st.profile_id::text,
                   'weekly_bill',
                   tl.chat_id,
                   st.profile_id,
                   private.weekly_bill_message(v_period_id, st.profile_id),
                   'none',
                   v_period_id
              from public.billing_statements st
              join public.memberships    mem on mem.org_id = st.org_id
                                            and mem.profile_id = st.profile_id
              join public.v_account_balance bal on bal.org_id = st.org_id
                                               and bal.profile_id = st.profile_id
              join public.telegram_links tl  on tl.membership_id = mem.id
             where st.billing_period_id = v_period_id
               and st.status <> 'waived'
               and bal.balance_minor > 0
               and tl.chat_id is not null
            on conflict (dedupe_key) do nothing;
          end if;
        end if;
      end if;

    exception when others then
      raise warning 'hourly tick failed for org %: % (%)', o.id, sqlerrm, sqlstate;
    end;
  end loop;
end $function$

;
