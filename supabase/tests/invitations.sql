-- The invitation path is the only way a non-member gets into a tenant, so its
-- checks are worth asserting rather than assuming. Run after seed_fixtures.sql
-- or against a project with a real org.
--
-- Rolls back, so it leaves nothing behind.
begin;
create temp table t (check_name text, got text, want text) on commit drop;
grant insert on t to authenticated;

do $$
declare
  v_org bigint; v_owner uuid; v_tok uuid; v_stranger uuid; v_res record;
begin
  select id into v_org from public.organizations order by id limit 1;
  select profile_id into v_owner from public.memberships
   where org_id = v_org and role = 'owner' limit 1;

  v_stranger := extensions.uuid_generate_v4();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', v_stranger,'authenticated','authenticated',
          'stranger@gmail.com','x',now(),now(),now(),
          '{"provider":"email"}','{"full_name":"A Stranger"}');

  insert into public.invitations (org_id, email, role, invited_by)
  values (v_org, 'stranger@gmail.com', 'member', v_owner) returning token into v_tok;

  -- A forwarded link must not work for whoever opens it: the invitation names
  -- an address and the signed-in email has to match.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_owner), true);
  begin
    perform public.accept_invitation(v_tok);
    insert into t values ('wrong account refused','accepted','refused');
  exception when others then
    insert into t values ('wrong account refused','refused','refused');
  end;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_stranger), true);
  select * into v_res from public.accept_invitation(v_tok);
  insert into t values ('correct account joined', (v_res.org_id = v_org)::text, 'true');
  insert into t values ('joined with invited role', v_res.role, 'member');

  begin
    perform public.accept_invitation(v_tok);
    insert into t values ('link is single use','reusable','refused');
  exception when others then
    insert into t values ('link is single use','refused','refused');
  end;

  insert into t values
    ('new member got a short code',
      (select short_code is not null from public.memberships
        where org_id = v_org and profile_id = v_stranger)::text, 'true'),
    ('new member sees only own billing',
      (select count(*) from public.billing_statements
        where profile_id <> v_stranger)::text, '0');
  reset role;

  update public.invitations set accepted_at = null, expires_at = now() - interval '1 day'
   where token = v_tok;
  delete from public.memberships where org_id = v_org and profile_id = v_stranger;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_stranger), true);
  begin
    perform public.accept_invitation(v_tok);
    insert into t values ('expired link refused','accepted','refused');
  exception when others then
    insert into t values ('expired link refused','refused','refused');
  end;
  reset role;
end $$;

-- Re-inviting someone who is already a member. The first version of
-- accept_invitation treated this as nothing to do, which silently discarded
-- the role the invitation carried: re-inviting a member as an admin left them
-- a member with no sign that anything had been ignored.
do $$
declare v_org bigint; v_owner uuid; v_uid uuid; v_tok uuid;
begin
  select id into v_org from public.organizations order by id limit 1;
  select profile_id into v_owner from public.memberships
   where org_id = v_org and role in ('owner','admin') limit 1;

  v_uid := extensions.uuid_generate_v4();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', v_uid,'authenticated','authenticated',
          'rejoiner@gmail.com','x',now(),now(),now(),
          '{"provider":"email"}','{"full_name":"Re Joiner"}');
  insert into public.memberships (org_id, profile_id, role, short_code, status)
  values (v_org, v_uid, 'member', 'REJ', 'inactive');

  insert into public.invitations (org_id, email, role, invited_by)
  values (v_org, 'rejoiner@gmail.com', 'admin', v_owner) returning token into v_tok;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_uid), true);
  perform public.accept_invitation(v_tok);
  reset role;
  insert into t
    select 'deactivated member re-invited as admin becomes admin', role, 'admin'
      from public.memberships where org_id = v_org and profile_id = v_uid
    union all
    select 'and their access is restored', status, 'active'
      from public.memberships where org_id = v_org and profile_id = v_uid;

  -- A stale link must never reduce access weeks later.
  update public.invitations set role = 'member', accepted_at = null
   where org_id = v_org and email = 'rejoiner@gmail.com' returning token into v_tok;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_uid), true);
  perform public.accept_invitation(v_tok);
  reset role;
  insert into t
    select 'a member-role link does not demote an admin', role, 'admin'
      from public.memberships where org_id = v_org and profile_id = v_uid;

  -- Ownership is not something a link may alter, in either direction.
  insert into public.invitations (org_id, email, role, invited_by)
  select v_org, p.email, 'member', v_owner from public.profiles p where p.id = v_owner
  returning token into v_tok;
  set local role authenticated;
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_owner), true);
  perform public.accept_invitation(v_tok);
  reset role;
  insert into t
    select 'an owner is never demoted by a link', role, 'owner'
      from public.memberships where org_id = v_org and profile_id = v_owner;
end $$;

select check_name, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict from t;
select case when exists (select 1 from t where got <> want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;
rollback;
