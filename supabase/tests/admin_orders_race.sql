-- Two sessions at once over the Orders screen's pass writes, and cancelling
-- lunch against a correction in the same week.
-- Run against a LOCAL scratch database only, as a superuser over TCP (dblink):
--   psql "$DATABASE_URL" -f supabase/tests/admin_orders_race.sql
--
-- Like atomic_writes_race.sql this COMMITS its fixtures, because the racing
-- sessions are dblink connections that cannot see an uncommitted row, and it
-- removes them at the end.
--
-- The pair that matters most is R1. A member answering an offer locks the
-- pass row and then, from meal_transfers_rebill, waits for the billing week.
-- An admin's answer_pass therefore takes the pass row before the week. Taken
-- the other way round, an admin queued on the week ahead of a member who holds
-- the pass is a deadlock (40P01) the moment the week is released.

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
  perform extensions.dblink_exec(p_conn, 'set local role authenticated');
  perform extensions.dblink_exec(p_conn, format(
    $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$, pg_temp.c(p_who)));
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

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('a0d00000-0000-0000-0000-000000000001', 'adm@aorace.test',  'Admin An'),
    ('a0d00000-0000-0000-0000-000000000002', 'adm2@aorace.test', 'Quan Hai'),
    ('a0d00000-0000-0000-0000-000000000003', 'teo@aorace.test',  'Teo Van'),
    ('a0d00000-0000-0000-0000-000000000004', 'dinh@aorace.test', 'Dinh Thi'),
    ('a0d00000-0000-0000-0000-000000000005', 'vy@aorace.test',   'Vy Tran'),
    ('a0d00000-0000-0000-0000-000000000006', 'lan@aorace.test',  'Lan Le')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code, business_day_starts_at, business_day_ends_at)
values ('aorace-a', 'Orders race', 'AORA', '00:00', '23:59');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('a0d00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('a0d00000-0000-0000-0000-000000000002', 'admin',  'QUAN'),
  ('a0d00000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('a0d00000-0000-0000-0000-000000000004', 'member', 'DINH'),
  ('a0d00000-0000-0000-0000-000000000005', 'member', 'VY'),
  ('a0d00000-0000-0000-0000-000000000006', 'member', 'LAN')
) as u(pid, role, code) on o.slug = 'aorace-a';

insert into ctx
select 'org', id::text from public.organizations where slug = 'aorace-a' union all
select 'adm',  'a0d00000-0000-0000-0000-000000000001' union all
select 'adm2', 'a0d00000-0000-0000-0000-000000000002' union all
select 'teo',  'a0d00000-0000-0000-0000-000000000003' union all
select 'dinh', 'a0d00000-0000-0000-0000-000000000004' union all
select 'vy',   'a0d00000-0000-0000-0000-000000000005' union all
select 'lan',  'a0d00000-0000-0000-0000-000000000006' union all
select 'dt', private.today_in('Asia/Ho_Chi_Minh')::text union all
select 'df', (private.today_in('Asia/Ho_Chi_Minh') + 1)::text union all
select 'dc', (private.today_in('Asia/Ho_Chi_Minh') + 2)::text;

-- Today is past its cutoff and cooking; tomorrow is open.
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
values (pg_temp.c('org')::bigint, pg_temp.c('dt')::date, 'published', now() - interval '1 hour',
        pg_temp.c('adm')::uuid, now()),
       (pg_temp.c('org')::bigint, pg_temp.c('df')::date, 'published', now() + interval '2 hours',
        pg_temp.c('adm')::uuid, now()),
       (pg_temp.c('org')::bigint, pg_temp.c('dc')::date, 'published', now() + interval '1 day',
        pg_temp.c('adm')::uuid, now());
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos from public.menus m
  join (values ('Pho', 40000, 0), ('Banh canh', 55000, 1)) as v(nm, pr, pos) on true
 where m.org_id = pg_temp.c('org')::bigint;

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c(v.who)::uuid, 'member', pg_temp.c(v.who)::uuid
  from public.menus m
  join (values ('dt','teo'), ('dt','dinh'), ('dt','vy'), ('dt','lan'), ('df','teo'), ('df','dinh')) as v(k, who)
    on m.service_date = pg_temp.c(v.k)::date
 where m.org_id = pg_temp.c('org')::bigint;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id and mi.name = 'Pho'
 where o.org_id = pg_temp.c('org')::bigint;

insert into ctx
select 'o_' || v.k || '_' || v.who, o.id::text
  from (values ('dt','teo'), ('dt','dinh'), ('dt','vy'), ('dt','lan'), ('df','teo'), ('df','dinh')) as v(k, who)
  join public.orders o on o.org_id = pg_temp.c('org')::bigint
   and o.service_date = pg_temp.c(v.k)::date and o.profile_id = pg_temp.c(v.who)::uuid;
insert into ctx
select 'i_banh', mi.id::text from public.menu_items mi join public.menus m on m.id = mi.menu_id
 where m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('dt')::date and mi.name = 'Banh canh';

-- Two offers waiting: Teo's to Dinh, Lan's to Teo.
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
values (pg_temp.c('org')::bigint, pg_temp.c('o_dt_teo')::bigint, pg_temp.c('teo')::uuid,
        pg_temp.c('dinh')::uuid, pg_temp.c('teo')::uuid),
       (pg_temp.c('org')::bigint, pg_temp.c('o_dt_lan')::bigint, pg_temp.c('lan')::uuid,
        pg_temp.c('teo')::uuid, pg_temp.c('lan')::uuid);
insert into ctx select 't_teo', id::text from public.meal_transfers where order_id = pg_temp.c('o_dt_teo')::bigint;
insert into ctx select 't_lan', id::text from public.meal_transfers where order_id = pg_temp.c('o_dt_lan')::bigint;

select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('dt')::date)) is not null;
select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('df')::date)) is not null;
select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('dc')::date)) is not null;

-- R9 and R10: Monday to Thursday of a week four weeks out, all open, one week.
insert into ctx
select 'w' || n, (private.today_in('Asia/Ho_Chi_Minh')
                  - (extract(isodow from private.today_in('Asia/Ho_Chi_Minh'))::int - 1) + 28 + n - 1)::text
  from generate_series(1, 4) n;
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
select pg_temp.c('org')::bigint, pg_temp.c('w' || n)::date, 'published', now() + interval '20 days',
       pg_temp.c('adm')::uuid, now()
  from generate_series(1, 4) n;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Pho', 40000, 0 from public.menus m
 where m.org_id = pg_temp.c('org')::bigint and m.service_date >= pg_temp.c('w1')::date;
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c(w)::uuid, 'member', pg_temp.c(w)::uuid
  from public.menus m, (values ('teo'), ('dinh')) as x(w)
 where m.org_id = pg_temp.c('org')::bigint and m.service_date >= pg_temp.c('w1')::date;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint and o.service_date >= pg_temp.c('w1')::date;
insert into ctx
select 'pho_w' || n, mi.id::text from generate_series(1, 4) n
  join public.menus m on m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('w' || n)::date
  join public.menu_items mi on mi.menu_id = m.id;
insert into ctx values ('p_w', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('w1')::date)::text);
select public.run_billing(pg_temp.c('p_w')::bigint) is not null;

-- R11 and R12: Monday and Friday of two weeks further out, never billed, so
-- neither week has a billing period yet.
insert into ctx
select k, (private.today_in('Asia/Ho_Chi_Minh')
           - (extract(isodow from private.today_in('Asia/Ho_Chi_Minh'))::int - 1) + n)::text
  from (values ('q1', 42), ('q5', 46), ('u1', 49), ('u5', 53)) as d(k, n);
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
select pg_temp.c('org')::bigint, pg_temp.c(k)::date, 'published', now() + interval '40 days',
       pg_temp.c('adm')::uuid, now()
  from unnest(array['q1', 'q5', 'u1', 'u5']) k;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Pho', 40000, 0 from public.menus m
 where m.org_id = pg_temp.c('org')::bigint and m.service_date >= pg_temp.c('q1')::date;
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c(w)::uuid, 'member', pg_temp.c(w)::uuid
  from public.menus m, (values ('teo'), ('dinh')) as x(w)
 where m.org_id = pg_temp.c('org')::bigint and m.service_date >= pg_temp.c('q1')::date;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint and o.service_date >= pg_temp.c('q1')::date;
insert into ctx
select 'pho_' || k, mi.id::text from unnest(array['q1', 'u1']) k
  join public.menus m on m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c(k)::date
  join public.menu_items mi on mi.menu_id = m.id;

-- A week's billing as it stands: its periods, lines on cancelled orders, and
-- each statement against its lines.
create function pg_temp.week_faults(p_day text) returns text
language sql stable as $fn$
  select (select count(*) from public.billing_periods bp
           where bp.org_id = pg_temp.c('org')::bigint
             and pg_temp.c(p_day)::date between bp.period_start and bp.period_end) || ' period, '
      || (select count(*) from public.billing_lines bl
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

------------------------ R1 an admin answers while the member's accept queues

-- C holds the week with a correction. A (admin) declines Teo's offer for
-- Dinh and waits on the week, already holding the pass. B (Dinh) accepts the
-- same offer and waits on the pass. C commits: A goes through, B is refused.
select pg_temp.open('c', 'adm2');
insert into probe values ('R1 C corrects Vy and holds the week',
  pg_temp.run('c', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('dt'), pg_temp.c('vy'), pg_temp.c('i_banh'))), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format($q$select count(*)::text from public.answer_pass(%s, 'decline')$q$, pg_temp.c('t_teo')));
select pg_temp.open('b', 'dinh');
select pg_temp.send('b', format($q$update public.meal_transfers set status = 'accepted' where id = %s$q$, pg_temp.c('t_teo')));
insert into probe values ('R1 A waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R1 B waits', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R1 A declines, no deadlock', pg_temp.finish('a'), 'ok');
insert into probe values ('R1 B is refused in the rule''s words', pg_temp.finish('b'), 'this transfer is already declined');
insert into probe values ('R1 the offer is declined and Teo still pays',
  (select t.status || ' ' || (bl.payer_profile_id = pg_temp.c('teo')::uuid)
     from public.meal_transfers t join public.billing_lines bl on bl.order_id = t.order_id
    where t.id = pg_temp.c('t_teo')::bigint), 'declined true');

------------------------------------------- R2 the member answers first

select pg_temp.open('b', 'teo');
insert into probe values ('R2 Teo accepts Lan''s offer',
  pg_temp.run('b', format($q$update public.meal_transfers set status = 'accepted' where id = %s$q$, pg_temp.c('t_lan'))),
  'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format($q$select count(*)::text from public.answer_pass(%s, 'decline')$q$, pg_temp.c('t_lan')));
insert into probe values ('R2 the admin''s decline waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R2 Teo commits', pg_temp.close('b'), 'ok');
insert into probe values ('R2 the admin is told it was answered',
  pg_temp.finish('a'), 'that offer has already been answered: it is accepted');

--------------------------------- R3 a pass meets the member cancelling

select pg_temp.open('b', 'teo');
insert into probe values ('R3 Teo cancels tomorrow',
  pg_temp.run('b', format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s$q$,
    pg_temp.c('o_df_teo'))), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format('select count(*)::text from public.record_pass(%s, %L::uuid)',
  pg_temp.c('o_df_teo'), pg_temp.c('dinh')));
insert into probe values ('R3 the pass waits on the order', pg_temp.busy('a'), 'waiting');
insert into probe values ('R3 Teo commits', pg_temp.close('b'), 'ok');
insert into probe values ('R3 the pass sees the cancel',
  pg_temp.finish('a'), 'nothing is recorded for Teo Van on ' || to_char(pg_temp.c('df')::date, 'DD/MM')
    || ', so there is no meal to pass');

------------------------- R4 a pass meets the member offering it first

select pg_temp.open('b', 'dinh');
insert into probe values ('R4 Dinh offers his lunch to Vy',
  pg_temp.run('b', format($q$insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
                             values (%s, %s, %L::uuid, %L::uuid, %L::uuid)$q$,
    pg_temp.c('org'), pg_temp.c('o_dt_dinh'), pg_temp.c('dinh'), pg_temp.c('vy'), pg_temp.c('dinh'))), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format('select count(*)::text from public.record_pass(%s, %L::uuid)',
  pg_temp.c('o_dt_dinh'), pg_temp.c('lan')));
insert into probe values ('R4 the pass waits on the offer', pg_temp.busy('a'), 'waiting');
insert into probe values ('R4 Dinh commits', pg_temp.close('b'), 'ok');
insert into probe values ('R4 the pass sees the offer',
  pg_temp.finish('a'), 'Dinh Thi''s lunch on ' || to_char(pg_temp.c('dt')::date, 'DD/MM')
    || ' is already offered to Vy Tran, so answer or withdraw that offer first');

---------------------------- R5 the admin's pass first, then the member's offer

select pg_temp.open('a', 'adm');
insert into probe values ('R5 the admin passes Vy''s lunch to Lan',
  pg_temp.run('a', format('select count(*)::text from public.record_pass(%s, %L::uuid)',
    pg_temp.c('o_dt_vy'), pg_temp.c('lan'))), 'ok');
select pg_temp.open('b', 'vy');
select pg_temp.send('b', format($q$insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
                                   values (%s, %s, %L::uuid, %L::uuid, %L::uuid)$q$,
  pg_temp.c('org'), pg_temp.c('o_dt_vy'), pg_temp.c('vy'), pg_temp.c('teo'), pg_temp.c('vy')));
insert into probe values ('R5 Vy''s offer waits on the order', pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 the admin commits', pg_temp.close('a'), 'ok');
insert into probe values ('R5 Vy''s offer is refused by the one-live-pass rule',
  pg_temp.finish('b'), 'duplicate key value violates unique constraint "transfers_one_live_uk"');
insert into probe values ('R5 one live pass, to Lan',
  (select count(*) || ' ' || max(status) || ' ' || (max(to_profile_id::text) = pg_temp.c('lan'))
     from public.meal_transfers where order_id = pg_temp.c('o_dt_vy')::bigint and status in ('pending','accepted')),
  '1 accepted true');
insert into ctx select 't_vy', id::text from public.meal_transfers
 where order_id = pg_temp.c('o_dt_vy')::bigint and status = 'accepted';

------------------------------------------ R6 an undo meets a correction

select pg_temp.open('c', 'adm2');
insert into probe values ('R6 C corrects Vy back to Pho and holds',
  pg_temp.run('c', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('dt'), pg_temp.c('vy'),
    (select mi.id from public.menu_items mi join public.menus m on m.id = mi.menu_id
      where m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('dt')::date and mi.name = 'Pho'))), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format('select count(*)::text from public.undo_pass(%s)', pg_temp.c('t_vy')));
insert into probe values ('R6 the undo waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R6 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R6 the undo goes through', pg_temp.finish('a'), 'ok');
insert into probe values ('R6 Vy pays for Pho again, once',
  (select count(*) || ' ' || max(bl.amount_minor) || ' ' || bool_and(bl.payer_profile_id = pg_temp.c('vy')::uuid)
     from public.billing_lines bl where bl.order_id = pg_temp.c('o_dt_vy')::bigint), '1 40000 true');

------------------- R7 record_pass holding the order meets a member's offer

-- record_pass holds the order before it inserts the pass. A member's offer on
-- the same order takes the pass slot first and then the order FOR KEY SHARE
-- through its foreign key. Were record_pass to hold the order FOR UPDATE, each
-- would wait for the other (40P01) once record_pass reached its insert.
--
-- To catch that in the real function, record_pass is paused between its order
-- lock and its insert: a test-only BEFORE INSERT trigger on meal_transfers
-- waits on an advisory lock that session C holds, and only for inserts made as
-- `postgres`, which is who record_pass runs as. The member's own insert runs
-- as `authenticated` and is not paused. The trigger is dropped straight after.
create function private.test_pause_pass_insert() returns trigger
language plpgsql as $fn$
begin
  if current_user = 'postgres' then
    perform pg_catalog.pg_advisory_xact_lock_shared(hashtext('admin_orders_race.r7'));
  end if;
  return new;
end $fn$;
create trigger meal_transfers_test_pause before insert on public.meal_transfers
  for each row execute function private.test_pause_pass_insert();

select pg_temp.open('c', 'adm2');
insert into probe values ('R7 C holds the pause',
  pg_temp.run('c', $q$select pg_advisory_xact_lock(hashtext('admin_orders_race.r7'))::text$q$), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format('select count(*)::text from public.record_pass(%s, %L::uuid)',
  pg_temp.c('o_df_dinh'), pg_temp.c('lan')));
insert into probe values ('R7 record_pass holds the order and pauses before its insert', pg_temp.busy('a'), 'waiting');
-- Somebody else asking for the order outright is turned away: record_pass
-- really does hold it at the pause.
select pg_temp.open('d', 'adm2');
insert into probe values ('R7 record_pass holds the order at the pause',
  pg_temp.run('d', format('select id::text from public.orders where id = %s for update nowait', pg_temp.c('o_df_dinh'))),
  '55P03 could not obtain lock on row in relation "orders"');
select pg_temp.close('d', false);
select pg_temp.open('b', 'dinh');
select pg_temp.send('b', format($q$insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
                                   values (%s, %s, %L::uuid, %L::uuid, %L::uuid)$q$,
  pg_temp.c('org'), pg_temp.c('o_df_dinh'), pg_temp.c('dinh'), pg_temp.c('teo'), pg_temp.c('dinh')));
insert into probe values ('R7 Dinh''s offer does not wait on the order record_pass holds', pg_temp.busy('b'), 'done');
insert into probe values ('R7 C lets record_pass go on', pg_temp.close('c'), 'ok');
insert into probe values ('R7 record_pass then waits on the offer', pg_temp.busy('a'), 'waiting');
insert into probe values ('R7 Dinh commits', pg_temp.finish('b'), 'ok');
insert into probe values ('R7 record_pass names the offer, no deadlock',
  pg_temp.finish('a'), 'Dinh Thi''s lunch on ' || to_char(pg_temp.c('df')::date, 'DD/MM')
    || ' is already offered to Teo Van, so answer or withdraw that offer first');

drop trigger meal_transfers_test_pause on public.meal_transfers;
drop function private.test_pause_pass_insert();

------------------------ R8 cancelling lunch meets a correction in flight

-- A correction holds its day's menu FOR SHARE, so cancelling lunch waits for
-- it and then cancels the order it wrote. Without that lock the cancel would
-- not see the uncommitted order and a placed order would outlive the day.
select pg_temp.open('a', 'adm2');
insert into probe values ('R8 an admin orders for Lan the day after tomorrow',
  pg_temp.run('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('dc'), pg_temp.c('lan'),
    (select mi.id from public.menu_items mi join public.menus m on m.id = mi.menu_id
      where m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('dc')::date and mi.name = 'Pho'))), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', format($q$update public.menus set status = 'cancelled'
                                   where org_id = %s and service_date = %L::date$q$, pg_temp.c('org'), pg_temp.c('dc')));
insert into probe values ('R8 cancelling lunch waits for the correction', pg_temp.busy('b'), 'waiting');
insert into probe values ('R8 the correction commits', pg_temp.close('a'), 'ok');
insert into probe values ('R8 then lunch is cancelled', pg_temp.finish('b'), 'ok');
insert into probe values ('R8 and no placed order is left on the cancelled day',
  (select count(*)::text from public.orders o join public.menus m on m.id = o.menu_id
    where m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('dc')::date
      and o.status = 'placed'), '0');

--------------------- R9, R10 cancelling lunch and a correction share a week

-- Cancelling lunch re-bills its week (20261022100300): it holds the day's
-- menu, then takes the week, then writes the orders. A correction on another
-- day of the week holds its own menu and then the week. Either way round, one
-- waits for the other and neither deadlocks.
select pg_temp.open('a', 'adm2');
insert into probe values ('R9 A orders for Vy on Monday and holds the week',
  pg_temp.run('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('w1'), pg_temp.c('vy'), pg_temp.c('pho_w1'))), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', format($q$update public.menus set status = 'cancelled'
                                   where org_id = %s and service_date = %L::date$q$, pg_temp.c('org'), pg_temp.c('w2')));
insert into probe values ('R9 cancelling Tuesday waits for the week', pg_temp.busy('b'), 'waiting');
insert into probe values ('R9 the correction commits', pg_temp.close('a'), 'ok');
insert into probe values ('R9 then Tuesday is cancelled, no deadlock', pg_temp.finish('b'), 'ok');

select pg_temp.open('b', 'adm');
insert into probe values ('R10 B cancels Wednesday first and holds the week',
  pg_temp.run('b', format($q$update public.menus set status = 'cancelled'
                             where org_id = %s and service_date = %L::date returning 'x'$q$,
    pg_temp.c('org'), pg_temp.c('w3'))), 'ok');
select pg_temp.open('a', 'adm2');
select pg_temp.send('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
  pg_temp.c('org'), pg_temp.c('w4'), pg_temp.c('vy'), pg_temp.c('pho_w4')));
insert into probe values ('R10 a correction on Thursday waits for the week', pg_temp.busy('a'), 'waiting');
insert into probe values ('R10 the cancel commits', pg_temp.close('b'), 'ok');
insert into probe values ('R10 then the correction goes through, no deadlock', pg_temp.finish('a'), 'ok');

insert into probe values
  ('R10 the week is billed as it stands: Monday and Thursday, each statement its lines',
   (select string_agg(m.short_code || ' ' || st.meals_minor || ' ' || st.meal_count
                      || case when st.meals_minor = (select coalesce(sum(bl.amount_minor), 0)
                                                       from public.billing_lines bl
                                                      where bl.billing_period_id = st.billing_period_id
                                                        and bl.payer_profile_id = st.profile_id)
                              then '' else ' NOT THE SUM' end, ', ' order by m.short_code)
      from public.billing_statements st
      join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
     where st.billing_period_id = pg_temp.c('p_w')::bigint),
   'DINH 80000 2, TEO 80000 2, VY 80000 2');

------------- R11, R12 cancelling lunch meets the first correction of a week

-- The week has no billing period. A correction makes the first one and bills
-- the week; a cancel looking for the period cannot see one still uncommitted.
-- Both take the office-week key before looking (20261022100300), so the second
-- waits and then sees the first's work. Without it, R11 leaves Friday's meals
-- billed on cancelled orders, and R12 the same the other way round.
select pg_temp.open('a', 'adm2');
insert into probe values ('R11 A orders for Vy on Monday, making the week''s first period',
  pg_temp.run('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
    pg_temp.c('org'), pg_temp.c('q1'), pg_temp.c('vy'), pg_temp.c('pho_q1'))), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', format($q$update public.menus set status = 'cancelled'
                                   where org_id = %s and service_date = %L::date$q$, pg_temp.c('org'), pg_temp.c('q5')));
insert into probe values ('R11 cancelling Friday waits for it', pg_temp.busy('b'), 'waiting');
insert into probe values ('R11 the correction commits', pg_temp.close('a'), 'ok');
insert into probe values ('R11 then Friday is cancelled', pg_temp.finish('b'), 'ok');
insert into probe values ('R11 and nothing is billed for Friday',
  pg_temp.week_faults('q1'), '1 period, 0 lines on cancelled orders, DINH 40000, TEO 40000, VY 40000');

select pg_temp.open('b', 'adm');
insert into probe values ('R12 B cancels Friday first, the week still without a period',
  pg_temp.run('b', format($q$update public.menus set status = 'cancelled'
                             where org_id = %s and service_date = %L::date returning 'x'$q$,
    pg_temp.c('org'), pg_temp.c('u5'))), 'ok');
select pg_temp.open('a', 'adm2');
select pg_temp.send('a', format('select count(*)::text from public.correct_meal(%s, %L::date, %L::uuid, %s)',
  pg_temp.c('org'), pg_temp.c('u1'), pg_temp.c('vy'), pg_temp.c('pho_u1')));
insert into probe values ('R12 the week''s first correction waits for it', pg_temp.busy('a'), 'waiting');
insert into probe values ('R12 the cancel commits', pg_temp.close('b'), 'ok');
insert into probe values ('R12 then the correction goes through', pg_temp.finish('a'), 'ok');
insert into probe values ('R12 and bills nothing for Friday',
  pg_temp.week_faults('u1'), '1 period, 0 lines on cancelled orders, DINH 40000, TEO 40000, VY 40000');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

drop trigger if exists meal_transfers_test_pause on public.meal_transfers;
drop function if exists private.test_pause_pass_insert();

do $$
declare v_org bigint;
begin
  select id into v_org from public.organizations where slug = 'aorace-a';
  delete from public.order_corrections   where org_id = v_org;
  delete from public.billing_statements  where org_id = v_org;
  delete from public.billing_lines       where org_id = v_org;
  delete from public.billing_periods     where org_id = v_org;
  delete from public.notification_outbox where org_id = v_org;
  delete from public.meal_transfers      where org_id = v_org;
  delete from public.order_items         where org_id = v_org;
  delete from public.orders              where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@aorace.test';
