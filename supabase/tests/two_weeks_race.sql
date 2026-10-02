-- One statement touching two weeks, against a correction in the second.
-- Run against a LOCAL scratch database only, as a superuser over TCP (dblink):
--   psql "$DATABASE_URL" -f supabase/tests/two_weeks_race.sql
--
-- Like admin_orders_race.sql this COMMITS its fixtures, because the racing
-- sessions are dblink connections that cannot see an uncommitted row, and it
-- removes them at the end.
--
-- Only a hand-made API request writes such a statement: Dinh accepting two
-- offers in two weeks in one PATCH, or an admin cancelling lunch on two days
-- in two weeks in one PATCH. Each row's trigger used to take its own week's
-- key, so the statement re-billed the first week, holding its people, before
-- asking for the second week's key, which a correction there held while it
-- waited on those same people: a deadlock (40P01). G holds the second week's
-- key so the correction queues for it first, the order that deadlocked.

set statement_timeout = '120s';
set client_min_messages = warning;
set lock_timeout = '20s';

create extension if not exists dblink with schema extensions;

create temp table probe (label text, got text, want text);
create temp table ctx (k text primary key, v text);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

create function pg_temp.connect(p_conn text) returns void
language plpgsql as $fn$
begin
  perform extensions.dblink_connect(p_conn, format('host=%s port=%s dbname=%s user=%s',
    coalesce(host(inet_server_addr()), 'localhost'), inet_server_port(),
    current_database(), current_user));
  perform extensions.dblink_exec(p_conn, 'begin');
  perform extensions.dblink_exec(p_conn, $q$set local lock_timeout = '8s'$q$);
  perform extensions.dblink_exec(p_conn, $q$set local statement_timeout = '15s'$q$);
end $fn$;

create function pg_temp.open(p_conn text, p_who text) returns void
language plpgsql as $fn$
begin
  perform pg_temp.connect(p_conn);
  perform extensions.dblink_exec(p_conn, 'set local role authenticated');
  perform extensions.dblink_exec(p_conn, format(
    $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$, pg_temp.c(p_who)));
end $fn$;

create function pg_temp.hold_week(p_day text) returns text
language plpgsql as $fn$
begin
  perform pg_temp.connect('g');
  perform * from extensions.dblink('g', format(
    'select private.lock_office_week(%s, %L::date)::text', pg_temp.c('org'), pg_temp.c(p_day)))
    as t(x text);
  return 'ok';
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

-- A week's billing as it stands: lines on cancelled orders, and each
-- statement against its lines.
create function pg_temp.week_faults(p_day text) returns text
language sql stable as $fn$
  select (select count(*) from public.billing_lines bl
            join public.billing_periods bp on bp.id = bl.billing_period_id
            join public.orders o on o.id = bl.order_id
           where bp.org_id = pg_temp.c('org')::bigint
             and pg_temp.c(p_day)::date between bp.period_start and bp.period_end
             and o.status <> 'placed') || ' lines on cancelled orders, '
      || coalesce((select string_agg(m.short_code || ' ' || st.meals_minor
                                     || case when st.meals_minor = (select coalesce(sum(bl.amount_minor), 0)
                                                                      from public.billing_lines bl
                                                                     where bl.billing_period_id = st.billing_period_id
                                                                       and bl.payer_profile_id = st.profile_id)
                                             then '' else ' NOT THE SUM' end, ', ' order by m.short_code)
                     from public.billing_statements st
                     join public.billing_periods bp on bp.id = st.billing_period_id
                     join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
                    where bp.org_id = pg_temp.c('org')::bigint
                      and pg_temp.c(p_day)::date between bp.period_start and bp.period_end), 'no statements');
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('a0f00000-0000-0000-0000-000000000001', 'adm@twowk.test',  'Admin An'),
    ('a0f00000-0000-0000-0000-000000000002', 'adm2@twowk.test', 'Quan Hai'),
    ('a0f00000-0000-0000-0000-000000000003', 'teo@twowk.test',  'Teo Van'),
    ('a0f00000-0000-0000-0000-000000000004', 'dinh@twowk.test', 'Dinh Thi'),
    ('a0f00000-0000-0000-0000-000000000005', 'vy@twowk.test',   'Vy Tran')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code) values ('twowk-a', 'Two weeks', 'TWK');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('a0f00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('a0f00000-0000-0000-0000-000000000002', 'admin',  'QUAN'),
  ('a0f00000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('a0f00000-0000-0000-0000-000000000004', 'member', 'DINH'),
  ('a0f00000-0000-0000-0000-000000000005', 'member', 'VY')
) as u(pid, role, code) on o.slug = 'twowk-a';

insert into ctx
select 'org', id::text from public.organizations where slug = 'twowk-a' union all
select 'adm',  'a0f00000-0000-0000-0000-000000000001' union all
select 'adm2', 'a0f00000-0000-0000-0000-000000000002' union all
select 'teo',  'a0f00000-0000-0000-0000-000000000003' union all
select 'dinh', 'a0f00000-0000-0000-0000-000000000004' union all
select 'vy',   'a0f00000-0000-0000-0000-000000000005';

-- Weeks A and B, four and five weeks out (the office's weeks start on
-- Monday). T1 passes Teo's Tuesday in each week to Dinh; T2 cancels each
-- Thursday. The corrections are Vy's, on another day of week B.
insert into ctx
select k, (private.today_in('Asia/Ho_Chi_Minh')
           - (extract(isodow from private.today_in('Asia/Ho_Chi_Minh'))::int - 1) + n)::text
  from (values ('a2', 29), ('a4', 31), ('b2', 36), ('b3', 37), ('b4', 38), ('b5', 39)) as d(k, n);
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
select pg_temp.c('org')::bigint, pg_temp.c(k)::date, 'published', now() + interval '20 days',
       pg_temp.c('adm')::uuid, now()
  from unnest(array['a2', 'a4', 'b2', 'b3', 'b4', 'b5']) k;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Pho', 40000, 0 from public.menus m where m.org_id = pg_temp.c('org')::bigint;
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c('teo')::uuid, 'member', pg_temp.c('teo')::uuid
  from public.menus m
 where m.org_id = pg_temp.c('org')::bigint
   and m.service_date in (pg_temp.c('a2')::date, pg_temp.c('a4')::date,
                          pg_temp.c('b2')::date, pg_temp.c('b4')::date);
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint;
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
select o.org_id, o.id, o.profile_id, pg_temp.c('dinh')::uuid, o.profile_id
  from public.orders o
 where o.org_id = pg_temp.c('org')::bigint
   and o.service_date in (pg_temp.c('a2')::date, pg_temp.c('b2')::date)
 order by o.service_date;

insert into ctx
select 'm_' || k, m.id::text from unnest(array['a2', 'a4', 'b2', 'b3', 'b4', 'b5']) k
  join public.menus m on m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c(k)::date;
insert into ctx
select 'pho_' || k, mi.id::text from unnest(array['b3', 'b5']) k
  join public.menu_items mi on mi.menu_id = pg_temp.c('m_' || k)::bigint;
insert into ctx
select 't_' || k, t.id::text from unnest(array['a2', 'b2']) k
  join public.orders o on o.menu_id = pg_temp.c('m_' || k)::bigint
  join public.meal_transfers t on t.order_id = o.id;

select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c(k)::date)) is not null
  from unnest(array['a2', 'b2']) k;

------------------------------------- T1 accepting offers in two weeks at once

insert into probe values ('T1 G holds week B', pg_temp.hold_week('b2'), 'ok');
select pg_temp.open('c', 'adm2');
select pg_temp.send('c', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
  pg_temp.c('org'), pg_temp.c('b3'), pg_temp.c('vy'), pg_temp.c('pho_b3')));
select pg_temp.open('s', 'dinh');
select pg_temp.send('s', format($q$update public.meal_transfers set status = 'accepted' where id in (%s, %s) returning 'x'$q$,
  pg_temp.c('t_a2'), pg_temp.c('t_b2')));
insert into probe values ('T1 the correction waits', pg_temp.busy('c'), 'waiting');
insert into probe values ('T1 Dinh''s two accepts wait', pg_temp.busy('s'), 'waiting');
insert into probe values ('T1 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('T1 the correction goes through', pg_temp.finish('c'), 'ok');
insert into probe values ('T1 and so do both accepts, no deadlock', pg_temp.finish('s'), 'ok');
insert into probe values
  ('T1 both meals on Dinh''s bill',
   (select string_agg(m.short_code, ',' order by bl.service_date)
      from public.billing_lines bl
      join public.memberships m on m.org_id = bl.org_id and m.profile_id = bl.payer_profile_id
     where bl.transfer_id in (pg_temp.c('t_a2')::bigint, pg_temp.c('t_b2')::bigint)), 'DINH,DINH'),
  ('T1 week A adds up', pg_temp.week_faults('a2'), '0 lines on cancelled orders, DINH 40000, TEO 40000'),
  ('T1 week B adds up', pg_temp.week_faults('b2'), '0 lines on cancelled orders, DINH 40000, TEO 40000, VY 40000');

------------------------------------ T2 cancelling lunch in two weeks at once

insert into probe values ('T2 G holds week B', pg_temp.hold_week('b2'), 'ok');
select pg_temp.open('c', 'adm2');
select pg_temp.send('c', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
  pg_temp.c('org'), pg_temp.c('b5'), pg_temp.c('vy'), pg_temp.c('pho_b5')));
select pg_temp.open('s', 'adm');
select pg_temp.send('s', format($q$update public.menus set status = 'cancelled' where id in (%s, %s) returning 'x'$q$,
  pg_temp.c('m_a4'), pg_temp.c('m_b4')));
insert into probe values ('T2 the correction waits', pg_temp.busy('c'), 'waiting');
insert into probe values ('T2 the cancel waits', pg_temp.busy('s'), 'waiting');
insert into probe values ('T2 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('T2 the correction goes through', pg_temp.finish('c'), 'ok');
insert into probe values ('T2 and so does the cancel, no deadlock', pg_temp.finish('s'), 'ok');
insert into probe values
  ('T2 both days cancelled',
   (select string_agg(o.status, ',' order by o.service_date) from public.orders o
     where o.menu_id in (pg_temp.c('m_a4')::bigint, pg_temp.c('m_b4')::bigint)), 'cancelled,cancelled'),
  ('T2 week A adds up', pg_temp.week_faults('a2'), '0 lines on cancelled orders, DINH 40000'),
  ('T2 week B adds up', pg_temp.week_faults('b2'), '0 lines on cancelled orders, DINH 40000, VY 80000');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint;
begin
  select id into v_org from public.organizations where slug = 'twowk-a';
  delete from public.order_corrections   where org_id = v_org;
  delete from public.billing_statements  where org_id = v_org;
  delete from public.billing_lines       where org_id = v_org;
  delete from public.billing_periods     where org_id = v_org;
  delete from public.notification_outbox where org_id = v_org;
  delete from public.meal_transfers      where org_id = v_org;
  delete from public.order_items         where org_id = v_org;
  delete from public.orders              where org_id = v_org;
  delete from public.menu_items          where org_id = v_org;
  delete from public.menus               where org_id = v_org;
  delete from public.memberships         where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@twowk.test';
