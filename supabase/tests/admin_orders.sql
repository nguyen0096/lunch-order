-- The Orders screen's writes: who may make them, on which days, what they do
-- to money, what they write down and who they tell.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/admin_orders.sql
--
-- Builds its own fixtures and rolls everything back. It shares the traps
-- corrections.sql names: the role is asserted downgraded before any refusal is
-- judged, every refusal is also a row delta, and every money probe is an exact
-- figure from the menu, with the people who must NOT have moved named too.
--
-- No fixture here holds credit or a payment. A person whose last meal leaves a
-- week keeps a stale statement while money is allocated to it, which is
-- fixed on another branch (rebill-rebuilds-statements); these figures do not
-- depend on that fix.
--
-- The day stages are real, from the clock: the office's day runs 00:00 to
-- 23:59, so today is `closed` (Cooking) for the whole run.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;
create temp table bal (step text, profile_id uuid, balance_minor bigint);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

-- One statement as whoever is acting; 'ok' or the SQLSTATE and the sentence.
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

create function pg_temp.snap(p_step text) returns void
language sql as $fn$
  insert into bal
  select p_step, b.profile_id, b.balance_minor::bigint
    from public.v_account_balance b
   where b.org_id = pg_temp.c('org_a')::bigint;
$fn$;

create function pg_temp.moved(p_a text, p_b text, p_who text) returns bigint
language sql stable as $fn$
  select coalesce((select balance_minor from bal where step = p_b and profile_id = pg_temp.c(p_who)::uuid), 0)
       - coalesce((select balance_minor from bal where step = p_a and profile_id = pg_temp.c(p_who)::uuid), 0);
$fn$;

-- Who moved between two snapshots, by key, so a probe can name its complement.
create function pg_temp.movers(p_a text, p_b text) returns text
language sql stable as $fn$
  select coalesce(string_agg(k.k, ',' order by k.k), '-')
    from ctx k
    join bal a on a.step = p_a and a.profile_id::text = k.v
    join bal b on b.step = p_b and b.profile_id = a.profile_id
   where k.k in ('adm', 'quan', 'teo', 'dinh', 'vy', 'lan')
     and a.balance_minor is distinct from b.balance_minor;
$fn$;

create function pg_temp.m(p_minor bigint) returns text
language sql stable as $fn$
  select private.money_text(p_minor, o.currency_minor_units, o.currency)
    from public.organizations o where o.id = pg_temp.c('org_a')::bigint;
$fn$;

-- Lines and statements agree with the record, for every open week of office A:
-- one line per placed, priced order at its amount on its payer, no line for
-- anything else, and each statement the sum of its person's lines.
create function pg_temp.ledger_faults() returns text
language sql stable as $fn$
  with periods as (
    select bp.* from public.billing_periods bp
     where bp.org_id = pg_temp.c('org_a')::bigint and bp.status = 'open'),
  want as (
    select c.order_id, c.payer_profile_id, c.amount_minor, p.id as period_id
      from public.v_order_charges c
      join periods p on c.service_date between p.period_start and p.period_end
     where c.org_id = pg_temp.c('org_a')::bigint
       and c.order_status = 'placed' and not c.unpriced),
  got as (
    select bl.order_id, bl.payer_profile_id, bl.amount_minor, bl.billing_period_id as period_id
      from public.billing_lines bl join periods p on p.id = bl.billing_period_id),
  line_faults as (
    select count(*) as n from (
      (select * from want except select * from got)
      union all
      (select * from got except select * from want)) x),
  stmt_faults as (
    select count(*) as n
      from public.billing_statements st
      join periods p on p.id = st.billing_period_id
     where st.meals_minor is distinct from
           (select coalesce(sum(bl.amount_minor), 0) from public.billing_lines bl
             where bl.billing_period_id = st.billing_period_id
               and bl.payer_profile_id = st.profile_id)),
  missing_stmt as (
    select count(*) as n from (
      select distinct g.period_id, g.payer_profile_id from got g
      except
      select st.billing_period_id, st.profile_id from public.billing_statements st) x)
  select (select n from line_faults) || ' lines, '
      || (select n from stmt_faults) || ' statements, '
      || (select n from missing_stmt) || ' missing';
$fn$;

create function pg_temp.body(p_key_like text, p_who text) returns text
language sql stable as $fn$
  select coalesce(string_agg(n.body, ' || ' order by n.id), '-')
    from public.notification_outbox n
   where n.org_id = pg_temp.c('org_a')::bigint
     and n.dedupe_key like p_key_like
     and n.recipient_profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.outbox_count(p_key_like text) returns text
language sql stable as $fn$
  select count(*)::text from public.notification_outbox n
   where n.org_id = pg_temp.c('org_a')::bigint and n.dedupe_key like p_key_like;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('0dd00000-0000-0000-0000-000000000001', 'adm@orda.test',  'Admin An'),
    ('0dd00000-0000-0000-0000-000000000002', 'quan@orda.test', 'Quan Hai'),
    ('0dd00000-0000-0000-0000-000000000003', 'teo@orda.test',  'Teo Van'),
    ('0dd00000-0000-0000-0000-000000000004', 'dinh@orda.test', 'Dinh Thi'),
    ('0dd00000-0000-0000-0000-000000000005', 'vy@orda.test',   'Vy Tran'),
    ('0dd00000-0000-0000-0000-000000000006', 'lan@orda.test',  'Lan Le'),
    ('0dd00000-0000-0000-0000-0000000000b1', 'bown@ordb.test', 'Be Owner'),
    ('0dd00000-0000-0000-0000-0000000000b2', 'bmem@ordb.test', 'Be Member')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, short_code,
                                  business_day_starts_at, business_day_ends_at)
values ('ord-a', 'Orders A', 'Asia/Ho_Chi_Minh', 'ORDA', '00:00', '23:59'),
       ('ord-b', 'Orders B', 'Asia/Ho_Chi_Minh', 'ORDB', '00:00', '23:59');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('ord-a', '0dd00000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('ord-a', '0dd00000-0000-0000-0000-000000000002', 'admin',  'QUAN'),
  ('ord-a', '0dd00000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('ord-a', '0dd00000-0000-0000-0000-000000000004', 'member', 'DINH'),
  ('ord-a', '0dd00000-0000-0000-0000-000000000005', 'member', 'VY'),
  ('ord-a', '0dd00000-0000-0000-0000-000000000006', 'member', 'LAN'),
  ('ord-b', '0dd00000-0000-0000-0000-0000000000b1', 'owner',  'BOWN'),
  ('ord-b', '0dd00000-0000-0000-0000-0000000000b2', 'member', 'BMEM')
) as u(slug, pid, role, code) on u.slug = o.slug;

-- Teo and Dinh have Telegram, so the outbox probes measure something.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 700000 + m.id, now()
  from public.memberships m
 where m.profile_id in ('0dd00000-0000-0000-0000-000000000003',
                        '0dd00000-0000-0000-0000-000000000004');

do $$
declare
  v_a bigint; v_b bigint; v_t date;
begin
  select id into v_a from public.organizations where slug = 'ord-a';
  select id into v_b from public.organizations where slug = 'ord-b';
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  insert into ctx values
    ('org_a', v_a::text), ('org_b', v_b::text),
    ('adm',  '0dd00000-0000-0000-0000-000000000001'),
    ('quan', '0dd00000-0000-0000-0000-000000000002'),
    ('teo',  '0dd00000-0000-0000-0000-000000000003'),
    ('dinh', '0dd00000-0000-0000-0000-000000000004'),
    ('vy',   '0dd00000-0000-0000-0000-000000000005'),
    ('lan',  '0dd00000-0000-0000-0000-000000000006'),
    ('bown', '0dd00000-0000-0000-0000-0000000000b1'),
    ('bmem', '0dd00000-0000-0000-0000-0000000000b2'),
    ('dp', (v_t - 7)::text),     -- past, open week: Served
    ('ds', (v_t - 14)::text),    -- past, settled week
    ('dt', v_t::text),           -- today, cutoff passed: Cooking
    ('df', (v_t + 1)::text),     -- ahead, published, open
    ('dd', (v_t + 2)::text),     -- ahead, draft
    ('dc', (v_t + 3)::text),     -- ahead, cancelled
    ('dn', (v_t + 4)::text);     -- no menu
end $$;

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by, published_at)
select pg_temp.c('org_a')::bigint, pg_temp.c(d.k)::date, d.st,
       case when d.k = 'df' then now() + interval '2 hours'
            else ((pg_temp.c(d.k)::date - 1)::timestamp + time '21:00') at time zone 'Asia/Ho_Chi_Minh' end,
       pg_temp.c('adm')::uuid,
       case when d.st = 'published' then now() end
  from (values ('dp','locked'), ('ds','locked'), ('dt','published'), ('df','published'),
               ('dd','draft'), ('dc','cancelled')) as d(k, st);

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
values (pg_temp.c('org_b')::bigint, pg_temp.c('dp')::date, 'locked',
        ((pg_temp.c('dp')::date - 1)::timestamp + time '21:00') at time zone 'Asia/Ho_Chi_Minh',
        pg_temp.c('bown')::uuid);

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  join (values
    ('dp', 'Com ga', 45000, 0), ('dp', 'Bun bo', 50000, 1),
    ('ds', 'Com ga', 45000, 0),
    ('dt', 'Pho', 40000, 0),    ('dt', 'Banh canh', 55000, 1), ('dt', 'Mi Quang', null, 2),
    ('df', 'Com chien', 40000, 0), ('df', 'Bun rieu', 45000, 1),
    ('dd', 'Mi Quang', 45000, 0),
    ('dc', 'Hu tieu', 45000, 0)
  ) as v(k, nm, pr, pos) on m.service_date = pg_temp.c(v.k)::date
 where m.org_id = pg_temp.c('org_a')::bigint;

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Com ga', 45000, 0 from public.menus m
 where m.org_id = pg_temp.c('org_b')::bigint;

-- Orders, each with one line. The cancelled day's is cancelled, as cancelling
-- lunch leaves it.
insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by, status, cancelled_at)
select m.org_id, m.id, m.service_date, pg_temp.c(v.who)::uuid, 'member', pg_temp.c(v.who)::uuid,
       case when v.k = 'dc' then 'cancelled' else 'placed' end,
       case when v.k = 'dc' then now() end
  from public.menus m
  join (values ('dp','teo'), ('dp','dinh'), ('dp','vy'), ('ds','teo'), ('ds','dinh'),
               ('dt','teo'), ('dt','dinh'), ('dt','vy'), ('df','teo'), ('dc','teo'))
    as v(k, who) on m.service_date = pg_temp.c(v.k)::date
 where m.org_id = pg_temp.c('org_a')::bigint;

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c('bmem')::uuid, 'member', pg_temp.c('bmem')::uuid
  from public.menus m where m.org_id = pg_temp.c('org_b')::bigint;

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id
  join (values ('dp','teo','Com ga'), ('dp','dinh','Bun bo'), ('dp','vy','Com ga'),
               ('ds','teo','Com ga'), ('ds','dinh','Com ga'),
               ('dt','teo','Pho'), ('dt','dinh','Pho'), ('dt','vy','Banh canh'),
               ('df','teo','Com chien'), ('dc','teo','Hu tieu'))
    as v(k, who, nm)
    on o.service_date = pg_temp.c(v.k)::date and o.profile_id = pg_temp.c(v.who)::uuid
   and mi.name = v.nm
 where o.org_id = pg_temp.c('org_a')::bigint;

insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org_b')::bigint;

insert into ctx
select 'o_' || v.k || '_' || v.who, o.id::text
  from (values ('dp','teo'), ('dp','dinh'), ('dp','vy'), ('ds','teo'), ('dt','teo'),
               ('dt','dinh'), ('dt','vy'), ('df','teo'), ('dc','teo')) as v(k, who)
  join public.orders o on o.org_id = pg_temp.c('org_a')::bigint
   and o.service_date = pg_temp.c(v.k)::date and o.profile_id = pg_temp.c(v.who)::uuid;
insert into ctx
select 'i_' || v.k || '_' || v.nm, mi.id::text
  from (values ('dp','Com ga'), ('dp','Bun bo'), ('dt','Pho'), ('dt','Banh canh'), ('dt','Mi Quang'),
               ('df','Com chien'), ('df','Bun rieu'), ('dd','Mi Quang'), ('dc','Hu tieu'),
               ('ds','Com ga')) as v(k, nm)
  join public.menus m on m.org_id = pg_temp.c('org_a')::bigint and m.service_date = pg_temp.c(v.k)::date
  join public.menu_items mi on mi.menu_id = m.id and mi.name = v.nm;

-- A pass already on the settled week, then every week billed and one settled.
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, status,
                                   created_by, decided_at, decided_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('o_ds_teo')::bigint, pg_temp.c('teo')::uuid,
        pg_temp.c('dinh')::uuid, 'accepted', pg_temp.c('adm')::uuid, now(), pg_temp.c('adm')::uuid);
insert into ctx select 't_ds', id::text from public.meal_transfers
 where order_id = pg_temp.c('o_ds_teo')::bigint;

do $$
declare k text; v_p bigint;
begin
  foreach k in array array['dp','ds','dt','df','dd','dc','dn'] loop
    v_p := public.ensure_billing_period(pg_temp.c('org_a')::bigint, pg_temp.c(k)::date);
    insert into ctx values ('p_' || k, v_p::text) on conflict do nothing;
    perform public.run_billing(v_p);
  end loop;
  perform public.run_billing(public.ensure_billing_period(pg_temp.c('org_b')::bigint, pg_temp.c('dp')::date));
  update public.billing_periods set status = 'closed', closed_at = now()
   where id = pg_temp.c('p_ds')::bigint;
end $$;

------------------------------------------------------------------- controls

insert into probe values
  ('control: settled week is closed',
   (select status from public.billing_periods where id = pg_temp.c('p_ds')::bigint), 'closed'),
  ('control: stages are past, today, ahead, draft, cancelled',
   (select string_agg(private.day_stage(m.org_id, m.service_date, m.status, m.order_cutoff_at), ','
                      order by m.service_date)
      from public.menus m where m.org_id = pg_temp.c('org_a')::bigint
       and m.service_date <> pg_temp.c('ds')::date),
   'done,closed,open,draft,cancelled'),
  ('control: ledger consistent before', pg_temp.ledger_faults(), '0 lines, 0 statements, 0 missing'),
  ('control: names come through', private.member_name(pg_temp.c('org_a')::bigint, pg_temp.c('adm')::uuid),
   'Admin An');

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values
    ('control: role downgraded', current_role, 'authenticated'),
    ('control: acting as the owner', (select auth.uid())::text, pg_temp.c('adm'));
end $$;
reset role;

---------------------------------------- A. who may correct, and on which day

create temp table cnt as
select (select count(*) from public.orders) o, (select count(*) from public.order_items) i,
       (select count(*) from public.order_corrections) c, (select count(*) from public.meal_transfers) t,
       (select count(*) from public.notification_outbox) n;

do $$
declare
  cm text := 'select public.correct_meal(%s, %L::date, %L::uuid, %s)';
begin
  perform pg_temp.act('teo');
  insert into probe values ('A1 a member cannot correct',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('dp'), pg_temp.c('lan'), pg_temp.c('i_dp_Com ga'))),
    '42501 only an admin of this office can correct the record');
  insert into probe values ('A1 a member cannot remove',
    pg_temp.try(format('select public.remove_meal(%s)', pg_temp.c('o_dp_dinh'))),
    '42501 only an admin of this office can correct the record');

  perform pg_temp.act('bown');
  insert into probe values ('A2 another office''s owner cannot correct',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('dp'), pg_temp.c('lan'), pg_temp.c('i_dp_Com ga'))),
    '42501 only an admin of this office can correct the record');

  perform pg_temp.act('adm');
  insert into probe values ('A3 a draft day is refused',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('dd'), pg_temp.c('lan'), pg_temp.c('i_dd_Mi Quang'))),
    '55000 the menu for ' || to_char(pg_temp.c('dd')::date, 'DD/MM') || ' isn''t published yet');
  insert into probe values ('A4 a cancelled day is refused',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('dc'), pg_temp.c('teo'), pg_temp.c('i_dc_Hu tieu'))),
    '55000 lunch on ' || to_char(pg_temp.c('dc')::date, 'DD/MM') || ' was cancelled');
  insert into probe values ('A4 removing on a cancelled day is refused',
    pg_temp.try(format('select public.remove_meal(%s)', pg_temp.c('o_dc_teo'))),
    '55000 lunch on ' || to_char(pg_temp.c('dc')::date, 'DD/MM') || ' was cancelled');
  insert into probe values ('A5 a day with no menu is refused',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('dn'), pg_temp.c('lan'), pg_temp.c('i_df_Bun rieu'))),
    'P0002 there is no menu for ' || to_char(pg_temp.c('dn')::date, 'DD/MM') || ', so there is nothing to correct');
  insert into probe values ('A6 a settled week is refused',
    pg_temp.try(format(cm, pg_temp.c('org_a'), pg_temp.c('ds'), pg_temp.c('lan'), pg_temp.c('i_ds_Com ga'))),
    '55000 the week of ' || to_char(pg_temp.c('ds')::date, 'DD/MM') || ' has been settled, so it can no longer be corrected');
  insert into probe values ('A7 an off-menu dish on a draft day is refused',
    pg_temp.try(format('select public.correct_meal_off_menu(%s, %L::date, %L::uuid, %L, 30000)',
      pg_temp.c('org_a'), pg_temp.c('dd'), pg_temp.c('lan'), 'Banh mi')),
    '55000 the menu for ' || to_char(pg_temp.c('dd')::date, 'DD/MM') || ' isn''t published yet');
  insert into probe values ('A7 an off-menu dish on a cancelled day is refused',
    pg_temp.try(format('select public.correct_meal_off_menu(%s, %L::date, %L::uuid, %L, 30000)',
      pg_temp.c('org_a'), pg_temp.c('dc'), pg_temp.c('lan'), 'Banh mi')),
    '55000 lunch on ' || to_char(pg_temp.c('dc')::date, 'DD/MM') || ' was cancelled');
end $$;
reset role;

insert into probe
select 'A8 the refusals wrote nothing',
       ((select count(*) from public.orders) = cnt.o and (select count(*) from public.order_items) = cnt.i
        and (select count(*) from public.order_corrections) = cnt.c
        and (select count(*) from public.notification_outbox) = cnt.n
        and (select count(*) from public.menu_items mi join public.menus m on m.id = mi.menu_id
              where m.service_date in (pg_temp.c('dd')::date, pg_temp.c('dc')::date)
                and m.org_id = pg_temp.c('org_a')::bigint) = 2)::text,
       'true'
  from cnt;
insert into probe values ('A8 the cancelled day''s order is still cancelled',
  (select status from public.orders where id = pg_temp.c('o_dc_teo')::bigint), 'cancelled');

-- A9. An off-menu name that is a dish already on the day. With no price, it
-- is refused: pricing it here would reach this line alone and leave everybody
-- else's on it unpriced. With a price, it is that dish at that price.
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('A9 an off-menu name matching an unpriced dish is refused',
    pg_temp.try(format('select public.correct_meal_off_menu(%s, %L::date, %L::uuid, %L, 60000)',
      pg_temp.c('org_a'), pg_temp.c('dt'), pg_temp.c('lan'), '  mi   QUANG ')),
    '55000 "Mi Quang" is already on the menu with no price yet. Set its price with Reprice, then record this meal');
  insert into probe values ('A9 a matching priced dish is recorded as that dish',
    pg_temp.try(format('select public.correct_meal_off_menu(%s, %L::date, %L::uuid, %L, 99000)',
      pg_temp.c('org_a'), pg_temp.c('dt'), pg_temp.c('lan'), 'pho')), 'ok');
end $$;
reset role;
insert into probe values
  ('A9 the unpriced dish kept no price',
   (select coalesce(price_minor::text, 'null') from public.menu_items where id = pg_temp.c('i_dt_Mi Quang')::bigint), 'null'),
  ('A9 the priced match kept its price, and so did the line',
   (select mi.price_minor || ' ' || oi.unit_price_minor || ' ' || oi.menu_item_id::text
      from public.order_items oi join public.menu_items mi on mi.id = oi.menu_item_id
     where oi.profile_id = pg_temp.c('lan')::uuid and oi.menu_id = mi.menu_id
       and mi.menu_id = (select menu_id from public.menu_items where id = pg_temp.c('i_dt_Pho')::bigint)),
   '40000 40000 ' || pg_temp.c('i_dt_Pho')),
  ('A9 no second dish of that name', (select count(*)::text from public.menu_items
     where menu_id = (select menu_id from public.menu_items where id = pg_temp.c('i_dt_Pho')::bigint)), '3');

---------------------------------------- B. ordering for somebody, and money

select pg_temp.snap('b0');

-- B1. Ahead, for somebody with nothing: an admin order, billed at once.
do $$
declare r record;
begin
  perform pg_temp.act('quan');
  select * into r from public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('df')::date,
    pg_temp.c('dinh')::uuid, pg_temp.c('i_df_Bun rieu')::bigint, 1::smallint, null, 'Dinh nhan qua Zalo');
  insert into ctx values ('o_df_dinh', r.order_id::text), ('b1_balance', r.balance_minor::text);
end $$;
reset role;
select pg_temp.snap('b1');

insert into probe values
  ('B1 an admin (not owner) orders ahead: the order is the admin''s',
   (select source || ' ' || status from public.orders where id = pg_temp.c('o_df_dinh')::bigint), 'admin placed'),
  ('B1 Dinh moved by exactly the dish', pg_temp.moved('b0', 'b1', 'dinh')::text, '45000'),
  ('B1 nobody else moved', pg_temp.movers('b0', 'b1'), 'dinh'),
  ('B1 the balance returned is the ledger''s',
   pg_temp.c('b1_balance'), (select balance_minor from bal where step = 'b1' and profile_id = pg_temp.c('dinh')::uuid)::text),
  ('B1 audited as a meal, with the reason',
   (select kind || ' / ' || summary || ' / ' || reason from public.order_corrections
     where order_id = pg_temp.c('o_df_dinh')::bigint),
   'meal / Dinh Thi: Bun rieu, ' || pg_temp.m(45000) || ' on ' || to_char(pg_temp.c('df')::date, 'DD/MM')
     || ' / Dinh nhan qua Zalo'),
  ('B1 Dinh is told the admin ordered lunch for him',
   pg_temp.body('%bill_correction:order:' || pg_temp.c('o_df_dinh') || ':%', 'dinh'),
   'Quan Hai ordered lunch for you on ' || to_char(pg_temp.c('df')::date, 'DD/MM') || '.' || E'\n'
     || 'You are down for Bun rieu, ' || pg_temp.m(45000) || '.' || E'\n'
     || 'Dinh nhan qua Zalo' || E'\n'
     || 'You owe ' || pg_temp.m(pg_temp.c('b1_balance')::bigint) || '.');

-- B2. Today, after the cutoff: change the dish and the portions.
do $$ begin
  perform pg_temp.act('adm');
  perform public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('dt')::date,
    pg_temp.c('teo')::uuid, pg_temp.c('i_dt_Banh canh')::bigint, 2::smallint, 'it com', null);
end $$;
reset role;
select pg_temp.snap('b2');
insert into probe values
  ('B2 after the cutoff: Teo moved by 2 x 55000 - 40000', pg_temp.moved('b1', 'b2', 'teo')::text, '70000'),
  ('B2 nobody else moved', pg_temp.movers('b1', 'b2'), 'teo'),
  ('B2 the member''s order keeps its source, and one line',
   (select o.source || ' ' || count(oi.id) || ' ' || max(oi.quantity) || ' ' || max(oi.note)
      from public.orders o join public.order_items oi on oi.order_id = o.id
     where o.id = pg_temp.c('o_dt_teo')::bigint group by o.source), 'member 1 2 it com'),
  ('B2 today is not over, so Teo reads that lunch was ordered for him',
   split_part(pg_temp.body('%bill_correction:order:' || pg_temp.c('o_dt_teo') || ':%', 'teo'), E'\n', 1),
   'Admin An ordered lunch for you on ' || to_char(pg_temp.c('dt')::date, 'DD/MM') || '.');

-- B3. A past day: the record corrected.
do $$ begin
  perform pg_temp.act('adm');
  perform public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('dp')::date,
    pg_temp.c('dinh')::uuid, pg_temp.c('i_dp_Com ga')::bigint);
end $$;
reset role;
select pg_temp.snap('b3');
insert into probe values
  ('B3 a past day: Dinh moved by 45000 - 50000', pg_temp.moved('b2', 'b3', 'dinh')::text, '-5000'),
  ('B3 nobody else moved', pg_temp.movers('b2', 'b3'), 'dinh'),
  ('B3 a past day reads as corrected',
   split_part(pg_temp.body('%bill_correction:order:' || pg_temp.c('o_dp_dinh') || ':%', 'dinh'), E'\n', 1),
   'Lunch on ' || to_char(pg_temp.c('dp')::date, 'DD/MM') || ' was corrected by Admin An.');

-- B4. Ahead, removed: cancelled, and said so.
do $$ begin
  perform pg_temp.act('adm');
  perform public.remove_meal(pg_temp.c('o_df_teo')::bigint, 'Teo nghi phep');
end $$;
reset role;
select pg_temp.snap('b4');
insert into probe values
  ('B4 removing ahead takes the dish off Teo', pg_temp.moved('b3', 'b4', 'teo')::text, '-40000'),
  ('B4 nobody else moved', pg_temp.movers('b3', 'b4'), 'teo'),
  ('B4 the order is cancelled, not deleted',
   (select status from public.orders where id = pg_temp.c('o_df_teo')::bigint), 'cancelled'),
  ('B4 Teo reads that his lunch was cancelled',
   split_part(pg_temp.body('%bill_correction:order:' || pg_temp.c('o_df_teo') || ':%', 'teo'), E'\n', 1),
   'Admin An cancelled your lunch on ' || to_char(pg_temp.c('df')::date, 'DD/MM') || '.'),
  ('B4 removing it again is refused',
   (select pg_temp.try(format('select public.remove_meal(%s)', pg_temp.c('o_df_teo')))),
   '55000 nothing is recorded for that person on ' || to_char(pg_temp.c('df')::date, 'DD/MM')
     || ', so there is nothing to remove');

-- B5. The admin's own row, after the cutoff.
do $$ begin
  perform pg_temp.act('adm');
  perform public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('dt')::date,
    pg_temp.c('adm')::uuid, pg_temp.c('i_dt_Pho')::bigint);
end $$;
reset role;
select pg_temp.snap('b5');
insert into probe values
  ('B5 an admin records their own lunch after the cutoff', pg_temp.moved('b4', 'b5', 'adm')::text, '40000'),
  ('B5 audited like anybody''s',
   (select count(*)::text from public.order_corrections
     where profile_id = pg_temp.c('adm')::uuid and kind = 'meal'), '1');

-- B6. An admin's order ahead stays the member's to change or cancel before the cutoff.
do $$ begin
  perform pg_temp.act('adm');
  perform public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('df')::date,
    pg_temp.c('lan')::uuid, pg_temp.c('i_df_Bun rieu')::bigint);
  perform pg_temp.act('lan');
  insert into probe values ('B6 the member changes the admin''s order before the cutoff',
    pg_temp.try(format('select public.set_my_order(%s, %s)',
      (select id from public.menus where org_id = pg_temp.c('org_a')::bigint and service_date = pg_temp.c('df')::date),
      pg_temp.c('i_df_Com chien'))), 'ok');
  insert into probe values ('B6 and cancels it',
    pg_temp.try(format($q$update public.orders set status = 'cancelled', cancelled_at = now()
                          where profile_id = %L and service_date = %L::date$q$,
                       pg_temp.c('lan'), pg_temp.c('df'))), 'ok');
end $$;
reset role;
insert into probe values ('B6 the order kept its source and is cancelled',
  (select source || ' ' || status || ' ' || (select item_name_snapshot from public.order_items where order_id = o.id)
     from public.orders o where o.profile_id = pg_temp.c('lan')::uuid and o.service_date = pg_temp.c('df')::date),
  'admin cancelled Com chien');

-- The member's own write reaches the bill at the next run; bill it so the
-- ledger probe compares like with like.
select public.run_billing(pg_temp.c('p_df')::bigint) is not null as rebilled \gset
insert into probe values ('B7 lines and statements agree with the record', pg_temp.ledger_faults(),
  '0 lines, 0 statements, 0 missing');

------------------------------------------------------------------- C. passes

select pg_temp.snap('c0');
truncate cnt;
insert into cnt select (select count(*) from public.orders), (select count(*) from public.order_items),
  (select count(*) from public.order_corrections), (select count(*) from public.meal_transfers),
  (select count(*) from public.notification_outbox);

do $$
declare rp text := 'select public.record_pass(%s, %L::uuid)';
begin
  perform pg_temp.act('teo');
  insert into probe values ('C1 a member cannot record a pass',
    pg_temp.try(format(rp, pg_temp.c('o_dp_teo'), pg_temp.c('dinh'))),
    '42501 only an admin of this office can correct the record');
  insert into probe values ('C1 a member cannot undo one',
    pg_temp.try(format('select public.undo_pass(%s)', pg_temp.c('t_ds'))),
    '42501 only an admin of this office can correct the record');
  insert into probe values ('C1 a member probing a missing pass hears the same refusal',
    pg_temp.try('select public.answer_pass(999999999, ''accept'')'),
    '42501 only an admin of this office can correct the record');
  perform pg_temp.act('bown');
  insert into probe values ('C1 another office''s owner cannot record a pass',
    pg_temp.try(format(rp, pg_temp.c('o_dp_teo'), pg_temp.c('dinh'))),
    '42501 only an admin of this office can correct the record');
  insert into probe values ('C1 another office''s owner cannot answer, undo or remove either',
    pg_temp.try(format($q$select public.answer_pass(%s, 'decline')$q$, pg_temp.c('t_ds'))) || ' | '
      || pg_temp.try(format('select public.undo_pass(%s)', pg_temp.c('t_ds'))) || ' | '
      || pg_temp.try(format('select public.remove_meal(%s)', pg_temp.c('o_dp_dinh'))),
    '42501 only an admin of this office can correct the record | 42501 only an admin of this office can correct the record | 42501 only an admin of this office can correct the record');
  -- A missing id answers like another office's, so ids cannot be probed.
  insert into probe values ('C1 a missing id answers like another office''s',
    pg_temp.try('select public.answer_pass(999999999, ''accept'')') || ' | '
      || pg_temp.try('select public.undo_pass(999999999)') || ' | '
      || pg_temp.try(format('select public.record_pass(999999999, %L::uuid)', pg_temp.c('bmem'))) || ' | '
      || pg_temp.try('select public.remove_meal(999999999)'),
    '42501 only an admin of this office can correct the record | 42501 only an admin of this office can correct the record | 42501 only an admin of this office can correct the record | 42501 only an admin of this office can correct the record');

  perform pg_temp.act('adm');
  insert into probe values ('C2 a settled week takes no pass',
    pg_temp.try(format(rp, pg_temp.c('o_ds_teo'), pg_temp.c('vy'))),
    '55000 the week of ' || to_char(pg_temp.c('ds')::date, 'DD/MM') || ' has been settled, so it can no longer be corrected');
  insert into probe values ('C2 nor an undo',
    pg_temp.try(format('select public.undo_pass(%s)', pg_temp.c('t_ds'))),
    '55000 the week of ' || to_char(pg_temp.c('ds')::date, 'DD/MM') || ' has been settled, so it can no longer be corrected');
  insert into probe values ('C3 never to the person whose meal it is',
    pg_temp.try(format(rp, pg_temp.c('o_dp_teo'), pg_temp.c('teo'))),
    '23514 a meal cannot be passed to the person whose meal it is');
  insert into probe values ('C3 never to somebody from another office',
    pg_temp.try(format(rp, pg_temp.c('o_dp_teo'), pg_temp.c('bmem'))),
    'P0002 that person is not a member of this office');
  insert into probe values ('C3 a cancelled day takes no pass',
    pg_temp.try(format(rp, pg_temp.c('o_dc_teo'), pg_temp.c('dinh'))),
    '55000 lunch on ' || to_char(pg_temp.c('dc')::date, 'DD/MM') || ' was cancelled');
  insert into probe values ('C3 a removed meal takes no pass',
    pg_temp.try(format(rp, pg_temp.c('o_df_teo'), pg_temp.c('dinh'))),
    '55000 nothing is recorded for Teo Van on ' || to_char(pg_temp.c('df')::date, 'DD/MM') || ', so there is no meal to pass');
end $$;
reset role;
insert into probe select 'C3 the refusals wrote nothing',
  ((select count(*) from public.meal_transfers) = cnt.t and (select count(*) from public.order_corrections) = cnt.c
   and (select count(*) from public.notification_outbox) = cnt.n)::text, 'true' from cnt;

-- C4. Record a pass on a past day: accepted at once, both told, both billed.
do $$
declare r record;
begin
  perform pg_temp.act('adm');
  select * into r from public.record_pass(pg_temp.c('o_dp_teo')::bigint, pg_temp.c('dinh')::uuid, 'Teo nghi, Dinh an thay');
  insert into ctx values ('t_dp', r.transfer_id::text), ('c4_from', r.from_balance_minor::text),
                         ('c4_to', r.to_balance_minor::text);
end $$;
reset role;
select pg_temp.snap('c4');
insert into probe values
  ('C4 accepted at once, decided by the admin',
   (select status || ' ' || (decided_by = pg_temp.c('adm')::uuid) || ' ' || (decided_at is not null)
      from public.meal_transfers where id = pg_temp.c('t_dp')::bigint), 'accepted true true'),
  ('C4 Teo loses exactly the dish', pg_temp.moved('c0', 'c4', 'teo')::text, '-45000'),
  ('C4 Dinh gains exactly the dish', pg_temp.moved('c0', 'c4', 'dinh')::text, '45000'),
  ('C4 nobody else moved', pg_temp.movers('c0', 'c4'), 'dinh,teo'),
  ('C4 the balances returned are the ledger''s',
   pg_temp.c('c4_from') || ' ' || pg_temp.c('c4_to'),
   (select balance_minor from bal where step = 'c4' and profile_id = pg_temp.c('teo')::uuid) || ' '
     || (select balance_minor from bal where step = 'c4' and profile_id = pg_temp.c('dinh')::uuid)),
  ('C4 the line now bills Dinh',
   (select payer_profile_id::text from public.billing_lines where order_id = pg_temp.c('o_dp_teo')::bigint),
   pg_temp.c('dinh')),
  ('C4 audited as a pass, naming the pass',
   (select kind || ' / ' || (transfer_id = pg_temp.c('t_dp')::bigint) || ' / ' || summary
      from public.order_corrections where transfer_id = pg_temp.c('t_dp')::bigint),
   'pass / true / Teo Van: Com ga, ' || pg_temp.m(45000) || ' on ' || to_char(pg_temp.c('dp')::date, 'DD/MM')
     || ', passed to Dinh Thi'),
  ('C4 Teo is told', split_part(pg_temp.body('%transfer:' || pg_temp.c('t_dp') || ':recorded:%', 'teo'), E'\n', 1),
   'Admin An recorded that Dinh Thi had your lunch on ' || to_char(pg_temp.c('dp')::date, 'DD/MM')
     || ' (Com ga, ' || pg_temp.m(45000) || '), so it is on Dinh Thi''s bill rather than yours.'),
  ('C4 Dinh is told, with the reason and his balance',
   pg_temp.body('%transfer:' || pg_temp.c('t_dp') || ':recorded:%', 'dinh'),
   'Admin An recorded that you had Teo Van''s lunch on ' || to_char(pg_temp.c('dp')::date, 'DD/MM')
     || ' (Com ga, ' || pg_temp.m(45000) || '), so it is on your bill.' || E'\n'
     || 'Teo nghi, Dinh an thay' || E'\n' || 'You owe ' || pg_temp.m(pg_temp.c('c4_to')::bigint) || '.'),
  ('C4 no offer message: nobody is asked',
   pg_temp.outbox_count('%transfer_offer:' || pg_temp.c('t_dp')), '0');

-- C5. No chains: the same meal cannot be passed again while this pass stands.
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('C5 a passed meal is not passed on',
    pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.c('o_dp_teo'), pg_temp.c('vy'))),
    '55000 Teo Van''s lunch on ' || to_char(pg_temp.c('dp')::date, 'DD/MM')
      || ' is already passed to Dinh Thi, so undo that pass first');
end $$;
reset role;

-- C6. A correction after a pass lands on the payer.
do $$ begin
  perform pg_temp.act('adm');
  perform public.correct_meal(pg_temp.c('org_a')::bigint, pg_temp.c('dp')::date,
    pg_temp.c('teo')::uuid, pg_temp.c('i_dp_Bun bo')::bigint);
end $$;
reset role;
select pg_temp.snap('c6');
insert into probe values
  ('C6 the payer moves by 50000 - 45000', pg_temp.moved('c4', 'c6', 'dinh')::text, '5000'),
  ('C6 the giver does not', pg_temp.moved('c4', 'c6', 'teo')::text, '0'),
  ('C6 nobody else moved', pg_temp.movers('c4', 'c6'), 'dinh'),
  ('C6 the payer is told what he pays for',
   split_part(pg_temp.body('%bill_correction:order:' || pg_temp.c('o_dp_teo') || ':%', 'dinh'), E'\n', 2),
   'You are paying for Teo Van''s Bun bo, ' || pg_temp.m(50000) || '.');

-- C7. Undo: back on the giver, the pass kept as history.
do $$
declare r record;
begin
  perform pg_temp.act('adm');
  select * into r from public.undo_pass(pg_temp.c('t_dp')::bigint, 'ghi nham');
  insert into ctx values ('c7_from', r.from_balance_minor::text), ('c7_to', r.to_balance_minor::text);
end $$;
reset role;
select pg_temp.snap('c7');
insert into probe values
  ('C7 undone, and the acceptance kept',
   (select status || ' ' || (undone_by = pg_temp.c('adm')::uuid) || ' ' || (decided_at is not null)
      from public.meal_transfers where id = pg_temp.c('t_dp')::bigint), 'undone true true'),
  ('C7 Teo pays again, exactly', pg_temp.moved('c6', 'c7', 'teo')::text, '50000'),
  ('C7 Dinh no longer does', pg_temp.moved('c6', 'c7', 'dinh')::text, '-50000'),
  ('C7 nobody else moved', pg_temp.movers('c6', 'c7'), 'dinh,teo'),
  ('C7 the balances returned are the ledger''s',
   pg_temp.c('c7_from') || ' ' || pg_temp.c('c7_to'),
   (select balance_minor from bal where step = 'c7' and profile_id = pg_temp.c('teo')::uuid) || ' '
     || (select balance_minor from bal where step = 'c7' and profile_id = pg_temp.c('dinh')::uuid)),
  ('C7 audited as undone',
   (select string_agg(kind, ',' order by id) from public.order_corrections where transfer_id = pg_temp.c('t_dp')::bigint),
   'pass,pass_undone'),
  ('C7 both are told',
   split_part(pg_temp.body('%transfer:' || pg_temp.c('t_dp') || ':undone:%', 'teo'), E'\n', 1) || ' | '
     || split_part(pg_temp.body('%transfer:' || pg_temp.c('t_dp') || ':undone:%', 'dinh'), E'\n', 1),
   'Admin An undid the pass of your lunch on ' || to_char(pg_temp.c('dp')::date, 'DD/MM') || ' (Bun bo, '
     || pg_temp.m(50000) || ') to Dinh Thi, so it is back on your bill. | Admin An undid the pass of Teo Van''s lunch on '
     || to_char(pg_temp.c('dp')::date, 'DD/MM') || ' (Bun bo, ' || pg_temp.m(50000) || '), so it is no longer on your bill.');

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('C7 undoing twice is refused',
    pg_temp.try(format('select public.undo_pass(%s)', pg_temp.c('t_dp'))), '55000 that pass is already undone');
  insert into probe values ('C7 and the meal can be passed afresh',
    pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.c('o_dp_teo'), pg_temp.c('vy'))), 'ok');
end $$;
reset role;
insert into probe values ('C7 one live pass, the new one',
  (select count(*) || ' ' || max(to_profile_id::text) from public.meal_transfers
    where order_id = pg_temp.c('o_dp_teo')::bigint and status in ('pending', 'accepted')),
  '1 ' || pg_temp.c('vy'));

-- C8. A member's own offer, as the Board makes it, and the browser's limits.
do $$ begin
  perform pg_temp.act('teo');
  -- Claims `accepted`; a member's insert is an offer whatever it says.
  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by,
                                     status, decided_at, decided_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('o_dt_teo')::bigint, pg_temp.c('teo')::uuid,
          pg_temp.c('dinh')::uuid, pg_temp.c('teo')::uuid, 'accepted', now(), pg_temp.c('dinh')::uuid);
  perform pg_temp.act('dinh');
  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('o_dt_dinh')::bigint, pg_temp.c('dinh')::uuid,
          pg_temp.c('teo')::uuid, pg_temp.c('dinh')::uuid);
  perform pg_temp.act('vy');
  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('o_dt_vy')::bigint, pg_temp.c('vy')::uuid,
          pg_temp.c('teo')::uuid, pg_temp.c('vy')::uuid);
end $$;
reset role;
insert into ctx select 't_' || v.k, t.id::text
  from (values ('teo'), ('dinh'), ('vy')) as v(k)
  join public.meal_transfers t on t.order_id = pg_temp.c('o_dt_' || v.k)::bigint;
insert into probe values ('C8 a member''s insert is an offer, whatever it claims',
  (select status || ' ' || (decided_at is null) from public.meal_transfers where id = pg_temp.c('t_teo')::bigint),
  'pending true');

do $$ begin
  perform pg_temp.act('dinh');
  insert into probe values ('C8 a browser cannot mark an offer undone',
    pg_temp.try(format($q$update public.meal_transfers set status = 'undone' where id = %s$q$, pg_temp.c('t_teo'))),
    '23514 a pass can only be accepted, declined or withdrawn');
  perform pg_temp.act('adm');
  insert into probe values ('C8 an admin cannot undo by writing the table',
    pg_temp.try(format($q$update public.meal_transfers set status = 'undone'
                          where order_id = %s and status = 'accepted'$q$, pg_temp.c('o_dp_teo'))),
    '55000 this transfer is already accepted');
  perform pg_temp.act('teo');
  insert into probe values ('C8 a member cannot answer for somebody',
    pg_temp.try(format($q$select public.answer_pass(%s, 'accept')$q$, pg_temp.c('t_dinh'))),
    '42501 only an admin of this office can correct the record');
  perform pg_temp.act('adm');
  insert into probe values ('C8 a waiting offer blocks recording another pass',
    pg_temp.try(format('select public.record_pass(%s, %L::uuid)', pg_temp.c('o_dt_teo'), pg_temp.c('vy'))),
    '55000 Teo Van''s lunch on ' || to_char(pg_temp.c('dt')::date, 'DD/MM')
      || ' is already offered to Dinh Thi, so answer or withdraw that offer first');
  insert into probe values ('C8 a waiting offer has nothing to undo',
    pg_temp.try(format('select public.undo_pass(%s)', pg_temp.c('t_teo'))),
    '55000 that offer has not been accepted, so there is nothing to undo');
  insert into probe values ('C8 an answer is one of three words',
    pg_temp.try(format($q$select public.answer_pass(%s, 'maybe')$q$, pg_temp.c('t_teo'))),
    '23514 an offer is answered with accept, decline or withdraw');
end $$;
reset role;

-- C9. Accept on the recipient's behalf.
select pg_temp.snap('c9a');
do $$ begin
  perform pg_temp.act('quan');
  perform public.answer_pass(pg_temp.c('t_teo')::bigint, 'accept', 'Dinh noi mieng');
end $$;
reset role;
select pg_temp.snap('c9');
insert into probe values
  ('C9 accepted for Dinh: Teo loses his 2 x 55000', pg_temp.moved('c9a', 'c9', 'teo')::text, '-110000'),
  ('C9 and Dinh gains them', pg_temp.moved('c9a', 'c9', 'dinh')::text, '110000'),
  ('C9 nobody else moved', pg_temp.movers('c9a', 'c9'), 'dinh,teo'),
  ('C9 decided by the admin',
   (select status || ' ' || (decided_by = pg_temp.c('quan')::uuid) from public.meal_transfers
     where id = pg_temp.c('t_teo')::bigint), 'accepted true'),
  ('C9 audited as a pass accepted for them',
   (select kind || ' / ' || summary from public.order_corrections where transfer_id = pg_temp.c('t_teo')::bigint),
   'pass / Teo Van: Banh canh x2, ' || pg_temp.m(110000) || ' on ' || to_char(pg_temp.c('dt')::date, 'DD/MM')
     || ', passed to Dinh Thi, accepted for them'),
  ('C9 Dinh is told the admin accepted it for him',
   split_part(pg_temp.body('%transfer:' || pg_temp.c('t_teo') || ':accepted:%', 'dinh'), E'\n', 1),
   'Quan Hai accepted Teo Van''s lunch on ' || to_char(pg_temp.c('dt')::date, 'DD/MM') || ' (Banh canh x2, '
     || pg_temp.m(110000) || ') for you, so it is on your bill.'),
  ('C9 and the Board''s own decision message is not sent as well',
   pg_temp.outbox_count('%transfer_decided:' || pg_temp.c('t_teo') || ':%'), '0'),
  ('C9 answering twice is refused',
   (select pg_temp.try(format($q$select public.answer_pass(%s, 'decline')$q$, pg_temp.c('t_teo')))),
   '55000 that offer has already been answered: it is accepted');

-- C10. Decline and withdraw on behalf: nothing moves, both are told.
select pg_temp.snap('c10a');
do $$ begin
  perform pg_temp.act('adm');
  perform public.answer_pass(pg_temp.c('t_dinh')::bigint, 'decline');
  perform public.answer_pass(pg_temp.c('t_vy')::bigint, 'withdraw');
end $$;
reset role;
select pg_temp.snap('c10');
insert into probe values
  ('C10 declining and withdrawing move no money', pg_temp.movers('c10a', 'c10'), '-'),
  ('C10 each ends in its own status',
   (select string_agg(status, ',' order by id) from public.meal_transfers
     where id in (pg_temp.c('t_dinh')::bigint, pg_temp.c('t_vy')::bigint)), 'declined,cancelled'),
  ('C10 audited as declined and withdrawn',
   (select string_agg(kind, ',' order by id) from public.order_corrections
     where transfer_id in (pg_temp.c('t_dinh')::bigint, pg_temp.c('t_vy')::bigint)), 'pass_declined,pass_withdrawn'),
  ('C10 the giver of the declined offer is told',
   split_part(pg_temp.body('%transfer:' || pg_temp.c('t_dinh') || ':declined:%', 'dinh'), E'\n', 1),
   'Admin An declined your lunch on ' || to_char(pg_temp.c('dt')::date, 'DD/MM')
     || ' for Teo Van, so it is still yours and on your bill.'),
  ('C10 the recipient of the withdrawn offer is told',
   split_part(pg_temp.body('%transfer:' || pg_temp.c('t_vy') || ':withdrawn:%', 'teo'), E'\n', 1),
   'Admin An withdrew Vy Tran''s offer of lunch on ' || to_char(pg_temp.c('dt')::date, 'DD/MM')
     || ', so there is nothing to answer.');

-- C11. Ahead, published: a pass of an admin's order to somebody else.
select pg_temp.snap('c11a');
do $$ begin
  perform pg_temp.act('adm');
  perform public.record_pass(pg_temp.c('o_df_dinh')::bigint, pg_temp.c('lan')::uuid);
end $$;
reset role;
select pg_temp.snap('c11');
insert into probe values
  ('C11 a day ahead takes a pass: Dinh to Lan',
   pg_temp.moved('c11a', 'c11', 'dinh') || ' ' || pg_temp.moved('c11a', 'c11', 'lan'), '-45000 45000');

------------------------------------------------------------ D. the whole book

insert into probe values
  ('D1 lines and statements agree with the record after everything', pg_temp.ledger_faults(),
   '0 lines, 0 statements, 0 missing'),
  ('D2 nothing billed twice',
   (select count(*)::text from (select order_id from public.billing_lines group by order_id having count(*) > 1) x), '0'),
  ('D3 the settled week did not move',
   (select string_agg(st.profile_id::text || ':' || st.meals_minor, ',' order by st.profile_id)
      from public.billing_statements st where st.billing_period_id = pg_temp.c('p_ds')::bigint),
   pg_temp.c('dinh') || ':90000'),
  ('D4 office B did not move',
   (select coalesce(sum(b.balance_minor), 0)::text from public.v_account_balance b
     where b.org_id = pg_temp.c('org_b')::bigint), '45000'),
  ('D5 every pass row names its pass',
   (select count(*)::text from public.order_corrections
     where org_id = pg_temp.c('org_a')::bigint and kind like 'pass%' and transfer_id is null), '0');

do $$ begin
  perform pg_temp.act('teo');
  insert into probe values ('D6 a member reads none of the trail',
    (select count(*)::text from public.order_corrections), '0');
  insert into probe values ('D6 nor forges a pass row',
    pg_temp.try(format($q$insert into public.order_corrections (org_id, service_date, kind, order_id, profile_id,
                          transfer_id, summary, made_by) values (%s, %L::date, 'pass', %s, %L::uuid, %s, 'x', %L::uuid)$q$,
      pg_temp.c('org_a'), pg_temp.c('dp'), pg_temp.c('o_dp_teo'), pg_temp.c('teo'), pg_temp.c('t_dp'), pg_temp.c('teo'))),
    '42501 permission denied for table order_corrections');
end $$;
reset role;

--------------------------------------------------------------------- verdict

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
