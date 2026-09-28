-- Who binds a Telegram chat, and what a removal means: the doors the 20261013
-- migrations closed, measured.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/removal_and_chat_binding.sql
--
-- Builds its own fixtures and rolls everything back. Same conventions as
-- supabase/tests/hardening.sql.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;

create temp table ctx (k text primary key, v text);
grant select, insert, update on ctx to authenticated;

create function pg_temp.attempt(p_sql text) returns text
language plpgsql as $fn$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok ' || n;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

create function pg_temp.act_as(p_uid text) returns void
language sql as $fn$
  select set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', p_uid), true);
$fn$;

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('dddddddd-0000-0000-0000-000000000001', 'own@rcb.test',   'Chu Nha'),
    ('dddddddd-0000-0000-0000-000000000002', 'adm@rcb.test',   'Quan Ly'),
    ('dddddddd-0000-0000-0000-000000000003', 'lefty@rcb.test', 'Di Ve'),
    ('dddddddd-0000-0000-0000-000000000004', 'out@rcb.test',   'Bi Moi'),
    ('dddddddd-0000-0000-0000-000000000005', 'teo@rcb.test',   'Teo Van'),
    ('dddddddd-0000-0000-0000-000000000006', 'new@rcb.test',   'Moi Den'),
    ('dddddddd-0000-0000-0000-000000000007', 'tg@rcb.test',    'Qua Bot')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code, telegram_join_code)
values ('rcb-a', 'Rcb A', 'RCBA', 'RCBJXKNA');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('dddddddd-0000-0000-0000-000000000001', 'owner',  'OWN'),
  ('dddddddd-0000-0000-0000-000000000002', 'admin',  'ADM'),
  ('dddddddd-0000-0000-0000-000000000003', 'member', 'LEFT'),
  ('dddddddd-0000-0000-0000-000000000004', 'member', 'OUT'),
  ('dddddddd-0000-0000-0000-000000000005', 'member', 'TEO')
) as u(pid, role, code) on true
where o.slug = 'rcb-a';

insert into ctx
select 'org', id::text from public.organizations where slug = 'rcb-a' union all
select 'own',   'dddddddd-0000-0000-0000-000000000001' union all
select 'adm',   'dddddddd-0000-0000-0000-000000000002' union all
select 'lefty', 'dddddddd-0000-0000-0000-000000000003' union all
select 'out',   'dddddddd-0000-0000-0000-000000000004' union all
select 'teo',   'dddddddd-0000-0000-0000-000000000005' union all
select 'new',   'dddddddd-0000-0000-0000-000000000006' union all
select 'tg',    'dddddddd-0000-0000-0000-000000000007';

insert into ctx
select 'm_' || m.short_code, m.id::text from public.memberships m
 where m.org_id = pg_temp.c('org')::bigint;

-- TEO's own chat, which is the one somebody else would like to take.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
values (pg_temp.c('m_TEO')::bigint, pg_temp.c('org')::bigint, 880005, now());

------------------------------------------- B: a chat is bound by Telegram only

insert into probe
select 'B the browser''s join takes no chat',
       pg_get_function_arguments('public.join_with_code(text, text, text)'::regprocedure),
       'p_code text, p_display_name text, p_short_code text DEFAULT NULL::text';
insert into probe
select 'B a signed-in browser cannot reach the join that binds a chat',
       has_function_privilege('authenticated',
         'private.join_office_with_code(uuid, text, text, text, bigint)', 'execute')::text, 'false';
insert into probe
select 'B nor can anon',
       has_function_privilege('anon',
         'private.join_office_with_code(uuid, text, text, text, bigint)', 'execute')::text, 'false';
insert into probe
select 'B the service role can',
       has_function_privilege('service_role',
         'private.join_office_with_code(uuid, text, text, text, bigint)', 'execute')::text, 'true';
insert into probe
select 'B anon cannot join at all',
       has_function_privilege('anon', 'public.join_with_code(text, text, text)', 'execute')::text, 'false';
insert into probe
select 'B the browser''s join is the only join_with_code left',
       (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = 'join_with_code'),
       'join_with_code(text,text,text)';

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('new'));
  insert into probe values ('B control: the role really is authenticated',
    current_user::text, 'authenticated');

  insert into probe values ('B a caller naming a chat finds no join that takes one',
    left(pg_temp.attempt($q$select * from public.join_with_code('RCBJXKNA', 'Moi Den', 777001::bigint, null)$q$), 5),
    '42883');
  insert into probe values ('B nor by name',
    left(pg_temp.attempt($q$select * from public.join_with_code(p_code => 'RCBJXKNA', p_display_name => 'Moi Den', p_chat_id => 777001)$q$), 5),
    '42883');
  insert into probe values ('B so the chat was bound to nobody',
    (select count(*)::text from public.telegram_links where chat_id = 777001), '0');
  insert into probe values ('B and the caller did not join on the way',
    (select count(*)::text from public.memberships where profile_id = pg_temp.c('new')::uuid), '0');

  insert into probe values ('B a browser calling the private join directly is refused',
    left(pg_temp.attempt(format(
      $q$select * from private.join_office_with_code(%L::uuid, 'RCBJXKNA', 'Moi Den', null, 880005)$q$,
      pg_temp.c('new'))), 5), '42501');

  insert into probe values ('B the browser joins with its three arguments',
    pg_temp.attempt($q$select * from public.join_with_code('RCBJXKNA', 'Moi Den', null)$q$),
    'ok 1');
  insert into probe values ('B the browser join works and binds nothing',
    (select count(*)::text from public.telegram_links tl
       join public.memberships m on m.id = tl.membership_id
      where m.profile_id = pg_temp.c('new')::uuid), '0');
  reset role;
end $$;

insert into probe
select 'B TEO''s chat is still TEO''s',
       (select count(*)::text from public.telegram_links
         where chat_id = 880005 and membership_id = pg_temp.c('m_TEO')::bigint), '1';

-- The bot, after checking the webhook secret, on its own connection.
insert into probe
select 'B the service path joins and binds the chat Telegram reported',
       (select org_name from private.join_office_with_code(
          pg_temp.c('tg')::uuid, 'RCBJXKNA', 'Qua Bot', null, 880007)),
       'Rcb A';
insert into probe
select 'B that chat now speaks for that member',
       (select m.profile_id::text from public.telegram_links tl
          join public.memberships m on m.id = tl.membership_id
         where tl.chat_id = 880007), pg_temp.c('tg');
insert into probe
select 'B the service path refuses a chat already somebody else''s in the office',
       left(pg_temp.attempt(format(
         $q$select * from private.join_office_with_code(%L::uuid, 'RCBJXKNA', 'Moi Den', null, 880005)$q$,
         pg_temp.c('new'))), 5), '23505';
insert into probe
select 'B the service path refuses a profile that does not exist',
       left(pg_temp.attempt(
         $q$select * from private.join_office_with_code('dddddddd-0000-0000-0000-00000000ffff', 'RCBJXKNA', 'X', null, 880099)$q$), 5),
       '42501';

------------------------------------------------- L: leaving is not a removal

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('lefty'));
  insert into probe values ('L LEFTY leaves',
    pg_temp.attempt(format($q$select public.leave_office(%s)$q$, pg_temp.c('org'))), 'ok 1');
  insert into probe values ('L told the office is a former one, and not a removal',
    (select string_agg(org_name || ':' || removed, ',') from public.my_former_offices()), 'Rcb A:false');
  reset role;
end $$;

insert into probe
select 'L the row says left: inactive, with no removal on it',
       (select status || ' ' || coalesce(removed_at::text, '-') || ' ' || coalesce(removed_by::text, '-')
          from public.memberships where id = pg_temp.c('m_LEFT')::bigint),
       'inactive - -';

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('lefty'));
  insert into probe values ('L somebody who left comes back with the join code',
    pg_temp.attempt($q$select * from public.join_with_code('RCBJXKNA', 'Di Ve')$q$), 'ok 1');
  insert into probe values ('L to the same membership, as a member',
    (select id::text || ' ' || status from public.memberships
      where profile_id = pg_temp.c('lefty')::uuid), pg_temp.c('m_LEFT') || ' active');
  reset role;
end $$;

---------------------------------------------- R: a removal is on the record

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('teo'));
  insert into probe values ('R a member cannot remove a colleague',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_OUT'))), 'ok 0');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('R an admin removes OUT',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_OUT'))), 'ok 1');
  insert into probe values ('R an admin cannot forge a removal record',
    left(pg_temp.attempt(format($q$update public.memberships set removed_at = null where id = %s$q$,
                                pg_temp.c('m_OUT'))), 5), '42501');
  reset role;
end $$;

insert into probe
select 'R the row says who removed OUT',
       (select status || ' ' || (removed_at is not null)::text || ' ' || removed_by::text
          from public.memberships where id = pg_temp.c('m_OUT')::bigint),
       'inactive true ' || pg_temp.c('adm');

-- An hour back, so an invitation can be issued before it and one after it.
update public.memberships set removed_at = now() - interval '1 hour'
 where id = pg_temp.c('m_OUT')::bigint;

insert into public.invitations (org_id, email, role, invited_by, issued_at, token)
values (pg_temp.c('org')::bigint, 'out@rcb.test', 'member', pg_temp.c('adm')::uuid,
        now() - interval '1 day', 'c0000000-0000-4000-8000-000000000001');

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('out'));
  insert into probe values ('R control: OUT is in no office',
    (select count(*)::text from public.memberships), '0');
  insert into probe values ('R OUT is told they were removed',
    (select string_agg(org_name || ':' || removed, ',') from public.my_former_offices()), 'Rcb A:true');
  insert into probe values ('R OUT cannot clear their own removal',
    left(pg_temp.attempt(format($q$update public.memberships set removed_at = null where id = %s$q$,
                                pg_temp.c('m_OUT'))), 5), '42501');

  insert into probe values ('R the join code does not bring a removed member back',
    pg_temp.attempt($q$select * from public.join_with_code('RCBJXKNA', 'Bi Moi')$q$),
    '55000 An admin removed you from Rcb A, so its join code will not bring you back. Ask an admin there to add you back.');
  insert into probe values ('R nor does an invitation sent before the removal',
    pg_temp.attempt($q$select * from public.accept_invitation('c0000000-0000-4000-8000-000000000001')$q$),
    '55000 This invitation was sent before an admin removed you from Rcb A. Ask an admin there to add you back, or to invite you again.');
  reset role;
end $$;

insert into probe
select 'R OUT is still out, and the invitation still unused',
       (select status from public.memberships where id = pg_temp.c('m_OUT')::bigint) || ' ' ||
       (select (accepted_at is null)::text from public.invitations
         where token = 'c0000000-0000-4000-8000-000000000001'),
       'inactive true';
insert into probe
select 'R nor does the Telegram path, which shares the join',
       left(pg_temp.attempt(format(
         $q$select * from private.join_office_with_code(%L::uuid, 'RCBJXKNA', 'Bi Moi', null, 880004)$q$,
         pg_temp.c('out'))), 5), '55000';

-- The admin invites OUT again: the app upserts on (org_id, email).
do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('R an admin issues the invitation again',
    pg_temp.attempt(format($q$insert into public.invitations (org_id, email, role, invited_by)
                              values (%s, 'out@rcb.test', 'member', %L)
                              on conflict (org_id, email) do update
                                set role = excluded.role, invited_by = excluded.invited_by$q$,
                           pg_temp.c('org'), pg_temp.c('adm'))), 'ok 1');
  perform pg_temp.act_as(pg_temp.c('out'));
  insert into probe values ('R and an invitation issued after the removal brings OUT back',
    pg_temp.attempt($q$select * from public.accept_invitation('c0000000-0000-4000-8000-000000000001')$q$),
    'ok 1');
  reset role;
end $$;

insert into probe
select 'R OUT is back, and the removal is cleared',
       (select status || ' ' || coalesce(removed_at::text, '-') from public.memberships
         where id = pg_temp.c('m_OUT')::bigint), 'active -';

-- A used invitation issued again is a new link, not the spent one revived.
do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  perform pg_temp.attempt(format($q$insert into public.invitations (org_id, email, role, invited_by)
                              values (%s, 'out@rcb.test', 'member', %L)
                              on conflict (org_id, email) do update
                                set role = excluded.role, invited_by = excluded.invited_by$q$,
                           pg_temp.c('org'), pg_temp.c('adm')));
  reset role;
end $$;

insert into probe
select 'R a used invitation issued again is waiting, under a new token',
       (select (accepted_at is null)::text || ' ' ||
               (token <> 'c0000000-0000-4000-8000-000000000001')::text || ' ' ||
               (expires_at > now() + interval '13 days')::text
          from public.invitations where email = 'out@rcb.test'),
       'true true true';

--------------------------------- A: an admin re-adds; an owner does as much

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  perform pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                                 pg_temp.c('m_OUT')));
  insert into probe values ('A an admin adds a removed member back',
    pg_temp.attempt(format($q$update public.memberships set status = 'active' where id = %s$q$,
                           pg_temp.c('m_OUT'))), 'ok 1');
  insert into probe values ('A an admin cannot remove the owner',
    left(pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                                pg_temp.c('m_OWN'))), 5), '42501');

  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('A the owner removes a member, as an admin can',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_TEO'))), 'ok 1');
  insert into probe values ('A and it is recorded as the owner''s removal',
    (select removed_by::text from public.memberships where id = pg_temp.c('m_TEO')::bigint),
    pg_temp.c('own'));
  insert into probe values ('A the owner removes an admin',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_ADM'))), 'ok 1');
  insert into probe values ('A the owner adds a member back, as an admin can',
    pg_temp.attempt(format($q$update public.memberships set status = 'active' where id = %s$q$,
                           pg_temp.c('m_TEO'))), 'ok 1');
  insert into probe values ('A the owner adds an admin back',
    pg_temp.attempt(format($q$update public.memberships set status = 'active' where id = %s$q$,
                           pg_temp.c('m_ADM'))), 'ok 1');
  reset role;
end $$;

insert into probe
select 'A everybody re-added is active with no removal on record',
       (select string_agg(short_code || ':' || status || ':' || coalesce(removed_at::text, '-'), ',' order by short_code)
          from public.memberships
         where id in (pg_temp.c('m_OUT')::bigint, pg_temp.c('m_TEO')::bigint, pg_temp.c('m_ADM')::bigint)),
       'ADM:active:-,OUT:active:-,TEO:active:-';

insert into probe
select 'A an active membership cannot carry a removal, even written by the service',
       left(pg_temp.attempt(format(
         $q$with o as (insert into public.organizations (slug, name, short_code)
                      values ('rcb-b', 'Rcb B', 'RCBB') returning id)
            insert into public.memberships (org_id, profile_id, role, short_code, status, removed_at)
            select o.id, %L, 'owner', 'OWN', 'active', now() from o$q$,
         pg_temp.c('own'))), 5), '23514';

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
