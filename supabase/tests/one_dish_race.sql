-- Two sessions at once on a one-dish menu: a dish added while a member
-- chooses the one dish, and a publish while a weekday rule is turned on.
-- Run against a LOCAL scratch database only:
--   psql "$DATABASE_URL" -f supabase/tests/one_dish_race.sql
--
-- Like atomic_writes_race.sql, this COMMITS its fixtures, because the racing
-- sessions are dblink connections back into the same database, and removes
-- them at the end. Session A takes its locks and stops, B is sent its
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

create function pg_temp.m(p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c('org_a')::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.dish(p_day text, p_name text) returns bigint
language sql stable as $fn$
  select id from public.menu_items where menu_id = pg_temp.m(p_day) and name = p_name;
$fn$;

-- `source status dish@price`, with `*` after a line the system wrote.
create function pg_temp.order_of(p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((
    select o.source || ' ' || o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot || '@' || oi.unit_price_minor
                                          || case when oi.auto_assigned then '*' else '' end, ',')
                          from public.order_items oi where oi.order_id = o.id), '-')
      from public.orders o
     where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid),
    'none');
$fn$;

create function pg_temp.asked(p_day text) returns text
language sql stable as $fn$
  select coalesce(string_agg(ms.short_code, ',' order by ms.short_code), '-')
    from public.notification_outbox n
    join public.memberships ms
      on ms.org_id = n.org_id and ms.profile_id = n.recipient_profile_id
   where n.kind = 'dish_choice' and n.related_menu_id = pg_temp.m(p_day);
$fn$;

-- publish_menu as sent over dblink, with every dish new but the one named.
create function pg_temp.publish_sql(p_day text, p_keep text, p_new text[]) returns text
language sql stable as $fn$
  select format(
    'select menu_id::text from public.publish_menu(%s, %L::date, %L::timestamptz, %L::jsonb, %L, %L::jsonb)',
    pg_temp.c('org_a'), pg_temp.c(p_day), now() + interval '9 days',
    coalesce((select jsonb_agg(jsonb_build_object('id', mi.id, 'name', mi.name,
                                                  'price_minor', mi.price_minor))
                from public.menu_items mi
               where mi.menu_id = pg_temp.m(p_day) and mi.name = p_keep), '[]'::jsonb)
      || (select jsonb_agg(jsonb_build_object('name', d, 'price_minor', 40000))
            from unnest(p_new) as d),
    'raw', '{}');
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.code || '@onerace.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.code)
  from (values
    ('0dace000-0000-0000-0000-000000000001', 'adm'),
    ('0dace000-0000-0000-0000-000000000002', 'teo'),
    ('0dace000-0000-0000-0000-000000000003', 'hoa'),
    ('0dace000-0000-0000-0000-000000000004', 'kim')
  ) as u(id, code)
on conflict (id) do nothing;

insert into ctx
select split_part(email, '@', 1), id::text from auth.users where email like '%@onerace.test';

insert into public.organizations (slug, name, short_code) values ('onerace-a', 'One Race A', 'ORA');
insert into ctx select 'org_a', id::text from public.organizations where slug = 'onerace-a';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org_a')::bigint, pg_temp.c(x)::uuid,
       case when x = 'adm' then 'owner' else 'member' end, upper(x)
  from unnest(array['adm', 'teo', 'hoa', 'kim']) as x;

insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select ms.id, ms.org_id, 990000 + ms.id, now() from public.memberships ms
 where ms.org_id = pg_temp.c('org_a')::bigint;

-- TEO and HOA eat every weekday; KIM turns hers on during a publish.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c('org_a')::bigint, pg_temp.c(w)::uuid, d, true
  from unnest(array['teo', 'hoa']) as w, generate_series(1, 7) as d;

insert into ctx
select k, (private.today_in(o.timezone) + n)::text
  from public.organizations o
  cross join (values ('g1', 14), ('g2', 15), ('p1', 16), ('p2', 17),
                     ('x1', 18), ('x2', 19), ('x3', 20)) as d(k, n)
 where o.slug = 'onerace-a';

-- g1, g2, x1 and x3 are out with one dish, so TEO and HOA have it from the
-- system; x2 has two. Each x day has its billing week, as a correction needs.
do $$
declare d text;
begin
  foreach d in array array['g1', 'g2', 'x1', 'x2', 'x3'] loop
    insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
    values (pg_temp.c('org_a')::bigint, pg_temp.c(d)::date, now() + interval '9 days',
            pg_temp.c('adm')::uuid);
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (pg_temp.m(d), pg_temp.c('org_a')::bigint, 'Com ga', 45000, 0);
    if d = 'x2' then
      insert into public.menu_items (menu_id, org_id, name, price_minor, position)
      values (pg_temp.m(d), pg_temp.c('org_a')::bigint, 'Pho', 50000, 1);
    end if;
    update public.menus set status = 'published' where id = pg_temp.m(d);
    if d like 'x%' then
      perform public.ensure_billing_period(pg_temp.c('org_a')::bigint, pg_temp.c(d)::date);
    end if;
  end loop;
  -- An undecided slot in x3's week is a 0 meal, and billing a 0 meal with no
  -- payment trips billing_statements_paid_ck in private.reallocate, which is
  -- not what these races are about. So nobody else eats in that week.
  update public.orders set status = 'cancelled', cancelled_at = now()
   where menu_id in (pg_temp.m('x2'), pg_temp.m('x3'));
end $$;

insert into probe values
  ('control: g1 starts with the system''s line',
   pg_temp.order_of('g1', 'teo') || ' / ' || pg_temp.order_of('g1', 'hoa'),
   'standing placed Com ga@45000* / standing placed Com ga@45000*');

------------------------------------ G a dish added while TEO chooses the one

-- g1: TEO's choice holds the menu; the new dish waits for it.
select pg_temp.open('a', 'teo');
insert into probe values ('G1 TEO chooses Com ga himself',
  pg_temp.run('a', format('select order_id::text from public.set_my_order(%s, %s)',
                          pg_temp.m('g1'), pg_temp.dish('g1', 'Com ga'))), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.publish_sql('g1', 'Com ga', array['Pho']));
insert into probe values ('G1 the new dish waits for the choice', pg_temp.busy('b'), 'waiting');
insert into probe values ('G1 the choice commits', pg_temp.close('a'), 'ok');
insert into probe values ('G1 then the dish is added', pg_temp.finish('b'), 'ok');
insert into probe values
  ('G1 TEO keeps his choice', pg_temp.order_of('g1', 'teo'), 'standing placed Com ga@45000'),
  ('G1 HOA is undecided again', pg_temp.order_of('g1', 'hoa'), 'standing placed -'),
  ('G1 and only HOA is asked', pg_temp.asked('g1'), 'HOA');

-- g2: the new dish holds the menu; TEO's choice waits and lands on two dishes.
select pg_temp.open('a', 'adm');
insert into probe values ('G2 a dish is added',
  pg_temp.run('a', pg_temp.publish_sql('g2', 'Com ga', array['Pho'])), 'ok');
select pg_temp.open('b', 'teo');
select pg_temp.send('b', format('select order_id::text from public.set_my_order(%s, %s)',
                                pg_temp.m('g2'), pg_temp.dish('g2', 'Com ga')));
insert into probe values ('G2 the choice waits for the dish', pg_temp.busy('b'), 'waiting');
insert into probe values ('G2 the dish commits', pg_temp.close('a'), 'ok');
insert into probe values ('G2 then the choice is made', pg_temp.finish('b'), 'ok');
insert into probe values
  ('G2 TEO has what he chose', pg_temp.order_of('g2', 'teo'), 'standing placed Com ga@45000'),
  ('G2 HOA is undecided again', pg_temp.order_of('g2', 'hoa'), 'standing placed -'),
  ('G2 both were asked, since both were put back', pg_temp.asked('g2'), 'HOA,TEO');

--------------------------------------- P a publish while KIM turns a rule on

create function pg_temp.rule_sql(p_day text) returns text
language sql stable as $fn$
  select format('insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
                 values (%s, %L, %s, true) returning 1::text',
                pg_temp.c('org_a'), pg_temp.c('kim'),
                extract(isodow from pg_temp.c(p_day)::date)::int);
$fn$;

-- p1: the publish first.
select pg_temp.open('a', 'adm');
insert into probe values ('P1 a one-dish publish',
  pg_temp.run('a', pg_temp.publish_sql('p1', null, array['Bun'])), 'ok');
select pg_temp.open('b', 'kim');
select pg_temp.send('b', pg_temp.rule_sql('p1'));
insert into probe values ('P1 the rule waits for the publish', pg_temp.busy('b'), 'waiting');
insert into probe values ('P1 the publish commits', pg_temp.close('a'), 'ok');
insert into probe values ('P1 then the rule is saved', pg_temp.finish('b'), 'ok');
insert into probe values
  ('P1 KIM''s slot has the dish', pg_temp.order_of('p1', 'kim'), 'standing placed Bun@40000*');

-- p2: the rule first.
select pg_temp.open('a', 'kim');
insert into probe values ('P2 the rule is turned on', pg_temp.run('a', pg_temp.rule_sql('p2')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.publish_sql('p2', null, array['Bun']));
insert into probe values ('P2 the publish waits for the rule', pg_temp.busy('b'), 'waiting');
insert into probe values ('P2 the rule commits', pg_temp.close('a'), 'ok');
insert into probe values ('P2 then the publish', pg_temp.finish('b'), 'ok');
insert into probe values
  ('P2 KIM''s slot has the dish', pg_temp.order_of('p2', 'kim'), 'standing placed Bun@40000*');

------------------------------------------ X corrections and the menu's lock

create function pg_temp.off_menu_sql(p_day text, p_dish text, p_who text default 'hoa')
returns text
language sql stable as $fn$
  select format($q$select order_id::text from public.correct_meal_off_menu(
                    %s, %L::date, %L::uuid, %L, 3000, 1::smallint, null, 'phone')$q$,
                pg_temp.c('org_a'), pg_temp.c(p_day), pg_temp.c(p_who), p_dish);
$fn$;

-- x1: TEO's choice holds the menu FOR SHARE and then wants the week, which a
-- record of a dish that was never on the menu holds while it adds the dish.
-- The lock is taken as the owner, as set_my_order takes it: a member's own
-- FOR SHARE would pass through RLS's update policy and lock nothing.
select pg_temp.open('a', null);
insert into probe values ('X1 TEO''s choice holds the menu',
  pg_temp.run('a', format('select id::text from public.menus where id = %s for share',
                          pg_temp.m('x1'))), 'ok');
select pg_temp.run('a', 'set local role authenticated');
select pg_temp.run('a', format(
  $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$, pg_temp.c('teo')));
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.off_menu_sql('x1', 'Bun rieu'));
insert into probe values ('X1 the off-menu record waits for the menu', pg_temp.busy('b'), 'waiting');
insert into probe values ('X1 then TEO chooses',
  pg_temp.run('a', format('select order_id::text from public.set_my_order(%s, %s)',
                          pg_temp.m('x1'), pg_temp.dish('x1', 'Com ga'))), 'ok');
insert into probe values ('X1 the choice commits', pg_temp.close('a'), 'ok');
insert into probe values ('X1 then the record is made', pg_temp.finish('b'), 'ok');
insert into probe values
  ('X1 TEO keeps his choice', pg_temp.order_of('x1', 'teo'), 'standing placed Com ga@45000'),
  ('X1 HOA has the record', pg_temp.order_of('x1', 'hoa'), 'standing placed Bun rieu@3000');

-- x3: pricing the week holds the menu and then wants the week.
select pg_temp.open('a', null);
insert into probe values ('X3 pricing holds the menu',
  pg_temp.run('a', format('select id::text from public.menus where id = %s for no key update',
                          pg_temp.m('x3'))), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.off_menu_sql('x3', 'Bun rieu', 'kim'));
insert into probe values ('X3 the off-menu record waits for the menu', pg_temp.busy('b'), 'waiting');
insert into probe values ('X3 then pricing takes the week',
  pg_temp.run('a', format('select private.assert_week_open(%s, %L::date)::text',
                          pg_temp.c('org_a'), pg_temp.c('x3'))), 'ok');
insert into probe values ('X3 pricing commits', pg_temp.close('a'), 'ok');
insert into probe values ('X3 then the record is made', pg_temp.finish('b'), 'ok');

-- x2: TEO's choice of Pho holds the menu; a direct delete of Pho would lock
-- the dish first and wait on the menu. A browser may not write dishes at all.
select pg_temp.open('a', null);
insert into probe values ('X2 TEO''s choice holds the menu',
  pg_temp.run('a', format('select id::text from public.menus where id = %s for share',
                          pg_temp.m('x2'))), 'ok');
select pg_temp.run('a', 'set local role authenticated');
select pg_temp.run('a', format(
  $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$, pg_temp.c('teo')));
select pg_temp.open('b', 'adm');
insert into probe values ('X2 an admin deleting the dish directly is refused',
  pg_temp.run('b', format('delete from public.menu_items where id = %s returning 1::text',
                          pg_temp.dish('x2', 'Pho'))),
  '42501 permission denied for table menu_items');
select pg_temp.close('b', false);
insert into probe values ('X2 TEO chooses Pho',
  pg_temp.run('a', format('select order_id::text from public.set_my_order(%s, %s)',
                          pg_temp.m('x2'), pg_temp.dish('x2', 'Pho'))), 'ok');
insert into probe values ('X2 the choice commits', pg_temp.close('a'), 'ok');
insert into probe values ('X2 TEO has Pho', pg_temp.order_of('x2', 'teo'), 'standing placed Pho@50000');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint := pg_temp.c('org_a')::bigint;
begin
  delete from public.notification_outbox where org_id = v_org;
  delete from public.order_corrections   where org_id = v_org;
  delete from public.billing_statements  where org_id = v_org;
  delete from public.billing_lines       where org_id = v_org;
  delete from public.billing_periods     where org_id = v_org;
  delete from public.order_items         where org_id = v_org;
  delete from public.orders              where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@onerace.test';
