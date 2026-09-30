-- Two sessions at once: a re-bill that deletes a statement, and the payment on
-- it being moved. Run against a LOCAL scratch database only:
--   psql "$DATABASE_URL" -f supabase/tests/rebill_race.sql
--
-- Like atomic_writes_race.sql, this COMMITS its fixtures, because the racing
-- sessions are dblink connections back into the same database, and removes
-- them at the end. It needs the dblink extension and a loopback connection
-- that authenticates as the current user without a password.
--
-- Removing somebody's only meal of the week deletes their statement, which
-- updates every payment pointing at it (ON DELETE SET NULL). `move_payment`
-- holds the payment and then the person. So the re-bill locks those payments
-- before it takes anybody, and each order below waits for the other rather
-- than deadlocking, and ends with nobody owing for a meal they did not eat.

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
    $q$set local request.jwt.claims = '{"sub":"%s","role":"authenticated"}'$q$,
    pg_temp.c(p_who)));
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

create function pg_temp.finish(p_conn text) returns text
language plpgsql as $fn$
declare v_msg text; r record;
begin
  for r in select * from extensions.dblink_get_result(p_conn, false) as t(x text) loop end loop;
  v_msg := extensions.dblink_error_message(p_conn);
  perform * from extensions.dblink_get_result(p_conn, false) as t(x text);
  perform extensions.dblink_exec(p_conn, 'commit');
  perform extensions.dblink_disconnect(p_conn);
  return case when v_msg = 'OK' then 'ok'
              else split_part(regexp_replace(v_msg, '^ERROR:\s+', ''), E'\n', 1) end;
end $fn$;

create function pg_temp.close(p_conn text) returns text
language plpgsql as $fn$
declare v text;
begin
  begin
    perform extensions.dblink_exec(p_conn, 'commit');
    v := 'ok';
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  perform extensions.dblink_disconnect(p_conn);
  return v;
end $fn$;

create function pg_temp.bal(p_who text) returns text language sql stable as $fn$
  select b.balance_minor::text from public.v_account_balance b
   where b.org_id = pg_temp.c('org')::bigint and b.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.statements(p_who text) returns text language sql stable as $fn$
  select count(*)::text from public.billing_statements st
   where st.org_id = pg_temp.c('org')::bigint and st.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('bace0000-0000-0000-0000-000000000001', 'adm@rebillrace.test', 'Quan Ly'),
    ('bace0000-0000-0000-0000-000000000002', 'xa@rebillrace.test',  'Xa Nguyen'),
    ('bace0000-0000-0000-0000-000000000003', 'xb@rebillrace.test',  'Xb Tran'),
    ('bace0000-0000-0000-0000-000000000004', 'yen@rebillrace.test', 'Yen Le')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, short_code)
values ('rebill-race', 'Rebill Race', 'Asia/Ho_Chi_Minh', 'RBRC');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('bace0000-0000-0000-0000-000000000001', 'owner',  'RADM'),
  ('bace0000-0000-0000-0000-000000000002', 'member', 'RXAA'),
  ('bace0000-0000-0000-0000-000000000003', 'member', 'RXBB'),
  ('bace0000-0000-0000-0000-000000000004', 'member', 'RYEN')
) as u(pid, role, code) on o.slug = 'rebill-race';

insert into ctx
select 'org', id::text from public.organizations where slug = 'rebill-race' union all
select 'adm', 'bace0000-0000-0000-0000-000000000001' union all
select 'xa',  'bace0000-0000-0000-0000-000000000002' union all
select 'xb',  'bace0000-0000-0000-0000-000000000003' union all
select 'yen', 'bace0000-0000-0000-0000-000000000004' union all
select 'day', (current_date - ((extract(isodow from current_date)::int - 1 + 7) % 7) + 1)::text;

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
values (pg_temp.c('org')::bigint, pg_temp.c('day')::date, 'locked',
        (pg_temp.c('day')::date::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
        pg_temp.c('adm')::uuid);

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Com ga', 45000, 0 from public.menus m where m.org_id = pg_temp.c('org')::bigint;

-- XA and XB each eat once this week and have paid for it exactly.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, p.pid, 'member', p.pid
  from public.menus m
  cross join (values (pg_temp.c('xa')::uuid), (pg_temp.c('xb')::uuid)) as p(pid)
 where m.org_id = pg_temp.c('org')::bigint;

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint;

insert into ctx
select 'period', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('day')::date)::text;
select count(*) from public.run_billing(pg_temp.c('period')::bigint);

insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                             memo, received_at, raw, profile_id)
select pg_temp.c('org')::bigint, 'manual', 'rebill-race-' || w, 45000, null,
       now() - interval '1 hour', '{}'::jsonb, pg_temp.c(w)::uuid
  from (values ('xa'), ('xb')) as v(w);

insert into ctx
select 'pay_' || w, p.id::text from public.payments p
  join (values ('xa'), ('xb')) as v(w) on p.provider_txn_id = 'rebill-race-' || w;
insert into ctx
select 'order_' || w, o.id::text from public.orders o
  join (values ('xa'), ('xb')) as v(w) on o.profile_id = pg_temp.c(w)::uuid;

insert into probe values
  ('control: XA and XB each have one paid statement',
    pg_temp.statements('xa') || '/' || pg_temp.bal('xa') || ' ' || pg_temp.statements('xb') || '/' || pg_temp.bal('xb'),
    '1/0 1/0'),
  ('control: the payment points at XA''s statement',
    ((select p.matched_statement_id from public.payments p where p.id = pg_temp.c('pay_xa')::bigint)
      is not null)::text, 'true');

------------------------------------ R1 a payment moved, then the meal removed

-- A moves XA's payment to YEN and holds it. B removes XA's only meal, which
-- deletes the statement the payment points at, so B waits for A.
select pg_temp.open('a', 'adm');
select pg_temp.open('b', 'adm');
insert into probe values ('R1 A moves the payment and holds it',
  pg_temp.run('a', format($q$select payment_id::text from public.move_payment(%s, '%s', 'paid for Yen')$q$,
                          pg_temp.c('pay_xa'), pg_temp.c('yen'))), 'ok');
select pg_temp.send('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                                pg_temp.c('order_xa')));
insert into probe values ('R1 B waits for A', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 A commits', pg_temp.close('a'), 'ok');
insert into probe values ('R1 then B goes through', pg_temp.finish('b'), 'ok');

insert into probe values
  ('R1 XA has no statement and owes nothing', pg_temp.statements('xa') || '/' || pg_temp.bal('xa'), '0/0'),
  ('R1 YEN holds the money as credit', pg_temp.bal('yen'), '-45000'),
  ('R1 the payment points at nothing',
    coalesce((select p.matched_statement_id::text from public.payments p where p.id = pg_temp.c('pay_xa')::bigint), 'null'),
    'null');

------------------------------------ R2 the meal removed, then the payment moved

select pg_temp.open('a', 'adm');
select pg_temp.open('b', 'adm');
insert into probe values ('R2 B removes XB''s meal and holds it',
  pg_temp.run('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                          pg_temp.c('order_xb'))), 'ok');
select pg_temp.send('a', format($q$select payment_id::text from public.move_payment(%s, '%s', 'paid for Yen')$q$,
                                pg_temp.c('pay_xb'), pg_temp.c('yen')));
insert into probe values ('R2 A waits for B', pg_temp.busy('a'), 'waiting');
insert into probe values ('R2 B commits', pg_temp.close('b'), 'ok');
insert into probe values ('R2 then A goes through', pg_temp.finish('a'), 'ok');

insert into probe values
  ('R2 XB has no statement and owes nothing', pg_temp.statements('xb') || '/' || pg_temp.bal('xb'), '0/0'),
  ('R2 YEN holds both payments as credit', pg_temp.bal('yen'), '-90000'),
  ('R2 the week has no statement left',
    (select count(*)::text from public.billing_statements
      where billing_period_id = pg_temp.c('period')::bigint), '0');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint := (select id from public.organizations where slug = 'rebill-race');
begin
  delete from public.payment_corrections where org_id = v_org;
  delete from public.order_corrections   where org_id = v_org;
  delete from public.payments            where org_id = v_org;
  delete from public.billing_statements  where org_id = v_org;
  delete from public.billing_lines       where org_id = v_org;
  delete from public.billing_periods     where org_id = v_org;
  delete from public.notification_outbox where org_id = v_org;
  delete from public.order_items         where org_id = v_org;
  delete from public.orders              where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@rebillrace.test';
