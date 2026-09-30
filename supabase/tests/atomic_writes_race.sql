-- Two sessions at once: the interleavings the one-transaction writes exist for.
-- Run against a LOCAL scratch database only:
--   psql "$DATABASE_URL" -f supabase/tests/atomic_writes_race.sql
--
-- Unlike every other file here this one COMMITS its fixtures, because the two
-- sessions that race are dblink connections back into the same database and
-- cannot see an uncommitted row. It removes them again at the end. It needs
-- the dblink extension and a loopback connection that authenticates as the
-- current user without a password.
--
-- Session A takes its locks and stops. Session B is sent its statement
-- asynchronously, and the probe asks whether B is still waiting. Then A
-- commits and B's outcome is read. Every session runs with lock_timeout and
-- statement_timeout, so a regression shows up as a timeout or a deadlock
-- (40P01) in B's answer rather than as a hung run.

set statement_timeout = '120s';
set client_min_messages = warning;
set lock_timeout = '20s';

create extension if not exists dblink with schema extensions;

create temp table probe (label text, got text, want text);
create temp table ctx (k text primary key, v text);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

-- Opens a session as `p_who`, inside a transaction, with timeouts that end a
-- wait long before this file's own.
create function pg_temp.open(p_conn text, p_who text) returns void
language plpgsql as $fn$
begin
  perform extensions.dblink_connect(p_conn, format('host=%s port=%s dbname=%s user=%s',
    coalesce(host(inet_server_addr()), 'localhost'), inet_server_port(),
    current_database(), current_user));
  perform extensions.dblink_exec(p_conn, 'begin');
  perform extensions.dblink_exec(p_conn, $q$set local lock_timeout = '8s'$q$);
  perform extensions.dblink_exec(p_conn, $q$set local statement_timeout = '15s'$q$);
  if p_who is not null then
    perform extensions.dblink_exec(p_conn, 'set local role authenticated');
    perform extensions.dblink_exec(p_conn, format(
      $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$,
      pg_temp.c(p_who)));
  end if;
end $fn$;

-- One statement, synchronously; answers 'ok' or the error. A statement that
-- returns rows has to return one text column.
create function pg_temp.run(p_conn text, p_sql text) returns text
language plpgsql as $fn$
begin
  perform * from extensions.dblink(p_conn, p_sql) as t(x text);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

create function pg_temp.send(p_conn text, p_sql text) returns void
language plpgsql as $fn$
begin
  perform extensions.dblink_send_query(p_conn, p_sql);
  -- Long enough for B to reach the lock it will wait on.
  perform pg_sleep(0.5);
end $fn$;

create function pg_temp.busy(p_conn text) returns text
language sql as $fn$
  select case extensions.dblink_is_busy(p_conn) when 1 then 'waiting' else 'done' end;
$fn$;

-- B's answer: 'ok' or '<message>', then its transaction is ended.
create function pg_temp.finish(p_conn text, p_commit boolean default true) returns text
language plpgsql as $fn$
declare v_msg text; r record;
begin
  for r in select * from extensions.dblink_get_result(p_conn, false) as t(x text) loop end loop;
  v_msg := extensions.dblink_error_message(p_conn);
  -- Drains the empty result that ends an async query.
  perform * from extensions.dblink_get_result(p_conn, false) as t(x text);
  perform extensions.dblink_exec(p_conn, case when p_commit then 'commit' else 'rollback' end);
  perform extensions.dblink_disconnect(p_conn);
  return case when v_msg = 'OK' then 'ok'
              else split_part(regexp_replace(v_msg, '^ERROR:\s+', ''), E'\n', 1) end;
end $fn$;

create function pg_temp.close(p_conn text, p_commit boolean default true) returns text
language plpgsql as $fn$
declare v text;
begin
  begin
    perform extensions.dblink_exec(p_conn, case when p_commit then 'commit' else 'rollback' end);
    v := 'ok';
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  perform extensions.dblink_disconnect(p_conn);
  return v;
end $fn$;

create function pg_temp.dishes_of_eaten() returns text
language sql stable as $fn$
  select (select string_agg(mi.position || ':' || mi.name || '@' || coalesce(mi.price_minor::text, 'null'),
                            ',' order by mi.position)
            from public.menu_items mi where mi.menu_id = pg_temp.c('m_eaten')::bigint)
         || ' / ' ||
         coalesce((select string_agg(oi.item_name_snapshot, ',') from public.order_items oi
                    where oi.menu_id = pg_temp.c('m_eaten')::bigint
                      and oi.profile_id = pg_temp.c('teo')::uuid), '-');
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('ace00000-0000-0000-0000-000000000001', 'adm@race.test',  'Quan Ly'),
    ('ace00000-0000-0000-0000-000000000002', 'dinh@race.test', 'Dinh Thi'),
    ('ace00000-0000-0000-0000-000000000003', 'teo@race.test',  'Teo Van'),
    ('ace00000-0000-0000-0000-000000000004', 'bown@race.test', 'Be Owner'),
    ('ace00000-0000-0000-0000-000000000005', 'adm2@race.test', 'Hai Quan')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code)
values ('race-a', 'Race A', 'RACA'), ('race-b', 'Race B', 'RACB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('race-a', 'ace00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('race-a', 'ace00000-0000-0000-0000-000000000002', 'member', 'DINH'),
  ('race-a', 'ace00000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('race-b', 'ace00000-0000-0000-0000-000000000004', 'owner',  'BOWN'),
  ('race-a', 'ace00000-0000-0000-0000-000000000005', 'admin',  'HAI')
) as u(slug, pid, role, code) on u.slug = o.slug;

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'race-a' union all
select 'org_b', id::text from public.organizations where slug = 'race-b' union all
select 'adm',  'ace00000-0000-0000-0000-000000000001' union all
select 'dinh', 'ace00000-0000-0000-0000-000000000002' union all
select 'teo',  'ace00000-0000-0000-0000-000000000003' union all
select 'bown', 'ace00000-0000-0000-0000-000000000004' union all
select 'adm2', 'ace00000-0000-0000-0000-000000000005';

insert into ctx
select k, (private.today_in(o.timezone) + n)::text
  from public.organizations o
  cross join (values ('pick', 14), ('call', 15), ('call2', 16), ('priced', 17),
                     ('fresh', 20), ('rule_a', 22), ('rule_b', 23), ('eaten', -2)) as d(k, n)
 where o.slug = 'race-a';

-- DINH eats on fresh's weekday, so publishing fresh orders for her.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
values (pg_temp.c('org_a')::bigint, pg_temp.c('dinh')::uuid,
        extract(isodow from pg_temp.c('fresh')::date)::int, true);

create function pg_temp.menu(p_org text, p_day text, p_dishes text[], p_prices int[])
returns bigint
language plpgsql as $fn$
declare v_menu bigint; i int;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, now() + interval '10 days',
          pg_temp.c('adm')::uuid)
  returning id into v_menu;
  for i in 1 .. array_length(p_dishes, 1) loop
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu, pg_temp.c(p_org)::bigint, p_dishes[i], p_prices[i], i - 1);
    insert into ctx values ('i_' || p_day || '_' || i,
                            currval(pg_get_serial_sequence('public.menu_items', 'id'))::text);
  end loop;
  insert into ctx values ('m_' || p_day, v_menu::text);
  update public.menus set status = 'published' where id = v_menu;
  return v_menu;
end $fn$;

select pg_temp.menu('org_a', 'pick',   array['Com ga', 'Pho'],    array[45000, 50000]);
select pg_temp.menu('org_a', 'call',   array['Com ga'],           array[45000]);
select pg_temp.menu('org_a', 'call2',  array['Com ga'],           array[45000]);
select pg_temp.menu('org_a', 'priced', array['Bun bo', 'Banh mi'], array[null, 30000]);
select pg_temp.menu('org_a', 'rule_a', array['Ga'], array[1000]);
insert into ctx values ('rule_b_day', pg_temp.c('rule_b'));
select pg_temp.menu('org_b', 'rule_b', array['Ga'], array[1000]);

-- The priced day is locked with TEO's standing order on the unpriced dish.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('m_priced')::bigint, pg_temp.c('priced')::date,
        pg_temp.c('teo')::uuid, 'standing', pg_temp.c('teo')::uuid);
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
                                item_name_snapshot, unit_price_minor)
select o.id, o.org_id, o.profile_id, o.menu_id, pg_temp.c('i_priced_1')::bigint, '', 0
  from public.orders o where o.menu_id = pg_temp.c('m_priced')::bigint;
update public.menus set status = 'locked' where id = pg_temp.c('m_priced')::bigint;
insert into ctx values ('p_priced',
  public.ensure_billing_period(pg_temp.c('org_a')::bigint, pg_temp.c('priced')::date)::text);

-- Four messages waiting to be sent.
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, body, parse_mode)
select pg_temp.c('org_a')::bigint, 'race:' || n, 'announcement', 1, 'hello ' || n, 'none'
  from generate_series(1, 4) n;

---------------------------------------------- R1 one member, two taps at once

-- The Board used to send delete-lines and insert-line as two requests, so two
-- taps interleaved as delete, delete, insert, insert and left two dishes on
-- one order. Now the second call waits on the order row and replaces the line.
select pg_temp.open('a', 'dinh');
select pg_temp.open('b', 'dinh');
insert into probe values ('R1 A chooses Com ga and holds it',
  pg_temp.run('a', format('select count(*)::text from public.set_my_order(%s, %s, null)',
                          pg_temp.c('m_pick'), pg_temp.c('i_pick_1'))), 'ok');
-- The first choice has to exist before B can wait on it.
insert into probe values ('R1 A commits the first choice', pg_temp.close('a'), 'ok');

select pg_temp.open('a', 'dinh');
select pg_temp.run('a', format('select count(*)::text from public.set_my_order(%s, %s, null)',
                               pg_temp.c('m_pick'), pg_temp.c('i_pick_2')));
select pg_temp.send('b', format('select count(*)::text from public.set_my_order(%s, %s, null)',
                                pg_temp.c('m_pick'), pg_temp.c('i_pick_1')));
insert into probe values ('R1 B waits for A rather than interleaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 A commits Pho', pg_temp.close('a'), 'ok');
insert into probe values ('R1 then B goes through', pg_temp.finish('b'), 'ok');
insert into probe values ('R1 one line, the later tap''s',
  (select string_agg(oi.item_name_snapshot, ',')
     from public.order_items oi
    where oi.menu_id = pg_temp.c('m_pick')::bigint and oi.profile_id = pg_temp.c('dinh')::uuid),
  'Com ga');

--------------------------------------------- R2 cancelling lunch meets an order

-- An order in flight holds the menu FOR SHARE, so the cancel waits for it and
-- then cancels it too, rather than missing it.
select pg_temp.open('a', 'dinh');
select pg_temp.open('b', 'adm');
select pg_temp.run('a', format('select count(*)::text from public.set_my_order(%s, %s, null)',
                               pg_temp.c('m_call'), pg_temp.c('i_call_1')));
select pg_temp.send('b', format($q$update public.menus set status = 'cancelled' where id = %s$q$,
                                pg_temp.c('m_call')));
insert into probe values ('R2 the cancel waits for the order in flight', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2 A commits the order', pg_temp.close('a'), 'ok');
insert into probe values ('R2 the cancel goes through', pg_temp.finish('b'), 'ok');
insert into probe values ('R2 and the order it waited for is cancelled with the day',
  (select status from public.orders
    where menu_id = pg_temp.c('m_call')::bigint and profile_id = pg_temp.c('dinh')::uuid),
  'cancelled');

-- The other way round: the order waits for the cancel and is refused.
select pg_temp.open('a', 'adm');
select pg_temp.open('b', 'dinh');
select pg_temp.run('a', format($q$update public.menus set status = 'cancelled' where id = %s$q$,
                               pg_temp.c('m_call2')));
select pg_temp.send('b', format('select count(*)::text from public.set_my_order(%s, %s, null)',
                                pg_temp.c('m_call2'), pg_temp.c('i_call2_1')));
insert into probe values ('R2 an order waits for a cancel in flight', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2 A commits the cancel', pg_temp.close('a'), 'ok');
insert into probe values ('R2 and the order is refused in so many words',
  pg_temp.finish('b'), 'the menu for ' || to_char(pg_temp.c('call2')::date, 'DD/MM') || ' was cancelled');
insert into probe values ('R2 leaving no placed order on a cancelled day',
  (select count(*)::text from public.orders
    where menu_id = pg_temp.c('m_call2')::bigint and status = 'placed'),
  '0');

------------------------------------ R3 pricing the week meets a correction

-- A correction holds the menu FOR SHARE and then the week, the same order
-- apply_caterer_prices takes them in, so pricing waits on the menu rather than
-- holding it while it waits for the week: no 40P01 either way round.
select pg_temp.open('a', 'adm');
select pg_temp.open('b', 'adm');
insert into probe values ('R3 the correction goes through and holds the day',
  pg_temp.run('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org_a'), pg_temp.c('priced'), pg_temp.c('dinh'), pg_temp.c('i_priced_2'))), 'ok');
select pg_temp.send('b', format(
  $q$select count(*)::text from public.apply_caterer_prices(%s, '[{"price_minor": 40000, "menu_item_ids": [%s]}]')$q$,
  pg_temp.c('org_a'), pg_temp.c('i_priced_1')));
insert into probe values ('R3 pricing waits for the correction', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3 A commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3 then the pricing goes through', pg_temp.finish('b'), 'ok');
insert into probe values ('R3 and TEO''s standing line took the price',
  (select unit_price_minor::text from public.order_items
    where menu_id = pg_temp.c('m_priced')::bigint and profile_id = pg_temp.c('teo')::uuid),
  '40000');

------------------------------------------ R4 one office's sweep, another's day

-- A weekday rule switched on in office A holds office A's menus of that
-- weekday. Office B's admin editing a menu of the same date is not held up.
select pg_temp.open('a', 'teo');
select pg_temp.open('b', 'bown');
insert into probe values ('R4 a rule is switched on in office A',
  pg_temp.run('a', format(
    'insert into public.standing_orders (org_id, profile_id, weekday, is_enabled) values (%s, %L, %s, true)',
    pg_temp.c('org_a'), pg_temp.c('teo'), extract(isodow from pg_temp.c('rule_a')::date)::int)),
  'ok');
select pg_temp.send('b', format(
  $q$update public.menus set order_cutoff_at = order_cutoff_at - interval '1 minute' where id = %s$q$,
  pg_temp.c('m_rule_b')));
insert into probe values ('R4 office B''s menu of that date is not held', pg_temp.busy('b'), 'done');
insert into probe values ('R4 and its edit goes through', pg_temp.finish('b'), 'ok');
insert into probe values ('R4 office A''s rule commits', pg_temp.close('a'), 'ok');

-------------------------------------------- R5 a skip meets a brand new menu

-- publish_menu inserts and publishes in one transaction, so a skip written
-- meanwhile found no menu, and the publish could not see the skip. Both take
-- the office's materialize lock now: the skip waits, then sees the menu out.
select pg_temp.open('a', 'adm');
select pg_temp.open('b', 'dinh');
insert into probe values ('R5 a new day is published and held',
  pg_temp.run('a', format(
    $q$select count(*)::text from public.publish_menu(%s, %L::date, now() + interval '9 days', '[{"name": "Ga", "price_minor": 1}]', 'raw', '{}')$q$,
    pg_temp.c('org_a'), pg_temp.c('fresh'))),
  'ok');
select pg_temp.send('b', format($q$select public.set_standing_exception(%s, %L::date, 'skip')$q$,
                                pg_temp.c('org_a'), pg_temp.c('fresh')));
insert into probe values ('R5 the skip waits for the publish', pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 A commits the publish', pg_temp.close('a'), 'ok');
insert into probe values ('R5 the skip is refused, since the menu is out',
  pg_temp.finish('b'),
  'the menu for ' || to_char(pg_temp.c('fresh')::date, 'DD/MM')
    || ' is already out, so order or cancel that day instead');
insert into probe values ('R5 so the order stands and no skip claims otherwise',
  (select count(*)::text from public.orders o
    where o.org_id = pg_temp.c('org_a')::bigint and o.service_date = pg_temp.c('fresh')::date
      and o.profile_id = pg_temp.c('dinh')::uuid and o.status = 'placed')
   || ' ' ||
  (select count(*)::text from public.standing_order_exceptions e
    where e.org_id = pg_temp.c('org_a')::bigint and e.service_date = pg_temp.c('fresh')::date),
  '1 0');

------------------------------------ R7 a republish meets an off-menu record

-- Admin A republishes a finished day, dropping dish E and pricing dish D.
-- Admin B records TEO as having eaten "Dish D". The republish holds the menu
-- and waits on E's line (held here by H, as a correction deleting it would).
-- B holds the menu before the week (20261018100000), so it waits for A rather
-- than taking dish D from under it, and goes through once A commits.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('eaten')::date, now() - interval '3 days',
        pg_temp.c('adm')::uuid);
insert into ctx select 'm_eaten', currval(pg_get_serial_sequence('public.menus', 'id'))::text;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
values (pg_temp.c('m_eaten')::bigint, pg_temp.c('org_a')::bigint, 'Dish D', null, 0);
insert into ctx select 'i_eaten_d', currval(pg_get_serial_sequence('public.menu_items', 'id'))::text;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
values (pg_temp.c('m_eaten')::bigint, pg_temp.c('org_a')::bigint, 'Dish E', 1000, 1);
insert into ctx select 'i_eaten_e', currval(pg_get_serial_sequence('public.menu_items', 'id'))::text;
update public.menus set status = 'published' where id = pg_temp.c('m_eaten')::bigint;
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('m_eaten')::bigint, pg_temp.c('eaten')::date,
        pg_temp.c('dinh')::uuid, 'member', pg_temp.c('dinh')::uuid);
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
                                item_name_snapshot, unit_price_minor)
select o.id, o.org_id, o.profile_id, o.menu_id, pg_temp.c('i_eaten_e')::bigint, '', 0
  from public.orders o where o.menu_id = pg_temp.c('m_eaten')::bigint;
insert into ctx select 'l_eaten', max(id)::text from public.order_items
                 where menu_id = pg_temp.c('m_eaten')::bigint;
-- DINH also had the unpriced D, so losing E leaves her no 0 meal: billing a
-- 0 meal with no payment trips billing_statements_paid_ck in
-- private.reallocate, which is not what this race is about.
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
                                item_name_snapshot, unit_price_minor)
select o.id, o.org_id, o.profile_id, o.menu_id, pg_temp.c('i_eaten_d')::bigint, '', 0
  from public.orders o where o.menu_id = pg_temp.c('m_eaten')::bigint;

select pg_temp.open('h', null);
insert into probe values ('R7 H holds the line on dish E',
  pg_temp.run('h', format('delete from public.order_items where id = %s returning 1::text',
                          pg_temp.c('l_eaten'))), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format(
  $q$select menu_id::text from public.publish_menu(%s, %L::date, now() - interval '3 days', '[{"id": %s, "name": "Dish D", "price_minor": 2000}]'::jsonb, 'x', '{}'::jsonb)$q$,
  pg_temp.c('org_a'), pg_temp.c('eaten'), pg_temp.c('i_eaten_d')));
insert into probe values ('R7 the republish waits on the line', pg_temp.busy('a'), 'waiting');
select pg_temp.open('b', 'adm2');
select pg_temp.send('b', format(
  $q$select order_id::text from public.correct_meal_off_menu(%s, %L::date, %L::uuid, 'Dish D', 3000, 1::smallint, null, 'phone')$q$,
  pg_temp.c('org_a'), pg_temp.c('eaten'), pg_temp.c('teo')));
insert into probe values ('R7 the off-menu record waits on the menu', pg_temp.busy('b'), 'waiting');
insert into probe values ('R7 H lets the line go', pg_temp.close('h'), 'ok');
insert into probe values ('R7 the republish goes through', pg_temp.finish('a'), 'ok');
insert into probe values ('R7 and so does the off-menu record', pg_temp.finish('b'), 'ok');
insert into probe values ('R7 E is gone, D carries the republish''s price, TEO ate D',
  pg_temp.dishes_of_eaten() , '0:Dish D@2000 / Dish D');

------------------------------------------------ R6 two drains, one queue

-- Already true before this change, and kept: claim_outbox skips what another
-- drain holds, and re-checks the status of what it waited past.
select pg_temp.open('a', null);
select pg_temp.open('b', null);
select * from extensions.dblink('a', 'select count(*)::text from public.claim_outbox(2)') as t(n text);
insert into probe values ('R6 a second drain takes the other two at once',
  (select n from extensions.dblink('b',
     $q$select count(*)::text from public.claim_outbox(10) c where c.dedupe_key like 'race:%'$q$)
       as t(n text)),
  '2');
insert into probe values ('R6 A commits', pg_temp.close('a'), 'ok');
insert into probe values ('R6 B commits', pg_temp.close('b'), 'ok');
insert into probe values ('R6 every message claimed exactly once',
  (select string_agg(attempts::text || status, ',' order by id) from public.notification_outbox
    where dedupe_key like 'race:%'),
  '1sending,1sending,1sending,1sending');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_orgs bigint[];
begin
  select coalesce(array_agg(id), '{}') into v_orgs
    from public.organizations where slug in ('race-a', 'race-b');
  delete from public.order_corrections   where org_id = any (v_orgs);
  delete from public.billing_statements  where org_id = any (v_orgs);
  delete from public.billing_lines       where org_id = any (v_orgs);
  delete from public.billing_periods     where org_id = any (v_orgs);
  delete from public.notification_outbox where org_id = any (v_orgs);
  delete from public.order_items         where org_id = any (v_orgs);
  delete from public.orders              where org_id = any (v_orgs);
  delete from public.organizations       where id     = any (v_orgs);
end $$;

delete from auth.users where email like '%@race.test';
