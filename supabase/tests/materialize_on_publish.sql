-- Publishing a new day: standing orders, the one dish, one announcement.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/materialize_on_publish.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- A menu is published from its insert (20261022100000); there is no draft and
-- no draft -> published update any more. These probes hold what that update
-- used to carry: publish_menu still orders for every weekday rule and plan and
-- for nobody who skipped or left, a one-dish menu still gives those orders its
-- dish, the hourly tick still announces the day once, and a republish still
-- orders nobody twice and revives no cancelled order.
--
-- IT CALLS `private.run_hourly_tick()`, WHICH LOOPS EVERY ACTIVE OFFICE IN THE
-- DATABASE. Do not point this file at production.
--
-- Every refusal is judged by SQLSTATE and sentence, after the role is proved
-- downgraded.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

create function pg_temp.try(p_sql text) returns text
language plpgsql as $fn$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

create function pg_temp.act(p_who text) returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', pg_temp.c(p_who)), true);
end $fn$;

-- publish_menu as whoever is acting, answering 'standing_orders was_update'
-- or the refusal. p_dishes is a JSON list as the Menu screen sends it.
create function pg_temp.publish(p_day text, p_dishes jsonb) returns text
language plpgsql as $fn$
declare r record;
begin
  select * into r from public.publish_menu(
    pg_temp.c('org_a')::bigint, pg_temp.c(p_day)::date,
    (pg_temp.c(p_day)::date - 1)::timestamp at time zone 'Asia/Ho_Chi_Minh' + interval '21 hours',
    p_dishes, 'materialize_on_publish.sql', '{}'::jsonb);
  return r.standing_orders || ' ' || r.was_update;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

-- Everybody's order on a day, as `CODE source status dish[*]`, `*` marking the
-- system's line. Read with the role reset.
create function pg_temp.orders_on(p_org text, p_day text) returns text
language sql stable as $fn$
  select coalesce(string_agg(
           m.short_code || ' ' || o.source || ' ' || o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot
                                          || case when oi.auto_assigned then '*' else '' end, ',')
                          from public.order_items oi where oi.order_id = o.id), '-'),
           '; ' order by m.short_code), 'none')
    from public.orders o
    join public.menus mu on mu.id = o.menu_id
    join public.memberships m on m.org_id = o.org_id and m.profile_id = o.profile_id
   where mu.org_id = pg_temp.c(p_org)::bigint and mu.service_date = pg_temp.c(p_day)::date;
$fn$;

-- The day's menu_published rows: the group copy and who got a private one.
create function pg_temp.announced(p_day text) returns text
language sql stable as $fn$
  select count(*) || ': ' || coalesce(string_agg(coalesce(m.short_code, 'group'), ','
                                                 order by coalesce(m.short_code, 'group') collate "C"), '-')
    from public.notification_outbox n
    left join public.memberships m on m.org_id = n.org_id and m.profile_id = n.recipient_profile_id
   where n.org_id = pg_temp.c('org_a')::bigint and n.kind = 'menu_published'
     and n.related_menu_id = (select id from public.menus
                               where org_id = pg_temp.c('org_a')::bigint
                                 and service_date = pg_temp.c(p_day)::date);
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('3a700000-0000-0000-0000-000000000001', 'adm@mat.test',  'Admin An'),
    ('3a700000-0000-0000-0000-000000000002', 'teo@mat.test',  'Teo Van'),
    ('3a700000-0000-0000-0000-000000000003', 'hoa@mat.test',  'Hoa Le'),
    ('3a700000-0000-0000-0000-000000000004', 'nam@mat.test',  'Nam Vu'),
    ('3a700000-0000-0000-0000-000000000005', 'gone@mat.test', 'Gone Ho'),
    ('3a700000-0000-0000-0000-0000000000b1', 'bown@matb.test', 'Be Owner')
  ) as u(id, email, name)
on conflict (id) do nothing;

-- Office A has a group chat, so the group copy of the announcement shows.
insert into public.organizations (slug, name, timezone, short_code, telegram_group_chat_id)
values ('mat-a', 'Materialize A', 'Asia/Ho_Chi_Minh', 'MATA', 990001),
       ('mat-b', 'Materialize B', 'Asia/Ho_Chi_Minh', 'MATB', null);

insert into public.memberships (org_id, profile_id, role, short_code, status)
select o.id, u.pid::uuid, u.role, u.code, u.st from public.organizations o
join (values
  ('mat-a', '3a700000-0000-0000-0000-000000000001', 'owner',  'ADM',  'active'),
  ('mat-a', '3a700000-0000-0000-0000-000000000002', 'member', 'TEO',  'active'),
  ('mat-a', '3a700000-0000-0000-0000-000000000003', 'member', 'HOA',  'active'),
  ('mat-a', '3a700000-0000-0000-0000-000000000004', 'member', 'NAM',  'active'),
  ('mat-a', '3a700000-0000-0000-0000-000000000005', 'member', 'GONE', 'inactive'),
  ('mat-b', '3a700000-0000-0000-0000-0000000000b1', 'owner',  'BOWN', 'active')
) as u(slug, pid, role, code, st) on u.slug = o.slug;

-- ADM, TEO and HOA finished /start; NAM did not.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 990100 + m.id, now() from public.memberships m
 where m.short_code in ('ADM', 'TEO', 'HOA')
   and m.org_id = (select id from public.organizations where slug = 'mat-a');

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'mat-a' union all
select 'org_b', id::text from public.organizations where slug = 'mat-b' union all
select 'adm',  '3a700000-0000-0000-0000-000000000001' union all
select 'teo',  '3a700000-0000-0000-0000-000000000002' union all
select 'hoa',  '3a700000-0000-0000-0000-000000000003' union all
select 'nam',  '3a700000-0000-0000-0000-000000000004' union all
select 'gone', '3a700000-0000-0000-0000-000000000005' union all
select 'bown', '3a700000-0000-0000-0000-0000000000b1';
insert into ctx
select k, (private.today_in('Asia/Ho_Chi_Minh') + n)::text
  from (values ('one', 21), ('two', 22), ('empty', 23), ('direct', 24), ('past', -3)) as d(k, n);

-- TEO, HOA and GONE eat every weekday in A; BOWN every weekday in B. On `one`
-- HOA skips and NAM, who has no rule, plans the day.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c(case when w = 'bown' then 'org_b' else 'org_a' end)::bigint,
       pg_temp.c(w)::uuid, d, true
  from unnest(array['teo', 'hoa', 'gone', 'bown']) as w, generate_series(1, 7) as d;
insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
values (pg_temp.c('org_a')::bigint, pg_temp.c('hoa')::uuid, pg_temp.c('one')::date, 'skip'),
       (pg_temp.c('org_a')::bigint, pg_temp.c('nam')::uuid, pg_temp.c('one')::date, 'force');

------------------------------------------------------------------- controls

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values
    ('P0 control: role downgraded', current_role, 'authenticated'),
    ('P0 control: acting as the owner', (select auth.uid())::text, pg_temp.c('adm'));
end $$;
reset role;
insert into probe values
  ('P0 control: no menu and no order before publishing',
   (select count(*)::text from public.orders o
     where o.org_id in (pg_temp.c('org_a')::bigint, pg_temp.c('org_b')::bigint)), '0');

-------------------------------------------------- P1 a new day, one dish

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('P1 publishing a new day orders for the rule and the plan',
    pg_temp.publish('one', '[{"name": "Com ga", "price_minor": 45000}]'), '2 false');
end $$;
reset role;

insert into probe values
  ('P1 the menu is published, by the admin, now',
   (select status || ' ' || (published_by = pg_temp.c('adm')::uuid) || ' ' || (published_at is not null)
      from public.menus where org_id = pg_temp.c('org_a')::bigint
       and service_date = pg_temp.c('one')::date), 'published true true'),
  ('P1 TEO by rule and NAM by plan, each given the one dish by the system; HOA skipped, GONE left',
   pg_temp.orders_on('org_a', 'one'),
   'NAM standing placed Com ga*; TEO standing placed Com ga*'),
  ('P1 the other office is untouched', pg_temp.orders_on('org_b', 'one'), 'none');

-------------------------------------------------- P2 a new day, two dishes

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('P2 two dishes',
    pg_temp.publish('two', '[{"name": "Com ga", "price_minor": 45000},
                             {"name": "Pho", "price_minor": 50000}]'), '2 false');
end $$;
reset role;
insert into probe values
  ('P2 the rule holders are down with no dish',
   pg_temp.orders_on('org_a', 'two'), 'HOA standing placed -; TEO standing placed -'),
  ('P2 and nobody is asked to choose at publish',
   (select count(*)::text from public.notification_outbox
     where org_id = pg_temp.c('org_a')::bigint and kind = 'dish_choice'), '0');

---------------------------------------------- P3 announced once, by the tick

insert into probe values ('P3 control: nothing announced before the tick',
  pg_temp.announced('one'), '0: -');
select private.run_hourly_tick();
insert into probe values
  ('P3 the tick announces the day to the group and each linked member',
   pg_temp.announced('one'), '4: ADM,HOA,TEO,group'),
  ('P3 and the other day too', pg_temp.announced('two'), '4: ADM,HOA,TEO,group');

-------------------------------------------- P4 a republish is an edit in place

-- TEO says no to `one` after it is out.
do $$ begin
  perform pg_temp.act('teo');
  insert into probe values ('P4 TEO cancels his order',
    pg_temp.try(format($q$update public.orders set status = 'cancelled', cancelled_at = now()
                          where menu_id = %s and profile_id = %L$q$,
      (select id from public.menus where org_id = pg_temp.c('org_a')::bigint
         and service_date = pg_temp.c('one')::date), pg_temp.c('teo'))), 'ok');

  perform pg_temp.act('adm');
  insert into probe values ('P4 republishing the same day orders nobody new',
    pg_temp.publish('one', format('[{"id": %s, "name": "Com ga", "price_minor": 45000}]',
      (select mi.id from public.menu_items mi join public.menus m on m.id = mi.menu_id
        where m.org_id = pg_temp.c('org_a')::bigint and m.service_date = pg_temp.c('one')::date))::jsonb),
    '0 true');
end $$;
reset role;
select private.run_hourly_tick();
insert into probe values
  ('P4 nobody is ordered twice and the cancelled order stays cancelled',
   pg_temp.orders_on('org_a', 'one'),
   'NAM standing placed Com ga*; TEO standing cancelled Com ga*'),
  ('P4 and a second tick announces nothing again', pg_temp.announced('one'), '4: ADM,HOA,TEO,group');

---------------------------------------------- P5 a past day, and an empty one

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('P5 a past day is published with no standing orders',
    pg_temp.publish('past', '[{"name": "Com ga", "price_minor": 45000}]'), '0 false');
  insert into probe values ('P5 a new day with no dishes is refused',
    pg_temp.publish('empty', '[]'), '55000 cannot publish a menu with no dishes');
end $$;
reset role;
insert into probe values
  ('P5 nobody is on the past day', pg_temp.orders_on('org_a', 'past'), 'none'),
  ('P5 the empty day has no menu',
   (select count(*)::text from public.menus where org_id = pg_temp.c('org_a')::bigint
     and service_date = pg_temp.c('empty')::date), '0');

--------------------------------------------- P6 there is no other way to begin

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('P6 an admin''s insert straight to the table is published too',
    pg_temp.try(format($q$insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
                          values (%s, %L::date, now() + interval '10 days', %L::uuid)$q$,
      pg_temp.c('org_a'), pg_temp.c('direct'), pg_temp.c('adm'))), 'ok');
  insert into probe values ('P6 nor can a day begin locked',
    pg_temp.try(format($q$insert into public.menus (org_id, service_date, order_cutoff_at, created_by, status)
                          values (%s, %L::date, now() + interval '10 days', %L::uuid, 'locked')$q$,
      pg_temp.c('org_a'), pg_temp.c('empty'), pg_temp.c('adm'))),
    '55000 a menu starts out published; locked is not where a day begins');
  insert into probe values ('P6 or cancelled',
    pg_temp.try(format($q$insert into public.menus (org_id, service_date, order_cutoff_at, created_by, status)
                          values (%s, %L::date, now() + interval '10 days', %L::uuid, 'cancelled')$q$,
      pg_temp.c('org_a'), pg_temp.c('empty'), pg_temp.c('adm'))),
    '55000 a menu starts out published; cancelled is not where a day begins');
  insert into probe values ('P6 and a published day does not go back to draft',
    pg_temp.try(format($q$update public.menus set status = 'draft' where org_id = %s and service_date = %L::date$q$,
      pg_temp.c('org_a'), pg_temp.c('two'))),
    '55000 illegal menu status transition published -> draft');
end $$;
reset role;
insert into probe values
  ('P6 the direct insert ordered for the rules, as a publish does',
   pg_temp.orders_on('org_a', 'direct'),
   'HOA standing placed -; TEO standing placed -'),
  ('P6 and draft is not a status at all, even for the service role',
   pg_temp.try(format($q$insert into public.menus (org_id, service_date, order_cutoff_at, created_by, status)
                         values (%s, %L::date, now() + interval '10 days', %L::uuid, 'draft')$q$,
     pg_temp.c('org_a'), pg_temp.c('empty'), pg_temp.c('adm'))),
   '23514 new row for relation "menus" violates check constraint "menus_status_check"');

------------------------------------------------- P7 every member reads every menu

do $$ begin
  perform pg_temp.act('teo');
  insert into probe values
    ('P7 a member reads every menu of the office, and its dishes',
     (select count(*)::text from public.menus) || ' '
       || (select count(*)::text from public.menu_items), '4 4'),
    ('P7 and none of another office''s',
     (select count(*)::text from public.menus where org_id = pg_temp.c('org_b')::bigint), '0');
end $$;
reset role;

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
