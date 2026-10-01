-- Cancelling lunch takes the day off the bill at once.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/cancelling_lunch.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- trg_menu_cancelled cancels the day's orders and, since 20261022100300,
-- re-bills the day's week in the same transaction, so every statement stays the
-- sum of its lines. Every money probe is an exact figure, with the people who
-- must NOT have moved named too.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;
create temp table bal (step text, code text, balance_minor bigint);

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

create function pg_temp.act(p_who text) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', pg_temp.c(p_who)), true);
end $fn$;

-- Every balance in both offices, by short code.
create function pg_temp.snap(p_step text) returns void
language sql as $fn$
  insert into bal
  select p_step, m.short_code, coalesce(b.balance_minor, 0)::bigint
    from public.memberships m
    left join public.v_account_balance b on b.org_id = m.org_id and b.profile_id = m.profile_id
   where m.org_id in (pg_temp.c('org')::bigint, pg_temp.c('org_b')::bigint);
$fn$;

create function pg_temp.moved(p_a text, p_b text) returns text
language sql stable as $fn$
  select coalesce(string_agg(a.code || ' ' || (b.balance_minor - a.balance_minor), ', ' order by a.code), '-')
    from bal a join bal b on b.code = a.code and b.step = p_b
   where a.step = p_a and a.balance_minor is distinct from b.balance_minor;
$fn$;

-- A week's statements as `CODE meals n`, and whether each is the sum of its lines.
create function pg_temp.statements(p_period text) returns text
language sql stable as $fn$
  select coalesce(string_agg(m.short_code || ' ' || st.meals_minor || ' ' || st.meal_count
                             || case when st.meals_minor = (select coalesce(sum(bl.amount_minor), 0)
                                                              from public.billing_lines bl
                                                             where bl.billing_period_id = st.billing_period_id
                                                               and bl.payer_profile_id = st.profile_id)
                                     then '' else ' NOT THE SUM' end,
                             ', ' order by m.short_code), 'none')
    from public.billing_statements st
    join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
   where st.billing_period_id = pg_temp.c(p_period)::bigint;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('ca0c0000-0000-0000-0000-000000000001', 'adm@cancel.test',  'Admin An'),
    ('ca0c0000-0000-0000-0000-000000000002', 'cred@cancel.test', 'Cred Le'),
    ('ca0c0000-0000-0000-0000-000000000003', 'two@cancel.test',  'Two Tran'),
    ('ca0c0000-0000-0000-0000-000000000004', 'oth@cancel.test',  'Other Vu'),
    ('ca0c0000-0000-0000-0000-0000000000b1', 'bown@cancelb.test', 'Be Owner')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, short_code)
values ('cancel-a', 'Cancel A', 'Asia/Ho_Chi_Minh', 'CANA'),
       ('cancel-b', 'Cancel B', 'Asia/Ho_Chi_Minh', 'CANB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('cancel-a', 'ca0c0000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('cancel-a', 'ca0c0000-0000-0000-0000-000000000002', 'member', 'CRED'),
  ('cancel-a', 'ca0c0000-0000-0000-0000-000000000003', 'member', 'TWO'),
  ('cancel-a', 'ca0c0000-0000-0000-0000-000000000004', 'member', 'OTH'),
  ('cancel-b', 'ca0c0000-0000-0000-0000-0000000000b1', 'owner',  'BOWN')
) as u(slug, pid, role, code) on u.slug = o.slug;

-- `x` and `y` are the Monday and Tuesday of a week three weeks out, so both
-- are open and in one billing week; `past` is in a settled week, `bare` in a
-- week nobody has billed yet.
do $$
declare v_t date; v_mon date;
begin
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  v_mon := v_t - (extract(isodow from v_t)::int - 1) + 21;
  insert into ctx values
    ('org', (select id from public.organizations where slug = 'cancel-a')::text),
    ('org_b', (select id from public.organizations where slug = 'cancel-b')::text),
    ('adm',  'ca0c0000-0000-0000-0000-000000000001'),
    ('cred', 'ca0c0000-0000-0000-0000-000000000002'),
    ('two',  'ca0c0000-0000-0000-0000-000000000003'),
    ('oth',  'ca0c0000-0000-0000-0000-000000000004'),
    ('bown', 'ca0c0000-0000-0000-0000-0000000000b1'),
    ('x', v_mon::text), ('y', (v_mon + 1)::text), ('bare', (v_mon + 14)::text),
    ('past', (v_t - (extract(isodow from v_t)::int - 1) - 14)::text);
end $$;

-- One day, one dish at 45 000, an order for each person named.
create function pg_temp.day(p_org text, p_day text, p_who text[], p_cutoff timestamptz) returns void
language plpgsql as $fn$
declare v_menu bigint; v_dish bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, p_cutoff,
          pg_temp.c(case when p_org = 'org' then 'adm' else 'bown' end)::uuid)
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  values (v_menu, pg_temp.c(p_org)::bigint, 'Com ga', 45000, 0) returning id into v_dish;
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  select pg_temp.c(p_org)::bigint, v_menu, pg_temp.c(p_day)::date, pg_temp.c(w)::uuid,
         'member', pg_temp.c(w)::uuid
    from unnest(p_who) as w;
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
  select o.id, o.org_id, o.profile_id, o.menu_id, v_dish, 1
    from public.orders o where o.menu_id = v_menu;
  insert into ctx values ('m_' || p_day || '_' || p_org, v_menu::text);
end $fn$;

select pg_temp.day('org', 'x', array['cred', 'two'], now() + interval '10 days');
select pg_temp.day('org', 'y', array['two', 'oth'], now() + interval '10 days');
select pg_temp.day('org_b', 'x', array['bown'], now() + interval '10 days');
select pg_temp.day('org', 'bare', array['cred'], now() + interval '10 days');
select pg_temp.day('org', 'past', array['two', 'oth'], now() - interval '15 days');

insert into ctx values
  ('p_x', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('x')::date)::text),
  ('p_past', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('past')::date)::text);
select public.run_billing(pg_temp.c('p_x')::bigint) is not null;
select public.run_billing(public.ensure_billing_period(pg_temp.c('org_b')::bigint, pg_temp.c('x')::date)) is not null;
select public.run_billing(pg_temp.c('p_past')::bigint) is not null;
update public.billing_periods set status = 'closed', closed_at = now()
 where id = pg_temp.c('p_past')::bigint;

-- CRED paid 100 000 ahead, so holds credit.
insert into public.payments (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
values (pg_temp.c('org')::bigint, 'cancel-1', 100000, 'LUNCHCRED', now(), '{}');

------------------------------------------------------------------- controls

select pg_temp.snap('k0');
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values
    ('K0 control: role downgraded', current_role, 'authenticated'),
    ('K0 control: x is open', private.day_stage(pg_temp.c('org')::bigint, pg_temp.c('x')::date,
       'published', now() + interval '10 days'), 'open');
end $$;
reset role;
insert into probe values
  ('K0 control: x and y are one week',
   (public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('y')::date)::text), pg_temp.c('p_x')),
  ('K0 control: the week is billed, each statement its lines', pg_temp.statements('p_x'),
   'CRED 45000 1, OTH 45000 1, TWO 90000 2'),
  ('K0 control: CRED''s credit already pays for x',
   (select balance_minor::text from bal where step = 'k0' and code = 'CRED'), '-55000');

----------------------------------------------------- K1 lunch is called off

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('K1 the owner cancels x',
    pg_temp.try(format($q$update public.menus set status = 'cancelled' where id = %s$q$,
      pg_temp.c('m_x_org'))), 'ok');
end $$;
reset role;
select pg_temp.snap('k1');

insert into probe values
  ('K1 the week is re-billed at once: CRED has nothing left, TWO keeps y',
   pg_temp.statements('p_x'), 'OTH 45000 1, TWO 45000 1'),
  ('K1 CRED has all the credit back, TWO pays 45 000 less, nobody else moves',
   pg_temp.moved('k0', 'k1'), 'CRED -45000, TWO -45000'),
  ('K1 CRED holds the whole 100 000 again',
   (select balance_minor::text from bal where step = 'k1' and code = 'CRED'), '-100000'),
  ('K1 the other office''s statement is untouched',
   (select st.meals_minor::text from public.billing_statements st
     where st.org_id = pg_temp.c('org_b')::bigint), '45000'),
  ('K1 the orders on x are cancelled',
   (select string_agg(distinct o.status, ',') from public.orders o
     where o.menu_id = pg_temp.c('m_x_org')::bigint), 'cancelled');

---------------------------------------- K2 a week with no period, a settled one

select pg_temp.snap('k2a');
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('K2 a day in a week nobody has billed is cancelled too',
    pg_temp.try(format($q$update public.menus set status = 'cancelled' where id = %s$q$,
      pg_temp.c('m_bare_org'))), 'ok');
  insert into probe values ('K2 a day in a settled week cannot be cancelled from a browser',
    pg_temp.try(format($q$update public.menus set status = 'cancelled' where id = %s$q$,
      pg_temp.c('m_past_org'))),
    '55000 ordering for ' || to_char(pg_temp.c('past')::date, 'DD/MM')
      || ' has closed, so lunch cannot be called off here; talk to the caterer');
end $$;
reset role;

-- The service role is not held to the stage; a settled week is still not
-- re-billed, so its statements stay as they were settled.
update public.menus set status = 'cancelled' where id = pg_temp.c('m_past_org')::bigint;
select pg_temp.snap('k2b');
insert into probe values
  ('K2 no billing period was made for the unbilled week',
   (select count(*)::text from public.billing_periods
     where org_id = pg_temp.c('org')::bigint
       and pg_temp.c('bare')::date between period_start and period_end), '0'),
  ('K2 the settled week keeps its statements', pg_temp.statements('p_past'),
   'OTH 45000 1, TWO 45000 1'),
  ('K2 and nobody''s balance moved', pg_temp.moved('k2a', 'k2b'), '-');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
