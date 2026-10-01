-- A week's payment reference repeats a year later, and money still finds its
-- person.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/weekly_reference.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- A statement's reference is 'LUNCH' || ISO week || short code, so week 40 of
-- one year and week 40 of the next give one person the same reference.
-- billing_statements_ref_uk refused the second, failing the whole re-bill,
-- until 20261022100200 dropped it. private.payer_from_memo then decides who a
-- memo names: a member's own reference first, then the longest statement
-- reference, newest week first, so a short code that changed hands between
-- the two years credits its holder in the newer one.
--
-- The two weeks are found from today rather than written down, so the file
-- keeps working; a control asserts they really share a week number.

begin;

create temp table probe (label text, got text, want text);
create temp table ctx (k text primary key, v text);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

create function pg_temp.try(p_sql text) returns text
language plpgsql as $fn$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

-- A finished day with one meal of 45 000 for each person named.
create function pg_temp.day(p_day text, p_who text[]) returns void
language plpgsql as $fn$
declare v_menu bigint; v_dish bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by, status)
  values (pg_temp.c('org')::bigint, pg_temp.c(p_day)::date,
          (pg_temp.c(p_day)::date - 1)::timestamp at time zone 'Asia/Ho_Chi_Minh',
          pg_temp.c('adm')::uuid, 'locked')
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  values (v_menu, pg_temp.c('org')::bigint, 'Com ga', 45000, 0) returning id into v_dish;
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  select pg_temp.c('org')::bigint, v_menu, pg_temp.c(p_day)::date, pg_temp.c(w)::uuid,
         'member', pg_temp.c(w)::uuid
    from unnest(p_who) as w;
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
  select o.id, o.org_id, o.profile_id, o.menu_id, v_dish, 1
    from public.orders o where o.menu_id = v_menu;
end $fn$;

-- Bill a day's week, and say how it went.
create function pg_temp.bill(p_day text) returns text
language plpgsql as $fn$
declare v_p bigint;
begin
  v_p := public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c(p_day)::date);
  insert into ctx values ('p_' || p_day, v_p::text) on conflict (k) do nothing;
  perform public.run_billing(v_p);
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

-- Who holds a reference: `CODE meals` per statement, oldest week first.
create function pg_temp.holders(p_ref text) returns text
language sql stable as $fn$
  select coalesce(string_agg(m.short_code || ' ' || st.meals_minor, ', ' order by st.billing_period_id), 'none')
    from public.billing_statements st
    join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
   where st.org_id = pg_temp.c('org')::bigint and st.payment_ref = p_ref;
$fn$;

create function pg_temp.payer(p_memo text) returns text
language sql stable as $fn$
  select coalesce((select m.short_code from public.memberships m
                    where m.org_id = pg_temp.c('org')::bigint
                      and m.profile_id = private.payer_from_memo(pg_temp.c('org')::bigint, p_memo)),
                  'nobody');
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('7ef00000-0000-0000-0000-000000000001', 'adm@wref.test', 'Admin An'),
    ('7ef00000-0000-0000-0000-000000000002', 'teo@wref.test', 'Teo Van'),
    ('7ef00000-0000-0000-0000-000000000003', 'lan@wref.test', 'Lan Le'),
    ('7ef00000-0000-0000-0000-000000000004', 'hoa@wref.test', 'Hoa Tran')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, short_code)
values ('wref', 'Weekly Ref', 'Asia/Ho_Chi_Minh', 'WREF');

-- LAN holds HAI in the first year; HOA starts as HOAX and takes HAI later.
insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('7ef00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('7ef00000-0000-0000-0000-000000000002', 'member', 'TEO'),
  ('7ef00000-0000-0000-0000-000000000003', 'member', 'HAI'),
  ('7ef00000-0000-0000-0000-000000000004', 'member', 'HOAX')
) as u(pid, role, code) on o.slug = 'wref';

-- `now` is two weeks back, so its week is over; `then` is the same weekday 52
-- weeks earlier, or 53 when a 53-week ISO year lies between.
do $$
declare v_now date; v_then date; v_org bigint;
begin
  select id into v_org from public.organizations where slug = 'wref';
  v_now  := private.today_in('Asia/Ho_Chi_Minh') - 14;
  v_then := v_now - 364;
  if to_char(v_then, 'IW') <> to_char(v_now, 'IW') then v_then := v_now - 371; end if;
  insert into ctx values
    ('org', v_org::text), ('now', v_now::text), ('then', v_then::text),
    ('adm', '7ef00000-0000-0000-0000-000000000001'),
    ('teo', '7ef00000-0000-0000-0000-000000000002'),
    ('lan', '7ef00000-0000-0000-0000-000000000003'),
    ('hoa', '7ef00000-0000-0000-0000-000000000004');
end $$;

----------------------------------------------------------- R1 the first year

select pg_temp.day('then', array['teo', 'lan']);
insert into probe values ('R1 the first year bills', pg_temp.bill('then'), 'ok');
-- Settled, as a week a year old is: nothing re-bills it under a new code.
update public.billing_periods set status = 'closed', closed_at = now()
 where id = pg_temp.c('p_then')::bigint;

insert into ctx
select 'ref_teo', payment_ref from public.billing_statements
 where billing_period_id = pg_temp.c('p_then')::bigint and profile_id = pg_temp.c('teo')::uuid;
insert into ctx
select 'ref_hai', payment_ref from public.billing_statements
 where billing_period_id = pg_temp.c('p_then')::bigint and profile_id = pg_temp.c('lan')::uuid;

-------------------------------------------------- R2 the code changes hands

-- An admin gives LAN a new code and HAI to HOA. Done as the service role,
-- which is what the admin's write amounts to here; the clash check still runs.
update public.memberships set short_code = 'LANX'
 where org_id = pg_temp.c('org')::bigint and profile_id = pg_temp.c('lan')::uuid;
insert into probe values ('R2 HOA can take HAI, which no current reference contains',
  pg_temp.try(format($q$update public.memberships set short_code = 'HAI'
                        where org_id = %s and profile_id = %L$q$,
    pg_temp.c('org'), pg_temp.c('hoa'))), 'ok');

---------------------------------------------------------- R3 the next year

select pg_temp.day('now', array['teo', 'hoa']);
insert into probe values ('R3 the same week a year on bills, though the references repeat',
  pg_temp.bill('now'), 'ok');

insert into probe values
  ('R0 control: the two weeks share a week number, so the references are the same text',
   (select string_agg(to_char(bp.period_start, 'IW'), ',' order by bp.period_start)
      from public.billing_periods bp
     where bp.id in (pg_temp.c('p_then')::bigint, pg_temp.c('p_now')::bigint)),
   to_char(pg_temp.c('now')::date, 'IW') || ',' || to_char(pg_temp.c('now')::date, 'IW')),
  ('R0 control: a year apart',
   ((pg_temp.c('now')::date - pg_temp.c('then')::date) in (364, 371))::text, 'true'),
  ('R3 TEO holds his reference in both years, one meal each',
   pg_temp.holders(pg_temp.c('ref_teo')), 'TEO 45000, TEO 45000'),
  ('R3 the HAI reference is LAN''s (now LANX) in the first year and HOA''s in the next',
   pg_temp.holders(pg_temp.c('ref_hai')), 'LANX 45000, HAI 45000');

-------------------------------------------------- R4 the memo finds the person

insert into probe values
  ('R4 a week-style memo names TEO, whichever year it means',
   pg_temp.payer(pg_temp.c('ref_teo')), 'TEO'),
  ('R4 folded the way a bank sends it',
   pg_temp.payer('ck ' || lower(substr(pg_temp.c('ref_teo'), 1, 5)) || ' '
                 || substr(pg_temp.c('ref_teo'), 6, 2) || ' ' || lower(substr(pg_temp.c('ref_teo'), 8))),
   'TEO'),
  ('R4 a week-style memo for HAI names its newest holder', pg_temp.payer(pg_temp.c('ref_hai')), 'HAI'),
  ('R4 that is HOA',
   private.payer_from_memo(pg_temp.c('org')::bigint, pg_temp.c('ref_hai'))::text, pg_temp.c('hoa')),
  ('R4 a member''s own reference names its current holder',
   private.payer_from_memo(pg_temp.c('org')::bigint, 'LUNCHHAI')::text, pg_temp.c('hoa')),
  ('R4 LAN''s new code names LAN',
   private.payer_from_memo(pg_temp.c('org')::bigint, 'LUNCHLANX')::text, pg_temp.c('lan'));

-------------------------------------------------- R5 and the money lands there

insert into public.payments (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
values (pg_temp.c('org')::bigint, 'wref-1', 45000, pg_temp.c('ref_hai') || ' chuyen tien', now(), '{}'),
       (pg_temp.c('org')::bigint, 'wref-2', 45000, 'ck ' || pg_temp.c('ref_teo'), now(), '{}');

insert into probe values
  ('R5 the HAI transfer is HOA''s, on this year''s statement',
   (select p.profile_id::text || ' ' || (p.matched_statement_id = st.id)::text
      from public.payments p
      join public.billing_statements st on st.billing_period_id = pg_temp.c('p_now')::bigint
                                       and st.profile_id = pg_temp.c('hoa')::uuid
     where p.provider_txn_id = 'wref-1'),
   pg_temp.c('hoa') || ' true'),
  ('R5 HOA owes nothing now, and LAN''s settled week is untouched',
   (select string_agg(m.short_code || ' ' || b.balance_minor, ', ' order by m.short_code)
      from public.v_account_balance b
      join public.memberships m on m.org_id = b.org_id and m.profile_id = b.profile_id
     where b.org_id = pg_temp.c('org')::bigint and m.short_code in ('HAI', 'LANX')),
   'HAI 0, LANX 45000'),
  ('R5 the TEO transfer is TEO''s',
   (select profile_id::text from public.payments where provider_txn_id = 'wref-2'), pg_temp.c('teo'));

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
