-- A menu with one dish needs no choice: which slots get the dish, which lose
-- it again, what stays untouched, and what Telegram is told.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/one_dish.sql
--
-- Builds its own fixtures and rolls everything back. An order reads as
-- `source status dish@price`, with `*` after a line the system wrote.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;

create temp table ctx (k text primary key, v text);
grant select, insert, update on ctx to authenticated;

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

-- Runs one statement as a signed-in person and answers 'ok' or the refusal.
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

create function pg_temp.m(p_org text, p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c(p_org)::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.dish(p_org text, p_day text, p_name text) returns bigint
language sql stable as $fn$
  select id from public.menu_items where menu_id = pg_temp.m(p_org, p_day) and name = p_name;
$fn$;

-- p_dishes is 'Name@price' for a new dish, '=Name@price' for the dish of that
-- name already on the menu, kept by id, and '=Old>New@price' to rename it.
create function pg_temp.publish(p_org text, p_day text, p_dishes text[],
                                p_admin text default 'adm') returns text
language sql as $fn$
  select pg_temp.as_user(p_admin, format(
    'select * from public.publish_menu(%s, %L::date, %L::timestamptz, %L::jsonb, %L, %L::jsonb)',
    pg_temp.c(p_org), pg_temp.c(p_day), now() + interval '9 days',
    (select jsonb_agg(jsonb_build_object(
              'id', case when left(d, 1) = '=' then
                      pg_temp.dish(p_org, p_day,
                                   split_part(split_part(substr(d, 2), '@', 1), '>', 1)) end,
              'name', regexp_replace(split_part(ltrim(d, '='), '@', 1), '^.*>', ''),
              'price_minor', split_part(d, '@', 2)::int) order by n)
       from unnest(p_dishes) with ordinality as t(d, n)),
    'raw', '{}'));
$fn$;

create function pg_temp.order_of(p_org text, p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((
    select o.source || ' ' || o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot || '@' || oi.unit_price_minor
                                          || case when oi.auto_assigned then '*' else '' end, ',')
                          from public.order_items oi where oi.order_id = o.id), '-')
      from public.orders o
     where o.menu_id = pg_temp.m(p_org, p_day) and o.profile_id = pg_temp.c(p_who)::uuid),
    'none');
$fn$;

create function pg_temp.asked(p_org text, p_day text) returns text
language sql stable as $fn$
  select coalesce(string_agg(ms.short_code, ',' order by ms.short_code), '-')
    from public.notification_outbox n
    join public.memberships ms
      on ms.org_id = n.org_id and ms.profile_id = n.recipient_profile_id
   where n.kind = 'dish_choice' and n.related_menu_id = pg_temp.m(p_org, p_day);
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.code || '@onedish.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.code)
  from (values
    ('0d150000-0000-0000-0000-000000000001', 'adm'),
    ('0d150000-0000-0000-0000-000000000002', 'dinh'),
    ('0d150000-0000-0000-0000-000000000003', 'teo'),
    ('0d150000-0000-0000-0000-000000000004', 'nam'),
    ('0d150000-0000-0000-0000-000000000005', 'hoa'),
    ('0d150000-0000-0000-0000-000000000006', 'lan'),
    ('0d150000-0000-0000-0000-000000000007', 'kim'),
    ('0d150000-0000-0000-0000-000000000008', 'bown'),
    ('0d150000-0000-0000-0000-000000000009', 'bmem')
  ) as u(id, code)
on conflict (id) do nothing;

insert into ctx
select code, id::text from auth.users u
  cross join lateral (select split_part(u.email, '@', 1) as code) x
 where u.email like '%@onedish.test';

insert into public.organizations (slug, name, short_code)
values ('onedish-a', 'One Dish A', 'ODA'), ('onedish-b', 'One Dish B', 'ODB');
insert into ctx
select 'org_a', id::text from public.organizations where slug = 'onedish-a' union all
select 'org_b', id::text from public.organizations where slug = 'onedish-b';

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c(case when x.code in ('bown', 'bmem') then 'org_b' else 'org_a' end)::bigint,
       pg_temp.c(x.code)::uuid,
       case when x.code in ('adm', 'bown') then 'owner' else 'member' end,
       upper(x.code)
  from unnest(array['adm','dinh','teo','nam','hoa','lan','kim','bown','bmem']) as x(code);

-- Everybody has Telegram but LAN.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select ms.id, ms.org_id, 880000 + ms.id, now() from public.memberships ms
 where ms.org_id in (pg_temp.c('org_a')::bigint, pg_temp.c('org_b')::bigint)
   and ms.short_code <> 'LAN';

-- TEO, HOA and LAN eat every weekday in A, BMEM in B.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c(case when w = 'bmem' then 'org_b' else 'org_a' end)::bigint,
       pg_temp.c(w)::uuid, d, true
  from unnest(array['teo','hoa','lan','bmem']) as w, generate_series(1, 7) as d;

-- Seven days in a row, then more, so KIM's weekday (late) has one menu. The
-- hand days are a week after `week`, which is settled.
insert into ctx
select k, (private.today_in(o.timezone) + n)::text
  from public.organizations o
  cross join (values ('one', 14), ('two', 15), ('grow', 16), ('shrink', 17),
                     ('swap', 18), ('swap1', 19), ('late', 20), ('closed', 21),
                     ('closed2', 22), ('week', 23), ('ren', 24), ('hand', 28),
                     ('hand2', 29)) as d(k, n)
 where o.slug = 'onedish-a';

------------------------------------------------- C publishing with one dish

-- Before it is published: DINH is down for the day without a dish, LAN has
-- already said no, and NAM plans the day off his rules.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('one')::date, now() + interval '9 days',
        pg_temp.c('adm')::uuid);
insert into public.orders (org_id, menu_id, service_date, profile_id, source, status,
                           created_by, cancelled_at)
select pg_temp.c('org_a')::bigint, pg_temp.m('org_a', 'one'), pg_temp.c('one')::date,
       pg_temp.c(w)::uuid, s, st, pg_temp.c(w)::uuid,
       case when st = 'cancelled' then now() end
  from (values ('dinh', 'member', 'placed'), ('lan', 'standing', 'cancelled')) as x(w, s, st);
insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
values (pg_temp.c('org_a')::bigint, pg_temp.c('nam')::uuid, pg_temp.c('one')::date, 'force');

-- Each write is its own statement: a check in the same one would read the
-- snapshot from before it.
insert into probe values
  ('C0 publishing one dish', pg_temp.publish('org_a', 'one', array['Com ga@45000']), 'ok');
insert into probe values
  ('C1 a weekday rule gets the dish', pg_temp.order_of('org_a', 'one', 'teo'),
   'standing placed Com ga@45000*'),
  ('C1 a planned day gets it', pg_temp.order_of('org_a', 'one', 'nam'),
   'standing placed Com ga@45000*'),
  ('C1 a member down without a dish gets it', pg_temp.order_of('org_a', 'one', 'dinh'),
   'member placed Com ga@45000*'),
  ('C2 a cancelled slot stays cancelled', pg_temp.order_of('org_a', 'one', 'lan'),
   'standing cancelled -');
insert into probe values
  ('C3 eating without a dish on a one-dish menu is the dish',
   pg_temp.as_user('adm', format('select * from public.set_my_order(%s, null)',
                                 pg_temp.m('org_a', 'one'))), 'ok');

insert into probe values
  ('C3 and marked as the system''s', pg_temp.order_of('org_a', 'one', 'adm'),
   'member placed Com ga@45000*'),
  ('C4 it is billed at the dish''s price',
   (select c.amount_minor::text from public.v_order_charges c
      join public.orders o on o.id = c.order_id
     where o.menu_id = pg_temp.m('org_a', 'one') and o.profile_id = pg_temp.c('teo')::uuid),
   '45000'),
  ('C5 nobody is asked anything', pg_temp.asked('org_a', 'one'), '-');

-- An admin's correction is a decision, and a person's own write is too.
select private.replace_order_line(
  pg_temp.c('org_a')::bigint, pg_temp.m('org_a', 'one'), pg_temp.c('one')::date,
  pg_temp.c('nam')::uuid, pg_temp.dish('org_a', 'one', 'Com ga'), 1::smallint, null,
  pg_temp.c('adm')::uuid);
select pg_temp.as_user('hoa', format(
  'update public.order_items set note = %L where profile_id = %L',
  'no onion', pg_temp.c('hoa')));
select pg_temp.as_user('kim', format(
  'insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
   values (%s, %s, %L, %L, %L)', pg_temp.c('org_a'), pg_temp.m('org_a', 'one'),
  pg_temp.c('one'), pg_temp.c('kim'), pg_temp.c('kim')));
select pg_temp.as_user('kim', format(
  'insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
     auto_assigned, item_name_snapshot, unit_price_minor)
   select o.id, o.org_id, o.profile_id, o.menu_id, %s, true, %L, 0
     from public.orders o where o.menu_id = %s and o.profile_id = %L',
  pg_temp.dish('org_a', 'one', 'Com ga'), '', pg_temp.m('org_a', 'one'), pg_temp.c('kim')));

insert into probe values
  ('C6 an admin''s correction is not the system''s', pg_temp.order_of('org_a', 'one', 'nam'),
   'standing placed Com ga@45000'),
  ('C6 a person editing their line clears the mark', pg_temp.order_of('org_a', 'one', 'hoa'),
   'standing placed Com ga@45000'),
  ('C6 a person cannot write the mark', pg_temp.order_of('org_a', 'one', 'kim'),
   'member placed Com ga@45000'),
  ('C7 the menu message says who is down for it',
   (select split_part(private.menu_message(pg_temp.m('org_a', 'one')), E'\n', 3)),
   'Standing orders are down for Com ga.');

------------------------------------------------------ T two dishes, and B's

insert into probe values
  ('T0 publishing two dishes', pg_temp.publish('org_a', 'two', array['Pho@50000', 'Bun@40000']),
   'ok');
insert into ctx values ('g_b', pg_temp.c('grow'));
insert into probe values
  ('T0 B''s one dish', pg_temp.publish('org_b', 'g_b', array['Ga@30000'], 'bown'), 'ok');
insert into probe values
  ('T1 two dishes convert nothing', pg_temp.order_of('org_a', 'two', 'teo'), 'standing placed -'),
  ('T2 B''s own slot gets B''s dish', pg_temp.order_of('org_b', 'g_b', 'bmem'),
   'standing placed Ga@30000*');

------------------------------------------------------- G a dish is added

-- On grow: DINH chooses the one dish herself, HOA cancels hers.
insert into probe values
  ('G0 publishing one dish', pg_temp.publish('org_a', 'grow', array['Com ga@45000']), 'ok');
insert into probe values
  ('G0 DINH chooses it', pg_temp.as_user('dinh', format(
     'select * from public.set_my_order(%s, %s)', pg_temp.m('org_a', 'grow'),
     pg_temp.dish('org_a', 'grow', 'Com ga'))), 'ok'),
  ('G0 HOA cancels', pg_temp.as_user('hoa', format(
     'update public.orders set status = %L, cancelled_at = now() where menu_id = %s and profile_id = %L',
     'cancelled', pg_temp.m('org_a', 'grow'), pg_temp.c('hoa'))), 'ok');
insert into probe values
  ('G1 before: TEO has it from the system, DINH by choice',
   pg_temp.order_of('org_a', 'grow', 'teo') || ' / ' || pg_temp.order_of('org_a', 'grow', 'dinh'),
   'standing placed Com ga@45000* / member placed Com ga@45000');
insert into probe values
  ('G2 adding a second dish',
   pg_temp.publish('org_a', 'grow', array['=Com ga@45000', 'Pho@50000']), 'ok');
insert into probe values
  ('G3 the system''s lines go', pg_temp.order_of('org_a', 'grow', 'teo'), 'standing placed -'),
  ('G3 for those without Telegram too', pg_temp.order_of('org_a', 'grow', 'lan'),
   'standing placed -'),
  ('G3 a chosen dish stays', pg_temp.order_of('org_a', 'grow', 'dinh'),
   'member placed Com ga@45000'),
  ('G3 a cancelled slot stays cancelled', pg_temp.order_of('org_a', 'grow', 'hoa'),
   'standing cancelled -'),
  ('G4 only those put back with Telegram are asked', pg_temp.asked('org_a', 'grow'), 'TEO'),
  ('G5 in these words',
   (select n.body || ' ' || n.parse_mode from public.notification_outbox n
     where n.kind = 'dish_choice' and n.related_menu_id = pg_temp.m('org_a', 'grow')),
   (select 'The menu for ' || to_char(m.service_date, 'DD/MM') || ' now has 2 dishes. '
           || 'Choose yours before '
           || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '. none'
      from public.menus m join public.organizations o on o.id = m.org_id
     where m.id = pg_temp.m('org_a', 'grow'))),
  ('G6 B''s one-dish menu on the same date is untouched', pg_temp.order_of('org_b', 'g_b', 'bmem'),
   'standing placed Ga@30000*'),
  ('G6 and B is told nothing', pg_temp.asked('org_b', 'g_b'), '-');

insert into probe values
  ('G7 publishing again, a third dish',
   pg_temp.publish('org_a', 'grow', array['=Com ga@45000', '=Pho@50000', 'Bun@40000']), 'ok');
insert into probe values
  ('G7 asks nobody twice', pg_temp.asked('org_a', 'grow'), 'TEO'),
  ('G8 the choice survives', pg_temp.order_of('org_a', 'grow', 'dinh'),
   'member placed Com ga@45000');

----------------------------------------------- R dishes removed or replaced

insert into probe values
  ('R0 shrink publishes two', pg_temp.publish('org_a', 'shrink', array['Pho@50000', 'Bun@40000']),
   'ok'),
  ('R0 swap publishes one', pg_temp.publish('org_a', 'swap', array['Com ga@45000']), 'ok'),
  ('R0 swap1 publishes one', pg_temp.publish('org_a', 'swap1', array['Com ga@45000']), 'ok');
insert into probe values
  ('R1 removing the unordered dish', pg_temp.publish('org_a', 'shrink', array['=Pho@50000']), 'ok'),
  ('R1 replacing the one dish with two',
   pg_temp.publish('org_a', 'swap', array['Pho@50000', 'Bun@40000']), 'ok'),
  ('R1 replacing the one dish with another',
   pg_temp.publish('org_a', 'swap1', array['Bun@40000']), 'ok');
insert into probe values
  ('R2 down to one dish, the undecided get it', pg_temp.order_of('org_a', 'shrink', 'teo'),
   'standing placed Pho@50000*'),
  ('R2 nobody is asked', pg_temp.asked('org_a', 'shrink'), '-'),
  ('R3 the system''s dish can go, and those it had choose',
   pg_temp.order_of('org_a', 'swap', 'teo') || ' ' || pg_temp.asked('org_a', 'swap'),
   'standing placed - HOA,TEO'),
  ('R4 replaced by one, they get the new one',
   pg_temp.order_of('org_a', 'swap1', 'teo') || ' ' || pg_temp.asked('org_a', 'swap1'),
   'standing placed Bun@40000* -'),
  ('R5 a dish somebody chose still cannot go',
   (select pg_temp.publish('org_a', 'grow', array['=Pho@50000', '=Bun@40000'])),
   '23503 update or delete on table "menu_items" violates foreign key constraint "order_items_menu_item_fk" on table "order_items"');

----------------------------------------------------- N renaming is not a dish

insert into probe values
  ('N0 ren publishes one', pg_temp.publish('org_a', 'ren', array['Com ga@45000']), 'ok');
insert into probe values
  ('N1 renaming it', pg_temp.publish('org_a', 'ren', array['=Com ga>Com ga nuong@45000']), 'ok'),
  ('N1 renaming one of two',
   pg_temp.publish('org_a', 'two', array['=Pho>Pho bo@50000', '=Bun@40000']), 'ok');
insert into probe values
  ('N2 the one-dish menu keeps the system''s line', pg_temp.order_of('org_a', 'ren', 'teo'),
   'standing placed Com ga@45000*'),
  ('N2 the two-dish menu converts nothing', pg_temp.order_of('org_a', 'two', 'teo'),
   'standing placed -'),
  ('N3 nobody is asked', pg_temp.asked('org_a', 'ren') || ' ' || pg_temp.asked('org_a', 'two'),
   '- -');

------------------------------------------------ L a slot materialized later

insert into probe values
  ('L0 late publishes one', pg_temp.publish('org_a', 'late', array['Com ga@45000']), 'ok');
insert into probe values
  ('L0 KIM turns her weekday on', pg_temp.as_user('kim', format(
     'insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
      values (%s, %L, %s, true)', pg_temp.c('org_a'), pg_temp.c('kim'),
     extract(isodow from pg_temp.c('late')::date)::int)), 'ok');
insert into probe values
  ('L1 her slot arrives with the dish', pg_temp.order_of('org_a', 'late', 'kim'),
   'standing placed Com ga@45000*');

---------------------------------------------- K nothing after the cutoff

insert into probe values
  ('K0 closed publishes two', pg_temp.publish('org_a', 'closed', array['Pho@50000', 'Bun@40000']),
   'ok'),
  ('K0 closed2 publishes one', pg_temp.publish('org_a', 'closed2', array['Com ga@45000']), 'ok');
update public.menus set order_cutoff_at = now() - interval '1 minute'
 where id in (pg_temp.m('org_a', 'closed'), pg_temp.m('org_a', 'closed2'));
delete from public.menu_items where id = pg_temp.dish('org_a', 'closed', 'Bun');
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
values (pg_temp.m('org_a', 'closed2'), pg_temp.c('org_a')::bigint, 'Pho', 50000, 1);
insert into probe values
  ('K1 down to one after the cutoff converts nothing', pg_temp.order_of('org_a', 'closed', 'teo'),
   'standing placed -'),
  ('K2 a dish added after the cutoff takes nothing back',
   pg_temp.order_of('org_a', 'closed2', 'teo') || ' ' || pg_temp.asked('org_a', 'closed2'),
   'standing placed Com ga@45000* -');

------------------------------------------------------ W a settled week

-- Not reachable through the app, which settles only weeks already past; a
-- plain publish on the table stands in for the day being open anyway.
do $$
declare v_period bigint;
begin
  v_period := public.ensure_billing_period(pg_temp.c('org_a')::bigint, pg_temp.c('week')::date);
  update public.billing_periods set status = 'closed', closed_at = now() where id = v_period;
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('week')::date, now() + interval '9 days',
          pg_temp.c('adm')::uuid);
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  values (pg_temp.m('org_a', 'week'), pg_temp.c('org_a')::bigint, 'Com ga', 45000, 0);
  update public.menus set status = 'published' where id = pg_temp.m('org_a', 'week');
end $$;
insert into probe values
  ('W1 a slot in a settled week gets no dish', pg_temp.order_of('org_a', 'week', 'teo'),
   'standing placed -');

------------------------------------------------------ H a meal handed over

create function pg_temp.offer(p_day text, p_from text, p_to text) returns text
language sql as $fn$
  select pg_temp.as_user(p_from, format(
    'insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
     select o.org_id, o.id, o.profile_id, %L, o.profile_id from public.orders o
      where o.menu_id = %s and o.profile_id = %L',
    pg_temp.c(p_to), pg_temp.m('org_a', p_day), pg_temp.c(p_from)));
$fn$;

insert into probe values
  ('H0 hand publishes one', pg_temp.publish('org_a', 'hand', array['Com ga@45000']), 'ok'),
  ('H0 hand2 publishes two', pg_temp.publish('org_a', 'hand2', array['Pho@50000', 'Bun@40000']),
   'ok');
insert into probe values
  ('H1 TEO offers his meal to DINH', pg_temp.offer('hand', 'teo', 'dinh'), 'ok'),
  ('H1 and on hand2, still undecided', pg_temp.offer('hand2', 'teo', 'dinh'), 'ok');
insert into probe values
  ('H2 the offer makes the line his', pg_temp.order_of('org_a', 'hand', 'teo'),
   'standing placed Com ga@45000'),
  ('H3 down to one dish, a slot on offer gets it unmarked',
   pg_temp.publish('org_a', 'hand2', array['=Pho@50000']), 'ok');
insert into probe values
  ('H3 unmarked', pg_temp.order_of('org_a', 'hand2', 'teo'), 'standing placed Pho@50000'),
  ('H4 a second dish on hand', pg_temp.publish('org_a', 'hand', array['=Com ga@45000', 'Pho@50000']),
   'ok'),
  ('H4 a second dish on hand2', pg_temp.publish('org_a', 'hand2', array['=Pho@50000', 'Bun@40000']),
   'ok');
insert into probe values
  ('H5 the handed-over meal keeps its dish',
   pg_temp.order_of('org_a', 'hand', 'teo') || ' / ' || pg_temp.order_of('org_a', 'hand2', 'teo'),
   'standing placed Com ga@45000 / standing placed Pho@50000'),
  ('H5 and TEO is not asked', pg_temp.asked('org_a', 'hand') || ' ' || pg_temp.asked('org_a', 'hand2'),
   'HOA HOA');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
