-- Bug reports: who may write one, who may read one, and who is told.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/bug_reports.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- The traps from supabase/tests/isolation.sql apply: `control: role
-- downgraded` is asserted positively before any refusal is believed, and a
-- refusal is judged by SQLSTATE and message, not merely by having raised.
--
-- The reporter cannot read their own row, so INSERT ... RETURNING is never used
-- while authenticated: RETURNING must pass the SELECT policy and would raise.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated, anon;

create temp table ctx (k text primary key, v text);
grant select on ctx to authenticated, anon;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','eeeeeeee-0000-0000-0000-000000000001','authenticated','authenticated','own1@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Một Chủ"}'),
 ('00000000-0000-0000-0000-000000000000','eeeeeeee-0000-0000-0000-000000000002','authenticated','authenticated','own2@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Hai Chủ"}'),
 ('00000000-0000-0000-0000-000000000000','eeeeeeee-0000-0000-0000-000000000003','authenticated','authenticated','adm@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Ba Quản"}'),
 ('00000000-0000-0000-0000-000000000000','eeeeeeee-0000-0000-0000-000000000004','authenticated','authenticated','mem@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bốn <Lý> & Co"}'),
 ('00000000-0000-0000-0000-000000000000','ffffffff-0000-0000-0000-000000000001','authenticated','authenticated','ownb@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bê Chủ"}'),
 ('00000000-0000-0000-0000-000000000000','ffffffff-0000-0000-0000-000000000002','authenticated','authenticated','memb@bug.test','x',now(),now(),now(),'{"provider":"google"}','{"full_name":"Bê Viên"}')
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time)
values ('bug-a','Bug A','Asia/Ho_Chi_Minh','16:00'),
       ('bug-b','Bug B','Asia/Ho_Chi_Minh','16:00');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid, u.role, u.code from public.organizations o
join (values
  ('bug-a','eeeeeeee-0000-0000-0000-000000000001'::uuid,'owner', 'OWA'),
  ('bug-a','eeeeeeee-0000-0000-0000-000000000002'::uuid,'owner', 'OWB'),
  ('bug-a','eeeeeeee-0000-0000-0000-000000000003'::uuid,'admin', 'ADM'),
  ('bug-a','eeeeeeee-0000-0000-0000-000000000004'::uuid,'member','MEM'),
  ('bug-b','ffffffff-0000-0000-0000-000000000001'::uuid,'owner', 'BOW'),
  ('bug-b','ffffffff-0000-0000-0000-000000000002'::uuid,'member','BME')
) as u(slug,pid,role,code) on u.slug = o.slug;

-- OWB has not finished /start, which is what makes "only a connected owner is
-- messaged" measurable. ADM and MEM are connected, so a message reaching either
-- of them could not be excused by a missing chat.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 990100 + m.id, now()
  from public.memberships m
 where m.short_code in ('OWA','ADM','MEM','BOW');

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'bug-a'
union all
select 'org_b', id::text from public.organizations where slug = 'bug-b';

-- Another kind in office A's outbox, so "the admin reads no bug report through
-- the queue" cannot pass because the admin reads nothing at all.
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, body, parse_mode)
select (select v::bigint from ctx where k='org_a'), 'bug_reports.sql:control', 'announcement',
       990001, 'control row', 'none';

------------------------------------------------------------- the member reports

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000004","role":"authenticated"}', true);
  insert into probe values
    ('control: role downgraded', (current_role = 'authenticated')::text, 'true'),
    ('control: acting as the member',
      ((select auth.uid())::text = 'eeeeeeee-0000-0000-0000-000000000004')::text, 'true');

  insert into public.bug_reports (org_id, description, route, app_version, user_agent, viewport)
  values ((select v::bigint from ctx where k='org_a'),
          '  B1 the <b>board</b> & the bill disagree  ',
          '#/o/bug-a/board', '0.1.0+abc1234', 'Mozilla/5.0 <Test>', '390x844');

  insert into probe values ('the member reads no report, their own included',
    (select count(*)::text from public.bug_reports), '0');

  reset role;
end $$;

insert into probe
select 'the report is stored, trimmed, against the member and office A',
       (select r.description || '|' || (r.reporter_id = 'eeeeeeee-0000-0000-0000-000000000004')::text
                || '|' || (r.org_id = (select v::bigint from ctx where k='org_a'))::text
          from public.bug_reports r where r.description like 'B1 %'),
       'B1 the <b>board</b> & the bill disagree|true|true';

insert into probe
select 'it reached OWA alone: not the unconnected owner, not the admin, not the member',
       coalesce((select string_agg(m.short_code, ',' order by m.short_code)
                   from public.notification_outbox ob
                   join public.memberships m on m.org_id = ob.org_id
                                            and m.profile_id = ob.recipient_profile_id
                  where ob.kind = 'bug_report'), '(none)'),
       'OWA';

insert into probe
select 'the message is HTML',
       (select parse_mode from public.notification_outbox where kind = 'bug_report'), 'HTML';

insert into probe
select 'every user-supplied field is escaped for HTML',
       (select (body like '%B1 the &lt;b&gt;board&lt;/b&gt; &amp; the bill disagree%'
            and body like '%from Bốn &lt;Lý&gt; &amp; Co, Bug A%'
            and body like '%Browser: Mozilla/5.0 &lt;Test&gt;%'
            and body not like '%<b>board%'
            and body like '<b>Bug report</b>%')::text
          from public.notification_outbox where kind = 'bug_report'),
       'true';

------------------------------------------------------------------- who reads

do $$
declare v_n integer;
begin
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into probe values ('the connected owner reads it',
    (select count(*)::text from public.bug_reports), '1');

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000002","role":"authenticated"}', true);
  insert into probe values ('the unconnected owner reads it too',
    (select count(*)::text from public.bug_reports), '1');

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000003","role":"authenticated"}', true);
  insert into probe values
    ('control: the admin reads the outbox at all',
      (select count(*)::text from public.notification_outbox where kind = 'announcement'), '1'),
    ('the admin reads no report', (select count(*)::text from public.bug_reports), '0'),
    ('the admin reads no report through the outbox',
      (select count(*)::text from public.notification_outbox where kind = 'bug_report'), '0');

  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into probe values ('another office''s owner reads nothing',
    (select count(*)::text from public.bug_reports), '0');

  -- The member tries to resolve it: no row matches, because they cannot see it.
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000004","role":"authenticated"}', true);
  update public.bug_reports set resolved_at = now();
  get diagnostics v_n = row_count;
  insert into probe values ('the member cannot resolve it', v_n::text, '0');

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000003","role":"authenticated"}', true);
  update public.bug_reports set resolved_at = now();
  get diagnostics v_n = row_count;
  insert into probe values ('the admin cannot resolve it', v_n::text, '0');

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000002","role":"authenticated"}', true);
  update public.bug_reports set resolved_at = now();
  get diagnostics v_n = row_count;
  insert into probe values ('an owner resolves it', v_n::text, '1');

  reset role;
end $$;

------------------------------------------------------------------- refusals

do $$
declare v_state text; v_before bigint; v_after bigint;
begin
  select count(*) into v_before from public.bug_reports;
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000004","role":"authenticated"}', true);

  begin
    insert into public.bug_reports (org_id, reporter_id, description)
    values ((select v::bigint from ctx where k='org_a'),
            'eeeeeeee-0000-0000-0000-000000000001', 'in somebody else''s name');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('R1 naming another reporter: refused by the column grant', v_state, '42501');

  begin
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_b'), 'into an office I am not in');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('R2 reporting into another office: refused by RLS', v_state, '42501');

  begin
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_a'), '   ');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R3 blank description: refused', v_state,
    '23514 a bug report needs a description of what went wrong');

  begin
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_a'), repeat('x', 2001));
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('R4 over-long description: refused', v_state,
    '22001 a bug report can be at most 2000 characters; that one is 2001');

  begin
    delete from public.bug_reports;
    v_state := 'no refusal';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('R5 deleting a report: refused', v_state, '42501');

  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000001","role":"authenticated"}', true);
  begin
    update public.bug_reports set description = 'rewritten by the owner';
    v_state := 'no refusal';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('R6 an owner rewriting the words: refused', v_state, '42501');

  reset role;

  set local role anon;
  begin
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_a'), 'from nobody');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate;
  end;
  insert into probe values ('R7 anon reporting: refused', v_state, '42501');
  reset role;

  select count(*) into v_after from public.bug_reports;
  insert into probe values ('refusals stored nothing', (v_before = v_after)::text, 'true');
end $$;

------------------------------------------------------------------- the limit

do $$
declare v_state text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeeee-0000-0000-0000-000000000004","role":"authenticated"}', true);

  -- One is already stored, so nine more reach ten.
  for i in 2..10 loop
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_a'), 'L' || i);
  end loop;

  begin
    insert into public.bug_reports (org_id, description)
    values ((select v::bigint from ctx where k='org_a'), 'L11');
    v_state := 'no refusal';
  exception when others then v_state := sqlstate || ' ' || sqlerrm;
  end;
  insert into probe values ('the eleventh report in an hour: refused', v_state,
    '54000 you have sent 10 bug reports in the last hour; the owner has them all, so try again later');

  reset role;
end $$;

insert into probe
select 'each of the ten reached the connected owner once',
       (select count(*)::text from public.notification_outbox where kind = 'bug_report'), '10';

--------------------------------------------------------------------- verdict

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
