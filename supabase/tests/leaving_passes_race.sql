-- Two sessions at once around somebody leaving who was passed a meal: the
-- giver cancelling it, an admin undoing the pass, the giver leaving too, two
-- people who passed each other meals leaving together, and the leaver
-- accepting an offer on another device. Each both ways round where the order
-- matters.
-- Run against a LOCAL scratch database only, as a superuser over TCP:
--   docker exec -i <db container> psql -h 127.0.0.1 -U supabase_admin -d postgres \
--     -f - < supabase/tests/leaving_passes_race.sql
--
-- Like the other race files this COMMITS its fixtures, because the racing
-- sessions are dblink connections back into the same database, and removes
-- them at the end. Every session has lock_timeout and statement_timeout, so a
-- regression shows up as a timeout or a deadlock (40P01) in an answer.
--
-- Negative control: with 20261025100000 reverted, R1b, R2a, R3b and R5 fail
-- (the meal stays on the leaver's bill, or the giver is never charged).
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

-- The answer of a one-value statement on a session, or its error.
create function pg_temp.val(p_conn text, p_sql text) returns text
language plpgsql as $fn$
declare v text;
begin
  select x into v from extensions.dblink(p_conn, p_sql) as t(x text);
  return coalesce(v, 'null');
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

-- `order status / pass status` on somebody's meal of a day.
create function pg_temp.meal(p_day text, p_who text) returns text
language sql stable as $fn$
  select o.status || ' / '
         || coalesce((select t.status from public.meal_transfers t where t.order_id = o.id
                       order by t.id desc limit 1), 'no pass')
    from public.orders o
   where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.leave_sql() returns text
language sql stable as $fn$
  select format('select public.leave_office(%s)::text', pg_temp.c('org'));
$fn$;

create function pg_temp.cancel_sql(p_day text, p_who text) returns text
language sql stable as $fn$
  select format($q$update public.orders set status = 'cancelled', cancelled_at = now()
                    where id = %s returning 1::text$q$, pg_temp.oid(p_day, p_who));
$fn$;

create function pg_temp.undo_sql(p_day text, p_who text) returns text
language sql stable as $fn$
  select format('select transfer_id::text from public.undo_pass(%s)',
                (select t.id from public.meal_transfers t
                  where t.order_id = pg_temp.oid(p_day, p_who) and t.status = 'accepted'));
$fn$;

-- What each named person is charged in the week, as `CODE amount`.
create function pg_temp.charged(p_who text[]) returns text
language sql stable as $fn$
  select string_agg(upper(w) || ' ' || coalesce((
           select sum(bl.amount_minor) from public.billing_lines bl
            where bl.org_id = pg_temp.c('org')::bigint and bl.payer_profile_id = pg_temp.c(w)::uuid), 0),
         ', ' order by n)
    from unnest(p_who) with ordinality as x(w, n);
$fn$;

-- Every statement in the office that is not the sum of its lines, or `none`.
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

-- Messages queued for somebody, by kind and the start of the body.
create function pg_temp.told(p_who text) returns text
language sql stable as $fn$
  select coalesce(string_agg(n.kind || ' ' || split_part(n.body, ',', 1), ' | ' order by n.id), 'nothing')
    from public.notification_outbox n
   where n.org_id = pg_temp.c('org')::bigint and n.recipient_profile_id = pg_temp.c(p_who)::uuid;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@passrace.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1ec0ace0-0000-0000-0000-000000000001', 'adm'),
    ('1ec0ace0-0000-0000-0000-000000000002', 'ga'), ('1ec0ace0-0000-0000-0000-000000000003', 'ra'),
    ('1ec0ace0-0000-0000-0000-000000000004', 'gb'), ('1ec0ace0-0000-0000-0000-000000000005', 'rb'),
    ('1ec0ace0-0000-0000-0000-000000000006', 'gc'), ('1ec0ace0-0000-0000-0000-000000000007', 'rc'),
    ('1ec0ace0-0000-0000-0000-000000000008', 'gd'), ('1ec0ace0-0000-0000-0000-000000000009', 'rd'),
    ('1ec0ace0-0000-0000-0000-00000000000a', 'ge'), ('1ec0ace0-0000-0000-0000-00000000000b', 're'),
    ('1ec0ace0-0000-0000-0000-00000000000c', 'gf'), ('1ec0ace0-0000-0000-0000-00000000000d', 'rf'),
    ('1ec0ace0-0000-0000-0000-00000000000e', 'gg'), ('1ec0ace0-0000-0000-0000-00000000000f', 'rg'),
    ('1ec0ace0-0000-0000-0000-000000000010', 'oh'), ('1ec0ace0-0000-0000-0000-000000000011', 'rh')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@passrace.test';

insert into public.organizations (slug, name, timezone, short_code)
values ('passrace-a', 'Pass Race A', 'Asia/Ho_Chi_Minh', 'PRA');
insert into ctx select 'org', id::text from public.organizations where slug = 'passrace-a';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org')::bigint, pg_temp.c(x)::uuid,
       case when x = 'adm' then 'owner' else 'member' end, upper(x) || 'Q'
  from unnest(array['adm', 'ga', 'ra', 'gb', 'rb', 'gc', 'rc', 'gd', 'rd', 'ge', 're',
                    'gf', 'rf', 'gg', 'rg', 'oh', 'rh']) as x;

-- The givers are on Telegram, so who is told what can be read.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select ms.id, ms.org_id, 910000 + ms.id, now() from public.memberships ms
 where ms.org_id = pg_temp.c('org')::bigint
   and ms.short_code in ('GAQ', 'GBQ', 'GCQ', 'GDQ', 'GEQ', 'GFQ', 'GGQ', 'OHQ');

-- d1 and d2, three weeks out, both open.
do $$
declare v_t date; v_mon date;
begin
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  v_mon := v_t - (extract(isodow from v_t)::int - 1) + 21;
  insert into ctx values ('d1', v_mon::text), ('d2', (v_mon + 1)::text);
end $$;

insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
select pg_temp.c('org')::bigint, pg_temp.c(d)::date, now() + interval '10 days', pg_temp.c('adm')::uuid
  from unnest(array['d1', 'd2']) as d;
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select pg_temp.m(d), pg_temp.c('org')::bigint, 'Bun', 40000, 0 from unnest(array['d1', 'd2']) as d;

-- Every giver has Bun on d1, and RG on d2 for GG.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select pg_temp.c('org')::bigint, pg_temp.m(x.d), pg_temp.c(x.d)::date, pg_temp.c(x.w)::uuid,
       'member', pg_temp.c(x.w)::uuid
  from (values ('d1', 'ga'), ('d1', 'gb'), ('d1', 'gc'), ('d1', 'gd'), ('d1', 'ge'), ('d1', 'gf'),
               ('d1', 'gg'), ('d2', 'rg'), ('d1', 'oh')) as x(d, w);
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org')::bigint;

-- Each giver's meal passed to their R and accepted; GG and RG passed each
-- other theirs. OH's offer to RH waits.
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, status,
                                   created_by, decided_at, decided_by)
select pg_temp.c('org')::bigint, pg_temp.oid(x.d, x.g), pg_temp.c(x.g)::uuid, pg_temp.c(x.r)::uuid,
       'accepted', pg_temp.c('adm')::uuid, now(), pg_temp.c('adm')::uuid
  from (values ('d1', 'ga', 'ra'), ('d1', 'gb', 'rb'), ('d1', 'gc', 'rc'), ('d1', 'gd', 'rd'),
               ('d1', 'ge', 're'), ('d1', 'gf', 'rf'), ('d1', 'gg', 'rg'), ('d2', 'rg', 'gg')) as x(d, g, r);
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
values (pg_temp.c('org')::bigint, pg_temp.oid('d1', 'oh'), pg_temp.c('oh')::uuid, pg_temp.c('rh')::uuid,
        pg_temp.c('oh')::uuid);

select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date))
       is not null;

insert into probe values
  ('control: every passed meal is billed to its recipient, the offered one to OH',
   pg_temp.charged(array['ga', 'ra', 'gg', 'rg', 'oh', 'rh']), 'GA 0, RA 40000, GG 40000, RG 40000, OH 40000, RH 0'),
  ('control: d1 and d2 are one billing week',
   (select count(distinct public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c(d)::date))::text
      from unnest(array['d1', 'd2']) as d), '1');

-------------------------------- R1 the giver cancels while the recipient leaves

-- R1a: GA cancels the meal he passed, and the owner removes RA before it
-- commits. A removal, not RA leaving: a member's own cancel reaches the bill
-- only at the next re-bill, so RA's statement still holds the meal and
-- leaving would refuse her for it.
create function pg_temp.remove_sql(p_who text) returns text
language sql stable as $fn$
  select format($q$update public.memberships set status = 'inactive'
                    where org_id = %s and profile_id = %L returning 1::text$q$,
                pg_temp.c('org'), pg_temp.c(p_who));
$fn$;

select pg_temp.open('a', 'ga');
insert into probe values ('R1a GA cancels his d1', pg_temp.run('a', pg_temp.cancel_sql('d1', 'ga')), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.remove_sql('ra'));
insert into probe values ('R1a the removal waits for the cancel', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1a the cancel commits', pg_temp.close('a'), 'ok');
insert into probe values ('R1a then RA is removed', pg_temp.finish('b'), 'ok');
select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date))
       is not null;
insert into probe values
  ('R1a the meal stays cancelled and its pass as it was; at the next re-bill nobody pays',
   pg_temp.meal('d1', 'ga') || ' | ' || pg_temp.charged(array['ga', 'ra']), 'cancelled / accepted | GA 0, RA 0'),
  ('R1a GA is told nothing came back', pg_temp.told('ga'), 'nothing');

-- R1b: RB leaves, and GB cancels the meal before it commits.
select pg_temp.open('a', 'rb');
insert into probe values ('R1b RB leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'gb');
select pg_temp.send('b', pg_temp.cancel_sql('d1', 'gb'));
insert into probe values ('R1b the cancel waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R1b the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R1b then GB cancels the meal that came back to him', pg_temp.finish('b'), 'ok');
select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date))
       is not null;
insert into probe values
  ('R1b the pass is undone and the meal cancelled; nobody pays',
   pg_temp.meal('d1', 'gb') || ' | ' || pg_temp.charged(array['gb', 'rb']), 'cancelled / undone | GB 0, RB 0'),
  ('R1b GB was told it came back', pg_temp.told('gb'), 'bill_correction rb left the office');

-------------------------------- R2 an admin undoes the pass while the recipient leaves

-- R2a: the owner undoes GC's pass, and RC leaves before it commits.
select pg_temp.open('a', 'adm');
insert into probe values ('R2a the owner undoes GC''s pass', pg_temp.run('a', pg_temp.undo_sql('d1', 'gc')), 'ok');
select pg_temp.open('b', 'rc');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R2a leaving waits for the undo', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2a the undo commits', pg_temp.close('a'), 'ok');
insert into probe values ('R2a then RC leaves, with nothing left to give back', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R2a GC has the meal and pays; RC does not',
   pg_temp.meal('d1', 'gc') || ' | ' || pg_temp.charged(array['gc', 'rc']), 'placed / undone | GC 40000, RC 0'),
  ('R2a GC is told once, by the undo', pg_temp.told('gc'), 'bill_correction adm undid the pass of your lunch on '
     || to_char(pg_temp.c('d1')::date, 'DD/MM') || ' (Bun');

-- R2b: RD leaves, and the owner undoes GD's pass before it commits.
select pg_temp.open('a', 'rd');
insert into probe values ('R2b RD leaves', pg_temp.run('a', pg_temp.leave_sql()), 'ok');
select pg_temp.open('b', 'adm');
select pg_temp.send('b', pg_temp.undo_sql('d1', 'gd'));
insert into probe values ('R2b the undo waits for the leaving', pg_temp.busy('b'), 'waiting');
insert into probe values ('R2b the leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R2b then the undo is refused', pg_temp.finish('b'), 'that pass is already undone');
insert into probe values
  ('R2b GD has the meal and pays; RD does not',
   pg_temp.meal('d1', 'gd') || ' | ' || pg_temp.charged(array['gd', 'rd']), 'placed / undone | GD 40000, RD 0'),
  ('R2b GD is told once, by the leaving', pg_temp.told('gd'), 'bill_correction rd left the office');

-------------------------------- R3 the giver and the recipient leave together

-- R3a: GE leaves first, then RE.
select pg_temp.open('a', 'ge');
insert into probe values ('R3a GE leaves, cancelling nothing', pg_temp.val('a', pg_temp.leave_sql()), '0');
select pg_temp.open('b', 're');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R3a RE''s leaving waits for GE''s', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3a GE''s leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3a then RE leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R3a the meal goes back to nobody: it is cancelled, and nobody pays',
   pg_temp.meal('d1', 'ge') || ' | ' || pg_temp.charged(array['ge', 're']), 'cancelled / accepted | GE 0, RE 0'),
  ('R3a GE, gone, is told nothing', pg_temp.told('ge'), 'nothing');

-- R3b: RF leaves first, then GF.
select pg_temp.open('a', 'rf');
insert into probe values ('R3b RF leaves', pg_temp.val('a', pg_temp.leave_sql()), '1');
select pg_temp.open('b', 'gf');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R3b GF''s leaving waits for RF''s', pg_temp.busy('b'), 'waiting');
insert into probe values ('R3b RF''s leaving commits', pg_temp.close('a'), 'ok');
insert into probe values ('R3b then GF leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R3b the meal came back to GF and went with his leaving; nobody pays',
   pg_temp.meal('d1', 'gf') || ' | ' || pg_temp.charged(array['gf', 'rf']), 'cancelled / undone | GF 0, RF 0');

-------------------- R4 two people who passed each other meals leave at once

-- A third session holds the publish lock, so both leavings hold their own
-- membership and queue on it: what holding the other's row would deadlock.
select pg_temp.open('c', null);
insert into probe values ('R4 a third session holds the publish lock', pg_temp.run('c', format(
  'select private.lock_office_materialize(%s)::text', pg_temp.c('org'))), 'ok');
select pg_temp.open('a', 'gg');
select pg_temp.send('a', pg_temp.leave_sql());
select pg_temp.open('b', 'rg');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R4 both wait', pg_temp.busy('a') || ' ' || pg_temp.busy('b'), 'waiting waiting');
insert into probe values ('R4 the third session commits', pg_temp.close('c'), 'ok');
insert into probe values ('R4 GG leaves, without a deadlock', pg_temp.finish('a'), 'ok');
insert into probe values ('R4 RG leaves, without a deadlock', pg_temp.finish('b'), 'ok');
-- Whichever got the lock first gave the other's meal back, and the second
-- then cancelled both; which one that was is the lock queue's choice.
insert into probe values
  ('R4 both meals are cancelled, one pass undone, and nobody pays',
   (select string_agg(o.status, ',' order by o.status) from public.orders o
     where o.id in (pg_temp.oid('d1', 'gg'), pg_temp.oid('d2', 'rg'))) || ' | '
   || (select string_agg(t.status, ',' order by t.status) from public.meal_transfers t
        where t.order_id in (pg_temp.oid('d1', 'gg'), pg_temp.oid('d2', 'rg'))) || ' | '
   || pg_temp.charged(array['gg', 'rg']),
   'cancelled,cancelled | accepted,undone | GG 0, RG 0');

-------------------- R5 RH accepts OH's offer on one device, leaves on another

select pg_temp.open('a', 'rh');
insert into probe values ('R5 RH accepts OH''s d1', pg_temp.run('a', format(
  $q$update public.meal_transfers set status = 'accepted' where order_id = %s returning 1::text$q$,
  pg_temp.oid('d1', 'oh'))), 'ok');
select pg_temp.open('b', 'rh');
select pg_temp.send('b', pg_temp.leave_sql());
insert into probe values ('R5 leaving waits for the accept', pg_temp.busy('b'), 'waiting');
insert into probe values ('R5 the accept commits', pg_temp.close('a'), 'ok');
insert into probe values ('R5 then RH leaves', pg_temp.finish('b'), 'ok');
insert into probe values
  ('R5 the meal RH had just accepted goes back to OH, who pays',
   pg_temp.meal('d1', 'oh') || ' | ' || pg_temp.charged(array['oh', 'rh']), 'placed / undone | OH 40000, RH 0');

insert into probe values
  ('every statement is still the sum of its lines', pg_temp.off_sum(), 'none'),
  ('nobody who went is charged',
   (select coalesce(string_agg(m.short_code, ','), 'none') from public.billing_lines bl
      join public.memberships m on m.org_id = bl.org_id and m.profile_id = bl.payer_profile_id
     where bl.org_id = pg_temp.c('org')::bigint and m.status = 'inactive'), 'none');

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
  delete from public.telegram_links      where org_id = v_org;
  delete from public.memberships         where org_id = v_org;
  delete from public.organizations       where id     = v_org;
end $$;

delete from auth.users where email like '%@passrace.test';
