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

-- Never a zero for an unknown price: 0 is a real price.
insert into probe
select 'no unpriced dish is shown as zero',
       (pg_temp.msg('2030-01-02') like '%0 ₫%')::text, 'false';

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
