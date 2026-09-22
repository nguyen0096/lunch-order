-- What an anonymous sign-in can see. Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/anonymous.sql
--
-- Anonymous sign-ins are enabled so somebody can join from Telegram without an
-- email address. The cost is that an anonymous visitor arrives holding a real
-- JWT whose role is `authenticated`, which is the same role every policy in
-- this schema is written against -- so Supabase's advisor flags all twenty
-- tables as reachable by anonymous users, and it is right that they are
-- reachable. What makes it safe is that `private.my_org_ids()` returns nothing
-- for a subject with no membership row, and every policy goes through it.
--
-- That is an argument, and arguments rot. This file is the measurement.
--
-- The traps that produce a false PASS are the ones isolation.sql documents:
-- `set local role` as its own statement, positive controls, and the grant
-- below without which every probe insert aborts with 42501.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;

do $$
begin
  set local role authenticated;
  -- A subject that exists nowhere in public.memberships, which is exactly the
  -- state of a browser that has just called signInAnonymously().
  perform set_config('request.jwt.claims',
    '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated","is_anonymous":true}',
    true);

  insert into probe values
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: is the anon user',
       ((select auth.uid())::text = '99999999-9999-9999-9999-999999999999')::text, 'true'),
    ('orgs',           (select count(*) from public.organizations)::text, '0'),
    ('memberships',    (select count(*) from public.memberships)::text, '0'),
    ('menus',          (select count(*) from public.menus)::text, '0'),
    ('menu_items',     (select count(*) from public.menu_items)::text, '0'),
    ('orders',         (select count(*) from public.orders)::text, '0'),
    ('order_items',    (select count(*) from public.order_items)::text, '0'),
    ('billing_statements', (select count(*) from public.billing_statements)::text, '0'),
    ('billing_lines',  (select count(*) from public.billing_lines)::text, '0'),
    ('billing_periods',(select count(*) from public.billing_periods)::text, '0'),
    ('payments',       (select count(*) from public.payments)::text, '0'),
    ('telegram_links', (select count(*) from public.telegram_links)::text, '0'),
    ('invitations',    (select count(*) from public.invitations)::text, '0'),
    ('profiles',       (select count(*) from public.profiles)::text, '0'),
    ('meal_transfers', (select count(*) from public.meal_transfers)::text, '0'),
    ('notification_outbox', (select count(*) from public.notification_outbox)::text, '0'),
    ('standing_orders',(select count(*) from public.standing_orders)::text, '0'),
    -- The one row an anonymous visitor could turn into a membership. It is
    -- reachable only by sending the right string to join_with_code, never by
    -- reading it off a table.
    ('the join code is not readable',
       (select count(*) from public.organizations where telegram_join_code is not null)::text, '0');

  reset role;
end $$;

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
