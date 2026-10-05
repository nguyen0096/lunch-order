-- Two sessions at once around an office being deleted: a member's order and
-- an admin's record of a meal, each in flight when the owner deletes, and a
-- member ordering, or an admin recording a meal on a day ahead or a day past,
-- while the deletion is in flight.
-- Run against a LOCAL scratch database only, as a superuser over TCP:
--   docker exec -i <db container> psql -h 127.0.0.1 -U supabase_admin -d postgres \
--     -f - < supabase/tests/deleting_an_office_race.sql
--
-- COMMITS its fixtures, because the racing sessions are dblink connections
-- back into the same database, and removes them at the end. Every session has
-- lock_timeout and statement_timeout, so a regression shows up as a timeout
-- or a deadlock (40P01) in an answer.
--
-- Negative control: with 20261025100200 reverted, R1 and R2 fail (the order
-- stays placed in the deleted office), and the deletion no longer waits; with
-- only its `correction_period` reverted, R4 and R5 record a meal, and bill it,
-- in an office already deleted.
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

create function pg_temp.m(p_org text) returns bigint
language sql stable as $fn$
  select id from public.menus where org_id = pg_temp.c(p_org)::bigint;
$fn$;

-- Somebody's order on the office's one day, or `none`.
create function pg_temp.ord(p_org text, p_who text) returns text
language sql stable as $fn$
  select coalesce((select o.status from public.orders o
                    where o.menu_id = pg_temp.m(p_org) and o.profile_id = pg_temp.c(p_who)::uuid), 'none');
$fn$;

create function pg_temp.choose_sql(p_org text) returns text
language sql stable as $fn$
  select format('select order_id::text from public.set_my_order(%s, %s)', pg_temp.m(p_org),
                (select mi.id from public.menu_items mi where mi.menu_id = pg_temp.m(p_org)));
$fn$;

create function pg_temp.correct_sql(p_org text, p_who text) returns text
language sql stable as $fn$
  select format('select order_id::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
                pg_temp.c(p_org), pg_temp.c('day'), pg_temp.c(p_who),
                (select mi.id from public.menu_items mi where mi.menu_id = pg_temp.m(p_org)));
$fn$;

create function pg_temp.delete_sql(p_org text) returns text
language sql stable as $fn$
  select format('select public.delete_office(%s)::text', pg_temp.c(p_org));
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@delrace.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1edace00-0000-0000-0000-000000000001', 'own'),
    ('1edace00-0000-0000-0000-000000000002', 'mem'),
    ('1edace00-0000-0000-0000-000000000003', 'adm')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@delrace.test';

-- Five offices with the same people: one per race.
insert into public.organizations (slug, name, timezone, short_code)
select 'delrace-' || x, 'Del Race ' || x, 'Asia/Ho_Chi_Minh', 'DR' || upper(x)
  from unnest(array['a', 'b', 'c', 'd', 'e']) as x;
insert into ctx select 'org_' || right(slug, 1), id::text from public.organizations where slug like 'delrace-%';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org_' || o)::bigint, pg_temp.c(x)::uuid,
       case x when 'own' then 'owner' when 'adm' then 'admin' else 'member' end, upper(x) || 'Q'
  from unnest(array['a', 'b', 'c', 'd', 'e']) as o, unnest(array['own', 'mem', 'adm']) as x;

do $$
declare v_t date := private.today_in('Asia/Ho_Chi_Minh');
begin
  insert into ctx values ('day', (v_t + 21)::text), ('past', (v_t - 1)::text);
end $$;

insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
select pg_temp.c('org_' || o)::bigint, pg_temp.c('day')::date, now() + interval '10 days', pg_temp.c('own')::uuid
  from unnest(array['a', 'b', 'c', 'd', 'e']) as o;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select pg_temp.m('org_' || o), pg_temp.c('org_' || o)::bigint, 'Bun', 40000, 0
  from unnest(array['a', 'b', 'c', 'd', 'e']) as o;

-- E also has yesterday, served, which a deletion leaves alone.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
values (pg_temp.c('org_e')::bigint, pg_temp.c('past')::date, now() - interval '2 days', pg_temp.c('own')::uuid);
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select id, org_id, 'Bun', 40000, 0 from public.menus
 where org_id = pg_temp.c('org_e')::bigint and service_date = pg_temp.c('past')::date;

------------------------------------- R1 a member orders, then the office goes

select pg_temp.open('a', 'mem');
insert into probe values ('R1 MEM orders', pg_temp.run('a', pg_temp.choose_sql('org_a')), 'ok');
select pg_temp.open('b', 'own');
select pg_temp.send('b', pg_temp.delete_sql('org_a'));
insert into probe values ('R1 the deletion waits for the order', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 the order commits', pg_temp.close('a'), 'ok');
insert into probe values ('R1 then the office is deleted', pg_temp.finish('b'), 'ok');
insert into probe values ('R1 and the order is cancelled with the rest', pg_temp.ord('org_a', 'mem'), 'cancelled');

------------------------------------- R2 the office goes, then a member orders

select pg_temp.open('a', 'own');
insert into probe values ('R2 the owner deletes the office', pg_temp.run('a', pg_temp.delete_sql('org_b')), 'ok');
select pg_temp.open('b', 'mem');
select pg_temp.send('b', pg_temp.choose_sql('org_b'));
insert into probe values ('R2 the order waits for the deletion', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2 the deletion commits', pg_temp.close('a'), 'ok');
insert into probe values ('R2 then the order is refused', pg_temp.finish('b'), 'you are not a member of that office');
insert into probe values ('R2 and there is none', pg_temp.ord('org_b', 'mem'), 'none');

------------------------------- R3 an admin records a meal, then the office goes

select pg_temp.open('a', 'adm');
insert into probe values ('R3 the admin records MEM''s lunch', pg_temp.run('a', pg_temp.correct_sql('org_c', 'mem')), 'ok');
select pg_temp.open('b', 'own');
select pg_temp.send('b', pg_temp.delete_sql('org_c'));
insert into probe values ('R3 the deletion waits for the record', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3 the record commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3 then the office is deleted', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R3 the meal recorded is cancelled, and its week re-billed to nothing',
   pg_temp.ord('org_c', 'mem') || ' '
   || (select count(*)::text from public.billing_lines where org_id = pg_temp.c('org_c')::bigint), 'cancelled 0');

------------------------ R4 the office goes, then an admin records a day ahead

select pg_temp.open('a', 'own');
insert into probe values ('R4 the owner deletes the office', pg_temp.run('a', pg_temp.delete_sql('org_d')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.correct_sql('org_d', 'mem'));
insert into probe values ('R4 the record, past its admin check, waits for the deletion', pg_temp.busy('b'), 'waiting');
insert into probe values ('R4 the deletion commits', pg_temp.close('a'), 'ok');
insert into probe values ('R4 then the record is refused', pg_temp.finish('b'),
  'this office has been deleted, so nothing in it can be changed');
insert into probe values
  ('R4 nothing was recorded, billed or queued',
   pg_temp.ord('org_d', 'mem') || ' '
   || (select count(*)::text from public.billing_lines where org_id = pg_temp.c('org_d')::bigint) || ' '
   || (select count(*)::text from public.notification_outbox where org_id = pg_temp.c('org_d')::bigint),
   'none 0 0');

------------------------- R5 the office goes, then an admin records a day past

create function pg_temp.correct_past_sql(p_org text, p_who text) returns text
language sql stable as $fn$
  select format('select order_id::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
                pg_temp.c(p_org), pg_temp.c('past'), pg_temp.c(p_who),
                (select mi.id from public.menu_items mi
                   join public.menus m on m.id = mi.menu_id
                  where m.org_id = pg_temp.c(p_org)::bigint and m.service_date = pg_temp.c('past')::date));
$fn$;

select pg_temp.open('a', 'own');
insert into probe values ('R5 the owner deletes the office', pg_temp.run('a', pg_temp.delete_sql('org_e')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.correct_past_sql('org_e', 'mem'));
insert into probe values ('R5 the record of yesterday, a day the deletion does not hold, waits at the office',
  pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 the deletion commits', pg_temp.close('a'), 'ok');
insert into probe values ('R5 then the record is refused', pg_temp.finish('b'),
  'this office has been deleted, so nothing in it can be changed');
insert into probe values
  ('R5 nothing was recorded, billed or queued',
   (select count(*)::text from public.orders where org_id = pg_temp.c('org_e')::bigint) || ' '
   || (select count(*)::text from public.billing_lines where org_id = pg_temp.c('org_e')::bigint) || ' '
   || (select count(*)::text from public.notification_outbox where org_id = pg_temp.c('org_e')::bigint),
   '0 0 0');

insert into probe values
  ('all five offices are deleted',
   (select count(*)::text from public.organizations where slug like 'delrace-%' and deleted_at is not null), '5');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint;
begin
  for v_org in select id from public.organizations where slug like 'delrace-%' loop
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
    delete from public.memberships         where org_id = v_org;
    delete from public.organizations       where id     = v_org;
  end loop;
end $$;

delete from auth.users where email like '%@delrace.test';
