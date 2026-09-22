-- Cross-tenant and privilege isolation. Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/isolation.sql
--
-- Two traps this file exists to avoid, both of which produce a false PASS:
--
-- 1. A test that passes because the session was never actually downgraded to
--    `authenticated`. set_config() in a FROM clause has no guaranteed
--    evaluation order relative to the query it is meant to affect. Use
--    `set local role` as its own statement inside a DO block, and assert a
--    POSITIVE CONTROL, as below.
--
-- 2. Judging a blocked write by whether it raised. An UPDATE or DELETE whose
--    rows are filtered out by RLS affects zero rows and raises nothing, so an
--    exception-only test reports "allowed" for a write that was fully blocked.
--    Assert the row delta. Only INSERT reliably raises 42501.

begin;

create temp table probe (label text, got text, want text);
-- Load-bearing. Every probe row below is inserted AFTER `set local role
-- authenticated`, and a temp table is not writable by that role without this.
-- Its absence did not make these tests fail, it made them ABORT at the first
-- probe row with 42501, so neither file had ever produced a verdict.
grant insert on probe to authenticated;

do $$
declare
  v_a bigint; v_b bigint; v_menu_b bigint; v_date date; v_before bigint; v_after bigint;
begin
  select id into v_a from public.organizations where slug = 'org-a';
  select id into v_b from public.organizations where slug = 'org-b';
  select m.id, m.service_date into v_menu_b, v_date
    from public.menus m where m.org_id = v_b limit 1;
  select count(*) into v_before from public.orders where org_id = v_b;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

  insert into probe values
    ('control: acting as Binh',
       ((select auth.uid())::text = '22222222-2222-2222-2222-222222222222')::text, 'true'),
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: sees own org',    (select count(*) from public.organizations)::text, '1'),
    ('leak: organizations', (select count(*) from public.organizations where id = v_b)::text, '0'),
    ('leak: memberships',   (select count(*) from public.memberships where org_id = v_b)::text, '0'),
    ('leak: menus',         (select count(*) from public.menus where org_id = v_b)::text, '0'),
    ('leak: menu_items',    (select count(*) from public.menu_items where org_id = v_b)::text, '0'),
    ('leak: orders',        (select count(*) from public.orders where org_id = v_b)::text, '0'),
    ('leak: order_items',   (select count(*) from public.order_items where org_id = v_b)::text, '0'),
    ('leak: v_order_charges', (select count(*) from public.v_order_charges where org_id = v_b)::text, '0'),
    ('leak: billing_lines', (select count(*) from public.billing_lines where org_id = v_b)::text, '0'),
    ('leak: billing_statements', (select count(*) from public.billing_statements where org_id = v_b)::text, '0'),
    ('leak: payments',      (select count(*) from public.payments where org_id = v_b)::text, '0'),
    ('leak: outbox',        (select count(*) from public.notification_outbox where org_id = v_b)::text, '0'),
    ('leak: telegram_links',(select count(*) from public.telegram_links where org_id = v_b)::text, '0'),
    ('leak: invitations',   (select count(*) from public.invitations where org_id = v_b)::text, '0'),
    ('leak: other org profile',
       (select count(*) from public.profiles where id = '33333333-3333-3333-3333-333333333333')::text, '0'),
    -- Was 'within org: sees only own order', wanting 1. Stale twice over:
    -- seed_fixtures creates no orders, and orders_select_own was replaced by
    -- orders_select_org in 20260911140000, which made the board deliberately
    -- org-wide. sharing.sql asserts that visibility positively; this file's job
    -- is the other org, and the leak checks above already cover it.
    ('within org: no other org''s orders',
       (select count(*) from public.orders where org_id = v_b)::text, '0');

  -- Literal ids, so the write is genuinely attempted rather than an
  -- INSERT..SELECT that reads zero rows and trivially "succeeds".
  begin
    insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
    values (v_b, v_menu_b, v_date,
            '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222');
    insert into probe values ('write: cross-org insert', 'allowed', 'blocked');
  exception when others then
    insert into probe values ('write: cross-org insert', 'blocked', 'blocked');
  end;

  begin
    update public.order_items set unit_price_minor = 0
     where profile_id = '22222222-2222-2222-2222-222222222222';
    insert into probe values ('write: forge own price', 'allowed', 'blocked');
  exception when others then
    insert into probe values ('write: forge own price', 'blocked', 'blocked');
  end;

  begin
    update public.memberships set role = 'owner'
     where profile_id = '22222222-2222-2222-2222-222222222222';
    insert into probe values ('write: self-promote to owner', 'allowed', 'blocked');
  exception when others then
    insert into probe values ('write: self-promote to owner', 'blocked', 'blocked');
  end;

  reset role;
  select count(*) into v_after from public.orders where org_id = v_b;
  insert into probe values
    ('write: org B row count unchanged', (v_before = v_after)::text, 'true');
end $$;

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
