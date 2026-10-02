-- Two sessions at once over a pending pass whose meal is being cancelled.
-- Run against a LOCAL scratch database only, as a superuser over TCP (dblink):
--   psql "$DATABASE_URL" -f supabase/tests/withdrawn_pass_race.sql
--
-- Like admin_orders_race.sql this COMMITS its fixtures, because the racing
-- sessions are dblink connections that cannot see an uncommitted row, and it
-- removes them at the end.
--
-- A member answering an offer locks the pass and then the office-week key. A
-- cancel that withdraws the pass must therefore take the pass before the key
-- (cancelling lunch, removing a meal), or not wait on it at all (a member's
-- own cancel, which locks the order first). G holds a week's key, standing in
-- for a correction in flight, so each pair meets in the order that matters.

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

-- G: the service, holding the office-week key of a day's week.
create function pg_temp.hold_week(p_day text) returns text
language plpgsql as $fn$
begin
  perform pg_temp.connect('g');
  perform * from extensions.dblink('g', format(
    'select private.lock_office_week(%s, %L::date)::text', pg_temp.c('org'), pg_temp.c(p_day)))
    as t(x text);
  return 'ok';
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

-- The day's pass and order, as `pass-status order-status`, and whether the
-- giver was told the pass was taken or turned down.
create function pg_temp.state(p_day text) returns text
language sql stable as $fn$
  select t.status || ' ' || o.status
         || case when exists (select 1 from public.notification_outbox n
                               where n.kind = 'transfer_decided'
                                 and n.dedupe_key like '%:transfer_decided:' || t.id || ':%')
                 then ' told' else '' end
    from public.meal_transfers t join public.orders o on o.id = t.order_id
   where t.id = pg_temp.c('t_' || p_day)::bigint;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('a0e00000-0000-0000-0000-000000000001', 'adm@wprace.test',  'Admin An'),
    ('a0e00000-0000-0000-0000-000000000002', 'teo@wprace.test',  'Teo Van'),
    ('a0e00000-0000-0000-0000-000000000003', 'dinh@wprace.test', 'Dinh Thi')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code) values ('wprace-a', 'Withdrawn race', 'WPR');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('a0e00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('a0e00000-0000-0000-0000-000000000002', 'member', 'TEO'),
  ('a0e00000-0000-0000-0000-000000000003', 'member', 'DINH')
) as u(pid, role, code) on o.slug = 'wprace-a';

-- Dinh has Telegram, so a transfer_decided to the giver would be written.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 660000 + m.id, now() from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug = 'wprace-a';

insert into ctx
select 'org', id::text from public.organizations where slug = 'wprace-a' union all
select 'adm',  'a0e00000-0000-0000-0000-000000000001' union all
select 'teo',  'a0e00000-0000-0000-0000-000000000002' union all
select 'dinh', 'a0e00000-0000-0000-0000-000000000003';

-- One open day per pair, each in its own week, so each gate holds one pair.
insert into ctx
select k, (private.today_in('Asia/Ho_Chi_Minh') + n)::text
  from (values ('r1', 14), ('r2', 21), ('r3', 28), ('r4', 35), ('r5', 42), ('r6', 49)) as d(k, n);
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
select pg_temp.c('org')::bigint, pg_temp.c(k)::date, 'published', now() + interval '60 days',
       pg_temp.c('adm')::uuid, now()
  from unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) k;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Pho', 40000, 0 from public.menus m where m.org_id = pg_temp.c('org')::bigint;
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c('teo')::uuid, 'member', pg_temp.c('teo')::uuid
  from public.menus m where m.org_id = pg_temp.c('org')::bigint;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint;
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
select o.org_id, o.id, o.profile_id, pg_temp.c('dinh')::uuid, o.profile_id
  from public.orders o where o.org_id = pg_temp.c('org')::bigint;

insert into ctx
select 'm_' || k, m.id::text from unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) k
  join public.menus m on m.org_id = pg_temp.c('org')::bigint and m.service_date = pg_temp.c(k)::date;
insert into ctx
select 'o_' || k, o.id::text from unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) k
  join public.orders o on o.menu_id = pg_temp.c('m_' || k)::bigint;
insert into ctx
select 't_' || k, t.id::text from unnest(array['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) k
  join public.meal_transfers t on t.order_id = pg_temp.c('o_' || k)::bigint;

-------------------------------------- R1 cancelling lunch meets an accept

-- A cancels lunch and, holding the day's offer, waits on the week. B (Dinh)
-- accepts the offer and waits on it. Taken after the key instead, A would
-- skip the offer B holds, and B would then accept it on a cancelled day and
-- tell Teo his lunch was taken.
insert into probe values ('R1 G holds the week', pg_temp.hold_week('r1'), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format($q$update public.menus set status = 'cancelled' where id = %s returning 'x'$q$,
  pg_temp.c('m_r1')));
select pg_temp.open('b', 'dinh');
select pg_temp.send('b', format($q$update public.meal_transfers set status = 'accepted' where id = %s returning 'x'$q$,
  pg_temp.c('t_r1')));
insert into probe values ('R1 A waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R1 B waits', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('R1 A cancels lunch', pg_temp.finish('a'), 'ok');
insert into probe values ('R1 B is refused', pg_temp.finish('b'),
  'lunch on ' || to_char(pg_temp.c('r1')::date, 'DD/MM') || ' was cancelled');
insert into probe values ('R1 the offer is withdrawn and Teo is told nothing', pg_temp.state('r1'),
  'cancelled cancelled');

------------------------------------------- R2 an accept, then Teo cancels

-- B accepts and holds the offer; Teo's cancel does not wait on it. The accept
-- came first, so the pass stays accepted on an order that bills nobody.
select pg_temp.open('b', 'dinh');
insert into probe values ('R2 B accepts and holds the offer', pg_temp.run('b',
  format($q$update public.meal_transfers set status = 'accepted' where id = %s returning 'x'$q$,
    pg_temp.c('t_r2'))), 'ok');
select pg_temp.open('a', 'teo');
select pg_temp.send('a', format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s returning 'x'$q$,
  pg_temp.c('o_r2')));
insert into probe values ('R2 Teo''s cancel does not wait on the offer', pg_temp.busy('a'), 'done');
insert into probe values ('R2 Teo cancels', pg_temp.finish('a'), 'ok');
insert into probe values ('R2 B commits', pg_temp.close('b'), 'ok');
insert into probe values ('R2 accepted first, so accepted', pg_temp.state('r2'), 'accepted cancelled told');

------------------------------------------- R3 Teo cancels, then an accept

select pg_temp.open('a', 'teo');
insert into probe values ('R3 Teo cancels and holds his order', pg_temp.run('a',
  format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s returning 'x'$q$,
    pg_temp.c('o_r3'))), 'ok');
select pg_temp.open('b', 'dinh');
select pg_temp.send('b', format($q$update public.meal_transfers set status = 'accepted' where id = %s returning 'x'$q$,
  pg_temp.c('t_r3')));
insert into probe values ('R3 B waits on the offer', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3 Teo commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3 B is refused', pg_temp.finish('b'),
  'the lunch on ' || to_char(pg_temp.c('r3')::date, 'DD/MM')
  || ' offered to you was cancelled, so there is no meal to accept');
insert into probe values ('R3 withdrawn', pg_temp.state('r3'), 'cancelled cancelled');

---------------------------------- R4 Teo's cancel takes no week while held

-- The withdrawal does not re-bill: a member's cancel holds the order, and
-- waiting on the week from there is the wrong way round.
insert into probe values ('R4 G holds the week', pg_temp.hold_week('r4'), 'ok');
select pg_temp.open('a', 'teo');
select pg_temp.send('a', format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s returning 'x'$q$,
  pg_temp.c('o_r4')));
insert into probe values ('R4 Teo''s cancel does not wait for the week', pg_temp.busy('a'), 'done');
insert into probe values ('R4 Teo cancels', pg_temp.finish('a'), 'ok');
insert into probe values ('R4 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('R4 withdrawn', pg_temp.state('r4'), 'cancelled cancelled');

----------------------------------------- R5 removing a meal meets an accept

insert into probe values ('R5 G holds the week', pg_temp.hold_week('r5'), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format('select count(*)::text from public.remove_meal(%s)', pg_temp.c('o_r5')));
select pg_temp.open('b', 'dinh');
select pg_temp.send('b', format($q$update public.meal_transfers set status = 'accepted' where id = %s returning 'x'$q$,
  pg_temp.c('t_r5')));
insert into probe values ('R5 A waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R5 B waits', pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('R5 A removes the meal', pg_temp.finish('a'), 'ok');
insert into probe values ('R5 B is refused', pg_temp.finish('b'),
  'the lunch on ' || to_char(pg_temp.c('r5')::date, 'DD/MM')
  || ' offered to you was cancelled, so there is no meal to accept');
insert into probe values ('R5 withdrawn, Teo told nothing of a pass', pg_temp.state('r5'), 'cancelled cancelled');

---------------------------- R6 an admin's accept meets Teo cancelling

-- A (admin) accepts for Dinh, holding the offer while it waits on the week.
-- Teo's cancel skips the offer A holds rather than wait, so neither waits on
-- the other. A then finds the order cancelled and is refused; the offer is
-- left waiting on a cancelled order, which nobody can accept, Dinh can decline
-- and Teo can withdraw (withdrawn_pass.sql). Teo ordering again withdraws it,
-- so it never reaches his new meal.
insert into probe values ('R6 G holds the week', pg_temp.hold_week('r6'), 'ok');
select pg_temp.open('a', 'adm');
select pg_temp.send('a', format($q$select count(*)::text from public.answer_pass(%s, 'accept')$q$,
  pg_temp.c('t_r6')));
select pg_temp.open('c', 'teo');
select pg_temp.send('c', format($q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s returning 'x'$q$,
  pg_temp.c('o_r6')));
insert into probe values ('R6 A waits', pg_temp.busy('a'), 'waiting');
insert into probe values ('R6 Teo''s cancel does not', pg_temp.busy('c'), 'done');
insert into probe values ('R6 Teo cancels', pg_temp.finish('c'), 'ok');
insert into probe values ('R6 G lets go', pg_temp.close('g'), 'ok');
insert into probe values ('R6 A is refused, no deadlock', pg_temp.finish('a'),
  'nothing is recorded for Teo Van on ' || to_char(pg_temp.c('r6')::date, 'DD/MM')
  || ', so there is no meal to accept');
insert into probe values ('R6 the offer waits on a cancelled order', pg_temp.state('r6'), 'pending cancelled');
select pg_temp.open('a', 'teo');
insert into probe values ('R6 Teo orders again', pg_temp.run('a', format(
  'select count(*)::text from public.set_my_order(%s, (select id from public.menu_items where menu_id = %s))',
  pg_temp.c('m_r6'), pg_temp.c('m_r6'))), 'ok');
insert into probe values ('R6 Teo commits', pg_temp.close('a'), 'ok');
insert into probe values ('R6 which withdraws the old offer, so Dinh cannot take his new meal',
  pg_temp.state('r6'), 'cancelled placed');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

------------------------------------------------------------------- teardown

do $$
declare v_org bigint;
begin
  select id into v_org from public.organizations where slug = 'wprace-a';
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
  delete from public.telegram_links      where org_id = v_org;
  delete from public.memberships         where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@wprace.test';
