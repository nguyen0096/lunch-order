-- Re-billing a week: every statement in it is the sum of its lines, including
-- a statement whose last line left, and credit comes back when a meal goes.
-- Also: nobody deletes a pass, which would move a charge with no re-bill.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/rebill_statements.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- One member per scenario, each with their own payment, so every probe can
-- name an exact balance and an exact statement row (meals, count, paid,
-- status) computed from the menu prices below, never from the function under
-- test. `none` means the person has no statement in that week. Probes run as
-- the owner (postgres) after `reset role`; the corrections themselves run as
-- the office admin, through the same RPCs the app calls.
--
-- Prices: Cơm gà 45000, Bún bò 60000, Phở 30000.
-- Weeks:  w0 open (two weeks ago), w1 settled (last week), w2 open (this week).

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;

create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;

create temp table snap (step text, k text, v text);

------------------------------------------------------------------- helpers

create function pg_temp.pid(p_code text) returns uuid language sql stable as $$
  select m.profile_id from public.memberships m
    join public.organizations o on o.id = m.org_id and o.slug in ('rb-a','rb-b')
   where m.short_code = p_code;
$$;

create function pg_temp.bal(p_code text) returns text language sql stable as $$
  select b.balance_minor::text from public.v_account_balance b
    join public.organizations o on o.id = b.org_id and o.slug in ('rb-a','rb-b')
   where b.profile_id = pg_temp.pid(p_code);
$$;

-- One person's statement in one week, as the row the Bill screen reads.
create function pg_temp.st(p_code text, p_week text) returns text language sql stable as $$
  select coalesce(
    (select format('meals=%s n=%s paid=%s %s', st.meals_minor, st.meal_count,
                   st.paid_minor, st.status)
       from public.billing_statements st
      where st.billing_period_id = (select v::bigint from ctx where k = p_week)
        and st.profile_id = pg_temp.pid(p_code)),
    'none');
$$;

create function pg_temp.st_id(p_code text, p_week text) returns bigint language sql stable as $$
  select st.id from public.billing_statements st
   where st.billing_period_id = (select v::bigint from ctx where k = p_week)
     and st.profile_id = pg_temp.pid(p_code);
$$;

create function pg_temp.item(p_date text, p_name text) returns bigint language sql stable as $$
  select mi.id from public.menu_items mi
    join public.menus mu on mu.id = mi.menu_id
   where mu.org_id = (select v::bigint from ctx where k = 'org_a')
     and mu.service_date = (select v::date from ctx where k = p_date)
     and mi.name = p_name;
$$;

create function pg_temp.order_of(p_code text, p_date text) returns bigint language sql stable as $$
  select o.id from public.orders o
   where o.profile_id = pg_temp.pid(p_code)
     and o.service_date = (select v::date from ctx where k = p_date);
$$;

-- Every statement against the lines under it, for one office: a row per
-- (week, person) where the two disagree, or where a statement has no line.
create function pg_temp.mismatches(p_org text) returns text language sql stable as $$
  with l as (
    select bl.billing_period_id, bl.payer_profile_id as profile_id,
           count(*)::int as n, sum(bl.amount_minor)::bigint as amt
      from public.billing_lines bl where bl.org_id = (select v::bigint from ctx where k = p_org)
     group by 1, 2),
  s as (
    select st.billing_period_id, st.profile_id, st.meal_count as n, st.meals_minor as amt
      from public.billing_statements st where st.org_id = (select v::bigint from ctx where k = p_org))
  select count(*)::text from l full join s using (billing_period_id, profile_id)
   where l.n is distinct from s.n or l.amt is distinct from s.amt;
$$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.nm)
  from (values
    ('cccccccc-0000-0000-0000-000000000001'::uuid, 'admn@rba.test', 'Admin An'),
    ('cccccccc-0000-0000-0000-000000000002'::uuid, 'cred@rba.test', 'Credit Case'),
    ('cccccccc-0000-0000-0000-000000000003'::uuid, 'menu@rba.test', 'Menu Case'),
    ('cccccccc-0000-0000-0000-000000000004'::uuid, 'chng@rba.test', 'Change Case'),
    ('cccccccc-0000-0000-0000-000000000005'::uuid, 'twom@rba.test', 'Two Meals'),
    ('cccccccc-0000-0000-0000-000000000006'::uuid, 'sprd@rba.test', 'Spread Case'),
    ('cccccccc-0000-0000-0000-000000000007'::uuid, 'setl@rba.test', 'Settled Case'),
    ('cccccccc-0000-0000-0000-000000000008'::uuid, 'give@rba.test', 'Giver'),
    ('cccccccc-0000-0000-0000-000000000009'::uuid, 'take@rba.test', 'Taker'),
    ('cccccccc-0000-0000-0000-000000000010'::uuid, 'givb@rba.test', 'Giver Two'),
    ('cccccccc-0000-0000-0000-000000000011'::uuid, 'nocr@rba.test', 'No Credit'),
    ('cccccccc-0000-0000-0000-000000000012'::uuid, 'waiv@rba.test', 'Waived Case'),
    ('cccccccc-0000-0000-0000-000000000013'::uuid, 'canc@rba.test', 'Cancel Case'),
    ('dddddddd-0000-0000-0000-000000000001'::uuid, 'bown@rbb.test', 'B Owner'),
    ('dddddddd-0000-0000-0000-000000000002'::uuid, 'bmem@rbb.test', 'B Member')
  ) as u(id, email, nm)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time, short_code)
values ('rb-a','Rebill A','Asia/Ho_Chi_Minh','16:00','RBA'),
       ('rb-b','Rebill B','Asia/Ho_Chi_Minh','16:00','RBB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid, u.role, u.code from public.organizations o
join (values
  ('rb-a','cccccccc-0000-0000-0000-000000000001'::uuid,'owner', 'ADMN'),
  ('rb-a','cccccccc-0000-0000-0000-000000000002'::uuid,'member','CRED'),
  ('rb-a','cccccccc-0000-0000-0000-000000000003'::uuid,'member','MENU'),
  ('rb-a','cccccccc-0000-0000-0000-000000000004'::uuid,'member','CHNG'),
  ('rb-a','cccccccc-0000-0000-0000-000000000005'::uuid,'member','TWOM'),
  ('rb-a','cccccccc-0000-0000-0000-000000000006'::uuid,'member','SPRD'),
  ('rb-a','cccccccc-0000-0000-0000-000000000007'::uuid,'member','SETL'),
  ('rb-a','cccccccc-0000-0000-0000-000000000008'::uuid,'member','GIVE'),
  ('rb-a','cccccccc-0000-0000-0000-000000000009'::uuid,'member','TAKE'),
  ('rb-a','cccccccc-0000-0000-0000-000000000010'::uuid,'member','GIVB'),
  ('rb-a','cccccccc-0000-0000-0000-000000000011'::uuid,'member','NOCR'),
  ('rb-a','cccccccc-0000-0000-0000-000000000012'::uuid,'member','WAIV'),
  ('rb-a','cccccccc-0000-0000-0000-000000000013'::uuid,'member','CANC'),
  ('rb-b','dddddddd-0000-0000-0000-000000000001'::uuid,'owner', 'BOWN'),
  ('rb-b','dddddddd-0000-0000-0000-000000000002'::uuid,'member','BMEM')
) as u(slug,pid,role,code) on u.slug = o.slug;

do $$
declare v_mon date := current_date - ((extract(isodow from current_date)::int - 1 + 7) % 7);
begin
  insert into ctx values
    ('org_a', (select id from public.organizations where slug = 'rb-a')::text),
    ('org_b', (select id from public.organizations where slug = 'rb-b')::text),
    ('w0', (v_mon - 14)::text), ('w1', (v_mon - 7)::text), ('w2', v_mon::text),
    ('d0', (v_mon - 13)::text), ('d1', (v_mon - 6)::text),
    ('d2a', (v_mon + 1)::text), ('d2b', (v_mon + 2)::text);
end $$;

-- Locked, as a week being settled is, and inserted at that status because
-- `menus_lifecycle` is BEFORE UPDATE and this file is not about menus.
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select (select v::bigint from ctx where k = 'org_a'), d.v::date, 'locked',
       (d.v::date::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
       'cccccccc-0000-0000-0000-000000000001'
  from ctx d where d.k in ('d0','d1','d2a','d2b');

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select (select v::bigint from ctx where k = 'org_b'), d.v::date, 'locked',
       (d.v::date::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
       'dddddddd-0000-0000-0000-000000000001'
  from ctx d where d.k = 'd2a';

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  join public.organizations o on o.id = m.org_id and o.slug in ('rb-a','rb-b')
  join lateral (values ('Cơm gà', 45000, 0), ('Bún bò', 60000, 1), ('Phở', 30000, 2))
       as v(nm, pr, pos) on true;

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select mu.org_id, mu.id, mu.service_date, pg_temp.pid(v.code), 'member', pg_temp.pid(v.code)
  from (values
    ('CHNG','d2a','Cơm gà'),
    ('TWOM','d2a','Cơm gà'), ('TWOM','d2b','Phở'),
    ('SPRD','d0','Bún bò'),  ('SPRD','d2a','Bún bò'),
    ('SETL','d1','Cơm gà'),  ('SETL','d2a','Cơm gà'),
    ('GIVE','d2a','Cơm gà'),
    ('GIVB','d2a','Cơm gà'),
    ('NOCR','d2a','Cơm gà'),
    ('WAIV','d2a','Cơm gà'),
    ('CANC','d2a','Cơm gà'),
    ('BMEM','d2a','Cơm gà')
  ) as v(code, dk, nm)
  join public.menus mu on mu.service_date = (select c.v::date from ctx c where c.k = v.dk)
  join public.memberships m on m.org_id = mu.org_id and m.short_code = v.code;

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from (values
    ('CHNG','d2a','Cơm gà'),
    ('TWOM','d2a','Cơm gà'), ('TWOM','d2b','Phở'),
    ('SPRD','d0','Bún bò'),  ('SPRD','d2a','Bún bò'),
    ('SETL','d1','Cơm gà'),  ('SETL','d2a','Cơm gà'),
    ('GIVE','d2a','Cơm gà'),
    ('GIVB','d2a','Cơm gà'),
    ('NOCR','d2a','Cơm gà'),
    ('WAIV','d2a','Cơm gà'),
    ('CANC','d2a','Cơm gà'),
    ('BMEM','d2a','Cơm gà')
  ) as v(code, dk, nm)
  join public.orders o on o.profile_id = pg_temp.pid(v.code)
                      and o.service_date = (select c.v::date from ctx c where c.k = v.dk)
  join public.menu_items mi on mi.menu_id = o.menu_id and mi.name = v.nm;

-- Bill the weeks, then pay, then settle w1. Memo null: the money belongs to
-- the person named on the row, which is what `trg_payment_apply` does when a
-- memo names nobody.
do $$
declare v_a bigint := (select v::bigint from ctx where k = 'org_a');
        v_b bigint := (select v::bigint from ctx where k = 'org_b');
        p0 bigint; p1 bigint; p2 bigint; pb bigint;
begin
  p0 := public.ensure_billing_period(v_a, (select v::date from ctx where k = 'w0'));
  p1 := public.ensure_billing_period(v_a, (select v::date from ctx where k = 'w1'));
  p2 := public.ensure_billing_period(v_a, (select v::date from ctx where k = 'w2'));
  pb := public.ensure_billing_period(v_b, (select v::date from ctx where k = 'w2'));
  insert into ctx values ('p0', p0::text), ('p1', p1::text), ('p2', p2::text), ('pb', pb::text);
  perform public.run_billing(p0);
  perform public.run_billing(p1);
  perform public.run_billing(p2);
  perform public.run_billing(pb);

  insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                               memo, received_at, raw, profile_id)
  select m.org_id, 'sepay', 'rb-' || v.code, v.amt, null,
         now() - interval '1 hour', '{}'::jsonb, m.profile_id
    from (values ('CRED', 203000), ('MENU', 100000), ('CHNG', 50000), ('TWOM', 100000),
                 ('SPRD', 90000),  ('SETL', 60000),  ('GIVE', 100000), ('GIVB', 50000),
                 ('WAIV', 20000),  ('CANC', 50000),  ('BMEM', 100000)) as v(code, amt)
    join public.memberships m on m.short_code = v.code
    join public.organizations o on o.id = m.org_id and o.slug in ('rb-a','rb-b');

  update public.billing_periods set status = 'closed', closed_at = now() where id = p1;
end $$;

insert into snap
select 'start', m.short_code, pg_temp.bal(m.short_code)
  from public.memberships m where m.org_id = (select v::bigint from ctx where k = 'org_b');
insert into snap
select 'start', 'b_statements', string_agg(format('%s/%s/%s/%s', st.id, st.meals_minor, st.paid_minor, st.status), ',' order by st.id)
  from public.billing_statements st where st.org_id = (select v::bigint from ctx where k = 'org_b');
insert into snap
select 'start', 'a_payments', format('%s/%s', count(*), sum(amount_minor))
  from public.payments where org_id = (select v::bigint from ctx where k = 'org_a');
insert into snap
select 'start', 'w1', string_agg(format('%s/%s/%s/%s/%s/%s/%s', st.id, st.meal_count, st.meals_minor,
                                        st.paid_minor, st.status, st.paid_at, st.updated_at), ',' order by st.id)
  from public.billing_statements st where st.billing_period_id = (select v::bigint from ctx where k = 'p1');

------------------------------------------------------------------- controls

insert into probe values
  ('control: w1 is settled',
    (select status from public.billing_periods where id = (select v::bigint from ctx where k = 'p1')), 'closed'),
  ('control: w0 is open',
    (select status from public.billing_periods where id = (select v::bigint from ctx where k = 'p0')), 'open'),
  ('control: w2 is open',
    (select status from public.billing_periods where id = (select v::bigint from ctx where k = 'p2')), 'open'),
  ('control: CRED starts in credit, with no statement',
    pg_temp.bal('CRED') || ' ' || pg_temp.st('CRED', 'p2'), '-203000 none'),
  ('control: SPRD credit spans w0 and w2',
    pg_temp.st('SPRD', 'p0') || ' | ' || pg_temp.st('SPRD', 'p2'),
    'meals=60000 n=1 paid=60000 paid | meals=60000 n=1 paid=30000 partial'),
  ('control: SPRD payment points at w2',
    ((select p.matched_statement_id from public.payments p where p.provider_txn_id = 'rb-SPRD')
      = pg_temp.st_id('SPRD', 'p2'))::text, 'true'),
  ('control: SETL has a settled paid w1 and a partial w2',
    pg_temp.st('SETL', 'p1') || ' | ' || pg_temp.st('SETL', 'p2'),
    'meals=45000 n=1 paid=45000 paid | meals=45000 n=1 paid=15000 partial'),
  ('control: GIVE charged for their own meal',
    pg_temp.st('GIVE', 'p2') || ' ' || pg_temp.bal('GIVE'), 'meals=45000 n=1 paid=45000 paid -55000'),
  ('control: NOCR owes their meal', pg_temp.st('NOCR', 'p2') || ' ' || pg_temp.bal('NOCR'),
    'meals=45000 n=1 paid=0 unpaid 45000'),
  ('control: lines match statements in office A', pg_temp.mismatches('org_a'), '0');

-------------------------------------------- 1. the owner's case, off the menu

do $$
declare v_order bigint; v_bal bigint; v_bal2 bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into probe values
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true');

  select r.order_id, r.balance_minor into v_order, v_bal
    from public.correct_meal_off_menu(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd2a'),
           'cccccccc-0000-0000-0000-000000000002', 'Lẩu hải sản', 300000, 1::smallint,
           null, 'caterer sent it') r;
  insert into ctx values ('order_cred', v_order::text);
  insert into probe values ('1 off-menu: returned balance', v_bal::text, '97000');

  select r.balance_minor into v_bal2 from public.remove_meal(v_order, 'did not eat') r;
  insert into probe values ('1 remove: returned balance', v_bal2::text, '-203000');
  reset role;
end $$;

insert into probe values
  ('1 remove: CRED balance is the credit again', pg_temp.bal('CRED'), '-203000'),
  ('1 remove: CRED has no statement in w2', pg_temp.st('CRED', 'p2'), 'none'),
  ('1 remove: CRED has no statement anywhere',
    (select count(*)::text from public.billing_statements where profile_id = pg_temp.pid('CRED')), '0'),
  ('1 remove: CRED payment points at nothing',
    coalesce((select matched_statement_id::text from public.payments where provider_txn_id = 'rb-CRED'), 'null'),
    'null');

-------------------------------------------- 2. the same, on a menu dish

do $$
declare v_order bigint; v_bal bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  select r.order_id, r.balance_minor into v_order, v_bal
    from public.correct_meal(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd2a'),
           'cccccccc-0000-0000-0000-000000000003', pg_temp.item('d2a', 'Cơm gà'), 1::smallint,
           null, 'forgot to order') r;
  reset role;
  insert into probe values
    ('2 correct_meal: returned balance', v_bal::text, '-55000'),
    ('2 correct_meal: MENU statement', pg_temp.st('MENU', 'p2'), 'meals=45000 n=1 paid=45000 paid');

  set local role authenticated;
  perform public.remove_meal(v_order, 'did not eat');
  reset role;
end $$;

insert into probe values
  ('2 remove: MENU balance', pg_temp.bal('MENU'), '-100000'),
  ('2 remove: MENU statement', pg_temp.st('MENU', 'p2'), 'none');

-------------------------------------------- 3. a changed dish and price

insert into ctx values ('chng_st', pg_temp.st_id('CHNG', 'p2')::text);

do $$
declare v_item bigint;
begin
  insert into probe values
    ('3 before: CHNG statement', pg_temp.st('CHNG', 'p2'), 'meals=45000 n=1 paid=45000 paid'),
    ('3 before: CHNG balance', pg_temp.bal('CHNG'), '-5000');

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.correct_meal(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd2a'),
           'cccccccc-0000-0000-0000-000000000004', pg_temp.item('d2a', 'Bún bò'), 1::smallint,
           null, 'had the other one');
  reset role;
  insert into probe values
    ('3 dish up: CHNG statement', pg_temp.st('CHNG', 'p2'), 'meals=60000 n=1 paid=50000 partial'),
    ('3 dish up: CHNG balance', pg_temp.bal('CHNG'), '10000');

  set local role authenticated;
  select r.menu_item_id into v_item
    from public.correct_meal_off_menu(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd2a'),
           'cccccccc-0000-0000-0000-000000000004', 'Gỏi cuốn', 30000, 1::smallint,
           null, 'swapped at the counter') r;
  reset role;
  insert into probe values
    ('3 dish down: CHNG statement', pg_temp.st('CHNG', 'p2'), 'meals=30000 n=1 paid=30000 paid'),
    ('3 dish down: CHNG balance', pg_temp.bal('CHNG'), '-20000');

  set local role authenticated;
  perform public.reprice_dish(v_item, 40000, 'caterer charged 40k');
  reset role;
  insert into probe values
    ('3 reprice: CHNG statement', pg_temp.st('CHNG', 'p2'), 'meals=40000 n=1 paid=40000 paid'),
    ('3 reprice: CHNG balance', pg_temp.bal('CHNG'), '-10000'),
    ('3 reprice: CHNG kept the same statement row',
      (pg_temp.st_id('CHNG', 'p2') = (select v::bigint from ctx where k = 'chng_st'))::text, 'true');
end $$;

-------------------------------------------- 4. one of two meals goes

insert into ctx values ('twom_st', pg_temp.st_id('TWOM', 'p2')::text);
insert into probe values
  ('4 before: TWOM statement', pg_temp.st('TWOM', 'p2'), 'meals=75000 n=2 paid=75000 paid'),
  ('4 before: TWOM balance', pg_temp.bal('TWOM'), '-25000');

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.remove_meal(pg_temp.order_of('TWOM', 'd2a'), 'only ate once');
  reset role;
end $$;

insert into probe values
  ('4 remove one: TWOM statement shrinks', pg_temp.st('TWOM', 'p2'), 'meals=30000 n=1 paid=30000 paid'),
  ('4 remove one: TWOM balance', pg_temp.bal('TWOM'), '-70000'),
  ('4 remove one: TWOM kept the same statement row',
    (pg_temp.st_id('TWOM', 'p2') = (select v::bigint from ctx where k = 'twom_st'))::text, 'true');

-------------------------------------------- 5. credit across two open weeks

insert into snap select 'b5', 'sprd_w0',
  (select format('%s/%s', st.id, st.paid_at) from public.billing_statements st
    where st.id = pg_temp.st_id('SPRD', 'p0'));

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.remove_meal(pg_temp.order_of('SPRD', 'd2a'), 'did not eat');
  reset role;
end $$;

insert into probe values
  ('5 remove newer: SPRD w2 statement', pg_temp.st('SPRD', 'p2'), 'none'),
  ('5 remove newer: SPRD w0 still paid', pg_temp.st('SPRD', 'p0'), 'meals=60000 n=1 paid=60000 paid'),
  ('5 remove newer: SPRD w0 row and paid_at unchanged',
    (select format('%s/%s', st.id, st.paid_at) from public.billing_statements st
      where st.id = pg_temp.st_id('SPRD', 'p0')),
    (select v from snap where step = 'b5' and k = 'sprd_w0')),
  ('5 remove newer: SPRD balance', pg_temp.bal('SPRD'), '-30000'),
  ('5 remove newer: SPRD payment re-pointed at w0',
    ((select p.matched_statement_id from public.payments p where p.provider_txn_id = 'rb-SPRD')
      = pg_temp.st_id('SPRD', 'p0'))::text, 'true');

-------------------------------------------- 6. credit across a settled week

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.remove_meal(pg_temp.order_of('SETL', 'd2a'), 'did not eat');
  reset role;
end $$;

insert into probe values
  ('6 remove newer: SETL w2 statement', pg_temp.st('SETL', 'p2'), 'none'),
  ('6 remove newer: SETL settled week still paid', pg_temp.st('SETL', 'p1'), 'meals=45000 n=1 paid=45000 paid'),
  ('6 remove newer: SETL balance', pg_temp.bal('SETL'), '-15000');

-------------------------------------------- 7. a pass accepted

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  -- An admin recording two other people's swap: accepted on insert.
  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values ((select v::bigint from ctx where k = 'org_a'), pg_temp.order_of('GIVE', 'd2a'),
          'cccccccc-0000-0000-0000-000000000008', 'cccccccc-0000-0000-0000-000000000009',
          'cccccccc-0000-0000-0000-000000000001');
  reset role;
end $$;

insert into probe values
  ('7 accepted: the pass is accepted',
    (select status from public.meal_transfers where order_id = pg_temp.order_of('GIVE', 'd2a')), 'accepted'),
  ('7 accepted: GIVE has no statement', pg_temp.st('GIVE', 'p2'), 'none'),
  ('7 accepted: GIVE credit restored', pg_temp.bal('GIVE'), '-100000'),
  ('7 accepted: TAKE charged once', pg_temp.st('TAKE', 'p2'), 'meals=45000 n=1 paid=0 unpaid'),
  ('7 accepted: TAKE balance', pg_temp.bal('TAKE'), '45000'),
  ('7 accepted: the meal is on one line, TAKE''s',
    (select string_agg(bl.payer_profile_id::text, ',') from public.billing_lines bl
      where bl.order_id = pg_temp.order_of('GIVE', 'd2a')),
    'cccccccc-0000-0000-0000-000000000009');

-------------------------------------------- 8. a pass declined, and one withdrawn

insert into ctx values ('givb_st', pg_temp.st_id('GIVB', 'p2')::text);

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  -- Created by GIVB, so it waits on TAKE rather than being recorded accepted.
  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values ((select v::bigint from ctx where k = 'org_a'), pg_temp.order_of('GIVB', 'd2a'),
          'cccccccc-0000-0000-0000-000000000010', 'cccccccc-0000-0000-0000-000000000009',
          'cccccccc-0000-0000-0000-000000000010');
  insert into probe values
    ('8 offered: the pass is pending',
      (select status from public.meal_transfers where order_id = pg_temp.order_of('GIVB', 'd2a')), 'pending');
  update public.meal_transfers set status = 'declined'
   where order_id = pg_temp.order_of('GIVB', 'd2a') and status = 'pending';

  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values ((select v::bigint from ctx where k = 'org_a'), pg_temp.order_of('GIVB', 'd2a'),
          'cccccccc-0000-0000-0000-000000000010', 'cccccccc-0000-0000-0000-000000000009',
          'cccccccc-0000-0000-0000-000000000010');
  update public.meal_transfers set status = 'cancelled'
   where order_id = pg_temp.order_of('GIVB', 'd2a') and status = 'pending';
  reset role;
end $$;

insert into probe values
  ('8 declined, withdrawn: both recorded',
    (select string_agg(status, ',' order by id) from public.meal_transfers
      where order_id = pg_temp.order_of('GIVB', 'd2a')), 'declined,cancelled'),
  ('8 declined, withdrawn: GIVB still charged once', pg_temp.st('GIVB', 'p2'), 'meals=45000 n=1 paid=45000 paid'),
  ('8 declined, withdrawn: GIVB balance', pg_temp.bal('GIVB'), '-5000'),
  ('8 declined, withdrawn: GIVB kept the same statement row',
    (pg_temp.st_id('GIVB', 'p2') = (select v::bigint from ctx where k = 'givb_st'))::text, 'true'),
  ('8 declined, withdrawn: TAKE not charged for it', pg_temp.st('TAKE', 'p2'), 'meals=45000 n=1 paid=0 unpaid');

-------------------------------------------- 8b. a pass cannot be deleted

-- Deleting an accepted pass would move the meal back onto GIVE with no re-bill
-- and no record. A pass ends by being declined or withdrawn, as above.
do $$
declare v_state text; v_n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into probe values ('8b control: role downgraded', (current_role = 'authenticated')::text, 'true');
  begin
    delete from public.meal_transfers where order_id = pg_temp.order_of('GIVE', 'd2a');
    get diagnostics v_n = row_count;
    v_state := 'deleted ' || v_n;
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('8b an admin cannot delete a pass', v_state, '42501');

  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000009","role":"authenticated"}', true);
  begin
    delete from public.meal_transfers where to_profile_id = 'cccccccc-0000-0000-0000-000000000009';
    get diagnostics v_n = row_count;
    v_state := 'deleted ' || v_n;
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('8b a member cannot delete a pass', v_state, '42501');
  reset role;
end $$;

insert into probe values
  ('8b the passes are all still there',
    (select string_agg(status, ',' order by id) from public.meal_transfers
      where org_id = (select v::bigint from ctx where k = 'org_a')), 'accepted,declined,cancelled'),
  ('8b TAKE is still the one charged', pg_temp.st('TAKE', 'p2'), 'meals=45000 n=1 paid=0 unpaid'),
  ('8b no browser role holds DELETE on meal_transfers',
    (has_table_privilege('authenticated', 'public.meal_transfers', 'delete')
     or has_table_privilege('anon', 'public.meal_transfers', 'delete'))::text, 'false');

-------------------------------------------- 9. no credit, only meal goes

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.remove_meal(pg_temp.order_of('NOCR', 'd2a'), 'did not eat');
  reset role;
end $$;

insert into probe values
  ('9 remove: NOCR statement', pg_temp.st('NOCR', 'p2'), 'none'),
  ('9 remove: NOCR balance', pg_temp.bal('NOCR'), '0');

-------------------------------------------- 10. a waived week whose lines all go

do $$
begin
  insert into probe values
    ('10 before: WAIV statement', pg_temp.st('WAIV', 'p2'), 'meals=45000 n=1 paid=20000 partial');

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.waive_statement(pg_temp.st_id('WAIV', 'p2'), 'on the house');
  reset role;

  insert into ctx values ('waiv_st', pg_temp.st_id('WAIV', 'p2')::text);
  insert into probe values
    ('10 waived: WAIV statement', pg_temp.st('WAIV', 'p2'), 'meals=45000 n=1 paid=20000 waived'),
    ('10 waived: WAIV balance is the payment', pg_temp.bal('WAIV'), '-20000');

  set local role authenticated;
  perform public.remove_meal(pg_temp.order_of('WAIV', 'd2a'), 'did not eat');
  reset role;
end $$;

insert into probe values
  ('10 remove: WAIV statement gone', pg_temp.st('WAIV', 'p2'), 'none'),
  ('10 remove: WAIV balance unchanged', pg_temp.bal('WAIV'), '-20000'),
  ('10 remove: the waiver''s record survives, pointing at nothing',
    (select format('%s/%s', count(*), count(c.statement_id)) from public.payment_corrections c
      where c.kind = 'waive' and c.from_profile_id = pg_temp.pid('WAIV')), '1/0'),
  ('10 remove: WAIV payment points at nothing',
    coalesce((select matched_statement_id::text from public.payments where provider_txn_id = 'rb-WAIV'), 'null'),
    'null');

-- Waiving a week a re-bill has deleted says so, rather than claiming the admin
-- may not. A member waiving a real week is still a permission question.
do $$
declare v_state text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  begin
    perform public.waive_statement((select v::bigint from ctx where k = 'waiv_st'), 'again');
    v_state := 'allowed';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('10 waive a deleted week: says it is gone', v_state,
    'P0002 that week has nothing on it any more, so there is nothing to waive');

  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000009","role":"authenticated"}', true);
  begin
    perform public.waive_statement(pg_temp.st_id('TAKE', 'p2'), 'mine');
    v_state := 'allowed';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('10 a member waiving a real week is refused', v_state, '42501');
  reset role;
end $$;

-- The waiver went with the statement. A meal recorded again is charged on a
-- new, unwaived statement, and the payment the waived week never used pays it.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.correct_meal(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd2a'),
           'cccccccc-0000-0000-0000-000000000012', pg_temp.item('d2a', 'Cơm gà'), 1::smallint,
           null, 'did eat after all');
  reset role;
end $$;

insert into probe values
  ('10 re-added: WAIV charged on a new unwaived statement', pg_temp.st('WAIV', 'p2'),
    'meals=45000 n=1 paid=20000 partial'),
  ('10 re-added: not the waived row',
    (pg_temp.st_id('WAIV', 'p2') <> (select v::bigint from ctx where k = 'waiv_st'))::text, 'true'),
  ('10 re-added: WAIV balance', pg_temp.bal('WAIV'), '25000');

-------------------------------------------- 11. lunch cancelled, not corrected

-- The member's own cancel reaches the bill at the next re-bill; this is that
-- re-bill, run by hand.
update public.orders set status = 'cancelled', cancelled_at = now()
 where id = pg_temp.order_of('CANC', 'd2a');
do $$ begin perform public.run_billing((select v::bigint from ctx where k = 'p2')); end $$;

insert into probe values
  ('11 cancelled: CANC statement', pg_temp.st('CANC', 'p2'), 'none'),
  ('11 cancelled: CANC balance', pg_temp.bal('CANC'), '-50000');

-------------------------------------------- 12. the settled week refuses

do $$
declare v_state text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-0000-0000-0000-000000000001","role":"authenticated"}', true);

  begin
    perform public.remove_meal(pg_temp.order_of('SETL', 'd1'), 'did not eat');
    v_state := 'allowed';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('12 settled: remove_meal refused', v_state, '55000');

  begin
    perform public.correct_meal(
           (select v::bigint from ctx where k = 'org_a'), (select v::date from ctx where k = 'd1'),
           'cccccccc-0000-0000-0000-000000000007', pg_temp.item('d1', 'Bún bò'), 1::smallint,
           null, 'late correction');
    v_state := 'allowed';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('12 settled: correct_meal refused', v_state, '55000');
  reset role;

  begin
    perform public.run_billing((select v::bigint from ctx where k = 'p1'));
    v_state := 'allowed';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('12 settled: run_billing refused', v_state, '55000');
end $$;

insert into probe values
  ('12 settled: w1 statements byte for byte',
    (select string_agg(format('%s/%s/%s/%s/%s/%s/%s', st.id, st.meal_count, st.meals_minor,
                              st.paid_minor, st.status, st.paid_at, st.updated_at), ',' order by st.id)
       from public.billing_statements st where st.billing_period_id = (select v::bigint from ctx where k = 'p1')),
    (select v from snap where step = 'start' and k = 'w1'));

-------------------------------------------- across everything above

insert into probe values
  ('G1 office A: every statement equals its lines, and none is empty', pg_temp.mismatches('org_a'), '0'),
  ('G2 w2: lines total equals statements total',
    ((select coalesce(sum(amount_minor), 0) from public.billing_lines
       where billing_period_id = (select v::bigint from ctx where k = 'p2'))
     = (select coalesce(sum(meals_minor), 0) from public.billing_statements
         where billing_period_id = (select v::bigint from ctx where k = 'p2')))::text, 'true'),
  -- Exact, from the prices: TWOM Phở 30000, CHNG Gỏi cuốn 40000, GIVB,
  -- TAKE (GIVE's meal) and WAIV (re-added) at 45000 each.
  ('G3 w2: the week totals what was eaten',
    (select coalesce(sum(amount_minor), 0)::text from public.billing_lines
      where billing_period_id = (select v::bigint from ctx where k = 'p2')), '205000'),
  ('G4 w2: the period roll-up agrees',
    (select format('%s/%s', line_count, total_minor) from public.billing_periods
      where id = (select v::bigint from ctx where k = 'p2')), '5/205000'),
  ('G5 office A: no payment appeared, vanished or changed',
    (select format('%s/%s', count(*), sum(amount_minor)) from public.payments
      where org_id = (select v::bigint from ctx where k = 'org_a')),
    (select v from snap where step = 'start' and k = 'a_payments')),
  ('G6 office A: every payment points at a statement of its own person, or none',
    (select count(*)::text from public.payments p
       join public.billing_statements st on st.id = p.matched_statement_id
      where p.org_id = (select v::bigint from ctx where k = 'org_a')
        and st.profile_id <> p.profile_id), '0'),
  ('G7 office B: balances unchanged',
    (select count(*)::text from snap s
      where s.step = 'start' and s.k <> 'b_statements' and s.k <> 'a_payments' and s.k <> 'w1'
        and s.v is distinct from pg_temp.bal(s.k)), '0'),
  ('G7 office B: statements unchanged',
    (select string_agg(format('%s/%s/%s/%s', st.id, st.meals_minor, st.paid_minor, st.status), ',' order by st.id)
       from public.billing_statements st where st.org_id = (select v::bigint from ctx where k = 'org_b')),
    (select v from snap where step = 'start' and k = 'b_statements')),
  ('G7 control: office B has a statement to compare',
    (select count(*)::text from public.billing_statements st
      where st.org_id = (select v::bigint from ctx where k = 'org_b')), '1');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
