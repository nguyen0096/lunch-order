-- The "menu published" message lists every available dish, priced or not.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/menu_message.sql
--
-- Builds its own fixtures and rolls everything back. Each probe compares the
-- whole body, not a substring, so a line that silently disappears fails here.

begin;

create temp table probe (label text, got text, want text);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','e1e1e1e1-0000-0000-0000-000000000001',
        'authenticated','authenticated','owner@menu.test','x',now(),now(),now(),
        '{"provider":"google"}','{"full_name":"Chu Thuc Don"}')
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time)
values ('menu-msg','Menu Message','Asia/Ho_Chi_Minh','16:00');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, 'e1e1e1e1-0000-0000-0000-000000000001', 'owner', 'CTD'
  from public.organizations o where o.slug = 'menu-msg';

-- One menu per case. Drafts, because menu_message reads the rows and not the
-- status, and a draft keeps the fixture clear of the publish triggers.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by, source_text)
select o.id, v.d, v.cut, 'e1e1e1e1-0000-0000-0000-000000000001', 'menu_message.sql'
  from public.organizations o
  cross join (values
    (date '2030-01-02', timestamptz '2030-01-01 16:00:00+00'),
    (date '2030-01-03', timestamptz '2030-01-02 16:00:00+00'),
    (date '2030-01-04', timestamptz '2030-01-03 16:00:00+00')
  ) as v(d, cut)
 where o.slug = 'menu-msg';

-- The last dish of each menu is unavailable, so the probes also show that a
-- price going missing did not change which dishes are listed.
insert into public.menu_items (menu_id, org_id, name, price_minor, position, is_available)
select m.id, m.org_id, v.nm, v.pr, v.pos, v.avail
  from public.menus m
  join public.organizations o on o.id = m.org_id and o.slug = 'menu-msg'
  join (values
    (date '2030-01-02', 'Cơm tấm', null::bigint, 0, true),
    (date '2030-01-02', 'Bún bò',  null,         1, true),
    (date '2030-01-02', 'Hết món', null,         2, false),
    (date '2030-01-03', 'Cơm tấm', 50000,        0, true),
    (date '2030-01-03', 'Bún bò',  null,         1, true),
    (date '2030-01-03', 'Hết món', 40000,        2, false),
    (date '2030-01-04', 'Cơm tấm', 50000,        0, true),
    (date '2030-01-04', 'Bún bò',  60000,        1, true),
    (date '2030-01-04', 'Hết món', null,         2, false)
  ) as v(d, nm, pr, pos, avail) on v.d = m.service_date;

create function pg_temp.msg(p_date date) returns text
language sql stable as $fn$
  select private.menu_message(m.id)
    from public.menus m
    join public.organizations o on o.id = m.org_id and o.slug = 'menu-msg'
   where m.service_date = p_date
$fn$;

insert into probe values
  ('every price missing: both dishes listed, price to come',
   pg_temp.msg('2030-01-02'),
   E'Menu for 02/01\n- Cơm tấm  price to come\n- Bún bò  price to come\nOrders close 23:00 01/01.'),
  ('some prices missing: the priced one priced, the other price to come',
   pg_temp.msg('2030-01-03'),
   E'Menu for 03/01\n- Cơm tấm  50.000 ₫\n- Bún bò  price to come\nOrders close 23:00 02/01.'),
  ('every price present: unchanged from before',
   pg_temp.msg('2030-01-04'),
   E'Menu for 04/01\n- Cơm tấm  50.000 ₫\n- Bún bò  60.000 ₫\nOrders close 23:00 03/01.');

-- Never a zero for an unknown price: 0 is a real price. Judged line by line
-- on both menus that hold an unpriced dish, so a priced 50.000 cannot stand in.
insert into probe
select 'no line on a menu with unpriced dishes reads as a zero price',
       count(*)::text, '0'
  from unnest(array[pg_temp.msg('2030-01-02'), pg_temp.msg('2030-01-03')]) as b(body)
  cross join lateral regexp_split_to_table(b.body, E'\n') as l(line)
 where l.line ~ '(^|[^0-9.])0 ₫$';

insert into probe
select 'each of the three unpriced dishes ends in price to come',
       count(*) filter (where l.line like '%  price to come')::text, '3'
  from unnest(array[pg_temp.msg('2030-01-02'), pg_temp.msg('2030-01-03')]) as b(body)
  cross join lateral regexp_split_to_table(b.body, E'\n') as l(line)
 where l.line like '- %';

------------------------------------------------------------- a long menu

-- Sixty unpriced dishes of about 190 characters each, over 11000 characters
-- if listed in full. Telegram refuses a body over 4096 and the drain has no
-- splitter, so the whole message has to fit and say what it left out.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by, source_text)
select o.id, date '2030-01-05', timestamptz '2030-01-04 16:00:00+00',
       'e1e1e1e1-0000-0000-0000-000000000001', 'menu_message.sql'
  from public.organizations o where o.slug = 'menu-msg';

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id,
       'Món ' || lpad(g::text, 2, '0') || ' ' || repeat('cơm gà xối mỡ ', 13),
       null, g
  from public.menus m
  join public.organizations o on o.id = m.org_id and o.slug = 'menu-msg'
  cross join generate_series(1, 60) as g
 where m.service_date = date '2030-01-05';

create temp table long_menu as
select pg_temp.msg('2030-01-05') as body;

insert into probe
select 'a long menu stays under Telegram''s 4096 characters',
       (length(body) < 4096)::text, 'true' from long_menu;

insert into probe
select 'a long menu is cut, not sent whole',
       (length(body) > 3000 and length(body) < 3990)::text, 'true' from long_menu;

-- Listed plus left out is every dish, and what is listed is the first ones in
-- order, not whichever happened to be short.
insert into probe
select 'the dishes listed and the count left out add up to sixty',
       (listed + left_out)::text, '60'
  from (
    select (select count(*) from regexp_split_to_table(body, E'\n') l where l like '- Món %') as listed,
           (regexp_match(body, E'\nAnd (\\d+) more dishes\\. See the app for the full menu\\.\n'))[1]::int
             as left_out
      from long_menu
  ) x;

insert into probe
select 'the listed dishes are the first ones, in order',
       (select string_agg(substr(l, 7, 2), ',' order by ord)
          from regexp_split_to_table(body, E'\n') with ordinality as t(l, ord)
         where l like '- Món %'),
       (select string_agg(lpad(g::text, 2, '0'), ',' order by g)
          from generate_series(1,
                 (select count(*)::int from regexp_split_to_table(body, E'\n') l
                   where l like '- Món %')) g)
  from long_menu;

insert into probe
select 'a long menu still opens with the day and ends with the cutoff',
       (body like E'Menu for 05/01\n- Món 01 %'
        and body like E'%\nOrders close 23:00 04/01.')::text, 'true'
  from long_menu;

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
