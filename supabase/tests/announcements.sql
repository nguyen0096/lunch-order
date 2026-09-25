-- Announcements, test messages, and the switches the hourly tick now reads.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/announcements.sql
--
-- This file builds its own fixtures and rolls everything back. It needs no
-- other seed and deliberately shares none.
--
-- IT CALLS `private.run_hourly_tick()`, WHICH LOOPS EVERY ACTIVE OFFICE IN THE
-- DATABASE. On a scratch project that is two offices and a menu. On a project
-- with real data it would bill and close a real week before the rollback undoes
-- it, which is a lock held over real rows for no reason. Do not point this file
-- at production.
--
-- The two traps from supabase/tests/isolation.sql apply here in full:
--
-- 1. A test that passes because the session was never actually downgraded to
--    `authenticated`. `set local role` is its own statement inside a DO block,
--    and `control: role downgraded` asserts it POSITIVELY before any refusal
--    below is believed.
--
-- 2. Judging a blocked write by whether it raised. Every refusal here is
--    asserted twice: by SQLSTATE and message, AND by the outbox row delta,
--    because a function that raises after enqueuing is not refused.
--
-- And one this file adds. A send that reaches nobody looks exactly like a send
-- that was refused, and a window test passes for free if the menu was never
-- eligible in the first place. So every audience probe asserts WHO received it
-- by short code, not how many rows appeared, and the cutoff-window probe
-- asserts up front that the menu sits outside 70 minutes and inside 240.

begin;

create temp table probe (label text, got text, want text);
-- Load-bearing: probe rows are inserted while the session is `authenticated`,
-- and a temp table is not writable by that role without this.
grant insert on probe to authenticated;

create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;

-- What each RPC said it did, recorded while authenticated and judged after the
-- role is reset, so the verdict is never taken through RLS.
create temp table res (step text primary key, queued integer, unreachable integer);
grant insert on res to authenticated;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','cccccccc-0000-0000-0000-000000000001','authenticated','authenticated','anh@anna.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Ánh Đỗ"}'),
 ('00000000-0000-0000-0000-000000000000','cccccccc-0000-0000-0000-000000000002','authenticated','authenticated','bon@anna.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bốn Lý"}'),
 ('00000000-0000-0000-0000-000000000000','cccccccc-0000-0000-0000-000000000003','authenticated','authenticated','nam@anna.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Năm Vũ"}'),
 ('00000000-0000-0000-0000-000000000000','cccccccc-0000-0000-0000-000000000004','authenticated','authenticated','sau@anna.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Sáu Hồ"}'),
 ('00000000-0000-0000-0000-000000000000','dddddddd-0000-0000-0000-000000000001','authenticated','authenticated','be@annb.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bê Ngô"}')
on conflict (id) do nothing;

-- A group chat on office A and none on office B, so the tick probes below
-- exercise both the group copy and the per-member copy of each kind.
insert into public.organizations (slug, name, timezone, default_cutoff_local_time,
                                  telegram_group_chat_id)
values ('ann-a','Announce A','Asia/Ho_Chi_Minh','16:00', 880001),
       ('ann-b','Announce B','Asia/Ho_Chi_Minh','16:00', null);

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid, u.role, u.code from public.organizations o
join (values
  ('ann-a','cccccccc-0000-0000-0000-000000000001'::uuid,'owner', 'ANH'),
  ('ann-a','cccccccc-0000-0000-0000-000000000002'::uuid,'member','BON'),
  ('ann-a','cccccccc-0000-0000-0000-000000000003'::uuid,'member','NAM'),
  ('ann-a','cccccccc-0000-0000-0000-000000000004'::uuid,'member','SAU'),
  ('ann-b','dddddddd-0000-0000-0000-000000000001'::uuid,'owner', 'BEE')
) as u(slug,pid,role,code) on u.slug = o.slug;

-- Three of office A's four have finished /start. Sáu has not, and Bê has not:
-- Sáu is what makes `unreachable` measurable, Bê is what makes the "connect
-- Telegram first" refusal reachable at all.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 880100 + m.id, now()
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug = 'ann-a'
 where m.short_code in ('ANH','BON','NAM');

do $$
declare v_a bigint; v_b bigint; v_mon date;
begin
  select id into v_a from public.organizations where slug = 'ann-a';
  select id into v_b from public.organizations where slug = 'ann-b';
  v_mon := current_date - ((extract(isodow from current_date)::int - 1 + 7) % 7);

  insert into ctx values
    ('org_a', v_a::text), ('org_b', v_b::text),
    -- Three weeks back, deliberately NOT the week `ensure_billing_period`
    -- reaches for. The tick at the end of this file bills the week containing
    -- yesterday if today is the billing day, and a period it can recompute is a
    -- period whose statements could vanish under the probes above it.
    ('wk', (v_mon - 21)::text),
    ('d1', (current_date + 1)::text);
end $$;

-- The cutoff is three hours out: far outside the default seventy-minute warning
-- window and comfortably inside a four-hour one, which is the whole point of
-- the last two probes in this file.
--
-- Inserted as a draft and published by UPDATE, the way seed_fixtures.sql does
-- it, rather than inserted straight at 'published'. `enforce_menu_lifecycle` is
-- BEFORE UPDATE and is what stamps `published_at` and refuses a menu with no
-- dishes; an INSERT at 'published' skips it and leans on an AFTER INSERT
-- trigger that reads OLD. Publishing the way the app publishes is also the only
-- way this fixture stays true when that lifecycle changes.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by, source_text)
select (select v::bigint from ctx where k='org_a'),
       (select v::date   from ctx where k='d1'),
       now() + interval '3 hours',
       'cccccccc-0000-0000-0000-000000000001', 'announcements.sql';

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  join lateral (values ('Cơm gà', 45000, 0), ('Bún bò', 60000, 1)) as v(nm, pr, pos) on true
 where m.org_id = (select v::bigint from ctx where k='org_a');

update public.menus m set status = 'published'
 where m.org_id = (select v::bigint from ctx where k='org_a') and m.status = 'draft';

-- Two people who owe and two who do not. Bốn can be reached, Sáu cannot, which
-- is what separates "the 'unpaid' audience is wrong" from "the 'unpaid'
-- audience is right and one of them has no chat".
insert into public.billing_periods (org_id, period_start, period_end, status)
select (select v::bigint from ctx where k='org_a'),
       (select v::date   from ctx where k='wk'),
       (select v::date   from ctx where k='wk') + 6, 'open';

insert into public.billing_statements
  (org_id, billing_period_id, profile_id, meal_count, meals_minor, payment_ref)
select bp.org_id, bp.id, u.pid, 2, 90000,
       private.payment_ref(bp.org_id, bp.period_start, u.pid)
  from public.billing_periods bp
  join (values ('cccccccc-0000-0000-0000-000000000002'::uuid),
               ('cccccccc-0000-0000-0000-000000000004'::uuid)) as u(pid) on true
 where bp.org_id = (select v::bigint from ctx where k='org_a');

--------------------------------------------------------------- what the data says

-- Controls first. Every probe after this one is worthless if the fixtures do
-- not actually say what the probes assume they say.
insert into probe
select 'control: three linked chats in office A',
       (select count(*)::text from public.telegram_links tl
         where tl.org_id = (select v::bigint from ctx where k='org_a')
           and tl.chat_id is not null), '3';

insert into probe
select 'control: exactly two people owe in office A',
       (select string_agg(m.short_code, ',' order by m.short_code)
          from public.memberships m
          join public.v_account_balance b
            on b.org_id = m.org_id and b.profile_id = m.profile_id
         where m.org_id = (select v::bigint from ctx where k='org_a')
           and b.balance_minor > 0), 'BON,SAU';

-- The window control. Without it, "no cutoff warning at 70 minutes" passes for
-- an office whose menu was never eligible at any window at all.
insert into probe
select 'control: the menu is outside 70 minutes and inside 240',
       (select (m.order_cutoff_at >  now() + interval '70 minutes'
            and m.order_cutoff_at <= now() + interval '240 minutes')::text
          from public.menus m
         where m.org_id = (select v::bigint from ctx where k='org_a')), 'true';

------------------------------------------------------- the two refusals

do $$
declare
  v_before bigint; v_after bigint; v_state text;
begin
  select count(*) into v_before from public.notification_outbox;

  set local role authenticated;

  -- A member of office A, who is not an admin of it.
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000002","role":"authenticated"}', true);
  insert into probe values
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: acting as a member',
      ((select auth.uid())::text = 'cccccccc-0000-0000-0000-000000000002')::text, 'true');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'office', 'a member should not be able to say this');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R1 member announcing: refused', v_state,
    '42501 only an admin of this office can send an announcement');

  begin
    perform public.send_test_notification(
      (select v::bigint from ctx where k='org_a'), 'menu_published');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R2 member testing: refused', v_state,
    '42501 only an admin of this office can send a test message');

  -- An admin, but of the other office. The one who owns office B and has no
  -- linked chat of their own, so a pass here could not be luck about the chat.
  perform set_config('request.jwt.claims',
    '{"sub":"dddddddd-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into probe values
    ('control: acting as the other office''s owner',
      ((select auth.uid())::text = 'dddddddd-0000-0000-0000-000000000001')::text, 'true');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'office', 'a stranger should not be able to say this');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R3 cross-office announcing: refused', v_state,
    '42501 only an admin of this office can send an announcement');

  begin
    perform public.send_test_notification(
      (select v::bigint from ctx where k='org_a'), 'menu_published');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R4 cross-office testing: refused', v_state,
    '42501 only an admin of this office can send a test message');

  -- The admin check comes before everything else, so this admin of office B
  -- reaches the chat check for their OWN office and is told what to do about it.
  begin
    perform public.send_test_notification(
      (select v::bigint from ctx where k='org_b'), 'menu_published');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R5 admin with no linked chat: told to connect', v_state,
    'P0002 connect Telegram first: open the bot and finish /start, then the test will arrive in your own chat');

  -- The admin of office A, refused on the shape of the request rather than on
  -- who is asking.
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'everybody', 'to whom?');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R6 unknown audience: refused', v_state,
    '23514 an announcement goes to the office, to one person, or to everybody who owes');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'office', '    ');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R7 blank announcement: refused', v_state,
    '23514 an announcement needs something to say');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'office', repeat('x', 1001));
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R8 over-long announcement: refused', v_state,
    '22001 a message can be at most 1000 characters; that one is 1001');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'person', 'to nobody in particular');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R9 one person, nobody named: refused', v_state,
    '23514 sending to one person needs somebody to send it to');

  begin
    perform public.send_announcement(
      (select v::bigint from ctx where k='org_a'), 'person', 'to somebody elsewhere',
      'dddddddd-0000-0000-0000-000000000001');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R10 one person, not a member: refused', v_state,
    'P0002 that person is not a member of this office');

  begin
    perform public.send_test_notification(
      (select v::bigint from ctx where k='org_a'), 'weekly_preview');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R11 test of an unknown kind: refused', v_state,
    '23514 a test can be sent for menu_published, cutoff_warning or weekly_bill');

  reset role;

  select count(*) into v_after from public.notification_outbox;

  -- The delta, because a refusal that raised is not the same claim as a refusal
  -- that wrote nothing. Unqualified on purpose: eleven refusals must not have
  -- put a row anywhere in this database, not merely none in office A.
  insert into probe values
    ('refusals enqueued nothing', (v_before = v_after)::text, 'true');
end $$;

------------------------------------------------------------- who each audience reaches

do $$
declare v_q integer; v_u integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);

  insert into probe values
    ('control: acting as the admin of office A',
      ((select auth.uid())::text = 'cccccccc-0000-0000-0000-000000000001')::text, 'true'),
    ('control: role still downgraded', (current_role = 'authenticated')::text, 'true');

  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'office', 'A1 the caterer is closed on Friday') a;
  insert into res values ('office', v_q, v_u);

  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'person', 'A2 your transfer arrived', 'cccccccc-0000-0000-0000-000000000002') a;
  insert into res values ('person', v_q, v_u);

  -- The one person in the audience who cannot be reached at all. An admin has
  -- to be told the difference between this and a send that worked.
  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'person', 'A3 nobody will read this', 'cccccccc-0000-0000-0000-000000000004') a;
  insert into res values ('person_unreachable', v_q, v_u);

  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'unpaid', 'A4 please settle last week') a;
  insert into res values ('unpaid', v_q, v_u);

  -- Sent twice, word for word. Every other enqueue in this schema would swallow
  -- the second one on the dedupe key; an announcement must not.
  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'person', 'A5 said twice on purpose', 'cccccccc-0000-0000-0000-000000000002') a;
  insert into res values ('twice_1', v_q, v_u);
  select a.queued, a.unreachable into v_q, v_u
    from public.send_announcement((select v::bigint from ctx where k='org_a'),
           'person', 'A5 said twice on purpose', 'cccccccc-0000-0000-0000-000000000002') a;
  insert into res values ('twice_2', v_q, v_u);

  -- The preview, to the admin's own chat and nobody else's.
  select t.queued into v_q
    from public.send_test_notification((select v::bigint from ctx where k='org_a'),
           'menu_published') t;
  insert into res values ('test_menu', v_q, 0);

  reset role;
end $$;

-- What the functions SAID.
insert into probe
select 'office: queued 3, unreachable 1',
       (select queued || '/' || unreachable from res where step = 'office'), '3/1';
insert into probe
select 'person: queued 1, unreachable 0',
       (select queued || '/' || unreachable from res where step = 'person'), '1/0';
insert into probe
select 'person with no chat: queued 0, unreachable 1',
       (select queued || '/' || unreachable from res where step = 'person_unreachable'), '0/1';
insert into probe
select 'unpaid: queued 1, unreachable 1',
       (select queued || '/' || unreachable from res where step = 'unpaid'), '1/1';
insert into probe
select 'test message: queued 1',
       (select queued::text from res where step = 'test_menu'), '1';

-- What they actually DID. By short code, because three rows is the right answer
-- for the wrong three people too.
insert into probe
select 'office reached ANH, BON, NAM and nobody else',
       coalesce((select string_agg(m.short_code, ',' order by m.short_code)
                   from public.notification_outbox ob
                   join public.memberships m on m.org_id = ob.org_id
                                            and m.profile_id = ob.recipient_profile_id
                  where ob.kind = 'announcement' and ob.body like 'A1 %'), '(none)'),
       'ANH,BON,NAM';

insert into probe
select 'person reached BON alone',
       coalesce((select string_agg(m.short_code, ',' order by m.short_code)
                   from public.notification_outbox ob
                   join public.memberships m on m.org_id = ob.org_id
                                            and m.profile_id = ob.recipient_profile_id
                  where ob.kind = 'announcement' and ob.body like 'A2 %'), '(none)'),
       'BON';

insert into probe
select 'the unreachable person got no row at all',
       (select count(*)::text from public.notification_outbox ob
         where ob.kind = 'announcement' and ob.body like 'A3 %'), '0';

insert into probe
select 'unpaid reached BON alone, not NAM and not the admin',
       coalesce((select string_agg(m.short_code, ',' order by m.short_code)
                   from public.notification_outbox ob
                   join public.memberships m on m.org_id = ob.org_id
                                            and m.profile_id = ob.recipient_profile_id
                  where ob.kind = 'announcement' and ob.body like 'A4 %'), '(none)'),
       'BON';

insert into probe
select 'the same announcement twice is two rows',
       (select count(*)::text from public.notification_outbox ob
         where ob.kind = 'announcement' and ob.body like 'A5 %'), '2';

insert into probe
select 'the two rows carry different dedupe keys',
       (select count(distinct ob.dedupe_key)::text from public.notification_outbox ob
         where ob.kind = 'announcement' and ob.body like 'A5 %'), '2';

insert into probe
select 'every announcement names its sender and office',
       (select count(*) filter (where ob.body like '%' || chr(10) || chr(10) || 'From Ánh Đỗ, Announce A.')::text
               || '/' || count(*)::text
          from public.notification_outbox ob where ob.kind = 'announcement'), '7/7';

insert into probe
select 'every announcement is parse_mode none',
       (select coalesce(string_agg(distinct ob.parse_mode, ','), '(none)')
          from public.notification_outbox ob where ob.kind = 'announcement'), 'none';

insert into probe
select 'office B received nothing',
       (select count(*)::text from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_b')), '0';

-- The test message: the admin's chat only, marked as a test, and the real body
-- underneath it unchanged.
insert into probe
select 'the test went to the admin''s own chat only',
       coalesce((select string_agg(m.short_code, ',' order by m.short_code)
                   from public.notification_outbox ob
                   join public.memberships m on m.org_id = ob.org_id
                                            and m.profile_id = ob.recipient_profile_id
                  where ob.dedupe_key like '%:test:%'), '(none)'),
       'ANH';

insert into probe
select 'the test body is the real menu message, prefixed',
       (select (ob.body = 'Test message, sent to you alone. This is what your office receives.'
                          || chr(10) || chr(10) || private.menu_message(ob.related_menu_id))::text
          from public.notification_outbox ob where ob.dedupe_key like '%:test:%'), 'true';

------------------------------------------------------- the tick reads the switches

-- Switched off, and left at the default window. Neither kind should produce a
-- single row, and the window control above says the menu was eligible for
-- neither reason.
insert into public.org_notifications (org_id, kind, enabled)
values ((select v::bigint from ctx where k='org_a'), 'menu_published', false);

select private.run_hourly_tick();

-- `:test:` is excluded from every count below. The preview sent above is a
-- genuine menu_published row for this office, and counting it here would make
-- "the switch is off" read as "the switch leaked one message".
insert into probe
select 'tick with menu_published off: no menu announcement',
       (select count(*)::text from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_a')
           and ob.kind = 'menu_published'
           and ob.dedupe_key not like '%:test:%'), '0';

insert into probe
select 'tick at the default 70 minutes: no cutoff warning',
       (select count(*)::text from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_a')
           and ob.kind = 'cutoff_warning'
           and ob.dedupe_key not like '%:test:%'), '0';

-- Switched back on, and the warning moved to four hours. Same tick, same menu,
-- same clock: only the two rows in org_notifications changed.
update public.org_notifications set enabled = true
 where org_id = (select v::bigint from ctx where k='org_a') and kind = 'menu_published';

insert into public.org_notifications (org_id, kind, enabled, minutes_before)
values ((select v::bigint from ctx where k='org_a'), 'cutoff_warning', true, 240);

select private.run_hourly_tick();

-- One group copy and one per linked member, for each kind.
insert into probe
select 'tick with menu_published on: the group and three members',
       (select count(*) filter (where ob.recipient_profile_id is null)::text || '+'
            || count(*) filter (where ob.recipient_profile_id is not null)::text
          from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_a')
           and ob.kind = 'menu_published'
           and ob.dedupe_key not like '%:test:%'), '1+3';

insert into probe
select 'tick at 240 minutes: the cutoff warning now fires',
       (select count(*) filter (where ob.recipient_profile_id is null)::text || '+'
            || count(*) filter (where ob.recipient_profile_id is not null)::text
          from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_a')
           and ob.kind = 'cutoff_warning'
           and ob.dedupe_key not like '%:test:%'), '1+3';

insert into probe
select 'the unlinked member still got no tick message',
       (select count(*)::text from public.notification_outbox ob
         where ob.recipient_profile_id = 'cccccccc-0000-0000-0000-000000000004'), '0';

-- A third tick, changing nothing. The dedupe keys are what make a wider window
-- safe, and this is the probe that says so.
select private.run_hourly_tick();

insert into probe
select 'a third tick sends nothing twice',
       (select count(*)::text from public.notification_outbox ob
         where ob.org_id = (select v::bigint from ctx where k='org_a')
           and ob.kind in ('menu_published','cutoff_warning')
           and ob.dedupe_key not like '%:test:%'), '8';

-- The table is admin-only, both ways round.
do $$
declare v_seen bigint; v_state text;
begin
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000002","role":"authenticated"}', true);
  select count(*) into v_seen from public.org_notifications;
  insert into probe values ('a member reads no settings', v_seen::text, '0');

  begin
    insert into public.org_notifications (org_id, kind, enabled)
    values ((select v::bigint from ctx where k='org_a'), 'weekly_bill', false);
    v_state := 'allowed';
  exception when others then v_state := 'blocked';
  end;
  insert into probe values ('a member cannot switch a message off', v_state, 'blocked');

  perform set_config('request.jwt.claims',
    '{"sub":"dddddddd-0000-0000-0000-000000000001","role":"authenticated"}', true);
  select count(*) into v_seen from public.org_notifications;
  insert into probe values ('another office''s admin reads no settings', v_seen::text, '0');

  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  select count(*) into v_seen from public.org_notifications;
  insert into probe values ('the office''s own admin reads both rows', v_seen::text, '2');

  reset role;
end $$;

--------------------------------------------------------------------- verdict

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
