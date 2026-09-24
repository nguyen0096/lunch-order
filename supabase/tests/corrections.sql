-- Admin corrections: the arithmetic, the blast radius, and the refusals.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/corrections.sql
--
-- This file builds its own fixtures and rolls everything back. It needs no
-- other seed and deliberately shares none, so a correction in here can never be
-- confused with one somebody made on a real week.
--
-- The two traps from supabase/tests/isolation.sql apply here too, and a third:
--
-- 1. A test that passes because the session was never downgraded to
--    `authenticated`. `set local role` is its own statement inside a DO block,
--    and `control: role downgraded` asserts it POSITIVELY before any refusal is
--    judged.
--
-- 2. Judging a blocked write by whether it raised. An UPDATE or DELETE filtered
--    out by RLS affects zero rows and raises nothing. Every refusal below is
--    asserted as a ROW DELTA as well as by SQLSTATE.
--
-- 3. Judging money by whether it "changed". A correction that moves the right
--    person by the wrong amount, or the wrong person by the right amount, looks
--    identical to a correct one under "the balance moved". Every arithmetic
--    probe here is an exact figure, computed from the menu and the quantity
--    rather than from the function under test, and every probe names the
--    complement set that must NOT have moved.

begin;

create temp table probe (label text, got text, want text);
-- Load-bearing: probe rows are inserted while the session is `authenticated`,
-- and a temp table is not writable by that role without this.
grant insert on probe to authenticated;

create temp table ctx (k text primary key, v text);
-- Same reason as the grant above: the RPCs below are called while the session
-- is `authenticated`, and the ids they are called with are read out of here.
grant select, insert on ctx to authenticated;

create temp table bal (step text, org_id bigint, profile_id uuid, balance_minor bigint);
create temp table pay (step text, org_id bigint, profile_id uuid, total bigint, rows integer);
create temp table clo (step text, id bigint, paid_minor bigint, status text, paid_at timestamptz);
create temp table dish (step text, id bigint, price_minor integer);
create temp table lin (step text, id bigint, unit_price_minor integer, line_total_minor integer);

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000001','authenticated','authenticated','adm@corra.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Admin An"}'),
 ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000002','authenticated','authenticated','m1@corra.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Một Nguyễn"}'),
 ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000003','authenticated','authenticated','m2@corra.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Hai Trần"}'),
 ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000004','authenticated','authenticated','m3@corra.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Ba Lê"}'),
 ('00000000-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000005','authenticated','authenticated','m4@corra.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Tư Phạm"}'),
 ('00000000-0000-0000-0000-000000000000','bbbbbbbb-0000-0000-0000-000000000001','authenticated','authenticated','b1@corrb.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bê Một"}'),
 ('00000000-0000-0000-0000-000000000000','bbbbbbbb-0000-0000-0000-000000000002','authenticated','authenticated','b2@corrb.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bê Hai"}')
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time)
values ('corr-a','Corrections A','Asia/Ho_Chi_Minh','16:00'),
       ('corr-b','Corrections B','Asia/Ho_Chi_Minh','16:00');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid, u.role, u.code from public.organizations o
join (values
  ('corr-a','aaaaaaaa-0000-0000-0000-000000000001'::uuid,'owner','ADM'),
  ('corr-a','aaaaaaaa-0000-0000-0000-000000000002'::uuid,'member','MOT'),
  ('corr-a','aaaaaaaa-0000-0000-0000-000000000003'::uuid,'member','HAI'),
  ('corr-a','aaaaaaaa-0000-0000-0000-000000000004'::uuid,'member','BA'),
  ('corr-a','aaaaaaaa-0000-0000-0000-000000000005'::uuid,'member','TU'),
  ('corr-b','bbbbbbbb-0000-0000-0000-000000000001'::uuid,'owner','BMOT'),
  ('corr-b','bbbbbbbb-0000-0000-0000-000000000002'::uuid,'member','BHAI')
) as u(slug,pid,role,code) on u.slug = o.slug;

-- One linked chat, so the outbox probes measure something rather than passing
-- because nobody could have been messaged.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 900000 + m.id, now()
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug = 'corr-a'
 where m.profile_id = 'aaaaaaaa-0000-0000-0000-000000000003';

do $$
declare
  v_a bigint; v_b bigint;
  v_mon date;
begin
  select id into v_a from public.organizations where slug = 'corr-a';
  select id into v_b from public.organizations where slug = 'corr-b';

  -- Monday of the current week. billing_week_starts_on defaults to 1, so this
  -- is exactly the boundary ensure_billing_period() computes.
  v_mon := current_date - ((extract(isodow from current_date)::int - 1 + 7) % 7);

  insert into ctx values
    ('org_a', v_a::text), ('org_b', v_b::text),
    ('w0', (v_mon - 14)::text),          -- open, held open by an unpriced meal
    ('w1', (v_mon - 7)::text),           -- settled
    ('w2', v_mon::text),                 -- open, the week being corrected
    ('d0',  (v_mon - 13)::text),
    ('d1',  (v_mon - 6)::text),
    ('d2a', (v_mon + 1)::text),
    ('d2b', (v_mon + 2)::text);
end $$;

-- Menus go in `locked`, which is what a week being settled looks like: the
-- cutoff has passed and the headcount has gone to the caterer. Inserted at that
-- status rather than moved to it, because `menus_lifecycle` is BEFORE UPDATE
-- and this file is not testing the menu lifecycle.
insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select (select v::bigint from ctx where k='org_a'), d.dt, 'locked',
       (d.dt::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
       'aaaaaaaa-0000-0000-0000-000000000001'
  from (select (select v::date from ctx where k='d0') as dt
        union all select (select v::date from ctx where k='d1')
        union all select (select v::date from ctx where k='d2a')
        union all select (select v::date from ctx where k='d2b')) d;

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select (select v::bigint from ctx where k='org_b'), (select v::date from ctx where k='d2a'), 'locked',
       ((select v::date from ctx where k='d2a')::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh',
       'bbbbbbbb-0000-0000-0000-000000000001';

-- Same dish name on two days of one office and in a second office. The reprice
-- probes below assert that repricing one of them moves only that one.
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  join lateral (values
    ('Cơm gà', 45000, 0), ('Bún bò', 60000, 1), ('Phở', 30000, 2)
  ) as v(nm, pr, pos) on true
 where m.org_id = (select v::bigint from ctx where k='org_a')
   and m.service_date in ((select v::date from ctx where k='d1'),
                          (select v::date from ctx where k='d2a'),
                          (select v::date from ctx where k='d2b'));

-- The meal nobody has priced. It is what holds w0 open, and what makes the
-- closed-week probe below a real test rather than a hypothetical.
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Bánh mì', null, 0
  from public.menus m
 where m.org_id = (select v::bigint from ctx where k='org_a')
   and m.service_date = (select v::date from ctx where k='d0');

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Cơm gà', 45000, 0
  from public.menus m
 where m.org_id = (select v::bigint from ctx where k='org_b');

-- Orders. One target per RPC, so each probe's affected set is one person and
-- its complement is everybody else.
--   MOT  the reprice target        (Cơm gà on d2a, and it is MOT who also has
--        the settled week and the unpriced meal in w0)
--   HAI  the correct_meal target   (Cơm gà on d2a)
--   BA   the off-menu target       (Phở    on d2a)
--   TU   the remove_meal target    (Cơm gà on d2b)
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select mu.org_id, mu.id, mu.service_date, v.pid, 'member', v.pid
  from public.menus mu
  join lateral (values
    ((select v::date from ctx where k='d0'),  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Bánh mì'),
    ((select v::date from ctx where k='d1'),  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'Phở'),
    ((select v::date from ctx where k='d2b'), 'aaaaaaaa-0000-0000-0000-000000000005'::uuid, 'Cơm gà')
  ) as v(dt, pid, nm) on v.dt = mu.service_date
 where mu.org_id = (select v::bigint from ctx where k='org_a');

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select mu.org_id, mu.id, mu.service_date,
       'bbbbbbbb-0000-0000-0000-000000000002', 'member',
       'bbbbbbbb-0000-0000-0000-000000000002'
  from public.menus mu
 where mu.org_id = (select v::bigint from ctx where k='org_b');

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id
  join lateral (values
    ((select v::date from ctx where k='d0'),  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Bánh mì'),
    ((select v::date from ctx where k='d1'),  'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'Cơm gà'),
    ((select v::date from ctx where k='d2a'), 'aaaaaaaa-0000-0000-0000-000000000004'::uuid, 'Phở'),
    ((select v::date from ctx where k='d2b'), 'aaaaaaaa-0000-0000-0000-000000000005'::uuid, 'Cơm gà')
  ) as v(dt, pid, nm) on v.dt = o.service_date and v.pid = o.profile_id and v.nm = mi.name
 where o.org_id = (select v::bigint from ctx where k='org_a');

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = (select v::bigint from ctx where k='org_b');

-- Bill the three weeks, take one payment, settle the middle one.
do $$
declare v_a bigint; v_b bigint; p0 bigint; p1 bigint; p2 bigint; pb bigint;
begin
  select v::bigint into v_a from ctx where k='org_a';
  select v::bigint into v_b from ctx where k='org_b';

  p0 := public.ensure_billing_period(v_a, (select v::date from ctx where k='w0'));
  p1 := public.ensure_billing_period(v_a, (select v::date from ctx where k='w1'));
  p2 := public.ensure_billing_period(v_a, (select v::date from ctx where k='w2'));
  pb := public.ensure_billing_period(v_b, (select v::date from ctx where k='w2'));
  insert into ctx values ('p0', p0::text), ('p1', p1::text), ('p2', p2::text), ('pb', pb::text);

  perform public.run_billing(p0);
  perform public.run_billing(p1);
  perform public.run_billing(p2);
  perform public.run_billing(pb);

  -- Pays off the settled week exactly. This is the money the counter-example
  -- probe later watches get re-allocated out from under a closed statement.
  insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                               memo, received_at, raw, profile_id)
  values (v_a, 'sepay', 'corr-test-1', 45000, 'LUNCHMOT', now(), '{}'::jsonb,
          'aaaaaaaa-0000-0000-0000-000000000002');

  update public.billing_periods set status = 'closed', closed_at = now() where id = p1;
end $$;

------------------------------------------------------------------- controls

insert into probe
select 'control: profiles exist for the fixture users',
       (select count(*)::text from public.profiles
         where id in ('aaaaaaaa-0000-0000-0000-000000000001',
                      'aaaaaaaa-0000-0000-0000-000000000002',
                      'aaaaaaaa-0000-0000-0000-000000000003',
                      'aaaaaaaa-0000-0000-0000-000000000004',
                      'aaaaaaaa-0000-0000-0000-000000000005',
                      'bbbbbbbb-0000-0000-0000-000000000001',
                      'bbbbbbbb-0000-0000-0000-000000000002')),
       '7';

insert into probe
select 'control: settled week is closed',
       (select status from public.billing_periods where id = (select v::bigint from ctx where k='p1')),
       'closed';

-- hold_period_open_while_unpriced() reverts a close SILENTLY rather than
-- raising, so without the probe above a fixture that failed to settle would
-- make every closed-week refusal below pass for the wrong reason.
insert into probe
select 'control: the week before the settled one is open',
       (select status from public.billing_periods where id = (select v::bigint from ctx where k='p0')),
       'open';

insert into probe
select 'control: settled week is fully paid',
       (select st.status from public.billing_statements st
         where st.billing_period_id = (select v::bigint from ctx where k='p1')
           and st.profile_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
       'paid';

-------------------------------------------------- step 1: reprice_dish, as admin

insert into bal select 'b1', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into pay select 'b1', m.org_id, m.profile_id,
       coalesce(sum(p.amount_minor), 0)::bigint, count(p.id)::int
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug in ('corr-a','corr-b')
  left join public.payments p on p.org_id = m.org_id and p.profile_id = m.profile_id
 group by m.org_id, m.profile_id;
insert into clo select 'b1', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');
insert into dish select 'b1', mi.id, mi.price_minor
  from public.menu_items mi
  join public.organizations o on o.id = mi.org_id and o.slug in ('corr-a','corr-b');
insert into lin select 'b1', oi.id, oi.unit_price_minor, oi.line_total_minor
  from public.order_items oi
  join public.organizations o on o.id = oi.org_id and o.slug in ('corr-a','corr-b');

do $$
declare
  v_item bigint; v_lines integer; v_people integer;
begin
  select mi.id into v_item from public.menu_items mi
    join public.menus mu on mu.id = mi.menu_id
   where mu.org_id = (select v::bigint from ctx where k='org_a')
     and mu.service_date = (select v::date from ctx where k='d2a')
     and mi.name = 'Cơm gà';
  insert into ctx values ('item_comga_d2a', v_item::text);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

  insert into probe values
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: acting as the admin',
      ((select auth.uid())::text = 'aaaaaaaa-0000-0000-0000-000000000001')::text, 'true');

  select r.lines, r.people into v_lines, v_people
    from public.reprice_dish(v_item, 50000, 'caterer charged 50k') r;

  insert into probe values
    ('reprice: lines touched',  v_lines::text,  '2'),
    ('reprice: people touched', v_people::text, '2');

  reset role;
end $$;

insert into bal select 'a1', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into pay select 'a1', m.org_id, m.profile_id,
       coalesce(sum(p.amount_minor), 0)::bigint, count(p.id)::int
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug in ('corr-a','corr-b')
  left join public.payments p on p.org_id = m.org_id and p.profile_id = m.profile_id
 group by m.org_id, m.profile_id;
insert into clo select 'a1', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');
insert into dish select 'a1', mi.id, mi.price_minor
  from public.menu_items mi
  join public.organizations o on o.id = mi.org_id and o.slug in ('corr-a','corr-b');
insert into lin select 'a1', oi.id, oi.unit_price_minor, oi.line_total_minor
  from public.order_items oi
  join public.organizations o on o.id = oi.org_id and o.slug in ('corr-a','corr-b');

-- I1. Exactly the two people with that dish on that day moved; nobody else did.
insert into probe
select 'I1 reprice: only the two dish-eaters moved',
       (select string_agg(x.profile_id::text, ',' order by x.profile_id::text)
          from (select a.profile_id from bal a join bal b
                    on b.step='a1' and b.org_id=a.org_id and b.profile_id=a.profile_id
                 where a.step='b1' and a.balance_minor is distinct from b.balance_minor) x),
       (select string_agg(p::text, ',' order by p::text)
          from unnest(array['aaaaaaaa-0000-0000-0000-000000000002'::uuid,
                            'aaaaaaaa-0000-0000-0000-000000000003'::uuid]) p);

-- I2. And each by exactly 50000 - 45000, computed from the menu, not from the
-- function's return value.
insert into probe
select 'I2 reprice: each moved by exactly 5000',
       (select string_agg(distinct (b.balance_minor - a.balance_minor)::text, ',')
          from bal a join bal b on b.step='a1' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b1'
           and a.profile_id in ('aaaaaaaa-0000-0000-0000-000000000002',
                                'aaaaaaaa-0000-0000-0000-000000000003')),
       '5000';

-- Blast radius. One dish row, one menu, one office: the same name on the next
-- day and in the other office is a different row and must be untouched.
insert into probe
select 'reprice: no other dish repriced',
       (select count(*)::text from dish a join dish b on b.step='a1' and b.id=a.id
         where a.step='b1' and a.price_minor is distinct from b.price_minor
           and a.id <> (select v::bigint from ctx where k='item_comga_d2a')),
       '0';

insert into probe
select 'reprice: no line off that dish moved',
       (select count(*)::text from lin a join lin b on b.step='a1' and b.id=a.id
         where a.step='b1' and a.line_total_minor is distinct from b.line_total_minor
           and a.id not in (select oi.id from public.order_items oi
                             where oi.menu_item_id = (select v::bigint from ctx where k='item_comga_d2a'))),
       '0';

-- I5. No payment appeared, vanished or changed value.
insert into probe
select 'I5 reprice: payments identical',
       (select count(*)::text from pay a join pay b
           on b.step='a1' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b1' and (a.total, a.rows) is distinct from (b.total, b.rows)),
       '0';

-- I6. The whole ledger moved by the correction's delta and by nothing else.
insert into probe
select 'I6 reprice: ledger moved by exactly 10000',
       ((select sum(balance_minor) from bal where step='a1')
      - (select sum(balance_minor) from bal where step='b1'))::text,
       '10000';

-- I7. The settled week is untouched, byte for byte.
insert into probe
select 'I7 reprice: settled week untouched',
       (select count(*)::text from clo a join clo b on b.step='a1' and b.id=a.id
         where a.step='b1'
           and (a.paid_minor, a.status, a.paid_at) is distinct from (b.paid_minor, b.status, b.paid_at)),
       '0';

-- I8. The second office did not move at all.
insert into probe
select 'I8 reprice: other office lines unchanged',
       (select coalesce(sum(bl.amount_minor),0)::text from public.billing_lines bl
         where bl.billing_period_id = (select v::bigint from ctx where k='pb')),
       '45000';
insert into probe
select 'I8 reprice: other office balances unchanged',
       (select count(*)::text from bal a join bal b
           on b.step='a1' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b1' and a.org_id = (select v::bigint from ctx where k='org_b')
           and a.balance_minor is distinct from b.balance_minor),
       '0';

------------------------------------------- step 2: correct_meal, as admin

insert into bal select 'b2', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into pay select 'b2', m.org_id, m.profile_id,
       coalesce(sum(p.amount_minor), 0)::bigint, count(p.id)::int
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug in ('corr-a','corr-b')
  left join public.payments p on p.org_id = m.org_id and p.profile_id = m.profile_id
 group by m.org_id, m.profile_id;
insert into clo select 'b2', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

do $$
declare v_item bigint; v_order bigint; v_bal bigint; v_before integer; v_after integer;
begin
  select mi.id into v_item from public.menu_items mi
    join public.menus mu on mu.id = mi.menu_id
   where mu.org_id = (select v::bigint from ctx where k='org_a')
     and mu.service_date = (select v::date from ctx where k='d2a')
     and mi.name = 'Bún bò';

  -- Computed from the menu and the quantity asked for, independently of the
  -- function: 60000 x 2 replaces one 50000 line.
  select mi.price_minor * 2 into v_after from public.menu_items mi where mi.id = v_item;
  select sum(oi.line_total_minor) into v_before
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'
     and o.service_date = (select v::date from ctx where k='d2a');
  insert into ctx values ('delta2', (v_after - v_before)::text);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

  select r.order_id, r.balance_minor into v_order, v_bal
    from public.correct_meal(
           (select v::bigint from ctx where k='org_a'),
           (select v::date   from ctx where k='d2a'),
           'aaaaaaaa-0000-0000-0000-000000000003',
           v_item, 2::smallint, 'extra portion', 'ordered verbally on the day') r;
  insert into ctx values ('order_hai', v_order::text);

  reset role;

  -- The order's lines were REPLACED, not added to. A stray line is a second
  -- meal on a real bill, because v_order_charges sums every line on the order.
  insert into probe values
    ('correct_meal: exactly one line on the order',
      (select count(*)::text from public.order_items oi where oi.order_id = v_order), '1'),
    ('correct_meal: the line is the new dish',
      (select oi.menu_item_id::text from public.order_items oi where oi.order_id = v_order),
      v_item::text),
    ('correct_meal: source stayed member',
      (select o.source from public.orders o where o.id = v_order), 'member');
end $$;

insert into bal select 'a2', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into pay select 'a2', m.org_id, m.profile_id,
       coalesce(sum(p.amount_minor), 0)::bigint, count(p.id)::int
  from public.memberships m
  join public.organizations o on o.id = m.org_id and o.slug in ('corr-a','corr-b')
  left join public.payments p on p.org_id = m.org_id and p.profile_id = m.profile_id
 group by m.org_id, m.profile_id;
insert into clo select 'a2', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

insert into probe
select 'I1 correct_meal: only the affected member moved',
       (select count(*)::text from bal a join bal b
           on b.step='a2' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b2' and a.balance_minor is distinct from b.balance_minor
           and a.profile_id <> 'aaaaaaaa-0000-0000-0000-000000000003'),
       '0';

insert into probe
select 'I2 correct_meal: moved by exactly the line difference',
       (select (b.balance_minor - a.balance_minor)::text from bal a join bal b
           on b.step='a2' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b2' and a.profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
       (select v from ctx where k='delta2');

insert into probe
select 'I5 correct_meal: payments identical',
       (select count(*)::text from pay a join pay b
           on b.step='a2' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b2' and (a.total, a.rows) is distinct from (b.total, b.rows)),
       '0';

insert into probe
select 'I6 correct_meal: ledger moved by exactly the delta',
       ((select sum(balance_minor) from bal where step='a2')
      - (select sum(balance_minor) from bal where step='b2'))::text,
       (select v from ctx where k='delta2');

insert into probe
select 'I7 correct_meal: settled week untouched',
       (select count(*)::text from clo a join clo b on b.step='a2' and b.id=a.id
         where a.step='b2'
           and (a.paid_minor, a.status, a.paid_at) is distinct from (b.paid_minor, b.status, b.paid_at)),
       '0';

insert into probe
select 'I8 correct_meal: other office balances unchanged',
       (select count(*)::text from bal a join bal b
           on b.step='a2' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b2' and a.org_id = (select v::bigint from ctx where k='org_b')
           and a.balance_minor is distinct from b.balance_minor),
       '0';

-- The message, and only for people who finished /start. HAI is linked; nobody
-- else in this office is, so this counts what reached somebody rather than what
-- was written.
--
-- Two rows, not one: the reprice in step 1 and this correction both touched
-- HAI's Tuesday. A dedupe key of the day and the person would have swallowed
-- the second one under `on conflict (dedupe_key) do nothing`, and HAI would
-- have been told about the price change and never about the dish.
insert into probe
select 'two corrections to one day produced two messages',
       (select count(*)::text from public.notification_outbox n
         where n.kind = 'bill_correction'
           and n.recipient_profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
       '2';
insert into probe
select 'and two distinct dedupe keys',
       (select count(distinct n.dedupe_key)::text from public.notification_outbox n
         where n.kind = 'bill_correction'
           and n.recipient_profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
       '2';
insert into probe
select 'correct_meal: message is plain text',
       (select count(*)::text from public.notification_outbox n
         where n.kind = 'bill_correction' and n.parse_mode <> 'none'),
       '0';
insert into probe
select 'correct_meal: the reason is its own line',
       (select count(*)::text from public.notification_outbox n
         where n.kind = 'bill_correction'
           and n.recipient_profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'
           and position(E'\nordered verbally on the day\n' in n.body) > 0),
       '1';
insert into probe
select 'correct_meal: the message says what the record now holds',
       (select count(*)::text from public.notification_outbox n
         where n.kind = 'bill_correction'
           and n.recipient_profile_id = 'aaaaaaaa-0000-0000-0000-000000000003'
           and n.body like '%You are down for Bún bò x2, 120.000 ₫.%'),
       '1';

insert into probe
select 'correct_meal: one audit row, kind meal',
       (select c.kind from public.order_corrections c
         where c.order_id = (select v::bigint from ctx where k='order_hai')),
       'meal';

----------------------------------- step 3: correct_meal_off_menu, as admin

insert into bal select 'b3', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into clo select 'b3', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

do $$
declare v_order bigint; v_item bigint; v_bal bigint; v_before integer;
begin
  select sum(oi.line_total_minor) into v_before
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.profile_id = 'aaaaaaaa-0000-0000-0000-000000000004'
     and o.service_date = (select v::date from ctx where k='d2a');
  insert into ctx values ('delta3', (80000 - v_before)::text);

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

  select r.order_id, r.menu_item_id, r.balance_minor into v_order, v_item, v_bal
    from public.correct_meal_off_menu(
           (select v::bigint from ctx where k='org_a'),
           (select v::date   from ctx where k='d2a'),
           'aaaaaaaa-0000-0000-0000-000000000004',
           '  chả   cá  ', 80000, 1::smallint, null, 'caterer sent a spare') r;

  reset role;

  insert into probe values
    -- Normalised the way dishName() does: whitespace collapsed, sentence case.
    ('off_menu: dish name normalised',
      (select mi.name from public.menu_items mi where mi.id = v_item), 'Chả cá'),
    ('off_menu: dish is on that day''s menu',
      (select (mu.service_date = (select v::date from ctx where k='d2a'))::text
         from public.menu_items mi join public.menus mu on mu.id = mi.menu_id
        where mi.id = v_item), 'true'),
    ('off_menu: exactly one line on the order',
      (select count(*)::text from public.order_items oi where oi.order_id = v_order), '1'),
    ('off_menu: audit row names the dish',
      (select (c.menu_item_id = v_item)::text from public.order_corrections c
        where c.order_id = v_order and c.kind = 'off_menu'), 'true');
end $$;

insert into bal select 'a3', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into clo select 'a3', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

insert into probe
select 'I1 off_menu: only the affected member moved',
       (select count(*)::text from bal a join bal b
           on b.step='a3' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b3' and a.balance_minor is distinct from b.balance_minor
           and a.profile_id <> 'aaaaaaaa-0000-0000-0000-000000000004'),
       '0';

insert into probe
select 'I2 off_menu: moved by exactly the line difference',
       (select (b.balance_minor - a.balance_minor)::text from bal a join bal b
           on b.step='a3' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b3' and a.profile_id = 'aaaaaaaa-0000-0000-0000-000000000004'),
       (select v from ctx where k='delta3');

insert into probe
select 'I6 off_menu: ledger moved by exactly the delta',
       ((select sum(balance_minor) from bal where step='a3')
      - (select sum(balance_minor) from bal where step='b3'))::text,
       (select v from ctx where k='delta3');

insert into probe
select 'I7 off_menu: settled week untouched',
       (select count(*)::text from clo a join clo b on b.step='a3' and b.id=a.id
         where a.step='b3'
           and (a.paid_minor, a.status, a.paid_at) is distinct from (b.paid_minor, b.status, b.paid_at)),
       '0';

---------------------------------------------- step 4: remove_meal, as admin

insert into bal select 'b4', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into clo select 'b4', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

do $$
declare v_order bigint; v_bal bigint; v_orders_before integer; v_orders_after integer;
begin
  select o.id into v_order from public.orders o
   where o.profile_id = 'aaaaaaaa-0000-0000-0000-000000000005'
     and o.service_date = (select v::date from ctx where k='d2b');
  insert into ctx values ('order_tu', v_order::text),
                         ('delta4', (-(select sum(oi.line_total_minor)
                                         from public.order_items oi
                                        where oi.order_id = v_order))::text);
  select count(*) into v_orders_before from public.orders;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

  select r.balance_minor into v_bal from public.remove_meal(v_order, 'did not eat') r;

  reset role;
  select count(*) into v_orders_after from public.orders;

  insert into probe values
    -- Cancelled, never deleted: billing_lines.order_id is ON DELETE RESTRICT
    -- and a deleted order takes its items with it and leaves no trace.
    ('remove_meal: order row still exists', (v_orders_before = v_orders_after)::text, 'true'),
    ('remove_meal: order is cancelled',
      (select o.status from public.orders o where o.id = v_order), 'cancelled'),
    ('remove_meal: cancelled_at stamped',
      (select (o.cancelled_at is not null)::text from public.orders o where o.id = v_order), 'true'),
    ('remove_meal: its line left the bill',
      (select count(*)::text from public.billing_lines bl where bl.order_id = v_order), '0');
end $$;

insert into bal select 'a4', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');
insert into clo select 'a4', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');

insert into probe
select 'I1 remove_meal: only the affected member moved',
       (select count(*)::text from bal a join bal b
           on b.step='a4' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b4' and a.balance_minor is distinct from b.balance_minor
           and a.profile_id <> 'aaaaaaaa-0000-0000-0000-000000000005'),
       '0';

insert into probe
select 'I2 remove_meal: moved by exactly minus the line',
       (select (b.balance_minor - a.balance_minor)::text from bal a join bal b
           on b.step='a4' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b4' and a.profile_id = 'aaaaaaaa-0000-0000-0000-000000000005'),
       (select v from ctx where k='delta4');

insert into probe
select 'I6 remove_meal: ledger moved by exactly the delta',
       ((select sum(balance_minor) from bal where step='a4')
      - (select sum(balance_minor) from bal where step='b4'))::text,
       (select v from ctx where k='delta4');

insert into probe
select 'I7 remove_meal: settled week untouched',
       (select count(*)::text from clo a join clo b on b.step='a4' and b.id=a.id
         where a.step='b4'
           and (a.paid_minor, a.status, a.paid_at) is distinct from (b.paid_minor, b.status, b.paid_at)),
       '0';

------------------------------------------------------------ I3 and I4, at rest

-- I3. What the period was billed equals what the period's orders are worth.
insert into probe
select 'I3: billed total equals the orders it came from',
       (select coalesce(sum(bl.amount_minor),0)::text from public.billing_lines bl
         where bl.billing_period_id = (select v::bigint from ctx where k='p2')),
       (select coalesce(sum(c.amount_minor),0)::text from public.v_order_charges c
         where c.org_id = (select v::bigint from ctx where k='org_a')
           and c.order_status = 'placed' and not c.unpriced
           and c.service_date between (select v::date from ctx where k='w2')
                                  and (select v::date from ctx where k='w2') + 6);

-- I4. And every statement is the sum of the lines keyed on who PAYS, which is
-- the join a correction billed to the wrong person would fail.
insert into probe
select 'I4: every statement equals its payer''s lines',
       (select count(*)::text from public.billing_statements st
         where st.billing_period_id = (select v::bigint from ctx where k='p2')
           and st.meals_minor <> (select coalesce(sum(bl.amount_minor),0)
                                    from public.billing_lines bl
                                   where bl.billing_period_id = st.billing_period_id
                                     and bl.payer_profile_id = st.profile_id)),
       '0';

-- I5, over the whole run: nothing ever touched payments.
insert into probe
select 'I5: exactly one payment row, unchanged',
       (select count(*)::text || ':' || coalesce(sum(p.amount_minor),0)::text
          from public.payments p
          join public.organizations o on o.id = p.org_id and o.slug in ('corr-a','corr-b')),
       '1:45000';

------------------------------------------------- I7b: the counter-example

-- The coordinator's reading of I7 is that a closed week cannot move, because
-- only a LATER week's charge changed and the allocation is oldest-payment to
-- oldest-statement. That holds for every step above, where the corrected week
-- is the newest one this member has. It does not hold in general.
--
-- w0 is EARLIER than the settled w1 and is still open, because
-- billing_periods_hold_open refuses to close a week with an unpriced meal and
-- only looks inside its own dates. Pricing that meal gives MOT a charge that
-- sorts BEFORE the settled week, and private.reallocate re-walks every
-- statement the member has, closed ones included.
insert into clo select 'b7', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');
insert into bal select 'b7', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');

do $$
declare v_item bigint;
begin
  select mi.id into v_item from public.menu_items mi
    join public.menus mu on mu.id = mi.menu_id
   where mu.org_id = (select v::bigint from ctx where k='org_a')
     and mu.service_date = (select v::date from ctx where k='d0');

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform public.reprice_dish(v_item, 40000, 'the caterer finally sent a price');
  reset role;
end $$;

insert into clo select 'a7', st.id, st.paid_minor, st.status, st.paid_at
  from public.billing_statements st
 where st.billing_period_id = (select v::bigint from ctx where k='p1');
insert into bal select 'a7', b.org_id, b.profile_id, b.balance_minor::bigint
  from public.v_account_balance b
  join public.organizations o on o.id = b.org_id and o.slug in ('corr-a','corr-b');

-- These two are EXPECTED TO FAIL. `want` is what the coordinator's reading
-- predicts; `got` is what the database did. A FAIL here is the disproof, not a
-- test to loosen.
insert into probe
select 'I7b: settled statements rewritten by a correction to an EARLIER open week',
       (select count(*)::text from clo a join clo b on b.step='a7' and b.id=a.id
         where a.step='b7'
           and (a.paid_minor, a.status, a.paid_at) is distinct from (b.paid_minor, b.status, b.paid_at)),
       '0';

insert into probe
select 'I7b: settled statement status afterwards',
       (select b.status from clo b where b.step='a7' limit 1),
       'paid';

-- And the half that does hold, which is why this is an allocation bug and not a
-- money bug: reallocate rewrites paid_minor, status and paid_at, never
-- meals_minor and never a payment. The member's balance moves by the newly
-- priced meal and by nothing else.
insert into probe
select 'I7b: the member''s balance moved by exactly the newly priced meal',
       (select (b.balance_minor - a.balance_minor)::text from bal a join bal b
           on b.step='a7' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b7' and a.profile_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
       '40000';

insert into probe
select 'I7b: nobody else moved',
       (select count(*)::text from bal a join bal b
           on b.step='a7' and b.org_id=a.org_id and b.profile_id=a.profile_id
         where a.step='b7' and a.balance_minor is distinct from b.balance_minor
           and a.profile_id <> 'aaaaaaaa-0000-0000-0000-000000000002'),
       '0';

--------------------------------------------------------------- the refusals

do $$
declare
  v_item bigint; v_orders_before bigint; v_orders_after bigint;
  v_items_before bigint; v_items_after bigint; v_corr_before bigint; v_corr_after bigint;
  v_state text;
begin
  select mi.id into v_item from public.menu_items mi
    join public.menus mu on mu.id = mi.menu_id
   where mu.org_id = (select v::bigint from ctx where k='org_a')
     and mu.service_date = (select v::date from ctx where k='d2a')
     and mi.name = 'Phở';

  select count(*) into v_orders_before from public.orders;
  select count(*) into v_items_before  from public.order_items;
  select count(*) into v_corr_before   from public.order_corrections;

  set local role authenticated;

  -- R1. A member of the office, who is not an admin.
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}', true);
  insert into probe values
    ('control: role still downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: acting as a member',
      ((select auth.uid())::text = 'aaaaaaaa-0000-0000-0000-000000000002')::text, 'true');
  begin
    perform public.correct_meal((select v::bigint from ctx where k='org_a'),
              (select v::date from ctx where k='d2a'),
              'aaaaaaaa-0000-0000-0000-000000000002', v_item);
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values
    ('R1 member correcting: refused',
     v_state, '42501 only an admin of this office can correct the record');

  -- R2. An admin of this office reaching into the other one.
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
  begin
    perform public.correct_meal((select v::bigint from ctx where k='org_b'),
              (select v::date from ctx where k='d2a'),
              'bbbbbbbb-0000-0000-0000-000000000002',
              (select mi.id from public.menu_items mi
                 join public.menus mu on mu.id = mi.menu_id
                where mu.org_id = (select v::bigint from ctx where k='org_b') limit 1));
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values
    ('R2 cross-office correcting: refused',
     v_state, '42501 only an admin of this office can correct the record');

  -- R3. The settled week.
  begin
    perform public.correct_meal((select v::bigint from ctx where k='org_a'),
              (select v::date from ctx where k='d1'),
              'aaaaaaaa-0000-0000-0000-000000000002',
              (select mi.id from public.menu_items mi
                 join public.menus mu on mu.id = mi.menu_id
                where mu.org_id = (select v::bigint from ctx where k='org_a')
                  and mu.service_date = (select v::date from ctx where k='d1') limit 1));
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values
    ('R3 settled week: refused', v_state,
     '55000 the week of ' || to_char((select v::date from ctx where k='d1'), 'DD/MM')
       || ' has been settled, so it can no longer be corrected');

  -- R4. A reason longer than the record can hold.
  begin
    perform public.correct_meal((select v::bigint from ctx where k='org_a'),
              (select v::date from ctx where k='d2a'),
              'aaaaaaaa-0000-0000-0000-000000000004', v_item,
              1::smallint, null, repeat('x', 201));
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values
    ('R4 over-long reason: refused', v_state,
     '22001 a reason can be at most 200 characters; that one is 201');

  -- R5. The freeze trigger, reached directly. orders_admin_all lets an admin
  -- write any row of their office, and before 20261007100000 this INSERT
  -- succeeded and never reached a bill.
  begin
    insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
    select (select v::bigint from ctx where k='org_a'), mu.id, mu.service_date,
           'aaaaaaaa-0000-0000-0000-000000000003', 'admin',
           'aaaaaaaa-0000-0000-0000-000000000001'
      from public.menus mu
     where mu.org_id = (select v::bigint from ctx where k='org_a')
       and mu.service_date = (select v::date from ctx where k='d1');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values
    ('R5 direct insert into a settled week: refused', v_state,
     '55000 lunch on ' || to_char((select v::date from ctx where k='d1'), 'DD/MM')
       || ' is on a week that has been settled, so the record can no longer be changed');

  -- R6. The audit table is not writable from a browser, by grant OR by policy.
  begin
    insert into public.order_corrections
      (org_id, service_date, kind, order_id, profile_id, summary, made_by)
    values ((select v::bigint from ctx where k='org_a'),
            (select v::date from ctx where k='d2a'), 'meal',
            (select v::bigint from ctx where k='order_hai'),
            'aaaaaaaa-0000-0000-0000-000000000003', 'forged',
            'aaaaaaaa-0000-0000-0000-000000000001');
    v_state := 'allowed';
  exception when others then v_state := 'blocked';
  end;
  insert into probe values ('R6 forging an audit row', v_state, 'blocked');

  -- R7. An admin reads the trail; a member reads none of it.
  insert into probe values
    ('R7 admin sees the trail',
      ((select count(*) from public.order_corrections) >= 4)::text, 'true');
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}', true);
  insert into probe values
    ('R7 member sees no trail', (select count(*)::text from public.order_corrections), '0');

  reset role;

  select count(*) into v_orders_after from public.orders;
  select count(*) into v_items_after  from public.order_items;
  select count(*) into v_corr_after   from public.order_corrections;

  -- The deltas, because a refusal that raised is not the same claim as a
  -- refusal that wrote nothing.
  insert into probe values
    ('refusals wrote no order',      (v_orders_before = v_orders_after)::text, 'true'),
    ('refusals wrote no order line', (v_items_before  = v_items_after)::text,  'true'),
    ('refusals wrote no audit row',  (v_corr_before   = v_corr_after)::text,   'true');
end $$;

--------------------------------------------------------------------- verdict

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
