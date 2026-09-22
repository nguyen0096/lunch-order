-- Who has to agree before a meal transfer becomes a charge.
--
-- The rule is keyed on whether the admin is the SENDER, not on their role.
-- An earlier version auto-accepted any admin-created transfer, which meant an
-- admin giving away their own lunch charged a colleague with no say -- being
-- an admin does not make that consensual. Recording a swap two other people
-- already agreed is a different act: the admin's confirmation IS the consent.
--
-- Rolls back.
begin;
create temp table t (check_name text, got text, want text) on commit drop;
grant insert on t to authenticated;

do $$
declare
  v_org bigint; v_owner uuid; v_a uuid; v_b uuid; v_tz text;
  v_menu bigint; v_date date; v_own bigint; v_other bigint;
begin
  select id, timezone into v_org, v_tz from public.organizations order by id limit 1;
  select profile_id into v_owner from public.memberships
   where org_id=v_org and role in ('owner','admin') limit 1;
  select profile_id into v_a from public.memberships
   where org_id=v_org and role='member' order by id limit 1;
  select profile_id into v_b from public.memberships
   where org_id=v_org and role='member' and profile_id <> v_a order by id limit 1;

  v_date := private.today_in(v_tz) + 28;
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by, status)
  values (v_org, v_date, (v_date - 1)::timestamp at time zone v_tz, v_owner, 'draft')
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor)
  values (v_menu, v_org, 'Test dish', 45000);
  update public.menus set status='published' where id=v_menu;

  insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
  values (v_org, v_menu, v_date, v_owner, v_owner)
  on conflict (menu_id, profile_id) do update set status='placed' returning id into v_own;
  insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
  values (v_org, v_menu, v_date, v_a, v_a)
  on conflict (menu_id, profile_id) do update set status='placed' returning id into v_other;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_owner), true);

  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values (v_org, v_own, v_owner, v_a, v_owner);
  insert into t values ('admin giving away their OWN meal stays pending',
    (select status from public.meal_transfers where order_id = v_own), 'pending');

  insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
  values (v_org, v_other, v_a, v_b, v_owner);
  insert into t values ('admin recording ANOTHER pair''s swap is accepted',
    (select status from public.meal_transfers where order_id = v_other), 'accepted');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_a), true);
  update public.meal_transfers set status='accepted' where order_id = v_own;
  insert into t values ('the recipient can accept an admin''s offer',
    (select status from public.meal_transfers where order_id = v_own), 'accepted');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_b), true);
  begin
    insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
    values (v_org, v_own, v_owner, v_b, v_b);
    insert into t values ('a member cannot transfer someone else''s meal','allowed','refused');
  exception when others then
    insert into t values ('a member cannot transfer someone else''s meal','refused','refused');
  end;
  reset role;
end $$;

select check_name, got, want, case when got=want then 'PASS' else 'FAIL' end as verdict from t;
select case when exists (select 1 from t where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;
rollback;
