-- An admin can say something, and can see what the bot would say.
--
-- Everything this database has ever sent to Telegram was written by a
-- migration. The caterer cancels, the office moves floor, four people have not
-- paid for three weeks: none of that is a menu, a cutoff or a bill, and an
-- admin's only channel for it was to open Telegram and type it themselves,
-- which reaches whoever happens to be in the group and nobody who is not.
--
-- Two RPCs, both SECURITY DEFINER and both checking the admin themselves. The
-- grant says a signed-in browser may call them; the function decides whether
-- THIS browser gets an answer, exactly as the corrections screen does
-- (20261007100200).
--
-- They are definer functions rather than table writes for the same reason the
-- corrections are: a message a browser can INSERT into `notification_outbox` is
-- a message a member could enqueue for themselves, addressed to anybody, in
-- anybody's name. `outbox_admin` would let an admin do it today; the point is
-- that what goes out is rendered here, from the admin's own identity, rather
-- than posted by the client.

-- The announcement's own message kind.
--
-- Rewritten in full rather than patched, because a CHECK has no ALTER that adds
-- a value: the ten that were there are restated verbatim so a diff shows one
-- line added and nothing else moved.
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in
    ('menu_published','register_reminder','cutoff_warning',
     'weekly_preview','weekly_bill','payment_reminder','payment_ack',
     'transfer_offer','transfer_decided','bill_correction','announcement'));

------------------------------------------------------------------ announcements

-- Something an admin wants said, to the office, to one person, or to everybody
-- who owes money.
--
-- Returns two numbers because one of them is not good news. `queued` is rows
-- actually written; `unreachable` is how many people in the audience have no
-- linked chat and therefore got nothing. `notification_outbox.chat_id` is NOT
-- NULL, so somebody who never finished /start silently produces no row at all,
-- and an admin who is told "sent" while four people heard nothing will find out
-- from the four of them on Monday.
--
-- One row per person, and no group copy even for 'office'. The group chat is a
-- room, not a member: a copy there would be counted in neither number and would
-- make `unreachable` a lie for the people who read it there. If an office wants
-- the room, an admin can type in the room.
--
-- The dedupe key carries a fresh uuid, and there is no `on conflict do nothing`
-- under it. Every other enqueue in this schema is keyed so that a retried job
-- collides and does nothing; an announcement is the opposite case. An admin who
-- sends the same sentence twice meant to send it twice, and the house
-- convention would swallow the second one without a word. There is nothing here
-- for a conflict clause to absorb, so a collision would be a bug and should
-- raise rather than hide.
create or replace function public.send_announcement(
  p_org_id bigint, p_audience text, p_text text, p_profile_id uuid default null)
returns table(queued integer, unreachable integer)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor       uuid := (select auth.uid());
  v_send        uuid := pg_catalog.gen_random_uuid();
  v_text        text;
  v_body        text;
  v_queued      integer;
  v_unreachable integer;
begin
  -- The permission question first, and nothing before it. Validating the
  -- caller's text first would answer a stranger with a sentence about their
  -- input, which is a different answer from "you cannot do this at all".
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can send an announcement'
      using errcode = 'insufficient_privilege';
  end if;

  if p_audience is null or p_audience not in ('office','person','unpaid') then
    raise exception 'an announcement goes to the office, to one person, or to everybody who owes'
      using errcode = 'check_violation';
  end if;

  -- 1000 characters. Telegram refuses a sendMessage body over 4096 and the
  -- drain has no splitter, so the cap has to leave room for the line naming the
  -- sender; well under it, because nobody reads a four-thousand-character lunch
  -- announcement in a chat window, and what does not fit belongs in the app.
  -- `private.short_text` trims, turns blank into null, and refuses over-length
  -- in the words the corrections screen already uses. It is told 'message'
  -- rather than 'announcement' because its sentence starts with "a %".
  v_text := private.short_text(p_text, 1000, 'message');
  if v_text is null then
    raise exception 'an announcement needs something to say'
      using errcode = 'check_violation';
  end if;

  if p_audience = 'person' then
    if p_profile_id is null then
      raise exception 'sending to one person needs somebody to send it to'
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.memberships m
                    where m.org_id = p_org_id and m.profile_id = p_profile_id
                      and m.status = 'active') then
      raise exception 'that person is not a member of this office'
        using errcode = 'no_data_found';
    end if;
  end if;
  -- p_profile_id is ignored for the other two audiences rather than refused: a
  -- screen that keeps one person selected while the admin switches to "the
  -- whole office" should not be told off for it.

  -- Verbatim, and safe because parse_mode is 'none'. An admin's sentence will
  -- sooner or later contain an ampersand, and Telegram rejects one unescaped in
  -- HTML.
  --
  -- The signature is not decoration. A message with no sender is a message from
  -- "the lunch bot", and a member who wants to argue with it needs to know who
  -- to argue with, and which office it is about when they are in two.
  select v_text || E'\n\n' || 'From ' || private.member_name(p_org_id, v_actor)
           || ', ' || og.name || '.'
    into v_body
    from public.organizations og
   where og.id = p_org_id;

  -- `v_account_balance` is `security_invoker = true` (20261006100100) and this
  -- function runs as `postgres`, so RLS under it is skipped. The `b.org_id`
  -- predicate is the only thing keeping 'unpaid' inside this office; it is not
  -- redundant with the membership join above it.
  with aud as (
    select mem.id as membership_id, mem.profile_id
      from public.memberships mem
     where mem.org_id = p_org_id
       and mem.status = 'active'
       and case p_audience
             when 'office' then true
             when 'person' then mem.profile_id = p_profile_id
             else exists (select 1 from public.v_account_balance b
                           where b.org_id = p_org_id
                             and b.profile_id = mem.profile_id
                             and b.balance_minor > 0)
           end
  ),
  ins as (
    insert into public.notification_outbox
      (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
    select p_org_id,
           'org:' || p_org_id || ':announcement:' || v_send::text
             || ':profile:' || a.profile_id::text,
           'announcement',
           tl.chat_id,
           a.profile_id,
           v_body,
           'none'
      from aud a
      join public.telegram_links tl
        on tl.membership_id = a.membership_id and tl.chat_id is not null
    returning 1 as sent
  )
  -- Counted from the insert itself rather than from the audience, so `queued`
  -- is rows written and cannot drift from what the drain will find.
  select (select count(*) from ins)::integer,
         (select count(*) from aud a
           where not exists (select 1 from public.telegram_links tl
                              where tl.membership_id = a.membership_id
                                and tl.chat_id is not null))::integer
    into v_queued, v_unreachable;

  return query select v_queued, v_unreachable;
end $fn$;

--------------------------------------------------------------- the test message

-- What would my office receive? Sent to the asking admin and to nobody else.
--
-- The bodies come from `private.menu_message`, `private.cutoff_message` and
-- `private.weekly_bill_message` -- the same three the hourly tick calls, the
-- last of which was extracted out of it in 20261009100000 for exactly this.
-- A second rendering written for the preview is how the preview and the real
-- message start telling an admin two different things, and the preview is worth
-- having only while they cannot.
--
-- One line of preamble and then the real body, untouched. Rewording it to look
-- like a test would defeat the only purpose it has.
--
-- The row's `kind` is the real kind, because the row IS a menu announcement or
-- a bill; what marks it is `:test:` in the dedupe key, which is also what keeps
-- it from colliding with the genuine send for the same day.
--
-- `enabled` is deliberately not consulted. Previewing a message before turning
-- it on is the main reason to ask for one, and refusing would make the switch
-- and the preview a chicken and egg.
create or replace function public.send_test_notification(p_org_id bigint, p_kind text)
returns table(queued integer)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_chat   bigint;
  v_menu   bigint;
  v_period bigint;
  v_real   text;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can send a test message'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind is null
     or p_kind not in ('menu_published','cutoff_warning','weekly_bill') then
    raise exception
      'a test can be sent for menu_published, cutoff_warning or weekly_bill'
      using errcode = 'check_violation';
  end if;

  select tl.chat_id into v_chat
    from public.memberships mem
    join public.telegram_links tl on tl.membership_id = mem.id
   where mem.org_id = p_org_id and mem.profile_id = v_actor;

  -- Null covers both shapes of the same situation: no link row at all, and a
  -- link row whose chat_id is still null because /start was never finished.
  if v_chat is null then
    raise exception
      'connect Telegram first: open the bot and finish /start, then the test will arrive in your own chat'
      using errcode = 'no_data_found';
  end if;

  if p_kind in ('menu_published','cutoff_warning') then
    -- The menu the tick would be talking about: the next one still open.
    select m.id into v_menu
      from public.menus m
     where m.org_id = p_org_id
       and m.status = 'published'
       and m.order_cutoff_at > now()
     order by m.service_date
     limit 1;

    -- Falling back to the most recent menu instead of refusing, because an
    -- admin setting this up at four in the afternoon, after every cutoff has
    -- passed, is the likeliest person to be asking.
    if v_menu is null then
      select m.id into v_menu
        from public.menus m
       where m.org_id = p_org_id and m.status in ('published','locked')
       order by m.service_date desc
       limit 1;
    end if;

    if v_menu is null then
      raise exception 'there is no published menu to preview yet; publish one first'
        using errcode = 'no_data_found';
    end if;

    v_real := case p_kind
                when 'menu_published' then private.menu_message(v_menu)
                else private.cutoff_message(v_menu)
              end;
  else
    -- The weekly bill is about the reader's own money, so previewing it needs
    -- the reader to have a statement. Somebody else's would be a different
    -- message and a privacy problem besides.
    select st.billing_period_id into v_period
      from public.billing_statements st
      join public.billing_periods bp on bp.id = st.billing_period_id
     where st.org_id = p_org_id and st.profile_id = v_actor
     order by bp.period_start desc
     limit 1;

    if v_period is null then
      raise exception
        'you have no billed week yet, so there is no weekly bill to preview'
        using errcode = 'no_data_found';
    end if;

    v_real := private.weekly_bill_message(v_period, v_actor);
  end if;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
     related_menu_id, related_billing_period_id)
  values (p_org_id,
          'org:' || p_org_id || ':test:' || p_kind || ':'
            || pg_catalog.gen_random_uuid()::text,
          p_kind, v_chat, v_actor,
          'Test message, sent to you alone. This is what your office receives.'
            || E'\n\n' || v_real,
          'none', v_menu, v_period);

  return query select 1;
end $fn$;

--------------------------------------------------------------------- the grants

-- Postgres grants EXECUTE on every new function to PUBLIC and the default-
-- privileges guard in 20260911101100_grants.sql does not remove it
-- (20260925100200). Both of these carry their own revoke, and
-- supabase/tests/function_grants.sql fails if one does not.
revoke execute on function public.send_announcement(bigint, text, text, uuid)
  from public, anon;
grant  execute on function public.send_announcement(bigint, text, text, uuid)
  to authenticated;

revoke execute on function public.send_test_notification(bigint, text)
  from public, anon;
grant  execute on function public.send_test_notification(bigint, text)
  to authenticated;
