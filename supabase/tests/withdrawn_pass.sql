-- A pass ends with its meal: when an order stops being placed, by lunch being
-- cancelled, by its owner cancelling it or by an admin removing it, a pending
-- pass on it is withdrawn, quietly, and nobody can accept or decline a pass on
-- an order that is not placed. An accepted pass is left alone and bills
-- nobody once its order is cancelled.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/withdrawn_pass.sql
--
-- Builds its own fixtures and rolls everything back. A pass reads as
-- `status decided-by reason`, and a refusal as its SQLSTATE and sentence.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select on ctx to authenticated;

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

create function pg_temp.as_user(p_who text, p_sql text) returns text
language plpgsql as $fn$
declare v text := 'ok';
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', pg_temp.c(p_who)), true);
  set local role authenticated;
  begin
    execute p_sql;
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return v;
end $fn$;

create function pg_temp.m(p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c('org')::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.o(p_day text, p_who text default 'teo') returns bigint
language sql stable as $fn$
  select id from public.orders where menu_id = pg_temp.m(p_day) and profile_id = pg_temp.c(p_who)::uuid;
$fn$;

-- The newest pass on the day's order of TEO's.
create function pg_temp.pass_of(p_day text) returns text
language sql stable as $fn$
  select t.status || ' ' || coalesce(ms.short_code, '-') || ' ' || coalesce(t.reason, '-')
         || case when (t.status = 'pending') = (t.decided_at is null) then '' else ' BAD DATE' end
    from public.meal_transfers t
    left join public.memberships ms on ms.org_id = t.org_id and ms.profile_id = t.decided_by
   where t.order_id = pg_temp.o(p_day)
   order by t.id desc limit 1;
$fn$;

create function pg_temp.pass_id(p_day text) returns bigint
language sql stable as $fn$
  select max(t.id) from public.meal_transfers t where t.order_id = pg_temp.o(p_day);
$fn$;

create function pg_temp.offer(p_day text) returns text
language sql as $fn$
  select pg_temp.as_user('teo', format(
    'insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
     values (%s, %s, %L, %L, %L)', pg_temp.c('org'), pg_temp.o(p_day),
    pg_temp.c('teo'), pg_temp.c('dinh'), pg_temp.c('teo')));
$fn$;

create function pg_temp.answer(p_who text, p_day text, p_status text) returns text
language sql as $fn$
  select pg_temp.as_user(p_who, format(
    'update public.meal_transfers set status = %L where id = %s', p_status, pg_temp.pass_id(p_day)));
$fn$;

-- What reached the outbox about a day since the mark, as `kind:CODE`.
create function pg_temp.told(p_day text) returns text
language sql stable as $fn$
  select coalesce(string_agg(n.kind || ':' || ms.short_code, ',' order by n.id), '-')
    from public.notification_outbox n
    join public.memberships ms on ms.org_id = n.org_id and ms.profile_id = n.recipient_profile_id
   where n.org_id = pg_temp.c('org')::bigint
     and n.id > coalesce(pg_temp.c('mark_' || p_day)::bigint, 0)
     and n.kind in ('transfer_offer', 'transfer_decided', 'bill_correction');
$fn$;

create function pg_temp.mark(p_day text) returns void
language sql as $fn$
  insert into ctx values ('mark_' || p_day,
    (select coalesce(max(id), 0)::text from public.notification_outbox))
  on conflict (k) do update set v = excluded.v;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.code || '@wpass.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('0e700000-0000-0000-0000-000000000001', 'adm',  'Admin An'),
    ('0e700000-0000-0000-0000-000000000002', 'teo',  'Teo Van'),
    ('0e700000-0000-0000-0000-000000000003', 'dinh', 'Dinh Thi')
  ) as u(id, code, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code) values ('wpass-a', 'Withdrawn A', 'WPA');
insert into ctx
select 'org', id::text from public.organizations where slug = 'wpass-a' union all
select split_part(email, '@', 1), id::text from auth.users where email like '%@wpass.test';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org')::bigint, pg_temp.c(x)::uuid,
       case x when 'adm' then 'owner' else 'member' end, upper(x)
  from unnest(array['adm', 'teo', 'dinh']) as x;
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select ms.id, ms.org_id, 770000 + ms.id, now() from public.memberships ms
 where ms.org_id = pg_temp.c('org')::bigint;

-- One open day per case, each in a week of its own.
insert into ctx
select k, (private.today_in('Asia/Ho_Chi_Minh') + n)::text
  from (values ('lunch', 14), ('own', 21), ('remove', 28), ('took', 35), ('stale', 42),
               ('live', 49)) as d(k, n);

select pg_temp.as_user('adm', format(
  'select * from public.publish_menu(%s, %L::date, %L::timestamptz, %L::jsonb, %L, %L::jsonb)',
  pg_temp.c('org'), pg_temp.c(k), now() + interval '9 days',
  '[{"name":"Com ga","price_minor":45000}]', 'raw', '{}'))
  from unnest(array['lunch', 'own', 'remove', 'took', 'stale', 'live']) as k;
select pg_temp.as_user('teo', format(
  'select * from public.set_my_order(%s, (select id from public.menu_items where menu_id = %s))',
  pg_temp.m(k), pg_temp.m(k)))
  from unnest(array['lunch', 'own', 'remove', 'took', 'stale', 'live']) as k;

insert into probe
select 'F0 TEO offers ' || k || ' to DINH', pg_temp.offer(k), 'ok'
  from unnest(array['lunch', 'own', 'remove', 'took', 'stale', 'live']) as k;

------------------------------------------------------ L lunch is cancelled

select pg_temp.mark('lunch');
insert into probe values
  ('L0 the admin cancels lunch', pg_temp.as_user('adm', format(
     'update public.menus set status = %L where id = %s', 'cancelled', pg_temp.m('lunch'))), 'ok');
insert into probe values
  ('L1 the offer is withdrawn, by the admin, saying why', pg_temp.pass_of('lunch'),
   'cancelled ADM withdrawn: lunch on ' || to_char(pg_temp.c('lunch')::date, 'DD/MM') || ' was cancelled'),
  ('L2 DINH cannot take it', pg_temp.answer('dinh', 'lunch', 'accepted'),
   '55000 lunch on ' || to_char(pg_temp.c('lunch')::date, 'DD/MM') || ' was cancelled'),
  ('L2 nor turn it down', pg_temp.answer('dinh', 'lunch', 'declined'),
   '55000 lunch on ' || to_char(pg_temp.c('lunch')::date, 'DD/MM') || ' was cancelled');
insert into probe values
  ('L3 still withdrawn', split_part(pg_temp.pass_of('lunch'), ' ', 1), 'cancelled'),
  ('L4 and nobody is told anything', pg_temp.told('lunch'), '-');

-------------------------------------------------- O TEO cancels his own order

select pg_temp.mark('own');
insert into probe values
  ('O0 TEO says he is not eating', pg_temp.as_user('teo', format(
     'update public.orders set status = %L, cancelled_at = now() where id = %s',
     'cancelled', pg_temp.o('own'))), 'ok');
insert into probe values
  ('O1 the offer is withdrawn, by him, saying why', pg_temp.pass_of('own'),
   'cancelled TEO withdrawn: the meal was cancelled'),
  ('O2 DINH cannot take it', pg_temp.answer('dinh', 'own', 'accepted'),
   '55000 the lunch on ' || to_char(pg_temp.c('own')::date, 'DD/MM')
   || ' offered to you was cancelled, so there is no meal to accept'),
  ('O2 nor turn it down', pg_temp.answer('dinh', 'own', 'declined'),
   '55000 the lunch on ' || to_char(pg_temp.c('own')::date, 'DD/MM')
   || ' offered to you was cancelled, so there is no meal to turn down');
insert into probe values
  ('O3 nobody is told anything', pg_temp.told('own'), '-'),
  ('O4 TEO orders again', pg_temp.as_user('teo', format(
     'select * from public.set_my_order(%s, (select id from public.menu_items where menu_id = %s))',
     pg_temp.m('own'), pg_temp.m('own'))), 'ok');
insert into probe values
  ('O4 the old offer stays withdrawn', pg_temp.pass_of('own'),
   'cancelled TEO withdrawn: the meal was cancelled'),
  ('O5 and he can offer the meal afresh', pg_temp.offer('own'), 'ok');
insert into probe values
  ('O5 a new offer, waiting', split_part(pg_temp.pass_of('own'), ' ', 1), 'pending');

--------------------------------------------------- R an admin removes the meal

select pg_temp.mark('remove');
insert into probe values
  ('R0 the admin removes TEO''s meal', pg_temp.as_user('adm', format(
     'select * from public.remove_meal(%s)', pg_temp.o('remove'))), 'ok');
insert into probe values
  ('R1 the offer is withdrawn, by the admin', pg_temp.pass_of('remove'),
   'cancelled ADM withdrawn: the meal was cancelled'),
  ('R2 only TEO hears of it, as the removal', pg_temp.told('remove'), 'bill_correction:TEO'),
  ('R3 DINH cannot take it', pg_temp.answer('dinh', 'remove', 'accepted'),
   '55000 the lunch on ' || to_char(pg_temp.c('remove')::date, 'DD/MM')
   || ' offered to you was cancelled, so there is no meal to accept');

------------------------------------------- T an accepted pass, then cancelled

select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('took')::date));

insert into probe values
  ('T0 DINH takes TEO''s meal', pg_temp.answer('dinh', 'took', 'accepted'), 'ok');
insert into probe values
  ('T0 it is on DINH''s bill',
   (select string_agg(ms.short_code || ' ' || bl.amount_minor, ',')
      from public.billing_lines bl
      join public.memberships ms on ms.org_id = bl.org_id and ms.profile_id = bl.payer_profile_id
     where bl.order_id = pg_temp.o('took')), 'DINH 45000'),
  ('T1 TEO then cancels his order', pg_temp.as_user('teo', format(
     'update public.orders set status = %L, cancelled_at = now() where id = %s',
     'cancelled', pg_temp.o('took'))), 'ok');
select public.run_billing(public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('took')::date));
insert into probe values
  ('T2 the pass stays accepted: it happened', pg_temp.pass_of('took'), 'accepted DINH -'),
  ('T3 and the cancelled meal bills nobody',
   (select count(*)::text from public.billing_lines bl where bl.order_id = pg_temp.o('took')), '0'),
  ('T3 DINH owes nothing for it', private.account_balance(pg_temp.c('org')::bigint,
                                                          pg_temp.c('dinh')::uuid)::text, '0');

-------------------------------------- S a pass left waiting on a cancelled order

-- Only a cancel racing an answer leaves one (withdrawn_pass_race.sql); made
-- here by switching the withdrawal off for one statement.
alter table public.orders disable trigger orders_withdraw_pass;
select pg_temp.as_user('teo', format(
  'update public.orders set status = %L, cancelled_at = now() where id = %s',
  'cancelled', pg_temp.o('stale')));
alter table public.orders enable trigger orders_withdraw_pass;

insert into probe values
  ('S0 the offer waits on a cancelled order', split_part(pg_temp.pass_of('stale'), ' ', 1), 'pending'),
  ('S1 DINH cannot take it', pg_temp.answer('dinh', 'stale', 'accepted'),
   '55000 the lunch on ' || to_char(pg_temp.c('stale')::date, 'DD/MM')
   || ' offered to you was cancelled, so there is no meal to accept'),
  ('S1 nor turn it down', pg_temp.answer('dinh', 'stale', 'declined'),
   '55000 the lunch on ' || to_char(pg_temp.c('stale')::date, 'DD/MM')
   || ' offered to you was cancelled, so there is no meal to turn down'),
  ('S2 an admin cannot accept it for her', pg_temp.as_user('adm', format(
     'select * from public.answer_pass(%s, %L)', pg_temp.pass_id('stale'), 'accept')),
   '55000 nothing is recorded for Teo Van on ' || to_char(pg_temp.c('stale')::date, 'DD/MM')
   || ', so there is no meal to accept'),
  ('S2 nor decline it for her', pg_temp.as_user('adm', format(
     'select * from public.answer_pass(%s, %L)', pg_temp.pass_id('stale'), 'decline')),
   '55000 nothing is recorded for Teo Van on ' || to_char(pg_temp.c('stale')::date, 'DD/MM')
   || ', so there is no meal to turn down');
insert into probe values
  ('S3 TEO can still withdraw it', pg_temp.answer('teo', 'stale', 'cancelled'), 'ok');
insert into probe values
  ('S3 withdrawn', pg_temp.pass_of('stale'), 'cancelled TEO -');

---------------------------------------------- P a placed order, as before

insert into probe values
  ('P0 DINH turns down an offer on a placed order', pg_temp.answer('dinh', 'live', 'declined'), 'ok');
insert into probe values
  ('P0 declined', pg_temp.pass_of('live'), 'declined DINH -');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
