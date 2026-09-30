-- Three sessions at once: a re-bill, a payment being moved or a week waived,
-- and a payment arriving, all on one person. Run against a LOCAL scratch
-- database only, as a superuser over TCP (dblink needs it):
--   docker exec -i <db container> psql -h 127.0.0.1 -U supabase_admin -d postgres -f - < supabase/tests/rebill_race.sql
--
-- Like atomic_writes_race.sql, this COMMITS its fixtures, because the racing
-- sessions are dblink connections back into the same database, and removes
-- them at the end.
--
-- The lock order this holds to: the week, then payments, then each person
-- (the `lunch.reallocate:` advisory key, in profile order), then statement
-- rows. `move_payment` takes a payment and then people; a payment arriving
-- (`trg_payment_apply`) takes the person and then their statements;
-- `run_billing` takes the week, the payments on its statements, every person
-- in the week, then statements; `waive_statement` takes the person, then the
-- statement. Each scenario below:
--
--   C  a payment arriving for X, held open, so it holds X and X's statements
--   B  a re-bill of X's week (remove_meal, reprice_dish), sent first
--   A  move_payment of a payment of X's, or waive_statement of X's week
--   then C commits, and both A and B must go through.
--
-- Without the payment lock, R1 deadlocks: B deletes the statement the payment
-- points at, which updates the payment A holds. Without the person lock, R2
-- to R4 deadlock: B writes X's statement and then waits for X, while A holds
-- X and waits for that statement. With the old `waive_statement`, R5 does.

set statement_timeout = '180s';
set client_min_messages = warning;
set lock_timeout = '30s';

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
  perform extensions.dblink_exec(p_conn, $q$set local lock_timeout = '10s'$q$);
  perform extensions.dblink_exec(p_conn, $q$set local statement_timeout = '20s'$q$);
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
  -- Long enough for the session to reach the lock it will wait on.
  perform pg_sleep(0.5);
end $fn$;

create function pg_temp.busy(p_conn text) returns text
language sql as $fn$
  select case extensions.dblink_is_busy(p_conn) when 1 then 'waiting' else 'done' end;
$fn$;

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

-- One async session's answer, then commit: 'ok' or the error's first line.
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

-- Both async sessions, whichever finishes first committed first, so that the
-- one still waiting on it can go on. A deadlock ends one of them at once.
create function pg_temp.finish_both() returns text
language plpgsql as $fn$
declare v_a text; v_b text; i int := 0;
begin
  while v_a is null and v_b is null and i < 250 loop
    if pg_temp.busy('b') = 'done' then v_b := pg_temp.finish('b');
    elsif pg_temp.busy('a') = 'done' then v_a := pg_temp.finish('a');
    else perform pg_sleep(0.1); i := i + 1;
    end if;
  end loop;
  if v_a is null then v_a := pg_temp.finish('a'); end if;
  if v_b is null then v_b := pg_temp.finish('b'); end if;
  return 'a=' || v_a || ' b=' || v_b;
end $fn$;

create function pg_temp.arrive(p_who text) returns text
language sql as $fn$
  select format($q$insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                    memo, received_at, raw, profile_id)
                  values (%s, 'manual', 'rebill-race-arrive-%s', 10000, null, now(), '{}'::jsonb, '%s')
                  returning id::text$q$,
                pg_temp.c('org'), p_who, pg_temp.c(p_who));
$fn$;

create function pg_temp.move(p_pay text) returns text
language sql as $fn$
  select format($q$select payment_id::text from public.move_payment(%s, '%s', 'paid for Yen')$q$,
                pg_temp.c(p_pay), pg_temp.c('yen'));
$fn$;

create function pg_temp.bal(p_who text) returns text language sql stable as $fn$
  select b.balance_minor::text from public.v_account_balance b
   where b.org_id = pg_temp.c('org')::bigint and b.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.st(p_who text, p_week text) returns text language sql stable as $fn$
  select coalesce(
    (select format('meals=%s n=%s paid=%s %s', st.meals_minor, st.meal_count, st.paid_minor, st.status)
       from public.billing_statements st
      where st.billing_period_id = pg_temp.c(p_week)::bigint
        and st.profile_id = pg_temp.c(p_who)::uuid),
    'none');
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
    ('bace0000-0000-0000-0000-000000000004', 'xc@rebillrace.test',  'Xc Pham'),
    ('bace0000-0000-0000-0000-000000000005', 'xd@rebillrace.test',  'Xd Vo'),
    ('bace0000-0000-0000-0000-000000000006', 'xe@rebillrace.test',  'Xe Do'),
    ('bace0000-0000-0000-0000-000000000007', 'yen@rebillrace.test', 'Yen Le')
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
  ('bace0000-0000-0000-0000-000000000004', 'member', 'RXCC'),
  ('bace0000-0000-0000-0000-000000000005', 'member', 'RXDD'),
  ('bace0000-0000-0000-0000-000000000006', 'member', 'RXEE'),
  ('bace0000-0000-0000-0000-000000000007', 'member', 'RYEN')
) as u(pid, role, code) on o.slug = 'rebill-race';

insert into ctx
select 'org', id::text from public.organizations where slug = 'rebill-race' union all
select 'adm', 'bace0000-0000-0000-0000-000000000001' union all
select 'xa',  'bace0000-0000-0000-0000-000000000002' union all
select 'xb',  'bace0000-0000-0000-0000-000000000003' union all
select 'xc',  'bace0000-0000-0000-0000-000000000004' union all
select 'xd',  'bace0000-0000-0000-0000-000000000005' union all
select 'xe',  'bace0000-0000-0000-0000-000000000006' union all
select 'yen', 'bace0000-0000-0000-0000-000000000007';

-- This week (d, d2) and two weeks ago (d0), all locked, as weeks being
-- corrected are.
insert into ctx
select k, (current_date - ((extract(isodow from current_date)::int - 1 + 7) % 7) + n)::text
  from (values ('d0', -13), ('d', 1), ('d2', 2)) as v(k, n);

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select pg_temp.c('org')::bigint, pg_temp.c(k)::date, 'locked',
       (pg_temp.c(k)::date::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
       pg_temp.c('adm')::uuid
  from (values ('d0'), ('d'), ('d2')) as v(k);

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  cross join (values ('Com ga', 45000, 0), ('Pho', 30000, 1)) as v(nm, pr, pos)
 where m.org_id = pg_temp.c('org')::bigint;

-- XA eats once this week. XB and XD also ate two weeks ago, which their
-- payment went to. XC eats once and pays through a stray. XE eats twice.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c(v.who)::uuid, 'member', pg_temp.c(v.who)::uuid
  from (values ('xa','d'), ('xb','d0'), ('xb','d'), ('xc','d'), ('xd','d0'), ('xd','d'),
               ('xe','d'), ('xe','d2')) as v(who, dk)
  join public.menus m on m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c(v.dk)::date;

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id
   and mi.name = case when o.profile_id = pg_temp.c('xd')::uuid
                       and o.service_date = pg_temp.c('d')::date then 'Pho' else 'Com ga' end
 where o.org_id = pg_temp.c('org')::bigint;

insert into ctx
select 'w0', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d0')::date)::text union all
select 'w',  public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d')::date)::text;
select count(*) from public.run_billing(pg_temp.c('w0')::bigint);
select count(*) from public.run_billing(pg_temp.c('w')::bigint);

-- XC's is a stray: no memo and nobody named, so it matches nobody.
insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                             memo, received_at, raw, profile_id)
select pg_temp.c('org')::bigint, 'manual', 'rebill-race-' || v.who, 45000, null,
       now() - interval '1 hour', '{}'::jsonb,
       case when v.who = 'xc' then null else pg_temp.c(v.who)::uuid end
  from (values ('xa'), ('xb'), ('xc'), ('xd')) as v(who);

insert into ctx
select 'pay_' || v.who, p.id::text from public.payments p
  join (values ('xa'), ('xb'), ('xc'), ('xd')) as v(who) on p.provider_txn_id = 'rebill-race-' || v.who;
insert into ctx
select 'order_' || v.who, o.id::text from public.orders o
  join (values ('xa','d'), ('xb','d'), ('xe','d2')) as v(who, dk)
    on o.profile_id = pg_temp.c(v.who)::uuid and o.service_date = pg_temp.c(v.dk)::date;
insert into ctx
select 'pho', mi.id::text from public.menu_items mi join public.menus m on m.id = mi.menu_id
 where m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c('d')::date and mi.name = 'Pho';
insert into ctx
select 'st_xe', st.id::text from public.billing_statements st
 where st.billing_period_id = pg_temp.c('w')::bigint and st.profile_id = pg_temp.c('xe')::uuid;

insert into probe values
  ('control: XA''s payment points at this week',
    ((select p.matched_statement_id from public.payments p where p.id = pg_temp.c('pay_xa')::bigint)
      = (select st.id from public.billing_statements st
          where st.billing_period_id = pg_temp.c('w')::bigint and st.profile_id = pg_temp.c('xa')::uuid))::text,
    'true'),
  ('control: XB''s and XD''s payments point at two weeks ago',
    (select string_agg((st.billing_period_id = pg_temp.c('w0')::bigint)::text, ',' order by p.id)
       from public.payments p join public.billing_statements st on st.id = p.matched_statement_id
      where p.id in (pg_temp.c('pay_xb')::bigint, pg_temp.c('pay_xd')::bigint)), 'true,true'),
  ('control: XC''s payment is a stray',
    (select coalesce(p.profile_id::text, 'nobody') from public.payments p
      where p.id = pg_temp.c('pay_xc')::bigint), 'nobody'),
  ('control: XE has two meals this week', pg_temp.st('xe', 'w'), 'meals=90000 n=2 paid=0 unpaid');

------------------------- R1 the payment points at the week being re-billed

select pg_temp.open('c', 'adm');
insert into probe values ('R1 C: a payment arrives for XA, held', pg_temp.run('c', pg_temp.arrive('xa')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.open('a', 'adm');
select pg_temp.send('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                                pg_temp.c('order_xa')));
select pg_temp.send('a', pg_temp.move('pay_xa'));
insert into probe values ('R1 B and A both wait', pg_temp.busy('b') || ',' || pg_temp.busy('a'), 'waiting,waiting');
insert into probe values ('R1 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R1 then both go through', pg_temp.finish_both(), 'a=ok b=ok');
insert into probe values
  ('R1 XA: no statement, the arrival is credit', pg_temp.st('xa', 'w') || ' ' || pg_temp.bal('xa'), 'none -10000'),
  ('R1 the moved payment is YEN''s',
    (select (p.profile_id = pg_temp.c('yen')::uuid)::text from public.payments p
      where p.id = pg_temp.c('pay_xa')::bigint), 'true');

------------------------- R2 the payment points at another week

select pg_temp.open('c', 'adm');
insert into probe values ('R2 C: a payment arrives for XB, held', pg_temp.run('c', pg_temp.arrive('xb')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.open('a', 'adm');
select pg_temp.send('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                                pg_temp.c('order_xb')));
select pg_temp.send('a', pg_temp.move('pay_xb'));
insert into probe values ('R2 B and A both wait', pg_temp.busy('b') || ',' || pg_temp.busy('a'), 'waiting,waiting');
insert into probe values ('R2 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R2 then both go through', pg_temp.finish_both(), 'a=ok b=ok');
insert into probe values
  ('R2 XB: this week gone, the older week holds the arrival',
    pg_temp.st('xb', 'w') || ' | ' || pg_temp.st('xb', 'w0') || ' | ' || pg_temp.bal('xb'),
    'none | meals=45000 n=1 paid=10000 partial | 35000');

------------------------- R3 a stray applied to the person being re-billed

select pg_temp.open('c', 'adm');
insert into probe values ('R3 C: a payment arrives for XC, held', pg_temp.run('c', pg_temp.arrive('xc')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.open('a', 'adm');
select pg_temp.send('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                                (select o.id from public.orders o
                                  where o.profile_id = pg_temp.c('xc')::uuid)));
select pg_temp.send('a', format($q$select payment_id::text from public.move_payment(%s, '%s', 'it was XC')$q$,
                                pg_temp.c('pay_xc'), pg_temp.c('xc')));
insert into probe values ('R3 B and A both wait', pg_temp.busy('b') || ',' || pg_temp.busy('a'), 'waiting,waiting');
insert into probe values ('R3 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R3 then both go through', pg_temp.finish_both(), 'a=ok b=ok');
insert into probe values
  ('R3 XC: no statement, both payments are credit', pg_temp.st('xc', 'w') || ' ' || pg_temp.bal('xc'), 'none -55000');

------------------------- R4 a reprice instead of a removal

select pg_temp.open('c', 'adm');
insert into probe values ('R4 C: a payment arrives for XD, held', pg_temp.run('c', pg_temp.arrive('xd')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.open('a', 'adm');
select pg_temp.send('b', format($q$select lines::text from public.reprice_dish(%s, 35000, 'caterer charged more')$q$,
                                pg_temp.c('pho')));
select pg_temp.send('a', pg_temp.move('pay_xd'));
insert into probe values ('R4 B and A both wait', pg_temp.busy('b') || ',' || pg_temp.busy('a'), 'waiting,waiting');
insert into probe values ('R4 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R4 then both go through', pg_temp.finish_both(), 'a=ok b=ok');
insert into probe values
  ('R4 XD: this week at the new price, the arrival on the older week',
    pg_temp.st('xd', 'w') || ' | ' || pg_temp.st('xd', 'w0') || ' | ' || pg_temp.bal('xd'),
    'meals=35000 n=1 paid=0 unpaid | meals=45000 n=1 paid=10000 partial | 70000');

------------------------- R5 a waiver during a re-bill of the same week

select pg_temp.open('c', 'adm');
insert into probe values ('R5 C: a payment arrives for XE, held', pg_temp.run('c', pg_temp.arrive('xe')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.open('a', 'adm');
select pg_temp.send('b', format($q$select balance_minor::text from public.remove_meal(%s, 'did not eat')$q$,
                                pg_temp.c('order_xe')));
select pg_temp.send('a', format($q$select public.waive_statement(%s, 'on the house')::text$q$,
                                pg_temp.c('st_xe')));
insert into probe values ('R5 B and A both wait', pg_temp.busy('b') || ',' || pg_temp.busy('a'), 'waiting,waiting');
insert into probe values ('R5 C commits', pg_temp.close('c'), 'ok');
insert into probe values ('R5 then both go through', pg_temp.finish_both(), 'a=ok b=ok');
insert into probe values
  ('R5 XE: one meal left, waived, the arrival is credit',
    pg_temp.st('xe', 'w') || ' ' || pg_temp.bal('xe'), 'meals=45000 n=1 paid=10000 waived -10000');

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
