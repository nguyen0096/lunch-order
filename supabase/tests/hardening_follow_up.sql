-- Link tokens, the outbox, invitation previews and removed members: the doors
-- the 20261012 migrations closed or opened, measured.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/hardening_follow_up.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- Same conventions as supabase/tests/hardening.sql: each block asserts a
-- positive control that the role really was downgraded, a refusal is judged
-- by SQLSTATE (and message where the message is ours), and a write RLS
-- filters out is judged by the row count it reports.

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
    ('eeeeeeee-0000-0000-0000-000000000001', 'own@fup.test',  'Chu Nha'),
    ('eeeeeeee-0000-0000-0000-000000000002', 'adm@fup.test',  'Quan Ly'),
    ('eeeeeeee-0000-0000-0000-000000000003', 'dinh@fup.test', 'Dinh Thi'),
    ('eeeeeeee-0000-0000-0000-000000000004', 'teo@fup.test',  'Teo Van'),
    ('eeeeeeee-0000-0000-0000-000000000005', 'gone@fup.test', 'Da Di'),
    ('eeeeeeee-0000-0000-0000-000000000006', 'new@fup.test',  'Moi Den')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code)
values ('fup-a', 'Follow A', 'FUPA'),
       ('fup-b', 'Follow B', 'FUPB'),
       ('fup-c', 'Follow C', 'FUPC');

-- GONE was removed from A and from C, and C has since been deleted.
insert into public.memberships (org_id, profile_id, role, short_code, status, removed_at)
select o.id, u.pid::uuid, u.role, u.code, u.status,
       case when u.status = 'inactive' then now() end
  from public.organizations o
join (values
  ('fup-a', 'eeeeeeee-0000-0000-0000-000000000001', 'owner',  'OWN',  'active'),
  ('fup-a', 'eeeeeeee-0000-0000-0000-000000000002', 'admin',  'ADM',  'active'),
  ('fup-a', 'eeeeeeee-0000-0000-0000-000000000003', 'member', 'DINH', 'active'),
  ('fup-a', 'eeeeeeee-0000-0000-0000-000000000004', 'member', 'TEO',  'active'),
  ('fup-a', 'eeeeeeee-0000-0000-0000-000000000005', 'member', 'GONE', 'inactive'),
  ('fup-c', 'eeeeeeee-0000-0000-0000-000000000005', 'member', 'GONE', 'inactive'),
  ('fup-b', 'eeeeeeee-0000-0000-0000-000000000006', 'owner',  'NEWB', 'active')
) as u(slug, pid, role, code, status) on u.slug = o.slug;
update public.organizations set deleted_at = now() where slug = 'fup-c';

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'fup-a' union all
select 'org_b', id::text from public.organizations where slug = 'fup-b' union all
select 'org_c', id::text from public.organizations where slug = 'fup-c' union all
select 'own',  'eeeeeeee-0000-0000-0000-000000000001' union all
select 'adm',  'eeeeeeee-0000-0000-0000-000000000002' union all
select 'dinh', 'eeeeeeee-0000-0000-0000-000000000003' union all
select 'teo',  'eeeeeeee-0000-0000-0000-000000000004' union all
select 'gone', 'eeeeeeee-0000-0000-0000-000000000005' union all
select 'new',  'eeeeeeee-0000-0000-0000-000000000006';

insert into ctx
select 'm_' || m.short_code, m.id::text from public.memberships m
 where m.org_id = (select v::bigint from ctx where k = 'org_a');

-- OWN, ADM and DINH connected; GONE's link outlived the removal; TEO has none.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 990000 + m.id, now() from public.memberships m
 where m.org_id = (select v::bigint from ctx where k = 'org_a')
   and m.short_code in ('OWN', 'ADM', 'DINH', 'GONE');

insert into ctx
select 'tok_' || m.short_code, tl.link_token::text
  from public.telegram_links tl join public.memberships m on m.id = tl.membership_id
 where m.org_id = (select v::bigint from ctx where k = 'org_a');

-- One queued row of an ordinary kind and one bug report in A's outbox.
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, body, parse_mode)
values ((select v::bigint from ctx where k = 'org_a'), 'fup:announcement:1', 'announcement', 1, 'hello', 'none'),
       ((select v::bigint from ctx where k = 'org_a'), 'fup:bug_report:1',   'bug_report',   1, 'secret', 'none');

-- Invitations to A for NEW: live, expired and used; and one to deleted C.
insert into public.invitations (org_id, email, role, token, expires_at, accepted_at, invited_by)
values
  ((select v::bigint from ctx where k = 'org_a'), 'new@fup.test',   'admin',
   'f0000000-0000-4000-8000-000000000001', now() + interval '3 days', null,
   'eeeeeeee-0000-0000-0000-000000000002'),
  ((select v::bigint from ctx where k = 'org_a'), 'late@fup.test',  'member',
   'f0000000-0000-4000-8000-000000000002', now() - interval '1 day', null,
   'eeeeeeee-0000-0000-0000-000000000002'),
  ((select v::bigint from ctx where k = 'org_a'), 'done@fup.test',  'member',
   'f0000000-0000-4000-8000-000000000003', now() + interval '3 days', now(),
   'eeeeeeee-0000-0000-0000-000000000002'),
  ((select v::bigint from ctx where k = 'org_c'), 'new@fup.test',   'member',
   'f0000000-0000-4000-8000-000000000004', now() + interval '3 days', null,
   'eeeeeeee-0000-0000-0000-000000000005');

------------------------------------------------ T: a link token is its owner's

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('T control: the admin still reads every link in the office',
    (select count(*)::text from public.telegram_links where org_id = pg_temp.c('org_a')::bigint), '4');
  insert into probe values ('T the admin still sees who is connected, and since when',
    (select count(*)::text from public.telegram_links
      where org_id = pg_temp.c('org_a')::bigint and chat_id is not null and linked_at is not null), '4');

  insert into probe values ('T an admin cannot read a colleague''s link_token',
    left(pg_temp.attempt(format($q$select link_token from public.telegram_links where membership_id = %s$q$,
                                pg_temp.c('m_DINH'))), 5), '42501');
  insert into probe values ('T nor by asking for every column',
    left(pg_temp.attempt($q$select * from public.telegram_links$q$), 5), '42501');
  insert into probe values ('T nor by filtering on it',
    left(pg_temp.attempt(format($q$select 1 from public.telegram_links where link_token = '%s'$q$,
                                pg_temp.c('tok_DINH'))), 5), '42501');
  insert into probe values ('T the admin''s own token comes from the function, and only theirs',
    (select string_agg(membership_id || ':' || (link_token::text = pg_temp.c('tok_ADM')) || ':' || linked, ',')
       from public.my_telegram_link(pg_temp.c('org_a')::bigint)),
    pg_temp.c('m_ADM') || ':true:true');
  insert into probe values ('T an admin still disconnects a colleague',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = null where membership_id = %s$q$,
                           pg_temp.c('m_DINH'))), 'ok 1');

  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('T an owner cannot read a colleague''s link_token either',
    left(pg_temp.attempt($q$select link_token from public.telegram_links$q$), 5), '42501');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('T control: DINH reads their own link''s row',
    (select count(*)::text from public.telegram_links where membership_id = pg_temp.c('m_DINH')::bigint), '1');
  insert into probe values ('T DINH reads their own token through the function',
    (select (link_token::text = pg_temp.c('tok_DINH')) || ':' || linked
       from public.my_telegram_link(pg_temp.c('org_a')::bigint)), 'true:false');
  insert into probe values ('T a member cannot insert a link directly',
    left(pg_temp.attempt(format($q$insert into public.telegram_links (membership_id, org_id) values (%s, %s)$q$,
                                pg_temp.c('m_TEO'), pg_temp.c('org_a'))), 5), '42501');
  insert into probe values ('T a member still disconnects, the way the bot''s /unlink does it',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = null, linked_at = null
                               where membership_id = %s and chat_id is null returning membership_id$q$,
                           pg_temp.c('m_DINH'))), 'ok 1');

  perform pg_temp.act_as(pg_temp.c('teo'));
  insert into probe values ('T TEO has no link until they ask for one',
    (select count(*)::text from public.my_telegram_link(pg_temp.c('org_a')::bigint)), '0');
  insert into probe values ('T asking mints one, not connected',
    (select membership_id || ':' || linked from public.create_my_telegram_link(pg_temp.c('org_a')::bigint)),
    pg_temp.c('m_TEO') || ':false');
  insert into probe values ('T asking again hands back the same token',
    (select (a.link_token = b.link_token)::text
       from public.my_telegram_link(pg_temp.c('org_a')::bigint) a,
            public.create_my_telegram_link(pg_temp.c('org_a')::bigint) b), 'true');

  perform pg_temp.act_as(pg_temp.c('new'));
  insert into probe values ('T somebody from another office cannot mint a link in this one',
    pg_temp.attempt(format($q$select * from public.create_my_telegram_link(%s)$q$, pg_temp.c('org_a'))),
    '42501 you are not a member of that office');
  insert into probe values ('T nor read one there',
    (select count(*)::text from public.my_telegram_link(pg_temp.c('org_a')::bigint)), '0');

  perform pg_temp.act_as(pg_temp.c('gone'));
  insert into probe values ('T a removed member''s old token is not handed back to them',
    (select count(*)::text from public.my_telegram_link(pg_temp.c('org_a')::bigint)), '0');
  reset role;
end $$;

insert into probe
select 'T no browser role holds SELECT on link_token, or INSERT at all',
       (has_column_privilege('authenticated', 'public.telegram_links', 'link_token', 'select')
        or has_column_privilege('anon', 'public.telegram_links', 'link_token', 'select')
        or has_table_privilege('authenticated', 'public.telegram_links', 'insert'))::text,
       'false';
insert into probe
select 'T the service role still reads the table whole',
       has_column_privilege('service_role', 'public.telegram_links', 'link_token', 'select')::text,
       'true';

------------------------------------------------- O: the outbox is not a form

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('O control: the admin reads the outbox at all',
    (select count(*)::text from public.notification_outbox where kind = 'announcement'
        and org_id = pg_temp.c('org_a')::bigint), '1');
  insert into probe values ('O a non-owner admin still reads no bug report there',
    (select count(*)::text from public.notification_outbox where kind = 'bug_report'), '0');

  insert into probe values ('O an admin cannot queue a message to any chat',
    left(pg_temp.attempt(format($q$insert into public.notification_outbox
           (org_id, dedupe_key, kind, chat_id, body, parse_mode)
         values (%s, 'squat', 'announcement', 424242, 'pay me instead', 'none')$q$, pg_temp.c('org_a'))), 5),
    '42501');
  insert into probe values ('O an admin cannot rewrite a queued message',
    left(pg_temp.attempt($q$update public.notification_outbox set chat_id = 424242, body = 'x'$q$), 5), '42501');
  insert into probe values ('O an admin cannot delete a queued message',
    left(pg_temp.attempt($q$delete from public.notification_outbox$q$), 5), '42501');
  insert into probe values ('O an admin still makes an announcement, to linked members only',
    (select queued || '/' || unreachable
       from public.send_announcement(pg_temp.c('org_a')::bigint, 'office', 'Lunch is late')), '2/2');

  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('O an owner cannot queue a message directly either',
    left(pg_temp.attempt(format($q$insert into public.notification_outbox
           (org_id, dedupe_key, kind, chat_id, body, parse_mode)
         values (%s, 'squat2', 'announcement', 424242, 'x', 'none')$q$, pg_temp.c('org_a'))), 5),
    '42501');
  insert into probe values ('O an owner makes an announcement, holding no admin row',
    (select queued::text from public.send_announcement(pg_temp.c('org_a')::bigint, 'person', 'Hi', pg_temp.c('adm')::uuid)),
    '1');
  insert into probe values ('O an owner reads the bug report in the queue',
    (select count(*)::text from public.notification_outbox where kind = 'bug_report'), '1');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('O a member reads nothing in the outbox',
    (select count(*)::text from public.notification_outbox), '0');
  reset role;
end $$;

insert into probe
select 'O the announcements went to the office''s own chats and nowhere else',
       (select count(*)::text from public.notification_outbox ob
         where ob.kind = 'announcement' and ob.dedupe_key like 'org:%'
           and not exists (select 1 from public.telegram_links tl
                            where tl.chat_id = ob.chat_id and tl.org_id = ob.org_id)),
       '0';
insert into probe
select 'O no browser role holds INSERT, UPDATE, DELETE or TRUNCATE on the outbox',
       (has_table_privilege('authenticated', 'public.notification_outbox', 'insert')
        or has_table_privilege('authenticated', 'public.notification_outbox', 'update')
        or has_table_privilege('authenticated', 'public.notification_outbox', 'delete')
        or has_table_privilege('authenticated', 'public.notification_outbox', 'truncate')
        or has_table_privilege('anon', 'public.notification_outbox', 'insert')
        or has_table_privilege('anon', 'public.notification_outbox', 'select'))::text,
       'false';
insert into probe
select 'O the outbox has one policy, and it only reads',
       (select string_agg(polname || ':' || polcmd::text, ',') from pg_policy
         where polrelid = 'public.notification_outbox'::regclass),
       'outbox_admin_select:r';

-------------------------------------------- I: an invitation says where it leads

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('new'));
  insert into probe values ('I control: NEW is no member of A and reads no invitation there',
    (select count(*)::text from public.invitations), '0');

  insert into probe values ('I a live invitation names its office and role',
    (select org_name || '|' || role || '|' || state || '|' || (expires_at > now())
       from public.invitation_preview('f0000000-0000-4000-8000-000000000001')),
    'Follow A|admin|valid|true');
  insert into probe values ('I an expired one says so',
    (select org_name || '|' || state from public.invitation_preview('f0000000-0000-4000-8000-000000000002')),
    'Follow A|expired');
  insert into probe values ('I a used one says so',
    (select org_name || '|' || state from public.invitation_preview('f0000000-0000-4000-8000-000000000003')),
    'Follow A|used');
  insert into probe values ('I a token that matches nothing returns no row',
    (select count(*)::text from public.invitation_preview('f0000000-0000-4000-8000-00000000dead')), '0');
  insert into probe values ('I an invitation to a deleted office returns no row',
    (select count(*)::text from public.invitation_preview('f0000000-0000-4000-8000-000000000004')), '0');
  insert into probe values ('I previewing accepts nothing',
    (select count(*)::text from public.memberships where profile_id = pg_temp.c('new')::uuid
        and org_id = pg_temp.c('org_a')::bigint), '0');
  reset role;
end $$;

insert into probe
select 'I the preview carries no address, sender or id',
       pg_get_function_result('public.invitation_preview(uuid)'::regprocedure),
       'TABLE(org_name text, role text, expires_at timestamp with time zone, state text)';
insert into probe
select 'I anon cannot preview',
       has_function_privilege('anon', 'public.invitation_preview(uuid)', 'execute')::text, 'false';
insert into probe
select 'I an invitation token is a random v4 uuid',
       (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
          join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
         where d.adrelid = 'public.invitations'::regclass and a.attname = 'token'),
       'gen_random_uuid()';

---------------------------------------------- R: a removed member is told

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('gone'));
  insert into probe values ('R control: GONE is in no office',
    (select count(*)::text from public.memberships), '0');
  insert into probe values ('R GONE is told the live office they were removed from, and not the deleted one',
    (select string_agg(org_name || ':' || removed, ',') from public.my_former_offices()), 'Follow A:true');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('R an active member was removed from nothing',
    (select count(*)::text from public.my_former_offices()), '0');

  perform pg_temp.act_as(pg_temp.c('new'));
  insert into probe values ('R neither was somebody who never joined A',
    (select count(*)::text from public.my_former_offices()), '0');
  reset role;
end $$;

insert into probe
select 'R the answer is a name and whether it was a removal, and nothing else',
       pg_get_function_result('public.my_former_offices()'::regprocedure),
       'TABLE(org_name text, removed boolean)';
insert into probe
select 'R anon cannot ask',
       has_function_privilege('anon', 'public.my_former_offices()', 'execute')::text, 'false';
insert into probe
select 'R the old name is gone',
       (to_regprocedure('public.my_removed_offices()') is null)::text, 'true';

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
