-- Publishing a menu must create orders for everyone whose weekday rule covers
-- it, without the client asking. Regression test for two separate failures:
--
--  1. The client used to call materialize_standing_orders by RPC, which failed
--     on a missing EXECUTE grant and surfaced as "you don't have permission".
--  2. After moving it into a trigger, menus published BEFORE the trigger
--     existed had no orders at all -- the function was fine, nothing was
--     listening.
--
-- Exercises the exact sequence the app performs: insert draft, add dishes,
-- flip to published. No RPC anywhere. Rolls back.

begin;
create temp table t (check_name text, got text, want text) on commit drop;
grant insert on t to authenticated;

do $$
declare
  v_org bigint; v_admin uuid; v_today date; v_target date;
  v_menu bigint; v_dow int; v_expected int;
begin
  select id into v_org from public.organizations order by id limit 1;
  select profile_id into v_admin from public.memberships
   where org_id = v_org and role in ('owner','admin') limit 1;
  v_today := private.today_in(
    (select timezone from public.organizations where id = v_org));

  -- Far enough ahead that no menu exists and no cutoff has passed.
  v_target := v_today + 21;
  v_dow := extract(isodow from v_target)::int;

  -- Give someone a rule for that weekday if nobody has one, so the test is
  -- meaningful on a fresh database rather than vacuously passing.
  insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
  select v_org, m.profile_id, v_dow, true
    from public.memberships m
   where m.org_id = v_org and m.status = 'active'
   limit 1
  on conflict (org_id, profile_id, weekday) do update set is_enabled = true;

  select count(*) into v_expected
    from public.standing_orders so
    join public.memberships m on m.org_id = so.org_id
                             and m.profile_id = so.profile_id
                             and m.status = 'active'
   where so.org_id = v_org and so.weekday = v_dow and so.is_enabled;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_admin), true);

  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (v_org, v_target,
          (v_target - 1)::timestamp at time zone
            (select timezone from public.organizations where id = v_org),
          v_admin)
  returning id into v_menu;

  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  values (v_menu, v_org, 'Test dish', 45000, 0);

  begin
    update public.menus set status = 'published' where id = v_menu;
    insert into t values ('admin can publish without an RPC', 'ok', 'ok');
  exception when others then
    insert into t values ('admin can publish without an RPC',
                          sqlstate || ' ' || sqlerrm, 'ok');
  end;
  reset role;

  insert into t values
    ('at least one rule applied, so the test is not vacuous',
      (v_expected > 0)::text, 'true'),
    ('orders materialized on publish',
      (select count(*)::text from public.orders
        where menu_id = v_menu and source = 'standing'), v_expected::text),
    ('materialized orders have no dish yet',
      (select count(*)::text from public.order_items where menu_id = v_menu), '0');

  -- Republishing must not duplicate.
  update public.menus set status = 'locked'    where id = v_menu;
  update public.menus set status = 'published' where id = v_menu;
  insert into t values ('republishing does not duplicate',
    (select count(*)::text from public.orders where menu_id = v_menu), v_expected::text);

  -- A cancelled order must not come back from the dead.
  update public.orders set status = 'cancelled', cancelled_at = now()
   where menu_id = v_menu;
  update public.menus set status = 'locked'    where id = v_menu;
  update public.menus set status = 'published' where id = v_menu;
  insert into t values ('a cancelled order is not resurrected',
    (select count(*)::text from public.orders
      where menu_id = v_menu and status = 'placed'), '0');
end $$;

select check_name, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from t;
select case when exists (select 1 from t where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;
rollback;
