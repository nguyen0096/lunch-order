-- An admin orders for anybody on a published day, and says so.
--
-- The Orders screen puts correct_meal, correct_meal_off_menu and remove_meal
-- in front of every day of the week, not only the days that are over. Two
-- things they did were fine for a finished day and wrong for that:
--
--   * They checked only the week (ordering-rules Observed 8). A draft menu
--     took an order nobody could see, and a cancelled one had its order
--     revived and billed. Both are now refused, in the words below. A past day
--     with a draft menu is published on the Menu screen first.
--   * The member was always told "Lunch on 02/10 was corrected by Nguyên",
--     including when Nguyên had just ordered Friday's lunch for them at their
--     request. For a day that is not over yet the message now says what
--     happened: "Nguyên ordered lunch for you on 02/10." or "Nguyên cancelled
--     your lunch on 02/10." A reprice keeps "corrected" whatever the day,
--     since nobody ordered anything.
--
-- The message needs to know which of those it is, so correction_body and
-- enqueue_correction take the correction's kind. They are dropped and
-- recreated rather than overloaded: a four-argument call would otherwise be
-- ambiguous between the old function and the new one with a default.
--
-- The menu is now held FOR SHARE before the week, which is the lock order in
-- docs/reference/database.md, so cancelling lunch waits for a correction in
-- flight instead of missing the order it writes. remove_meal also takes the
-- order row before it reads the status it refuses on.

------------------------------------------------------------------- the stage

create or replace function private.assert_menu_correctable(p_status text, p_service_date date)
returns void
language plpgsql
immutable
set search_path to ''
as $fn$
begin
  if p_status = 'draft' then
    raise exception 'the menu for % isn''t published yet', to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if p_status = 'cancelled' then
    raise exception 'lunch on % was cancelled', to_char(p_service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $fn$;

------------------------------------------------------------------ the message

drop function if exists private.enqueue_correction(bigint, bigint, uuid, text);
drop function if exists private.correction_body(bigint, uuid, uuid, text);

-- As in 20261007100200, with the first line chosen by what happened. The eater
-- of a day that is not over was ordered for or cancelled for; everybody else,
-- and every reprice, reads that the record was corrected.
create or replace function private.correction_body(
  p_order_id bigint, p_recipient uuid, p_actor uuid, p_reason text, p_kind text)
returns text
language plpgsql
stable
set search_path to ''
as $fn$
declare
  o       public.orders%rowtype;
  v_lines text[];
  v_what  text;
  v_eater text;
  v_actor text;
  v_ahead boolean;
begin
  select * into o from public.orders where id = p_order_id;
  v_what  := private.order_dishes(p_order_id);
  v_eater := private.member_name(o.org_id, o.profile_id);
  v_actor := private.member_name(o.org_id, p_actor);
  v_ahead := p_kind <> 'reprice'
             and private.order_stage(p_order_id) in ('open', 'locked', 'closed');

  v_lines := array[case
    when v_ahead and p_recipient = o.profile_id and o.status = 'placed'
      then v_actor || ' ordered lunch for you on ' || to_char(o.service_date, 'DD/MM') || '.'
    when v_ahead and p_recipient = o.profile_id
      then v_actor || ' cancelled your lunch on ' || to_char(o.service_date, 'DD/MM') || '.'
    else 'Lunch on ' || to_char(o.service_date, 'DD/MM') || ' was corrected by ' || v_actor || '.'
  end];

  if p_recipient = o.profile_id then
    v_lines := v_lines || case
      when o.status <> 'placed' then 'Nothing is recorded for you that day.'
      when v_what is null then 'You are down for lunch that day, but no dish is recorded.'
      else 'You are down for ' || v_what || ', '
           || private.order_amount_text(p_order_id) || '.' end;
  else
    v_lines := v_lines || case
      when o.status <> 'placed'
        then v_eater || '''s lunch that day is no longer on your bill.'
      when v_what is null
        then v_eater || '''s lunch that day has no dish recorded.'
      else 'You are paying for ' || v_eater || '''s ' || v_what || ', '
           || private.order_amount_text(p_order_id) || '.' end;
  end if;

  -- Verbatim, and safe because parse_mode is 'none'.
  if p_reason is not null then
    v_lines := v_lines || p_reason;
  end if;

  v_lines := v_lines || private.balance_line(o.org_id, p_recipient);

  return array_to_string(v_lines, E'\n');
end $fn$;

-- As in 20261007100200: the order's owner and its payer, once each, keyed per
-- order, reader and instant so a second correction is never swallowed.
create or replace function private.enqueue_correction(
  p_order_id bigint, p_period_id bigint, p_actor uuid, p_reason text, p_kind text)
returns void
language plpgsql
set search_path to ''
as $fn$
declare
  o       public.orders%rowtype;
  v_payer uuid;
begin
  select * into o from public.orders where id = p_order_id;

  select c.payer_profile_id into v_payer
    from public.v_order_charges c where c.order_id = p_order_id;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
     related_billing_period_id)
  select o.org_id,
         'org:' || o.org_id || ':bill_correction:order:' || p_order_id
           || ':profile:' || r.who::text || ':'
           || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         'bill_correction',
         tl.chat_id,
         r.who,
         private.correction_body(p_order_id, r.who, p_actor, p_reason, p_kind),
         'none',
         p_period_id
    from (select distinct u.who
            from unnest(array[o.profile_id, v_payer]) as u(who)
           where u.who is not null) r
    join public.memberships mem
      on mem.org_id = o.org_id and mem.profile_id = r.who
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
  on conflict (dedupe_key) do nothing;
end $fn$;

--------------------------------------------------------------------- the RPCs

-- As in 20261007100200, with the menu held and its status checked first.
create or replace function public.correct_meal(
  p_org_id bigint, p_service_date date, p_profile_id uuid,
  p_menu_item_id bigint, p_quantity smallint default 1,
  p_note text default null, p_reason text default null)
returns table(order_id bigint, balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_note   text;
  v_menu   public.menus%rowtype;
  v_period bigint;
  v_order  bigint;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');
  v_note   := private.short_text(p_note, 120, 'note');

  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'a portion count has to be between 1 and 20'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.org_id = p_org_id and m.profile_id = p_profile_id) then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select * into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date
     for share;
  if not found then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;
  perform private.assert_menu_correctable(v_menu.status, p_service_date);

  if not exists (select 1 from public.menu_items mi
                  where mi.id = p_menu_item_id and mi.menu_id = v_menu.id) then
    raise exception 'that dish is not on the menu for %',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  v_order := private.replace_order_line(p_org_id, v_menu.id, p_service_date,
               p_profile_id, p_menu_item_id, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (p_org_id, p_service_date, 'meal', v_order, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'meal');

  return query select v_order, private.account_balance(p_org_id, p_profile_id);
end $fn$;

-- As in 20261018100000, with the menu's status checked once it is held. A name
-- matching a dish with no price yet is refused rather than priced for one
-- person: reprice_dish is what prices a dish for everybody on it.
create or replace function public.correct_meal_off_menu(
  p_org_id bigint, p_service_date date, p_profile_id uuid,
  p_dish_name text, p_price_minor integer, p_quantity smallint default 1,
  p_note text default null, p_reason text default null)
returns table(order_id bigint, menu_item_id bigint, balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_note   text;
  v_name   text := private.dish_name(p_dish_name);
  v_menu   public.menus%rowtype;
  v_period bigint;
  v_item   bigint;
  v_same   text;
  v_same_price integer;
  v_order  bigint;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');
  v_note   := private.short_text(p_note, 120, 'note');

  if v_name is null or length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'a dish needs a name of at most 200 characters'
      using errcode = 'check_violation';
  end if;
  if p_price_minor is null or p_price_minor < 0 or p_price_minor >= 1000000000 then
    raise exception 'a price has to be zero or more, and under a billion'
      using errcode = 'check_violation';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'a portion count has to be between 1 and 20'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.org_id = p_org_id and m.profile_id = p_profile_id) then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select * into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date
     for no key update;
  if not found then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;
  perform private.assert_menu_correctable(v_menu.status, p_service_date);

  v_period := private.correction_period(p_org_id, p_service_date);

  select mi.id, mi.name, mi.price_minor into v_item, v_same, v_same_price
    from public.menu_items mi
   where mi.menu_id = v_menu.id and lower(btrim(mi.name)) = lower(btrim(v_name));

  if v_item is null then
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu.id, p_org_id, v_name, p_price_minor,
            coalesce((select max(mi.position) from public.menu_items mi
                       where mi.menu_id = v_menu.id), -1) + 1)
    returning id into v_item;
  elsif v_same_price is null then
    -- Pricing the dish here would reach this person's line alone and leave
    -- everybody else's on it unpriced, while the day showed the new price.
    -- Repricing is reprice_dish, which reaches every line at once.
    raise exception '"%" is already on the menu with no price yet. Set its price with Reprice, then record this meal',
      v_same
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A priced dish of the same name is that dish, at its own price.

  v_order := private.replace_order_line(p_org_id, v_menu.id, p_service_date,
               p_profile_id, v_item, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, menu_item_id, profile_id,
     summary, reason, made_by)
  values (p_org_id, p_service_date, 'off_menu', v_order, v_item, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'off_menu');

  return query select v_order, v_item, private.account_balance(p_org_id, p_profile_id);
end $fn$;

-- As in 20261007100200. The menu, then the week, then the order, whose status
-- is read again once it is held: a member cancelling in the meantime is seen.
-- FOR NO KEY UPDATE, not FOR UPDATE: a member's offer on the same order takes
-- FOR KEY SHARE through its foreign key while it holds a pass slot, and a
-- FOR UPDATE here would make the two wait on each other.
create or replace function public.remove_meal(
  p_order_id bigint, p_reason text default null)
returns table(balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
begin
  -- A missing order and another office's get the same answer, so an id
  -- cannot be probed across offices.
  select * into o from public.orders where id = p_order_id;
  if not found or not (o.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  v_period := private.correction_period(o.org_id, o.service_date);

  select * into o from public.orders where id = p_order_id for no key update;
  if o.status <> 'placed' then
    raise exception 'nothing is recorded for that person on %, so there is nothing to remove',
      to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.orders x
     set status = 'cancelled', cancelled_at = now()
   where x.id = p_order_id;

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (o.org_id, o.service_date, 'removal', p_order_id, o.profile_id,
          private.order_summary(p_order_id), v_reason, v_actor);

  perform private.enqueue_correction(p_order_id, v_period, v_actor, v_reason, 'removal');

  return query select private.account_balance(o.org_id, o.profile_id);
end $fn$;

-- As in 20261007100200, telling each person as a reprice.
create or replace function public.reprice_dish(
  p_menu_item_id bigint, p_price_minor integer, p_reason text default null)
returns table(lines integer, people integer)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  v_item   public.menu_items%rowtype;
  v_date   date;
  v_period bigint;
  v_lines  integer;
  v_people integer;
  v_order  bigint;
  v_was    text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that dish is not on any menu' using errcode = 'no_data_found';
  end if;

  if not (v_item.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  if p_price_minor is null or p_price_minor < 0 or p_price_minor >= 1000000000 then
    raise exception 'a price has to be zero or more, and under a billion'
      using errcode = 'check_violation';
  end if;

  select mu.service_date into v_date from public.menus mu where mu.id = v_item.menu_id;
  v_period := private.correction_period(v_item.org_id, v_date);

  v_was := case when v_item.price_minor is null then null
                else private.money_text(v_item.price_minor::bigint,
                       (select o.currency_minor_units from public.organizations o
                         where o.id = v_item.org_id),
                       (select o.currency from public.organizations o
                         where o.id = v_item.org_id)) end;

  update public.menu_items mi set price_minor = p_price_minor where mi.id = p_menu_item_id;

  with touched as (
    update public.order_items oi
       set menu_item_id = oi.menu_item_id
     where oi.menu_item_id = p_menu_item_id
    returning oi.order_id as oid, oi.profile_id as pid)
  select count(*)::int,
         count(distinct t.pid) filter (where ord.status = 'placed')::int
    into v_lines, v_people
    from touched t
    join public.orders ord on ord.id = t.oid;

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, menu_item_id, summary, reason, made_by)
  values (v_item.org_id, v_date, 'reprice', p_menu_item_id,
          v_item.name || ' on ' || to_char(v_date, 'DD/MM')
            || case when v_was is null then ' priced at ' else ' repriced from ' || v_was || ' to ' end
            || private.money_text(p_price_minor::bigint,
                 (select o.currency_minor_units from public.organizations o where o.id = v_item.org_id),
                 (select o.currency from public.organizations o where o.id = v_item.org_id))
            || ': ' || v_lines  || case when v_lines  = 1 then ' line, '   else ' lines, '   end
            ||         v_people || case when v_people = 1 then ' person.' else ' people.' end,
          v_reason, v_actor);

  for v_order in
    select distinct oi.order_id
      from public.order_items oi
      join public.orders ord on ord.id = oi.order_id and ord.status = 'placed'
     where oi.menu_item_id = p_menu_item_id
  loop
    perform private.enqueue_correction(v_order, v_period, v_actor, v_reason, 'reprice');
  end loop;

  return query select v_lines, v_people;
end $fn$;

--------------------------------------------------------------------- grants

revoke execute on function private.assert_menu_correctable(text, date) from public, anon, authenticated;
revoke execute on function private.correction_body(bigint, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function private.enqueue_correction(bigint, bigint, uuid, text, text) from public, anon, authenticated;

revoke execute on function public.correct_meal(bigint, date, uuid, bigint, smallint, text, text) from public, anon;
grant  execute on function public.correct_meal(bigint, date, uuid, bigint, smallint, text, text) to authenticated;
revoke execute on function public.correct_meal_off_menu(bigint, date, uuid, text, integer, smallint, text, text) from public, anon;
grant  execute on function public.correct_meal_off_menu(bigint, date, uuid, text, integer, smallint, text, text) to authenticated;
revoke execute on function public.remove_meal(bigint, text) from public, anon;
grant  execute on function public.remove_meal(bigint, text) to authenticated;
revoke execute on function public.reprice_dish(bigint, integer, text) from public, anon;
grant  execute on function public.reprice_dish(bigint, integer, text) to authenticated;
