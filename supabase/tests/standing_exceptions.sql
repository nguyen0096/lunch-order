-- Skipping a standing day and planning a day off the rule, from the Board.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/standing_exceptions.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- The traps from supabase/tests/isolation.sql apply. A refusal is judged by
-- SQLSTATE and message rather than by having raised, and every block that
-- downgrades the role first proves it did.
--
-- pg_temp.attempt runs one statement as whoever is current and answers
-- 'ok <rows>' or '<sqlstate> <message>'.

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

create function pg_temp.set_exc(p_org text, p_day text, p_action text) returns text
language sql as $fn$
  select pg_temp.attempt(format(
    'select public.set_standing_exception(%s, %L::date, %L)',
    pg_temp.c(p_org), pg_temp.c(p_day), p_action));
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('5c1d0000-0000-0000-0000-000000000001', 'adm@skip.test',  'Quan Ly'),
    ('5c1d0000-0000-0000-0000-000000000002', 'dinh@skip.test', 'Dinh Thi'),
    ('5c1d0000-0000-0000-0000-000000000003', 'teo@skip.test',  'Teo Van'),
    ('5c1d0000-0000-0000-0000-000000000004', 'bown@skip.test', 'Be Owner')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code)
values ('skip-a', 'Skip A', 'SKPA'), ('skip-b', 'Skip B', 'SKPB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('skip-a', '5c1d0000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('skip-a', '5c1d0000-0000-0000-0000-000000000002', 'member', 'DINH'),
  ('skip-a', '5c1d0000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('skip-b', '5c1d0000-0000-0000-0000-000000000004', 'owner',  'BOWN')
) as u(slug, pid, role, code) on u.slug = o.slug;

-- Days far enough ahead that no cutoff has passed. `rule` is a weekday DINH
-- and TEO both eat on; `off` is the day after it, which neither rule covers.
insert into ctx
select 'org_a', id::text from public.organizations where slug = 'skip-a' union all
select 'org_b', id::text from public.organizations where slug = 'skip-b' union all
select 'adm',  '5c1d0000-0000-0000-0000-000000000001' union all
select 'dinh', '5c1d0000-0000-0000-0000-000000000002' union all
select 'teo',  '5c1d0000-0000-0000-0000-000000000003' union all
select 'bown', '5c1d0000-0000-0000-0000-000000000004';

insert into ctx
select k, (private.today_in(o.timezone) + n)::text
  from public.organizations o
  cross join (values ('rule', 14), ('off', 15), ('undo', 21), ('draft', 28),
                     ('kept', 35), ('order', 42), ('today', 0), ('yesterday', -1),
                     ('far', 3650)) as d(k, n)
 where o.slug = 'skip-a';

insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c('org_a')::bigint, p.pid::uuid, extract(isodow from pg_temp.c(d.k)::date)::int, true
  from (values ('dinh'), ('teo')) as p0(who)
  cross join lateral (select pg_temp.c(p0.who) as pid) p
  cross join (values ('rule'), ('undo'), ('kept'), ('order')) as d(k)
on conflict (org_id, profile_id, weekday) do nothing;

-- A menu for the day, with one dish, published by the office's owner. The
-- same sequence the Menu screen performs: insert a draft, add a dish, flip it.
create function pg_temp.publish(p_day text) returns bigint
language plpgsql as $fn$
declare v_menu bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c(p_day)::date,
          (pg_temp.c(p_day)::date - 1)::timestamp at time zone 'Asia/Ho_Chi_Minh',
          pg_temp.c('adm')::uuid)
  on conflict (org_id, service_date) do nothing
  returning id into v_menu;
  if v_menu is null then
    select id into v_menu from public.menus
     where org_id = pg_temp.c('org_a')::bigint and service_date = pg_temp.c(p_day)::date;
  else
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu, pg_temp.c('org_a')::bigint, 'Com ga', 45000, 0);
  end if;
  update public.menus set status = 'published' where id = v_menu;
  return v_menu;
end $fn$;

create function pg_temp.orders_on(p_day text, p_who text) returns text
language sql stable as $fn$
  select count(*)::text from public.orders
   where org_id = pg_temp.c('org_a')::bigint and service_date = pg_temp.c(p_day)::date
     and profile_id = pg_temp.c(p_who)::uuid and status = 'placed';
$fn$;

create function pg_temp.exc(p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((select action from public.standing_order_exceptions
                    where org_id = pg_temp.c('org_a')::bigint
                      and service_date = pg_temp.c(p_day)::date
                      and profile_id = pg_temp.c(p_who)::uuid), 'none');
$fn$;

------------------------------------------------------- S1 skip, then publish

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('S0 the role really was downgraded', current_user::text, 'authenticated');

  insert into probe values ('S1 a member skips a standing day with no menu yet',
    pg_temp.set_exc('org_a', 'rule', 'skip'), 'ok 1');
  insert into probe values ('S1 and plans a day off the rule',
    pg_temp.set_exc('org_a', 'off', 'force'), 'ok 1');
  insert into probe values ('S1 and plans years ahead, because there is no horizon',
    pg_temp.set_exc('org_a', 'far', 'force'), 'ok 1');

  perform pg_temp.act_as(pg_temp.c('adm'));
  perform pg_temp.publish('rule');
  perform pg_temp.publish('off');
  reset role;
end $$;

insert into probe values
  ('S1 the skip is stored as a skip', pg_temp.exc('rule', 'dinh'), 'skip'),
  ('S1 publishing a skipped day creates no order for the one who skipped',
   pg_temp.orders_on('rule', 'dinh'), '0'),
  ('S1 and still creates one for a colleague on the same rule',
   pg_temp.orders_on('rule', 'teo'), '1'),
  ('S2 publishing a planned day creates an order off the rule',
   pg_temp.orders_on('off', 'dinh'), '1'),
  ('S2 which is a standing order',
   (select source from public.orders
     where service_date = pg_temp.c('off')::date and profile_id = pg_temp.c('dinh')::uuid),
   'standing'),
  ('S2 with no dish chosen',
   (select count(*)::text from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.service_date = pg_temp.c('off')::date and o.profile_id = pg_temp.c('dinh')::uuid),
   '0'),
  ('S2 and nobody else is put on the planned day',
   pg_temp.orders_on('off', 'teo'), '0');

------------------------------------------------------------------ S3 undo

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('S3 skip', pg_temp.set_exc('org_a', 'undo', 'skip'), 'ok 1');
  insert into probe values ('S3 undo is a null', pg_temp.set_exc('org_a', 'undo', null), 'ok 1');
  insert into probe values ('S3 undoing what is not there is not an error',
    pg_temp.set_exc('org_a', 'undo', null), 'ok 1');
  insert into probe values ('S3 skip then plan replaces rather than adds',
    pg_temp.set_exc('org_a', 'kept', 'force') || ' / ' || pg_temp.set_exc('org_a', 'kept', 'skip'),
    'ok 1 / ok 1');
  perform pg_temp.act_as(pg_temp.c('adm'));
  perform pg_temp.publish('undo');
  reset role;
end $$;

insert into probe values
  ('S3 an undone skip leaves no row', pg_temp.exc('undo', 'dinh'), 'none'),
  ('S3 and the rule puts them back on when the menu comes',
   pg_temp.orders_on('undo', 'dinh'), '1'),
  ('S3 a replaced exception is the later one', pg_temp.exc('kept', 'dinh'), 'skip'),
  ('S3 one row per day',
   (select count(*)::text from public.standing_order_exceptions
     where profile_id = pg_temp.c('dinh')::uuid and service_date = pg_temp.c('kept')::date),
   '1');

------------------------------------------- S4 nobody else's, no other office

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));

  insert into probe values ('S4 the table takes no direct write, even for your own row',
    left(pg_temp.attempt(format(
      $q$insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
         values (%s, %L, %L, 'skip')$q$,
      pg_temp.c('org_a'), pg_temp.c('dinh'), pg_temp.c('draft'))), 5),
    '42501');
  insert into probe values ('S4 nor for a colleague''s',
    left(pg_temp.attempt(format(
      $q$insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
         values (%s, %L, %L, 'skip')$q$,
      pg_temp.c('org_a'), pg_temp.c('teo'), pg_temp.c('draft'))), 5),
    '42501');
  insert into probe values ('S4 nor deletes one',
    left(pg_temp.attempt(format(
      $q$delete from public.standing_order_exceptions where profile_id = %L$q$,
      pg_temp.c('dinh'))), 5),
    '42501');
  insert into probe values ('S4 your own are still readable',
    pg_temp.attempt(format(
      $q$select 1 from public.standing_order_exceptions where profile_id = %L$q$,
      pg_temp.c('dinh'))),
    'ok 4');

  insert into probe values ('S4 an office you are not in is refused',
    pg_temp.set_exc('org_b', 'draft', 'skip'),
    '42501 you are not a member of that office');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('S4 an owner cannot write a member''s row through the table either',
    left(pg_temp.attempt(format(
      $q$insert into public.standing_order_exceptions (org_id, profile_id, service_date, action)
         values (%s, %L, %L, 'skip')$q$,
      pg_temp.c('org_a'), pg_temp.c('dinh'), pg_temp.c('draft'))), 5),
    '42501');

  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('S4 the other office''s owner writes their own row, in their own office',
    pg_temp.set_exc('org_b', 'draft', 'force'), 'ok 1');
  reset role;
end $$;

insert into probe values
  ('S4 that row is theirs and in their office',
   (select string_agg(o.slug || ' ' || m.short_code, ',')
      from public.standing_order_exceptions e
      join public.organizations o on o.id = e.org_id
      join public.memberships m on m.org_id = e.org_id and m.profile_id = e.profile_id
     where e.service_date = pg_temp.c('draft')::date),
   'skip-b BOWN'),
  ('S4 anon cannot call it at all',
   has_function_privilege('anon', 'public.set_standing_exception(bigint, date, text)', 'execute')::text,
   'false');

------------------------------------------------ S5 days that are not for this

-- An order on a day whose menu went back to draft cannot happen through the
-- app, since un-publishing is refused once orders exist, so it is built with
-- triggers off. It is the check behind the menu check.
do $$
declare v_menu bigint;
begin
  v_menu := pg_temp.publish('order');
  set local session_replication_role = replica;
  update public.menus set status = 'draft', published_at = null where id = v_menu;
  set local session_replication_role = origin;
end $$;

do $$
declare v_menu bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('draft')::date,
          (pg_temp.c('draft')::date - 1)::timestamp at time zone 'Asia/Ho_Chi_Minh',
          pg_temp.c('adm')::uuid)
  returning id into v_menu;

  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));

  insert into probe values ('S5 today is refused',
    pg_temp.set_exc('org_a', 'today', 'skip'),
    '55000 ' || to_char(pg_temp.c('today')::date, 'DD/MM')
      || ' is today or already past, so it can no longer be planned ahead');
  insert into probe values ('S5 a past day is refused',
    left(pg_temp.set_exc('org_a', 'yesterday', null), 5), '55000');
  insert into probe values ('S5 a day whose menu is out is refused, skip or undo alike',
    pg_temp.set_exc('org_a', 'rule', null),
    '55000 the menu for ' || to_char(pg_temp.c('rule')::date, 'DD/MM')
      || ' is already out, so order or cancel that day instead');
  insert into probe values ('S5 a day with an order of yours is refused',
    pg_temp.set_exc('org_a', 'order', 'skip'),
    '55000 you already have an order on ' || to_char(pg_temp.c('order')::date, 'DD/MM')
      || ', so change that instead');
  insert into probe values ('S5 a draft menu is not out yet, so the day is still yours to skip',
    pg_temp.set_exc('org_a', 'draft', 'skip'), 'ok 1');
  insert into probe values ('S5 an action that is neither is refused',
    left(pg_temp.set_exc('org_a', 'draft', 'maybe'), 5), '22023');
  insert into probe values ('S5 no date at all is refused',
    pg_temp.attempt(format('select public.set_standing_exception(%s, null, %L)',
      pg_temp.c('org_a'), 'skip')), '22023 A date is needed.');

  perform pg_temp.act_as(pg_temp.c('adm'));
  update public.menus set status = 'cancelled' where id = v_menu;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('S5 a cancelled day is refused',
    left(pg_temp.set_exc('org_a', 'draft', null), 5), '55000');
  reset role;
end $$;

insert into probe values
  ('S5 the refused skip on the day with an order wrote nothing',
   pg_temp.exc('order', 'dinh'), 'none');

----------------------------------------------- S6 the rule changes, they stay

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  update public.standing_orders set is_enabled = false
   where profile_id = pg_temp.c('dinh')::uuid
     and weekday = extract(isodow from pg_temp.c('kept')::date)::int;
  delete from public.standing_orders
   where profile_id = pg_temp.c('dinh')::uuid
     and weekday = extract(isodow from pg_temp.c('far')::date)::int;
  insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('dinh')::uuid,
          extract(isodow from pg_temp.c('far')::date)::int, true);
  reset role;
end $$;

insert into probe values
  ('S6 a skip outlives its weekday being dropped', pg_temp.exc('kept', 'dinh'), 'skip'),
  ('S6 a plan outlives its weekday being added to the rule', pg_temp.exc('far', 'dinh'), 'force');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
