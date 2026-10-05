-- Two sessions at once around somebody leaving or being removed: a publish
-- materializing their rule, a correction of their meal, a removal of the same
-- person, and an answer to the offer on their meal, each both ways round.
-- Run against a LOCAL scratch database only, as a superuser over TCP:
--   docker exec -i <db container> psql -h 127.0.0.1 -U supabase_admin -d postgres \
--     -f - < supabase/tests/leaving_race.sql
--
-- Like the other race files this COMMITS its fixtures, because the racing
-- sessions are dblink connections back into the same database, and removes
-- them at the end. Session A does its write and stops, B is sent its
-- statement and the probe asks whether it waits, then A commits and B's
-- outcome is read. Every session has lock_timeout and statement_timeout, so a
-- regression shows up as a timeout or a deadlock (40P01) in B's answer.
set statement_timeout = '120s';
set client_min_messages = warning;
set lock_timeout = '20s';

create extension if not exists dblink with schema extensions;

create temp table probe (label text, got text, want text);
create temp table ctx (k text primary key, v text);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

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
  perform pg_sleep(0.5);
end $fn$;

create function pg_temp.busy(p_conn text) returns text
language sql as $fn$
  select case extensions.dblink_is_busy(p_conn) when 1 then 'waiting' else 'done' end;
$fn$;

create function pg_temp.finish(p_conn text, p_commit boolean default true) returns text
language plpgsql as $fn$
declare v_msg text; r record;
begin
  for r in select * from extensions.dblink_get_result(p_conn, false) as t(x text) loop end loop;
  v_msg := extensions.dblink_error_message(p_conn);
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

create function pg_temp.m(p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c('org')::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.oid(p_day text, p_who text) returns bigint
language sql stable as $fn$
  select o.id from public.orders o
   where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

-- `status dish@price` or `none`.
create function pg_temp.ord(p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((
    select o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot || '@' || oi.unit_price_minor, ',')
                          from public.order_items oi where oi.order_id = o.id), '-')
      from public.orders o
     where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid),
    'none');
$fn$;

create function pg_temp.publish_sql(p_day text) returns text
language sql stable as $fn$
  select format(
    $q$select menu_id::text from public.publish_menu(%s, %L::date, %L::timestamptz,
         '[{"name": "Bun", "price_minor": 40000}]'::jsonb, 'raw', '{}')$q$,
    pg_temp.c('org'), pg_temp.c(p_day), now() + interval '10 days');
$fn$;

create function pg_temp.leave_sql() returns text
language sql stable as $fn$
  select format('select public.leave_office(%s)::text', pg_temp.c('org'));
$fn$;

create function pg_temp.remove_sql(p_who text) returns text
language sql stable as $fn$
  select format($q$update public.memberships set status = 'inactive'
                    where org_id = %s and profile_id = %L returning 1::text$q$,
                pg_temp.c('org'), pg_temp.c(p_who));
$fn$;

-- Every statement in the week that is not the sum of its lines, or `none`.
create function pg_temp.off_sum() returns text
language sql stable as $fn$
  select coalesce(string_agg(m.short_code, ','), 'none')
    from public.billing_statements st
    join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
   where st.org_id = pg_temp.c('org')::bigint
     and st.meals_minor <> (select coalesce(sum(bl.amount_minor), 0) from public.billing_lines bl
                             where bl.billing_period_id = st.billing_period_id
                               and bl.payer_profile_id = st.profile_id);
$fn$;

create function pg_temp.charged(p_who text) returns text
language sql stable as $fn$
  select coalesce(sum(bl.amount_minor), 0)::text from public.billing_lines bl
   where bl.org_id = pg_temp.c('org')::bigint and bl.payer_profile_id = pg_temp.c(p_who)::uuid;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@leaverace.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1ea0ace0-0000-0000-0000-000000000001', 'adm'),
    ('1ea0ace0-0000-0000-0000-000000000002', 'pa'),
    ('1ea0ace0-0000-0000-0000-000000000003', 'pb'),
    ('1ea0ace0-0000-0000-0000-000000000004', 'pc'),
    ('1ea0ace0-0000-0000-0000-000000000005', 'co'),
    ('1ea0ace0-0000-0000-0000-000000000006', 'lr'),
    ('1ea0ace0-0000-0000-0000-000000000007', 'rl'),
    ('1ea0ace0-0000-0000-0000-000000000008', 'oa'),
    ('1ea0ace0-0000-0000-0000-000000000009', 'ob'),
    ('1ea0ace0-0000-0000-0000-00000000000a', 'rcv'),
    ('1ea0ace0-0000-0000-0000-00000000000b', 'oc'),
    ('1ea0ace0-0000-0000-0000-00000000000c', 'sa'),
    ('1ea0ace0-0000-0000-0000-00000000000d', 'sb'),
    ('1ea0ace0-0000-0000-0000-00000000000e', 'sc'),
    ('1ea0ace0-0000-0000-0000-00000000000f', 'sd'),
    ('1ea0ace0-0000-0000-0000-000000000010', 'ua'),
    ('1ea0ace0-0000-0000-0000-000000000011', 'ub'),
    ('1ea0ace0-0000-0000-0000-000000000012', 'uf'),
    ('1ea0ace0-0000-0000-0000-000000000013', 'ug')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@leaverace.test';

insert into public.organizations (slug, name, timezone, short_code)
values ('leaverace-a', 'Leave Race A', 'Asia/Ho_Chi_Minh', 'LRA');
insert into ctx select 'org', id::text from public.organizations where slug = 'leaverace-a';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org')::bigint, pg_temp.c(x)::uuid,
       case when x = 'adm' then 'owner' else 'member' end, upper(x) || 'Q'
  from unnest(array['adm', 'pa', 'pb', 'pc', 'co', 'lr', 'rl', 'oa', 'ob', 'rcv', 'oc',
                    'sa', 'sb', 'sc', 'sd', 'ua', 'ub', 'uf', 'ug']) as x;

-- Everybody but the owner and RCV eats every weekday by rule.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c('org')::bigint, pg_temp.c(w)::uuid, d, true
  from unnest(array['pa', 'pb', 'pc', 'co', 'lr', 'rl', 'oa', 'ob', 'oc']) as w,
       generate_series(1, 7) as d;

-- One week three weeks out. `base` is published now, so everybody has an
-- open meal on it; p1 to p3 are published during the races.
do $$
declare v_t date; v_mon date;
begin
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  v_mon := v_t - (extract(isodow from v_t)::int - 1) + 21;
  insert into ctx values
    ('base', v_mon::text), ('p1', (v_mon + 1)::text), ('p2', (v_mon + 2)::text),
    ('p3', (v_mon + 3)::text);
end $$;

do $$
declare
  v_org bigint := pg_temp.c('org')::bigint;
  v_day date := pg_temp.c('base')::date;
  v_claims text := format('{"sub":"%s","role":"authenticated"}', pg_temp.c('adm'));
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', v_claims, true);
  perform * from public.publish_menu(v_org, v_day, now() + interval '10 days',
    '[{"name": "Bun", "price_minor": 40000}, {"name": "Pho", "price_minor": 50000}]'::jsonb,
    'raw', '{}');
end $$;
reset role;

-- Everybody on base has Bun, chosen by themselves, so no 0 meal is billed.
update public.order_items oi set menu_item_id = (select mi.id from public.menu_items mi
                                                   where mi.menu_id = pg_temp.m('base') and mi.name = 'Bun')
 where oi.menu_id = pg_temp.m('base');
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id and mi.name = 'Bun'
 where o.menu_id = pg_temp.m('base')
   and not exists (select 1 from public.order_items x where x.order_id = o.id);

-- OA, OB and OC offer their meal on base to RCV, still waiting.
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
select pg_temp.c('org')::bigint, pg_temp.oid('base', w), pg_temp.c(w)::uuid,
       pg_temp.c('rcv')::uuid, pg_temp.c(w)::uuid
  from unnest(array['oa', 'ob', 'oc']) as w;

insert into probe values
  ('control: everybody with a rule has Bun on base',
   (select count(*)::text from public.orders o join public.order_items oi on oi.order_id = o.id
     where o.menu_id = pg_temp.m('base') and o.status = 'placed'), '9'),
  ('control: three offers wait',
   (select count(*)::text from public.meal_transfers t
     where t.org_id = pg_temp.c('org')::bigint and t.status = 'pending'), '3');

---------------------------------------- R1 a publish in flight, then PA leaves

select pg_temp.open('a', 'adm');
insert into probe values ('R1 the owner publishes p1', pg_temp.run('a', pg_temp.publish_sql('p1')), 'ok');
select pg_temp.open('b', 'pa');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R1 leaving waits for the publish', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 the publish commits', pg_temp.close('a'), 'ok');
insert into probe values ('R1 then PA leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R1 the meal the publish ordered for PA is cancelled with the rest',
   pg_temp.ord('p1', 'pa') || ' | ' || pg_temp.ord('base', 'pa'), 'cancelled Bun@40000 | cancelled Bun@40000'),
  ('R1 and the others on p1 keep theirs', pg_temp.ord('p1', 'pb'), 'placed Bun@40000');

---------------------------------------- R2 PB leaves, then a publish

select pg_temp.open('a', 'pb');
insert into probe values ('R2 PB leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.publish_sql('p2'));
insert into probe values ('R2 the publish waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R2 then p2 is published', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R2 p2 orders nothing for PB, and for PC as usual',
   pg_temp.ord('p2', 'pb') || ' | ' || pg_temp.ord('p2', 'pc'), 'none | placed Bun@40000');

---------------------------------------- R3 PC is removed, then a publish

select pg_temp.open('a', 'adm');
insert into probe values ('R3 the owner removes PC', pg_temp.run('a', pg_temp.remove_sql('pc')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.publish_sql('p3'));
insert into probe values ('R3 the publish waits for the removal', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3 the removal commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3 then p3 is published', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R3 p3 orders nothing for PC, whose open meals are cancelled',
   pg_temp.ord('p3', 'pc') || ' | ' || pg_temp.ord('p1', 'pc') || ' | ' || pg_temp.ord('p2', 'pc'),
   'none | cancelled Bun@40000 | cancelled Bun@40000');

---------------------------------- R4 a correction of CO's meal, then CO leaves

-- The correction creates the week's period and bills it, so CO owes for base
-- and p1 to p3 while it holds the week; leaving then takes them all off.
select pg_temp.open('a', 'adm');
insert into probe values ('R4 the owner changes CO''s base to Pho',
  pg_temp.run('a', format('select order_id::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('base'), pg_temp.c('co'),
    (select mi.id from public.menu_items mi where mi.menu_id = pg_temp.m('base') and mi.name = 'Pho'))), 'ok');
select pg_temp.open('b', 'co');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R4 leaving waits for the correction', pg_temp.busy('b'), 'waiting');
insert into probe values ('R4 the correction commits', pg_temp.close('a'), 'ok');
insert into probe values ('R4 then CO leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R4 CO''s corrected meal is cancelled too', pg_temp.ord('base', 'co'), 'cancelled Pho@50000'),
  ('R4 CO is charged nothing', pg_temp.charged('co'), '0'),
  ('R4 every statement is the sum of its lines', pg_temp.off_sum(), 'none');

------------------------------------ R5 LR leaves while the owner removes LR

select pg_temp.open('a', 'lr');
insert into probe values ('R5 LR leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.remove_sql('lr'));
insert into probe values ('R5 the removal waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R5 then the removal finds LR gone, without a deadlock', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R5 LR left rather than was removed, and the open meal is cancelled',
   (select status || ' ' || (removed_at is null)::text from public.memberships
     where org_id = pg_temp.c('org')::bigint and profile_id = pg_temp.c('lr')::uuid)
   || ' | ' || pg_temp.ord('base', 'lr'), 'inactive true | cancelled Bun@40000');

------------------------------------ R6 the owner removes RL while RL leaves

select pg_temp.open('a', 'adm');
insert into probe values ('R6 the owner removes RL', pg_temp.run('a', pg_temp.remove_sql('rl')), 'ok');
select pg_temp.open('b', 'rl');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R6 leaving waits for the removal', pg_temp.busy('b'), 'waiting');
insert into probe values ('R6 the removal commits', pg_temp.close('a'), 'ok');
insert into probe values ('R6 then RL is told they are no longer a member', pg_temp.finish('b'),
  'you are not a member of that office');
insert into probe values
  ('R6 RL was removed, and the open meal is cancelled',
   (select status || ' ' || (removed_at is not null)::text from public.memberships
     where org_id = pg_temp.c('org')::bigint and profile_id = pg_temp.c('rl')::uuid)
   || ' | ' || pg_temp.ord('base', 'rl'), 'inactive true | cancelled Bun@40000');

--------------------------- R7 RCV accepts OA's offer, then OA leaves

select pg_temp.open('a', 'rcv');
insert into probe values ('R7 RCV accepts OA''s base', pg_temp.run('a', format(
  $q$update public.meal_transfers set status = 'accepted' where order_id = %s returning 1::text$q$,
  pg_temp.oid('base', 'oa'))), 'ok');
select pg_temp.open('b', 'oa');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R7 leaving waits for the answer', pg_temp.busy('b'), 'waiting');
insert into probe values ('R7 the answer commits', pg_temp.close('a'), 'ok');
insert into probe values ('R7 then OA leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R7 the meal RCV accepted stays, on RCV''s bill',
   pg_temp.ord('base', 'oa') || ' | ' || pg_temp.charged('rcv'), 'placed Bun@40000 | 40000'),
  ('R7 OA''s other open meals are cancelled',
   pg_temp.ord('p1', 'oa') || ' | ' || pg_temp.ord('p3', 'oa'), 'cancelled Bun@40000 | cancelled Bun@40000');

--------------------------- R8 OB leaves, then RCV accepts OB's offer

select pg_temp.open('a', 'ob');
insert into probe values ('R8 OB leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'rcv');
select pg_temp.send('b', format(
  $q$update public.meal_transfers set status = 'accepted' where order_id = %s returning 1::text$q$,
  pg_temp.oid('base', 'ob')));
insert into probe values ('R8 the answer waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R8 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R8 then the accept is refused', pg_temp.finish('b'),
  'the lunch on ' || to_char(pg_temp.c('base')::date, 'DD/MM')
  || ' offered to you was cancelled, so there is no meal to accept');
insert into probe values
  ('R8 OB''s meal is cancelled and its offer withdrawn',
   pg_temp.ord('base', 'ob') || ' | '
   || (select t.status from public.meal_transfers t where t.order_id = pg_temp.oid('base', 'ob')),
   'cancelled Bun@40000 | cancelled'),
  ('R8 RCV pays only for OA''s meal', pg_temp.charged('rcv'), '40000');

------------------- R9 RCV is answering OC's offer when OC leaves

-- RCV holds the pass, as an accept does before it reaches the week. Leaving
-- waits for it rather than cancel the meal under an accept already checked.
select pg_temp.open('a', 'rcv');
insert into probe values ('R9 RCV holds the offer on OC''s base', pg_temp.run('a', format(
  'select id::text from public.meal_transfers where order_id = %s for no key update',
  pg_temp.oid('base', 'oc'))), 'ok');
select pg_temp.open('b', 'oc');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R9 leaving waits for the offer', pg_temp.busy('b'), 'waiting');
insert into probe values ('R9 RCV accepts', pg_temp.run('a', format(
  $q$update public.meal_transfers set status = 'accepted' where order_id = %s returning 1::text$q$,
  pg_temp.oid('base', 'oc'))), 'ok');
insert into probe values ('R9 the answer commits', pg_temp.close('a'), 'ok');
insert into probe values ('R9 then OC leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R9 the meal RCV accepted stays, on RCV''s bill, and OC''s others go',
   pg_temp.ord('base', 'oc') || ' | ' || pg_temp.charged('rcv') || ' | ' || pg_temp.ord('p1', 'oc'),
   'placed Bun@40000 | 80000 | cancelled Bun@40000');

insert into probe values
  ('R8 every statement is still the sum of its lines', pg_temp.off_sum(), 'none'),
  ('R8 nobody who went is charged',
   (select coalesce(string_agg(m.short_code, ','), 'none') from public.billing_lines bl
      join public.memberships m on m.org_id = bl.org_id and m.profile_id = bl.payer_profile_id
     where bl.org_id = pg_temp.c('org')::bigint and m.status = 'inactive'), 'none');

------------------ R10 to R13 an order placed for somebody while they leave

-- SA, SB, SC and SD have no rule, so nothing orders for them unless asked.
create function pg_temp.choose_sql() returns text
language sql stable as $fn$
  select format('select order_id::text from public.set_my_order(%s, %s)', pg_temp.m('p2'),
                (select mi.id from public.menu_items mi where mi.menu_id = pg_temp.m('p2')));
$fn$;

create function pg_temp.correct_sql(p_who text) returns text
language sql stable as $fn$
  select format('select order_id::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
                pg_temp.c('org'), pg_temp.c('p2'), pg_temp.c(p_who),
                (select mi.id from public.menu_items mi where mi.menu_id = pg_temp.m('p2')));
$fn$;

-- R10: SA orders on a second device, and leaves on the first before it commits.
select pg_temp.open('a', 'sa');
insert into probe values ('R10 SA orders p2', pg_temp.run('a', pg_temp.choose_sql()), 'ok');
select pg_temp.open('b', 'sa');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R10 leaving waits for the order', pg_temp.busy('b'), 'waiting');
insert into probe values ('R10 the order commits', pg_temp.close('a'), 'ok');
insert into probe values ('R10 then SA leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R10 the order is cancelled with the rest, and charged to nobody',
   pg_temp.ord('p2', 'sa') || ' | ' || pg_temp.charged('sa'), 'cancelled Bun@40000 | 0');

-- R11: SB leaves, and orders on another device before it commits.
select pg_temp.open('a', 'sb');
insert into probe values ('R11 SB leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'sb');
select pg_temp.send('b', pg_temp.choose_sql());
insert into probe values ('R11 the order waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R11 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R11 then the order is refused', pg_temp.finish('b'),
  'you are not a member of that office');
insert into probe values ('R11 SB has no order', pg_temp.ord('p2', 'sb'), 'none');

-- R12: the owner records a meal for SC, and SC leaves before it commits.
select pg_temp.open('a', 'adm');
insert into probe values ('R12 the owner records p2 for SC', pg_temp.run('a', pg_temp.correct_sql('sc')), 'ok');
select pg_temp.open('b', 'sc');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R12 leaving waits for the record', pg_temp.busy('b'), 'waiting');
insert into probe values ('R12 the record commits', pg_temp.close('a'), 'ok');
insert into probe values ('R12 then SC leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R12 the meal recorded is cancelled, and charged to nobody',
   pg_temp.ord('p2', 'sc') || ' | ' || pg_temp.charged('sc'), 'cancelled Bun@40000 | 0');

-- R13: SD leaves, and the owner records a meal for SD before it commits.
select pg_temp.open('a', 'sd');
insert into probe values ('R13 SD leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.correct_sql('sd'));
insert into probe values ('R13 the record waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R13 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R13 then the record is refused', pg_temp.finish('b'),
  'sd is no longer in this office, so no lunch can be recorded for them on '
  || to_char(pg_temp.c('p2')::date, 'DD/MM'));
insert into probe values
  ('R13 SD has no order', pg_temp.ord('p2', 'sd'), 'none'),
  ('R13 every statement is still the sum of its lines', pg_temp.off_sum(), 'none');

------------------------------ R14, R15 an undo of a pass while its giver leaves

-- UA, UB, UF and UG each had p3, open, recorded as RCV's.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select pg_temp.c('org')::bigint, pg_temp.m('p3'), pg_temp.c('p3')::date, pg_temp.c(w)::uuid,
       'member', pg_temp.c(w)::uuid
  from unnest(array['ua', 'ub', 'uf', 'ug']) as w;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.id in (pg_temp.oid('p3', 'ua'), pg_temp.oid('p3', 'ub'),
                pg_temp.oid('p3', 'uf'), pg_temp.oid('p3', 'ug'));
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, status,
                                   created_by, decided_at, decided_by)
select pg_temp.c('org')::bigint, pg_temp.oid('p3', w), pg_temp.c(w)::uuid, pg_temp.c('rcv')::uuid,
       'accepted', pg_temp.c('adm')::uuid, now(), pg_temp.c('adm')::uuid
  from unnest(array['ua', 'ub', 'uf', 'ug']) as w;

create function pg_temp.undo_sql(p_who text) returns text
language sql stable as $fn$
  select format('select transfer_id::text from public.undo_pass(%s)',
                (select t.id from public.meal_transfers t where t.order_id = pg_temp.oid('p3', p_who)));
$fn$;

-- R14: the owner undoes UA's pass, and UA leaves before it commits.
select pg_temp.open('a', 'adm');
insert into probe values ('R14 the owner undoes UA''s pass', pg_temp.run('a', pg_temp.undo_sql('ua')), 'ok');
select pg_temp.open('b', 'ua');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R14 leaving waits for the undo', pg_temp.busy('b'), 'waiting');
insert into probe values ('R14 the undo commits', pg_temp.close('a'), 'ok');
insert into probe values ('R14 then UA leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R14 the meal back on UA is cancelled with the rest, and charged to nobody',
   pg_temp.ord('p3', 'ua') || ' | ' || pg_temp.charged('ua'), 'cancelled Bun@40000 | 0');

-- R15: UB leaves, and the owner undoes UB's pass before it commits.
select pg_temp.open('a', 'ub');
insert into probe values ('R15 UB leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.undo_sql('ub'));
insert into probe values ('R15 the undo waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R15 the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R15 then the undo is refused', pg_temp.finish('b'),
  'ub has left the office, so the meal cannot go back to them on '
  || to_char(pg_temp.c('p3')::date, 'DD/MM'));
insert into probe values
  ('R15 the meal stays RCV''s, and UB is charged nothing',
   pg_temp.ord('p3', 'ub') || ' | '
   || (select t.status from public.meal_transfers t where t.order_id = pg_temp.oid('p3', 'ub'))
   || ' | ' || pg_temp.charged('ub'), 'placed Bun@40000 | accepted | 0'),
  ('R15 every statement is still the sum of its lines', pg_temp.off_sum(), 'none');

------------------- R16 leaving and an undo queued on the giver's membership

-- A third session holds the giver's row, so both arrive while neither has
-- started, and the queue order decides. An undo that held the giver only after
-- its week and order would deadlock here with leaving, which holds the row and
-- then wants the week.
create function pg_temp.hold_sql(p_who text) returns text
language sql stable as $fn$
  select format('select id::text from public.memberships where org_id = %s and profile_id = %L for update',
                pg_temp.c('org'), pg_temp.c(p_who));
$fn$;

-- R16a: leaving first, then the undo.
select pg_temp.open('c', null);
insert into probe values ('R16a a third session holds UF''s row', pg_temp.run('c', pg_temp.hold_sql('uf')), 'ok');
select pg_temp.open('a', 'uf');
select pg_temp.send('a', pg_temp.leave_sql());
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.undo_sql('uf'));
insert into probe values ('R16a both wait', pg_temp.busy('a') || ' ' || pg_temp.busy('b'), 'waiting waiting');
insert into probe values ('R16a the third session commits', pg_temp.close('c'), 'ok');
insert into probe values ('R16a UF leaves', pg_temp.finish('a'), 'ok');
insert into probe values ('R16a then the undo is refused, without a deadlock', pg_temp.finish('b'),
  'uf has left the office, so the meal cannot go back to them on '
  || to_char(pg_temp.c('p3')::date, 'DD/MM'));
insert into probe values
  ('R16a the meal stays RCV''s, and UF is charged nothing',
   pg_temp.ord('p3', 'uf') || ' | '
   || (select t.status from public.meal_transfers t where t.order_id = pg_temp.oid('p3', 'uf'))
   || ' | ' || pg_temp.charged('uf'), 'placed Bun@40000 | accepted | 0'),
  ('R16a every statement is still the sum of its lines', pg_temp.off_sum(), 'none');

-- R16b: the undo first, then leaving.
select pg_temp.open('c', null);
insert into probe values ('R16b a third session holds UG''s row', pg_temp.run('c', pg_temp.hold_sql('ug')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.undo_sql('ug'));
select pg_temp.open('a', 'ug');
select pg_temp.send('a', pg_temp.leave_sql());
insert into probe values ('R16b both wait', pg_temp.busy('b') || ' ' || pg_temp.busy('a'), 'waiting waiting');
insert into probe values ('R16b the third session commits', pg_temp.close('c'), 'ok');
insert into probe values ('R16b the undo goes through', pg_temp.finish('b'), 'ok');
insert into probe values ('R16b then UG leaves', pg_temp.finish('a'), 'ok');
insert into probe values
  ('R16b the meal back on UG is cancelled, and charged to nobody',
   pg_temp.ord('p3', 'ug') || ' | '
   || (select t.status from public.meal_transfers t where t.order_id = pg_temp.oid('p3', 'ug'))
   || ' | ' || pg_temp.charged('ug'), 'cancelled Bun@40000 | undone | 0'),
  ('R16b every statement is still the sum of its lines', pg_temp.off_sum(), 'none');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint := pg_temp.c('org')::bigint;
begin
  delete from public.notification_outbox where org_id = v_org;
  delete from public.order_corrections   where org_id = v_org;
  delete from public.billing_statements  where org_id = v_org;
  delete from public.billing_lines       where org_id = v_org;
  delete from public.billing_periods     where org_id = v_org;
  delete from public.meal_transfers      where org_id = v_org;
  delete from public.order_items         where org_id = v_org;
  delete from public.orders              where org_id = v_org;
  delete from public.menu_items          where org_id = v_org;
  delete from public.menus               where org_id = v_org;
  delete from public.standing_orders     where org_id = v_org;
  delete from public.memberships         where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@leaverace.test';
