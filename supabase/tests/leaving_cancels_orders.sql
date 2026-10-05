-- Leaving an office, or being removed, cancels the person's open orders.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/leaving_cancels_orders.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- An order is open while its day is published and its cutoff ahead, the window
-- in which the person could cancel it themselves. Those are cancelled, their
-- pending pass withdrawn and their week re-billed (20261024100000); everything
-- past the cutoff stays placed and billed. Every money probe is an exact
-- figure, and the people who must NOT have moved are named too.

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

-- The answer of a one-value query, or the error.
create function pg_temp.ask(p_sql text) returns text
language plpgsql as $fn$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'null');
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

create function pg_temp.balance(p_step text, p_code text) returns text
language sql stable as $fn$
  select balance_minor::text from bal where step = p_step and code = p_code;
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

create function pg_temp.m(p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c('org')::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

-- `status dish@price`, with `*` after a line the system wrote, or `none`.
create function pg_temp.ord(p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((
    select o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot || '@' || oi.unit_price_minor
                                          || case when oi.auto_assigned then '*' else '' end, ',')
                          from public.order_items oi where oi.order_id = o.id), '-')
      from public.orders o
     where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid),
    'none');
$fn$;

-- One person's orders on the days named, as `day:status`.
create function pg_temp.days(p_who text, p_days text[]) returns text
language sql stable as $fn$
  select string_agg(d || ':' || coalesce((
           select o.status from public.orders o
            where o.menu_id = pg_temp.m(d) and o.profile_id = pg_temp.c(p_who)::uuid), 'none'),
         ' ' order by n)
    from unnest(p_days) with ordinality as x(d, n);
$fn$;

create function pg_temp.oid(p_day text, p_who text) returns bigint
language sql stable as $fn$
  select o.id from public.orders o
   where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@leaving.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1ea00000-0000-0000-0000-000000000001', 'adm'),
    ('1ea00000-0000-0000-0000-000000000002', 'lea'),
    ('1ea00000-0000-0000-0000-000000000003', 'rem'),
    ('1ea00000-0000-0000-0000-000000000004', 'sty'),
    ('1ea00000-0000-0000-0000-000000000005', 'oth'),
    ('1ea00000-0000-0000-0000-000000000006', 'opn'),
    ('1ea00000-0000-0000-0000-000000000007', 'due'),
    ('1ea00000-0000-0000-0000-000000000008', 'eat'),
    ('1ea00000-0000-0000-0000-000000000009', 'rcv'),
    ('1ea00000-0000-0000-0000-00000000000a', 'exa'),
    ('1ea00000-0000-0000-0000-00000000000b', 'exb'),
    ('1ea00000-0000-0000-0000-0000000000b1', 'bown')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@leaving.test';

insert into public.organizations (slug, name, timezone, short_code, telegram_join_code)
values ('leaving-a', 'Leaving A', 'Asia/Ho_Chi_Minh', 'LVA', 'LVAJXKNA'),
       ('leaving-b', 'Leaving B', 'Asia/Ho_Chi_Minh', 'LVB', 'LVBJXKNA');
insert into ctx values
  ('org',   (select id from public.organizations where slug = 'leaving-a')::text),
  ('org_b', (select id from public.organizations where slug = 'leaving-b')::text);

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c(case when x = 'bown' then 'org_b' else 'org' end)::bigint, pg_temp.c(x)::uuid,
       case when x in ('adm', 'bown') then 'owner' else 'member' end,
       upper(x) || 'X'
  from unnest(array['adm', 'lea', 'rem', 'sty', 'oth', 'opn', 'due', 'eat', 'rcv',
                    'exa', 'exb', 'bown']) as x;
insert into ctx select 'm_' || lower(left(ms.short_code, 3)), ms.id::text from public.memberships ms
 where ms.org_id = pg_temp.c('org')::bigint;

-- LEA, REM and STY eat every weekday by rule.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c('org')::bigint, pg_temp.c(w)::uuid, d, true
  from unnest(array['lea', 'rem', 'sty']) as w, generate_series(1, 7) as d;

-- W is a week three weeks out: d1 and d2 open, d3 published with its cutoff
-- gone (the tick has not locked it yet), d4 locked. d5 and d6 are the next
-- week's Monday and Tuesday, open, a week nobody has billed. past is in a
-- settled week.
do $$
declare v_t date; v_mon date;
begin
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  v_mon := v_t - (extract(isodow from v_t)::int - 1) + 21;
  insert into ctx values
    ('d1', v_mon::text), ('d2', (v_mon + 1)::text), ('d3', (v_mon + 2)::text),
    ('d4', (v_mon + 3)::text), ('d5', (v_mon + 7)::text), ('d6', (v_mon + 8)::text),
    ('d7', (v_mon + 9)::text),
    ('past', (v_t - (extract(isodow from v_t)::int - 1) - 14)::text);
end $$;

-- A day with its dishes in one statement, so a two-dish day never passes
-- through one dish. Inserting the menu materializes the rules before its cutoff.
create function pg_temp.day(p_org text, p_day text, p_cutoff timestamptz, p_dishes text[], p_prices int[])
returns bigint language plpgsql as $fn$
declare v_menu bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, p_cutoff,
          pg_temp.c(case when p_org = 'org' then 'adm' else 'bown' end)::uuid)
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  select v_menu, pg_temp.c(p_org)::bigint, d, p, n - 1
    from unnest(p_dishes, p_prices) with ordinality as x(d, p, n);
  return v_menu;
end $fn$;

-- An order of somebody's with the dish named, written as the service.
create function pg_temp.eat(p_org text, p_day text, p_who text, p_dish text) returns void
language plpgsql as $fn$
declare v_menu bigint; v_order bigint;
begin
  select id into v_menu from public.menus
   where org_id = pg_temp.c(p_org)::bigint and service_date = pg_temp.c(p_day)::date;
  select id into v_order from public.orders where menu_id = v_menu and profile_id = pg_temp.c(p_who)::uuid;
  if v_order is null then
    insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
    values (pg_temp.c(p_org)::bigint, v_menu, pg_temp.c(p_day)::date, pg_temp.c(p_who)::uuid,
            'member', pg_temp.c(p_who)::uuid)
    returning id into v_order;
  end if;
  delete from public.order_items where order_id = v_order;
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
  select v_order, pg_temp.c(p_org)::bigint, pg_temp.c(p_who)::uuid, v_menu, mi.id, 1
    from public.menu_items mi where mi.menu_id = v_menu and mi.name = p_dish;
end $fn$;

select pg_temp.day('org', 'd1', now() + interval '10 days', array['Com ga', 'Pho'], array[45000, 50000]);
select pg_temp.day('org', 'd2', now() + interval '10 days', array['Bun'], array[40000]);
select pg_temp.day('org', 'd3', now() - interval '1 hour', array['Com ga'], array[45000]);
select pg_temp.day('org', 'd4', now() - interval '1 hour', array['Com ga'], array[45000]);
update public.menus set status = 'locked' where id = pg_temp.m('d4');
select pg_temp.day('org', 'd5', now() + interval '16 days', array['Bun'], array[40000]);
select pg_temp.day('org', 'past', now() - interval '15 days', array['Com ga'], array[45000]);
select pg_temp.day('org_b', 'd1', now() + interval '10 days', array['Com ga'], array[45000]);

select pg_temp.eat('org', 'd1', 'lea', 'Com ga');
select pg_temp.eat('org', 'd1', 'rem', 'Pho');
select pg_temp.eat('org', 'd1', w, 'Com ga') from unnest(array['opn', 'due', 'adm']) as w;
select pg_temp.eat('org', 'd1', 'oth', 'Pho');
select pg_temp.eat('org', 'd2', w, 'Bun') from unnest(array['oth', 'exa', 'exb']) as w;
select pg_temp.eat('org', 'd3', w, 'Com ga') from unnest(array['lea', 'due']) as w;
select pg_temp.eat('org', 'd4', w, 'Com ga') from unnest(array['lea', 'rem']) as w;
select pg_temp.eat('org', 'past', 'lea', 'Com ga');
select pg_temp.eat('org_b', 'd1', 'bown', 'Com ga');

-- LEA offers d1 to RCV, still waiting; REM passed d1 to EAT, who accepted.
do $$ begin
  perform pg_temp.act('lea');
  insert into probe values ('F0 LEA offers d1 to RCV', pg_temp.try(format(
    'insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
     values (%s, %s, %L, %L, %L)', pg_temp.c('org'), pg_temp.oid('d1', 'lea'),
     pg_temp.c('lea'), pg_temp.c('rcv'), pg_temp.c('lea'))), 'ok');
  perform pg_temp.act('rem');
  insert into probe values ('F0 REM offers d1 to EAT', pg_temp.try(format(
    'insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
     values (%s, %s, %L, %L, %L)', pg_temp.c('org'), pg_temp.oid('d1', 'rem'),
     pg_temp.c('rem'), pg_temp.c('eat'), pg_temp.c('rem'))), 'ok');
  perform pg_temp.act('eat');
  insert into probe values ('F0 EAT accepts', pg_temp.try(format(
    $q$update public.meal_transfers set status = 'accepted' where order_id = %s$q$,
    pg_temp.oid('d1', 'rem'))), 'ok');
end $$;
reset role;

insert into ctx values
  ('p_w',    public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date)::text),
  ('p_past', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('past')::date)::text),
  ('p_b',    public.ensure_billing_period(pg_temp.c('org_b')::bigint, pg_temp.c('d1')::date)::text);
select public.run_billing(pg_temp.c(p)::bigint) is not null from unnest(array['p_w', 'p_past', 'p_b']) as p;
update public.billing_periods set status = 'closed', closed_at = now()
 where id = pg_temp.c('p_past')::bigint;

-- LEA paid 200 000 ahead and REM 100 000, so both hold credit.
insert into public.payments (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
values (pg_temp.c('org')::bigint, 'leaving-1', 200000, 'LUNCHLEAX', now(), '{}'),
       (pg_temp.c('org')::bigint, 'leaving-2', 100000, 'LUNCHREMX', now(), '{}');

------------------------------------------------------------------- controls

select pg_temp.snap('k0');
do $$ begin
  perform pg_temp.act('lea');
  insert into probe values ('K0 control: role downgraded', current_role, 'authenticated');
end $$;
reset role;
insert into probe values
  ('K0 control: d1 to d4 are one billing week',
   (select string_agg(distinct public.ensure_billing_period(pg_temp.c('org')::bigint,
                                pg_temp.c(d)::date)::text, ',')
      from unnest(array['d1', 'd2', 'd3', 'd4']) as d), pg_temp.c('p_w')),
  ('K0 control: the stages are open, open, past the cutoff, locked',
   (select string_agg(m.status || case when m.order_cutoff_at > now() then '+' else '-' end, ' '
                      order by m.service_date)
      from public.menus m where m.id in (pg_temp.m('d1'), pg_temp.m('d2'), pg_temp.m('d3'),
                                         pg_temp.m('d4'), pg_temp.m('d5'))),
   'published+ published+ published- locked- published+'),
  ('K0 control: the rules ordered for LEA and REM on the open days, and the one dish is the system''s',
   pg_temp.ord('d2', 'lea') || ' | ' || pg_temp.ord('d2', 'rem') || ' | ' || pg_temp.ord('d5', 'lea'),
   'placed Bun@40000* | placed Bun@40000* | placed Bun@40000*'),
  ('K0 control: no rule ordered after a cutoff', pg_temp.ord('d3', 'rem'), 'none'),
  ('K0 control: the week is billed, each statement its lines', pg_temp.statements('p_w'),
   'ADMX 45000 1, DUEX 90000 2, EATX 50000 1, EXAX 40000 1, EXBX 40000 1, LEAX 175000 4, '
   || 'OPNX 45000 1, OTHX 90000 2, REMX 85000 2, STYX 40000 2'),
  ('K0 control: LEA owes 20 000 over two weeks, REM holds credit, OPN and DUE owe',
   pg_temp.balance('k0', 'LEAX') || ' ' || pg_temp.balance('k0', 'REMX') || ' '
   || pg_temp.balance('k0', 'OPNX') || ' ' || pg_temp.balance('k0', 'DUEX'),
   '20000 -15000 45000 90000'),
  ('K0 control: nobody has billed d5''s week',
   (select count(*)::text from public.billing_periods
     where org_id = pg_temp.c('org')::bigint
       and pg_temp.c('d5')::date between period_start and period_end), '0');

------------------------------------ L1 owing only for an open meal is no bar

do $$ begin
  perform pg_temp.act('opn');
  insert into probe values
    ('L1 OPN is told leaving leaves nothing owed, though the bill says 45 000',
     pg_temp.ask(format('select public.my_balance_after_leaving(%s)::text', pg_temp.c('org'))) || ' / '
     || (select balance_minor::text from public.v_account_balance
          where org_id = pg_temp.c('org')::bigint and profile_id = pg_temp.c('opn')::uuid),
     '0 / 45000');
  insert into probe values ('L1 asking changed nothing', pg_temp.ord('d1', 'opn'), 'placed Com ga@45000');
  insert into probe values ('L1 OPN leaves',
    pg_temp.try(format('select public.leave_office(%s)', pg_temp.c('org'))), 'ok');
end $$;
reset role;
select pg_temp.snap('l1');
insert into probe values
  ('L1 OPN''s open meal is cancelled', pg_temp.ord('d1', 'opn'), 'cancelled Com ga@45000'),
  ('L1 OPN owes nothing, and nobody else moved', pg_temp.moved('k0', 'l1'), 'OPNX -45000'),
  ('L1 OPN''s statement is gone with its last line', pg_temp.statements('p_w'),
   'ADMX 45000 1, DUEX 90000 2, EATX 50000 1, EXAX 40000 1, EXBX 40000 1, LEAX 175000 4, '
   || 'OTHX 90000 2, REMX 85000 2, STYX 40000 2');

------------------------------- L2 a debt past the cutoff still refuses, whole

do $$ begin
  perform pg_temp.act('due');
  insert into probe values
    ('L2 DUE is told the 45 000 of d3 is still owed', pg_temp.ask(format(
       'select public.my_balance_after_leaving(%s)::text', pg_temp.c('org'))), '45000');
  insert into probe values ('L2 DUE cannot leave',
    pg_temp.try(format('select public.leave_office(%s)', pg_temp.c('org'))),
    '55000 you still owe this office money; settle up before you leave');
  perform pg_temp.act('adm');
  insert into probe values ('L2 the only owner cannot leave, as before',
    pg_temp.try(format('select public.leave_office(%s)', pg_temp.c('org'))),
    '55000 you are the only owner; make somebody else an owner first, or delete the office');
end $$;
reset role;
select pg_temp.snap('l2');
insert into probe values
  ('L2 the refusals cancelled nothing', pg_temp.ord('d1', 'due') || ' | ' || pg_temp.ord('d1', 'adm'),
   'placed Com ga@45000 | placed Com ga@45000'),
  ('L2 and moved no money', pg_temp.moved('l1', 'l2'), '-'),
  ('L2 DUE and ADM are still members',
   (select string_agg(status, ',' order by id) from public.memberships
     where id in (pg_temp.c('m_due')::bigint, pg_temp.c('m_adm')::bigint)), 'active,active');

----------------------------------------------------------- L3 LEA leaves

do $$ begin
  perform pg_temp.act('lea');
  insert into probe values
    ('L3 LEA owes 20 000, and is told leaving leaves 65 000 of credit',
     pg_temp.ask(format('select public.my_balance_after_leaving(%s)::text', pg_temp.c('org'))), '-65000');
  insert into probe values ('L3 LEA leaves',
    pg_temp.try(format('select public.leave_office(%s)', pg_temp.c('org'))), 'ok');
end $$;
reset role;
select pg_temp.snap('l3');
insert into probe values
  ('L3 the open days are cancelled, the system''s one dish included; past the cutoff and past stay',
   pg_temp.days('lea', array['d1', 'd2', 'd5', 'd3', 'd4', 'past']),
   'd1:cancelled d2:cancelled d5:cancelled d3:placed d4:placed past:placed'),
  ('L3 the pending offer is withdrawn, by LEA, saying why',
   (select t.status || ' ' || ms.short_code || ' ' || t.reason || case when t.decided_at is null then ' NO DATE' else '' end
      from public.meal_transfers t
      join public.memberships ms on ms.org_id = t.org_id and ms.profile_id = t.decided_by
     where t.order_id = pg_temp.oid('d1', 'lea')),
   'cancelled LEAX withdrawn: the meal was cancelled when its owner left the office'),
  ('L3 LEA left, not removed',
   (select status || ' ' || coalesce(removed_at::text, '-') from public.memberships
     where id = pg_temp.c('m_lea')::bigint), 'inactive -');

do $$ begin
  perform pg_temp.act('rcv');
  insert into probe values ('L3 RCV cannot accept it now', pg_temp.try(format(
    $q$update public.meal_transfers set status = 'accepted' where order_id = %s$q$,
    pg_temp.oid('d1', 'lea'))),
    '55000 the lunch on ' || to_char(pg_temp.c('d1')::date, 'DD/MM')
      || ' offered to you was cancelled, so there is no meal to accept');
end $$;
reset role;
insert into probe values
  ('L3 the week is re-billed at once: LEA keeps d3 and d4', pg_temp.statements('p_w'),
   'ADMX 45000 1, DUEX 90000 2, EATX 50000 1, EXAX 40000 1, EXBX 40000 1, LEAX 90000 2, '
   || 'OTHX 90000 2, REMX 85000 2, STYX 40000 2'),
  ('L3 LEA has the 85 000 back as credit, and nobody else moved', pg_temp.moved('l2', 'l3'), 'LEAX -85000'),
  ('L3 the figure Settings was told is the one leaving left', pg_temp.balance('l3', 'LEAX'), '-65000'),
  ('L3 the settled week is untouched', (select st.meals_minor || ' ' || st.meal_count
      from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p_past')::bigint
       and st.profile_id = pg_temp.c('lea')::uuid), '45000 1'),
  ('L3 no billing period was made for d5''s week',
   (select count(*)::text from public.billing_periods
     where org_id = pg_temp.c('org')::bigint
       and pg_temp.c('d5')::date between period_start and period_end), '0');

---------------------------------------------- L4 an admin removes REM

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L4 ADM removes REM, as the People screen does', pg_temp.try(format(
    $q$update public.memberships set status = 'inactive' where id = %s$q$, pg_temp.c('m_rem'))), 'ok');
end $$;
reset role;
select pg_temp.snap('l4');
insert into probe values
  ('L4 REM''s open days are cancelled; the meal EAT accepted, and d4, stay',
   pg_temp.days('rem', array['d2', 'd5', 'd1', 'd4']),
   'd2:cancelled d5:cancelled d1:placed d4:placed'),
  ('L4 the accepted pass is untouched', (select string_agg(t.status, ',') from public.meal_transfers t
     where t.order_id = pg_temp.oid('d1', 'rem')), 'accepted'),
  ('L4 the week is re-billed: REM keeps d4, EAT still pays for d1', pg_temp.statements('p_w'),
   'ADMX 45000 1, DUEX 90000 2, EATX 50000 1, EXAX 40000 1, EXBX 40000 1, LEAX 90000 2, '
   || 'OTHX 90000 2, REMX 45000 1, STYX 40000 2'),
  ('L4 REM has the 40 000 back, nobody else moved', pg_temp.moved('l3', 'l4'), 'REMX -40000'),
  ('L4 the row says removed',
   (select status || ' ' || (removed_at is not null)::text from public.memberships
     where id = pg_temp.c('m_rem')::bigint), 'inactive true');

--------------------------------------- L5 two at once, by the service role

update public.memberships set status = 'inactive'
 where id in (pg_temp.c('m_exa')::bigint, pg_temp.c('m_exb')::bigint);
select pg_temp.snap('l5');
insert into probe values
  ('L5 one UPDATE removing two cancels both open meals',
   pg_temp.ord('d2', 'exa') || ' | ' || pg_temp.ord('d2', 'exb'), 'cancelled Bun@40000 | cancelled Bun@40000'),
  ('L5 and takes both off the bill', pg_temp.moved('l4', 'l5'), 'EXAX -40000, EXBX -40000');

------------------------------- L5b nothing is placed for somebody gone

select pg_temp.snap('l5b0');
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values
    ('L5b an admin cannot record a meal for LEA on a day she has none',
     pg_temp.try(format('select public.correct_meal(%s, %L::date, %L::uuid, %s)', pg_temp.c('org'),
       pg_temp.c('d2'), pg_temp.c('lea'),
       (select id from public.menu_items where menu_id = pg_temp.m('d2') and name = 'Bun'))),
     '55000 lea is no longer in this office, so no lunch can be recorded for them on '
       || to_char(pg_temp.c('d2')::date, 'DD/MM')),
    ('L5b nor an off-menu one for REM',
     pg_temp.try(format($q$select public.correct_meal_off_menu(%s, %L::date, %L::uuid, 'Bun rieu', 30000)$q$,
       pg_temp.c('org'), pg_temp.c('d5'), pg_temp.c('rem'))),
     '55000 rem is no longer in this office, so no lunch can be recorded for them on '
       || to_char(pg_temp.c('d5')::date, 'DD/MM')),
    ('L5b nor pass a meal to LEA',
     pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.oid('d1', 'oth'), pg_temp.c('lea'))),
     'P0002 that person is not a member of this office'),
    ('L5b nor place her cancelled order again on the table',
     pg_temp.try(format($q$update public.orders set status = 'placed', cancelled_at = null where id = %s$q$,
       pg_temp.oid('d5', 'lea'))),
     '42501 that person is not a member of this office');
end $$;
reset role;
select pg_temp.snap('l5b1');
insert into probe values
  ('L5b the refusals wrote nothing',
   pg_temp.days('lea', array['d2', 'd5']) || ' / ' || pg_temp.ord('d5', 'rem') || ' / '
   || (select count(*)::text from public.meal_transfers where order_id = pg_temp.oid('d1', 'oth')),
   'd2:cancelled d5:cancelled / cancelled Bun@40000* / 0'),
  ('L5b and moved no money', pg_temp.moved('l5b0', 'l5b1'), '-');

------------------------------ L6 the rules order nothing for somebody gone

select pg_temp.day('org', 'd6', now() + interval '16 days', array['Bun'], array[40000]);
select private.materialize_office(pg_temp.c('org')::bigint);
insert into probe values
  ('L6 a new day orders for STY and nobody who is gone',
   pg_temp.ord('d6', 'sty') || ' | ' || pg_temp.ord('d6', 'lea') || ' | ' || pg_temp.ord('d6', 'rem'),
   'placed Bun@40000* | none | none'),
  ('L6 materializing again revives nothing',
   pg_temp.days('lea', array['d1', 'd2', 'd5']) || ' / ' || pg_temp.days('rem', array['d2', 'd5']),
   'd1:cancelled d2:cancelled d5:cancelled / d2:cancelled d5:cancelled');

------------------------------------------- L7 coming back revives nothing

do $$ begin
  perform pg_temp.act('lea');
  insert into probe values ('L7 LEA rejoins with the code',
    pg_temp.try($q$select * from public.join_with_code('LVAJXKNA', 'lea')$q$), 'ok');
  perform pg_temp.act('adm');
  insert into probe values ('L7 ADM adds REM back', pg_temp.try(format(
    $q$update public.memberships set status = 'active' where id = %s$q$, pg_temp.c('m_rem'))), 'ok');
end $$;
reset role;
select private.materialize_office(pg_temp.c('org')::bigint);
select pg_temp.day('org', 'd7', now() + interval '16 days', array['Bun'], array[40000]);
select pg_temp.snap('l7');
insert into probe values
  ('L7 both are members again',
   (select string_agg(status, ',' order by id) from public.memberships
     where id in (pg_temp.c('m_lea')::bigint, pg_temp.c('m_rem')::bigint)), 'active,active'),
  ('L7 their cancelled meals stay cancelled',
   pg_temp.days('lea', array['d1', 'd2', 'd5']) || ' / ' || pg_temp.days('rem', array['d2', 'd5']),
   'd1:cancelled d2:cancelled d5:cancelled / d2:cancelled d5:cancelled'),
  ('L7 the offer stays withdrawn',
   (select t.status from public.meal_transfers t where t.order_id = pg_temp.oid('d1', 'lea')), 'cancelled'),
  ('L7 their rules order only open days they have no row on: d6, missed while away, and a new d7',
   pg_temp.ord('d6', 'lea') || ' | ' || pg_temp.ord('d7', 'lea') || ' | '
   || pg_temp.ord('d6', 'rem') || ' | ' || pg_temp.ord('d7', 'rem'),
   'placed Bun@40000* | placed Bun@40000* | placed Bun@40000* | placed Bun@40000*'),
  ('L7 and nobody''s balance moved on the way back', pg_temp.moved('l5', 'l7'), '-');

---------------------------------------------- L8 everybody else, untouched

insert into probe values
  ('L8 the members who stayed keep every order',
   pg_temp.days('sty', array['d1', 'd2', 'd5']) || ' / ' || pg_temp.days('oth', array['d1', 'd2'])
   || ' / ' || pg_temp.days('due', array['d1', 'd3']),
   'd1:placed d2:placed d5:placed / d1:placed d2:placed / d1:placed d3:placed'),
  ('L8 the other office''s order and statement are untouched',
   (select o.status from public.orders o where o.org_id = pg_temp.c('org_b')::bigint) || ' '
   || (select st.meals_minor::text from public.billing_statements st
        where st.billing_period_id = pg_temp.c('p_b')::bigint), 'placed 45000'),
  ('L8 across the file only the people who went moved, each by their open meals',
   pg_temp.moved('k0', 'l7'), 'EXAX -40000, EXBX -40000, LEAX -85000, OPNX -45000, REMX -40000'),
  ('L8 every statement in the week is still the sum of its lines',
   (select count(*)::text from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p_w')::bigint
       and st.meals_minor <> (select coalesce(sum(bl.amount_minor), 0) from public.billing_lines bl
                               where bl.billing_period_id = st.billing_period_id
                                 and bl.payer_profile_id = st.profile_id)), '0'),
  ('L8 no cancelled meal has a billing line',
   (select count(*)::text from public.billing_lines bl join public.orders o on o.id = bl.order_id
     where o.org_id = pg_temp.c('org')::bigint and o.status <> 'placed'), '0');

do $$ begin
  perform pg_temp.act('bown');
  insert into probe values ('L8 nobody outside the office can ask what leaving it would leave',
    pg_temp.ask(format('select public.my_balance_after_leaving(%s)::text', pg_temp.c('org'))),
    'P0002 you are not a member of that office');
end $$;
reset role;

------------------------- L9 a meal LEA kept can still be put right

do $$ begin
  perform pg_temp.act('lea');
  insert into probe values ('L9 LEA leaves again', pg_temp.try(format(
    'select public.leave_office(%s)', pg_temp.c('org'))), 'ok');
  perform pg_temp.act('adm');
  insert into probe values
    ('L9 an admin corrects d3, which LEA kept, to two portions',
     pg_temp.try(format('select public.correct_meal(%s, %L::date, %L::uuid, %s, 2::smallint)', pg_temp.c('org'),
       pg_temp.c('d3'), pg_temp.c('lea'),
       (select id from public.menu_items where menu_id = pg_temp.m('d3') and name = 'Com ga'))), 'ok');
end $$;
reset role;
insert into probe values
  ('L9 the record says so, still placed', pg_temp.ord('d3', 'lea'), 'placed Com ga@45000');

----------------------------- L10 an undo puts no open meal back on a giver gone

-- GVR's meals on d1 (open) and d3 (past its cutoff) were passed to OTH, so
-- leaving cancels neither; BGN is a member of the other office who left.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@leaving.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values ('1ea00000-0000-0000-0000-0000000000c1', 'gvr'),
               ('1ea00000-0000-0000-0000-0000000000c2', 'bgn')) as u(id, k);
insert into ctx values ('gvr', '1ea00000-0000-0000-0000-0000000000c1'),
                       ('bgn', '1ea00000-0000-0000-0000-0000000000c2');
insert into public.memberships (org_id, profile_id, role, short_code, status)
values (pg_temp.c('org')::bigint, pg_temp.c('gvr')::uuid, 'member', 'GVRX', 'active'),
       (pg_temp.c('org_b')::bigint, pg_temp.c('bgn')::uuid, 'member', 'BGNX', 'inactive');
select pg_temp.eat('org', d, 'gvr', 'Com ga') from unnest(array['d1', 'd3']) as d;

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L10 ADM records GVR''s d1 and d3 as OTH''s',
    pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.oid('d1', 'gvr'), pg_temp.c('oth')))
    || ' ' || pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.oid('d3', 'gvr'), pg_temp.c('oth'))),
    'ok ok');
  perform pg_temp.act('gvr');
  insert into probe values ('L10 GVR leaves, cancelling nothing',
    pg_temp.ask(format('select public.leave_office(%s)::text', pg_temp.c('org'))), '0');
end $$;
reset role;
select pg_temp.snap('l10a');
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L10 the open day''s pass cannot be undone onto GVR',
    pg_temp.try(format('select public.undo_pass(%s)', (select t.id from public.meal_transfers t
      where t.order_id = pg_temp.oid('d1', 'gvr')))),
    '55000 gvr has left the office, so the meal cannot go back to them on '
      || to_char(pg_temp.c('d1')::date, 'DD/MM'));
  insert into probe values ('L10 the one past its cutoff can',
    pg_temp.try(format('select public.undo_pass(%s)', (select t.id from public.meal_transfers t
      where t.order_id = pg_temp.oid('d3', 'gvr')))), 'ok');
end $$;
reset role;
select pg_temp.snap('l10b');
insert into probe values
  ('L10 d1 stays OTH''s, d3 is GVR''s again',
   (select string_agg(t.status, ',' order by o.service_date) from public.meal_transfers t
      join public.orders o on o.id = t.order_id where o.profile_id = pg_temp.c('gvr')::uuid),
   'accepted,undone'),
  ('L10 only d3 moved, 45 000 from OTH to GVR', pg_temp.moved('l10a', 'l10b'), 'GVRX 45000, OTHX -45000');

-- An order for another office's member is refused by RLS in the same words,
-- whether that person is active there, has left, or was never in it.
do $$
declare v_menu bigint := (select id from public.menus where org_id = pg_temp.c('org_b')::bigint);
        v_sql text := 'insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
                       values (%s, %s, %L::date, %L::uuid, ''member'', %L::uuid)';
begin
  perform pg_temp.act('oth');
  insert into probe values ('L10 isolation: an order in the other office says nothing about who is there',
    pg_temp.try(format(v_sql, pg_temp.c('org_b'), v_menu, pg_temp.c('d1'), pg_temp.c('bown'), pg_temp.c('oth')))
    || ' | ' || pg_temp.try(format(v_sql, pg_temp.c('org_b'), v_menu, pg_temp.c('d1'), pg_temp.c('bgn'), pg_temp.c('oth')))
    || ' | ' || pg_temp.try(format(v_sql, pg_temp.c('org_b'), v_menu, pg_temp.c('d1'), pg_temp.c('lea'), pg_temp.c('oth'))),
    '42501 new row violates row-level security policy for table "orders" | '
    || '42501 new row violates row-level security policy for table "orders" | '
    || '42501 new row violates row-level security policy for table "orders"');
end $$;
reset role;

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
