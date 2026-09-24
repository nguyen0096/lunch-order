-- The record is not what happened, and somebody has to be able to say so.
--
-- Four things an admin finds when they sit down to finalise last week: the
-- caterer delivered an extra portion because somebody ordered verbally, a
-- person is marked down for a lunch they did not eat, a dish was served that
-- was never on the menu, and the caterer charged a different price than the
-- menu said. None of them is reachable from the Board, which is the same screen
-- for admins and members by design (20261003100100), and none of them is
-- ordering: the day is over. They are corrections to a record.
--
-- Four RPCs rather than table writes, for three reasons that each rule out the
-- browser doing it directly:
--
--   * `enforce_menu_item_frozen` refuses a new dish on a locked menu, and every
--     menu of a week being settled is locked. An off-menu dish cannot be
--     written from a browser at all.
--   * the money has to move in the same transaction. `run_billing` is the only
--     thing that turns an order into a bill, it is revoked from every browser
--     role, and a correction that waits for Monday's tick is a correction the
--     admin cannot check.
--   * the affected member has to be told, and a message enqueued by the browser
--     is a message a member could enqueue for themselves.
--
-- Each one repeats its own admin check rather than leaning on the EXECUTE
-- grant, exactly as `public.settle_period` does: the grant says a signed-in
-- browser may call it, the function decides whether THIS browser gets an
-- answer.
--
-- Note what these functions are NOT protected by. `private.is_service()` tests
-- `current_user`, and inside a SECURITY DEFINER function owned by `postgres`
-- that is `postgres`, so every business-rule trigger under these writes exempts
-- itself -- including `refuse_write_to_settled_week` from 20261007100000. That
-- is deliberate and it is also why each function below resolves the period and
-- refuses a closed one itself. The trigger guards the table; these guard
-- themselves.

------------------------------------------------------------------ small helpers

-- A trimmed, optional free-text field, or a sentence saying it is too long.
-- Blank is null: an admin who tabs through the box has given no reason, and a
-- row holding '' would read as one nobody can see.
create or replace function private.short_text(p_text text, p_max integer, p_what text)
returns text
language plpgsql
immutable
set search_path to ''
as $fn$
declare v text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if v is not null and length(v) > p_max then
    raise exception 'a % can be at most % characters; that one is %',
      p_what, p_max, length(v)
      using errcode = 'string_data_right_truncation';
  end if;
  return v;
end $fn$;

-- The SQL twin of dishName() in src/shared/dishName.ts, and it exists for the
-- index rather than for looks: `menu_items_name_uk` is
-- (menu_id, lower(btrim(name))), iOS keyboards emit decomposed Vietnamese, and
-- an off-menu dish typed on a phone would otherwise land beside an identical
-- one pasted from the caterer. Sentence case, never title case.
--
-- Not byte-identical to the TypeScript for exotic whitespace: JavaScript's \s
-- and Postgres's [[:space:]] disagree about a few code points such as U+FEFF.
-- Nothing a caterer writes reaches either of them.
create or replace function private.dish_name(p_raw text)
returns text
language sql
immutable
set search_path to ''
as $fn$
  select case when s.t = '' then s.t else upper(left(s.t, 1)) || substr(s.t, 2) end
    from (select btrim(regexp_replace(normalize(coalesce(p_raw, ''), NFC),
                                      '\s+', ' ', 'g')) as t) s;
$fn$;

-- What colleagues call this person in this office.
create or replace function private.member_name(p_org_id bigint, p_profile_id uuid)
returns text
language sql
stable
set search_path to ''
as $fn$
  select coalesce(nullif(btrim(m.display_name), ''),
                  nullif(btrim(p.full_name), ''),
                  'a colleague')
    from public.profiles p
    left join public.memberships m
      on m.org_id = p_org_id and m.profile_id = p.id
   where p.id = p_profile_id;
$fn$;

create or replace function private.account_balance(p_org_id bigint, p_profile_id uuid)
returns bigint
language sql
stable
set search_path to ''
as $fn$
  select coalesce(b.balance_minor, 0)::bigint
    from public.v_account_balance b
   where b.org_id = p_org_id and b.profile_id = p_profile_id;
$fn$;

-- Where the member stands, in the three states the app already uses.
--
-- The words are renderAccountText()'s in src/shared/telegram.ts, minus its
-- markup: "You owe X.", "You are X in credit.", "Nothing to pay." A second,
-- prettier phrasing of the same three states is how the bot and this schema
-- start telling somebody two different things about the same number.
create or replace function private.balance_line(p_org_id bigint, p_profile_id uuid)
returns text
language sql
stable
set search_path to ''
as $fn$
  select case
           when private.account_balance(p_org_id, p_profile_id) > 0
             then 'You owe '
                  || private.money_text(private.account_balance(p_org_id, p_profile_id),
                       o.currency_minor_units, o.currency) || '.'
           when private.account_balance(p_org_id, p_profile_id) < 0
             then 'You are '
                  || private.money_text(-private.account_balance(p_org_id, p_profile_id),
                       o.currency_minor_units, o.currency) || ' in credit.'
           else 'Nothing to pay.'
         end
    from public.organizations o
   where o.id = p_org_id;
$fn$;

------------------------------------------------------------------- the week

-- The week a service date belongs to, held still and refused if it is settled.
--
-- The advisory lock is taken BEFORE the status is read and on the same key
-- `private.run_billing_inner` uses, so a Settle running in another session
-- either finishes first -- and this raises -- or waits. Read the status without
-- it and a week can close between the check and the write, which is the one
-- outcome the rule exists to prevent.
--
-- `ensure_billing_period` opens the week if it is not on the books yet, which
-- is what makes a correction to a week nobody has billed reach a bill at all.
create or replace function private.correction_period(p_org_id bigint, p_service_date date)
returns bigint
language plpgsql
set search_path to ''
as $fn$
declare v_id bigint; v_status text;
begin
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

  return v_id;
end $fn$;

--------------------------------------------------------------- what it now says

-- The order's dishes as one phrase, in `v_order_charges`'s own format, so the
-- message and the bill line describe the same meal the same way.
create or replace function private.order_dishes(p_order_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select string_agg(oi.item_name_snapshot
                      || case when oi.quantity > 1 then ' x' || oi.quantity else '' end,
                    ', ' order by oi.id)
    from public.order_items oi
   where oi.order_id = p_order_id;
$fn$;

-- What the order costs, or the words for a price nobody has yet.
--
-- Never money(0) for an unpriced meal: zero is a real price, and promising a
-- free lunch in a message is a promise nobody made. The words are
-- PRICE_TO_COME in src/shared/telegram.ts.
create or replace function private.order_amount_text(p_order_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select case when bool_or(oi.unit_price_minor is null) then 'price to come'
              else private.money_text(sum(oi.line_total_minor)::bigint,
                     o.currency_minor_units, o.currency) end
    from public.order_items oi
    join public.orders ord on ord.id = oi.order_id
    join public.organizations o on o.id = ord.org_id
   where oi.order_id = p_order_id
   group by o.currency_minor_units, o.currency;
$fn$;

-- One line of prose for the audit row: who, what, which day.
create or replace function private.order_summary(p_order_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select private.member_name(o.org_id, o.profile_id) || ': '
      || case
           when o.status <> 'placed' then 'nothing recorded'
           when private.order_dishes(o.id) is null then 'no dish recorded'
           else private.order_dishes(o.id) || ', ' || private.order_amount_text(o.id)
         end
      || ' on ' || to_char(o.service_date, 'DD/MM')
    from public.orders o
   where o.id = p_order_id;
$fn$;

-------------------------------------------------------------------- the message

-- Three or four short lines: the day and who changed it, what the record now
-- says for this reader, the reason if one was given, and where they stand.
--
-- Written for ONE reader, because a corrected meal has up to two: the person
-- who ate it and, when it was passed on, the person who accepted it and is
-- actually charged. The same correction reads differently to each of them and
-- the balance at the bottom is their own.
create or replace function private.correction_body(
  p_order_id bigint, p_recipient uuid, p_actor uuid, p_reason text)
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
begin
  select * into o from public.orders where id = p_order_id;
  v_what  := private.order_dishes(p_order_id);
  v_eater := private.member_name(o.org_id, o.profile_id);

  v_lines := array[
    'Lunch on ' || to_char(o.service_date, 'DD/MM') || ' was corrected by '
      || private.member_name(o.org_id, p_actor) || '.'];

  if p_recipient = o.profile_id then
    v_lines := v_lines || case
      when o.status <> 'placed' then 'Nothing is recorded for you that day.'
      when v_what is null then 'You are down for lunch that day, but no dish is recorded.'
      else 'You are down for ' || v_what || ', '
           || private.order_amount_text(p_order_id) || '.' end;
  else
    -- This reader accepted somebody else's meal, so it is their bill that
    -- moved. Telling only the eater would leave the person paying to find out
    -- from the total.
    v_lines := v_lines || case
      when o.status <> 'placed'
        then v_eater || '''s lunch that day is no longer on your bill.'
      when v_what is null
        then v_eater || '''s lunch that day has no dish recorded.'
      else 'You are paying for ' || v_eater || '''s ' || v_what || ', '
           || private.order_amount_text(p_order_id) || '.' end;
  end if;

  -- Verbatim, and safe because parse_mode is 'none'. A reason somebody typed
  -- may well contain an ampersand, and Telegram rejects one unescaped in HTML.
  if p_reason is not null then
    v_lines := v_lines || p_reason;
  end if;

  v_lines := v_lines || private.balance_line(o.org_id, p_recipient);

  return array_to_string(v_lines, E'\n');
end $fn$;

-- Enqueue that message for everybody the correction touched.
--
-- Skips anybody who has not finished /start: `telegram_links.chat_id` stays
-- null until then and `notification_outbox.chat_id` is NOT NULL, so no link
-- means no row. Same shape as the hourly tick's per-member weekly bill.
--
-- The dedupe key carries the order, the reader and a clock reading. Keyed per
-- day per person it would be a bug rather than a safeguard: the convention here
-- is `on conflict (dedupe_key) do nothing`, so the SECOND correction to the
-- same day would be silently swallowed and the member would be told about the
-- first one only.
create or replace function private.enqueue_correction(
  p_order_id bigint, p_period_id bigint, p_actor uuid, p_reason text)
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
         private.correction_body(p_order_id, r.who, p_actor, p_reason),
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

------------------------------------------------------------------- the write

-- "This is what this person had that day", as one order with one line.
--
-- Delete every line and write one, rather than upserting on the dish. An upsert
-- keyed on `(order_id, menu_item_id)` leaves the previous dish's line behind
-- when the dish changes, and `v_order_charges` sums EVERY line on the order, so
-- that stray row is a second meal on a real person's bill. Both statements run
-- in one transaction, so no reader ever sees the order with both lines or with
-- none.
--
-- The order row is kept if there is one, and so is its `source`. A member did
-- order; what changed is the line, and `order_corrections` is what records
-- that. Reviving a cancelled order rather than inserting beside it because
-- `orders_menu_profile_uk` is (menu_id, profile_id) with no status predicate:
-- there is one row per person per day, cancelled or not.
create or replace function private.replace_order_line(
  p_org_id bigint, p_menu_id bigint, p_service_date date, p_profile_id uuid,
  p_menu_item_id bigint, p_quantity smallint, p_note text, p_actor uuid)
returns bigint
language plpgsql
set search_path to ''
as $fn$
declare v_order public.orders%rowtype;
begin
  select * into v_order from public.orders o
   where o.menu_id = p_menu_id and o.profile_id = p_profile_id;

  if not found then
    insert into public.orders
      (org_id, menu_id, service_date, profile_id, source, created_by)
    values (p_org_id, p_menu_id, p_service_date, p_profile_id, 'admin', p_actor)
    returning * into v_order;
  elsif v_order.status <> 'placed' then
    update public.orders o
       set status = 'placed', cancelled_at = null
     where o.id = v_order.id
    returning * into v_order;
  end if;

  delete from public.order_items oi where oi.order_id = v_order.id;

  insert into public.order_items
    (order_id, org_id, profile_id, menu_id, menu_item_id, quantity, note)
  values (v_order.id, p_org_id, p_profile_id, p_menu_id, p_menu_item_id,
          p_quantity, p_note);

  return v_order.id;
end $fn$;

--------------------------------------------------------------------- the RPCs

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
  v_menu   bigint;
  v_period bigint;
  v_order  bigint;
begin
  -- The permission question first, and nothing before it. Validating the
  -- caller's text first would answer a stranger with a sentence about their
  -- input, which is a different answer from "you cannot do this at all".
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

  select mu.id into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date;
  if v_menu is null then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.menu_items mi
                  where mi.id = p_menu_item_id and mi.menu_id = v_menu) then
    raise exception 'that dish is not on the menu for %',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  v_order := private.replace_order_line(p_org_id, v_menu, p_service_date,
               p_profile_id, p_menu_item_id, p_quantity, v_note, v_actor);

  -- Immediately, not on Monday. A correction the admin cannot see land is a
  -- correction they will make twice (20261004100000).
  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (p_org_id, p_service_date, 'meal', v_order, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  -- After the billing run, so the balance in the message is the one the member
  -- would see if they opened the app while reading it.
  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason);

  return query select v_order, private.account_balance(p_org_id, p_profile_id);
end $fn$;

-- "The caterer served something that was never on the menu."
--
-- A definer function because of one trigger: `enforce_menu_item_frozen` refuses
-- any new dish on a locked or cancelled menu, and every menu of a week being
-- settled is locked. There is no browser path to this at all.
--
-- An existing dish of the same name is reused rather than duplicated, because
-- `menu_items_name_uk` is (menu_id, lower(btrim(name))) and a second insert
-- would simply fail. Its price is filled in only if it had none: repricing a
-- dish other people also ate is `reprice_dish`, which says out loud how many
-- lines and how many people it moved. Doing it silently here would put money on
-- somebody's bill who is not part of this correction.
--
-- And when the price IS filled in, nobody else's `order_items` row is
-- re-snapshotted. Their `unit_price_minor` stays null, so they stay unpriced and
-- unbilled, which is the state they were already in. That is what keeps this
-- function's blast radius to one person: the dish gains a price, one line gains
-- a price, and no other bill moves by a dong.
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
  v_menu   bigint;
  v_period bigint;
  v_item   bigint;
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

  select mu.id into v_menu from public.menus mu
   where mu.org_id = p_org_id and mu.service_date = p_service_date;
  if v_menu is null then
    raise exception 'there is no menu for %, so there is nothing to correct',
      to_char(p_service_date, 'DD/MM')
      using errcode = 'no_data_found';
  end if;

  v_period := private.correction_period(p_org_id, p_service_date);

  select mi.id into v_item from public.menu_items mi
   where mi.menu_id = v_menu and lower(btrim(mi.name)) = lower(btrim(v_name));

  if v_item is null then
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu, p_org_id, v_name, p_price_minor,
            coalesce((select max(mi.position) from public.menu_items mi
                       where mi.menu_id = v_menu), -1) + 1)
    returning id into v_item;
  else
    update public.menu_items mi set price_minor = p_price_minor
     where mi.id = v_item and mi.price_minor is null;
  end if;

  v_order := private.replace_order_line(p_org_id, v_menu, p_service_date,
               p_profile_id, v_item, p_quantity, v_note, v_actor);

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, menu_item_id, profile_id,
     summary, reason, made_by)
  values (p_org_id, p_service_date, 'off_menu', v_order, v_item, p_profile_id,
          private.order_summary(v_order), v_reason, v_actor);

  perform private.enqueue_correction(v_order, v_period, v_actor, v_reason);

  return query select v_order, v_item, private.account_balance(p_org_id, p_profile_id);
end $fn$;

-- "This person did not eat that day."
--
-- Cancelled, never deleted. `billing_lines.order_id` is ON DELETE RESTRICT, so
-- a billed order cannot be deleted at all, and an unbilled one goes quietly and
-- takes its `order_items` with it by cascade, leaving nothing behind to say a
-- meal was ever on the record. A cancelled order is still an answer to "what
-- happened on Wednesday"; a deleted one is a gap.
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
  v_period bigint;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'that meal is not on record' using errcode = 'no_data_found';
  end if;

  if not (o.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  if o.status <> 'placed' then
    raise exception 'nothing is recorded for that person on %, so there is nothing to remove',
      to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_period := private.correction_period(o.org_id, o.service_date);

  update public.orders x
     set status = 'cancelled', cancelled_at = now()
   where x.id = p_order_id;

  perform public.run_billing(v_period);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, summary, reason, made_by)
  values (o.org_id, o.service_date, 'removal', p_order_id, o.profile_id,
          private.order_summary(p_order_id), v_reason, v_actor);

  perform private.enqueue_correction(p_order_id, v_period, v_actor, v_reason);

  return query select private.account_balance(o.org_id, o.profile_id);
end $fn$;

-- "The caterer charged a different price than the menu said."
--
-- One dish, one day, every line on it at once. `menu_items.id` is the primary
-- key, so it names exactly one dish row, which belongs to exactly one menu,
-- which is one office's one day: the blast radius is not a filter to get right,
-- it is what the id means. The same dish name on another day or in another
-- office is another row and is not touched.
--
-- `update order_items set menu_item_id = menu_item_id` is the re-snapshot, the
-- same move `applyCatererPrices` makes in src/web/api/billing.ts.
-- `order_items_snapshot` is BEFORE INSERT OR UPDATE **OF menu_item_id**, and a
-- column named in the SET list fires it whether or not the value changes, so
-- `snapshot_order_item` rewrites `unit_price_minor` from the dish's new price.
--
-- `line_total_minor` then follows on its own, but NOT for the reason it is easy
-- to assume: it is `generated always as (unit_price_minor * quantity) stored`,
-- not a column with a DEFAULT. A DEFAULT would apply on INSERT only and every
-- re-priced line would keep its old total -- and `v_order_charges` sums
-- `line_total_minor`, so the bill would not move at all.
--
-- Cancelled orders' lines are re-snapshotted too, as `applyCatererPrices` does.
-- They produce no billing line, so no money moves; leaving them behind would
-- make two rows of the same dish on the same day disagree about its price.
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

  -- One audit row for the dish, one message per person. The row is about the
  -- dish; the message is about somebody's bill, and each reader needs their own
  -- balance at the bottom of it.
  for v_order in
    select distinct oi.order_id
      from public.order_items oi
      join public.orders ord on ord.id = oi.order_id and ord.status = 'placed'
     where oi.menu_item_id = p_menu_item_id
  loop
    perform private.enqueue_correction(v_order, v_period, v_actor, v_reason);
  end loop;

  return query select v_lines, v_people;
end $fn$;

--------------------------------------------------------------------- the grants

-- Postgres grants EXECUTE on every new function to PUBLIC and the default-
-- privileges guard in 20260911101100_grants.sql does not remove it
-- (20260925100200). Every function added here carries its own revoke, and
-- supabase/tests/function_grants.sql fails if one does not.
revoke execute on function private.short_text(text, integer, text)          from public, anon, authenticated;
revoke execute on function private.dish_name(text)                          from public, anon, authenticated;
revoke execute on function private.member_name(bigint, uuid)                from public, anon, authenticated;
revoke execute on function private.account_balance(bigint, uuid)            from public, anon, authenticated;
revoke execute on function private.balance_line(bigint, uuid)               from public, anon, authenticated;
revoke execute on function private.correction_period(bigint, date)          from public, anon, authenticated;
revoke execute on function private.order_dishes(bigint)                     from public, anon, authenticated;
revoke execute on function private.order_amount_text(bigint)                from public, anon, authenticated;
revoke execute on function private.order_summary(bigint)                    from public, anon, authenticated;
revoke execute on function private.correction_body(bigint, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.enqueue_correction(bigint, bigint, uuid, text) from public, anon, authenticated;
revoke execute on function private.replace_order_line(bigint, bigint, date, uuid, bigint, smallint, text, uuid)
  from public, anon, authenticated;

-- The four the admin screen calls. Each decides for itself whether this caller
-- is an admin of the office in question; the grant only says a signed-in
-- browser may ask.
revoke execute on function public.correct_meal(bigint, date, uuid, bigint, smallint, text, text)
  from public, anon;
grant  execute on function public.correct_meal(bigint, date, uuid, bigint, smallint, text, text)
  to authenticated;

revoke execute on function public.correct_meal_off_menu(bigint, date, uuid, text, integer, smallint, text, text)
  from public, anon;
grant  execute on function public.correct_meal_off_menu(bigint, date, uuid, text, integer, smallint, text, text)
  to authenticated;

revoke execute on function public.remove_meal(bigint, text)   from public, anon;
grant  execute on function public.remove_meal(bigint, text)   to authenticated;

revoke execute on function public.reprice_dish(bigint, integer, text) from public, anon;
grant  execute on function public.reprice_dish(bigint, integer, text) to authenticated;
