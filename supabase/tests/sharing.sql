-- The orders board is shared within an org and invisible across orgs.
--
-- Every write check asserts a ROW DELTA, not the absence of an exception. This
-- is not pedantry: an UPDATE or DELETE whose rows are filtered out by RLS
-- affects zero rows and raises nothing at all, so an exception-only test
-- reports "allowed" for a write that was in fact completely blocked. Only
-- INSERT reliably raises (42501, new row violates row-level security policy).
--
-- Run after seed_fixtures.sql.

begin;
create temp table probe (who text, label text, got text, want text);

do $$
declare
  v_a bigint; v_b bigint;
  v_anh uuid := '11111111-1111-1111-1111-111111111111';  -- org-a owner
  v_binh uuid := '22222222-2222-2222-2222-222222222222'; -- org-a member
  v_chi uuid := '33333333-3333-3333-3333-333333333333';  -- org-b owner
  v_anh_status text; v_before bigint; v_after bigint;
begin
  select id into v_a from public.organizations where slug = 'org-a';
  select id into v_b from public.organizations where slug = 'org-b';

  -- Anh's order must exist for the sharing check to mean anything.
  insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
  select m.org_id, m.id, m.service_date, v_anh, v_anh
    from public.menus m where m.org_id = v_a
  on conflict do nothing;
  insert into public.orders (org_id, menu_id, service_date, profile_id, created_by)
  select m.org_id, m.id, m.service_date, v_binh, v_binh
    from public.menus m where m.org_id = v_a
  on conflict do nothing;

  ---------------------------------------------------------------- as a member
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_binh), true);

  insert into probe values
    ('member', 'control: downgraded role', (current_role = 'authenticated')::text, 'true'),
    ('member', 'control: acting as Binh', ((select auth.uid()) = v_binh)::text, 'true'),
    ('member', 'board shows both colleagues',
      (select count(*) from public.orders where org_id = v_a)::text, '2'),
    ('member', 'other orgs stay invisible',
      (select count(*) from public.orders where org_id = v_b)::text, '0'),
    ('member', 'colleague billing stays private',
      (select count(*) from public.billing_statements where profile_id <> v_binh)::text, '0');
  reset role;

  -- Row delta, not exception: this is the check that actually proves anything.
  select status into v_anh_status from public.orders where profile_id = v_anh;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_binh), true);
  begin
    update public.orders set status = 'cancelled', cancelled_at = now()
     where profile_id = v_anh;
  exception when others then null;
  end;
  reset role;
  insert into probe
    select 'member', 'cannot cancel a colleague''s order',
           (select status from public.orders where profile_id = v_anh), v_anh_status;

  ---------------------------------------------------------------- cross-org
  select count(*) into v_before from public.orders where org_id = v_a;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_chi), true);
  insert into probe values
    ('outsider', 'control: acting as Chi', ((select auth.uid()) = v_chi)::text, 'true'),
    ('outsider', 'sees zero org-a orders',
      (select count(*) from public.orders where org_id = v_a)::text, '0'),
    ('outsider', 'sees zero org-a order_items',
      (select count(*) from public.order_items where org_id = v_a)::text, '0'),
    ('outsider', 'sees zero org-a members',
      (select count(*) from public.memberships where org_id = v_a)::text, '0');
  begin
    delete from public.orders where org_id = v_a;
  exception when others then null;
  end;
  reset role;
  select count(*) into v_after from public.orders where org_id = v_a;
  insert into probe values
    ('outsider', 'could not delete org-a orders', v_after::text, v_before::text);
end $$;

select who, label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by who, label;

select case when exists (select 1 from probe where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
