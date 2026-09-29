-- The writes that are one transaction: set_my_order, publish_menu and
-- apply_caterer_prices, and the materialize sweep that stays in its office.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/atomic_writes.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- Each function runs as the definer, and every guard trigger exempts that, so
-- what is tested here is that each one refuses for itself what the triggers
-- would have refused, in the same words, and that a refusal part way leaves
-- nothing written. A refusal is judged by SQLSTATE and message, and the state
-- it should have left alone is read back afterwards.
--
-- pg_temp.attempt runs one statement as whoever is current and answers
-- 'ok <rows>' or '<sqlstate> <message>'.

begin;

create extension if not exists pgrowlocks with schema extensions;

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

create function pg_temp.dm(p_key text) returns text
language sql stable as $fn$ select to_char(pg_temp.c(p_key)::date, 'DD/MM') $fn$;

create function pg_temp.order_for(p_menu text, p_item text, p_note text default null)
returns text
language sql as $fn$
  select pg_temp.attempt(format('select * from public.set_my_order(%s, %s, %L)',
    pg_temp.c(p_menu), coalesce(pg_temp.c(p_item), 'null'), p_note));
$fn$;

-- One order as the reader of the record sees it: source, status, and its lines
-- as `name@unit_price`, or '-' for none.
create function pg_temp.order_of(p_menu text, p_who text) returns text
language sql stable as $fn$
  select coalesce((
    select o.source || ' ' || o.status || ' '
           || coalesce((select string_agg(oi.item_name_snapshot || '@'
                                          || coalesce(oi.unit_price_minor::text, 'null'), ',')
                          from public.order_items oi where oi.order_id = o.id), '-')
      from public.orders o
     where o.menu_id = pg_temp.c(p_menu)::bigint and o.profile_id = pg_temp.c(p_who)::uuid),
    'none');
$fn$;

create function pg_temp.line_id(p_menu text, p_who text) returns text
language sql stable as $fn$
  select string_agg(oi.id::text, ',')
    from public.order_items oi
   where oi.menu_id = pg_temp.c(p_menu)::bigint and oi.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.dishes_of(p_menu text) returns text
language sql stable as $fn$
  select coalesce(string_agg(mi.position || ':' || mi.name || '@'
                             || coalesce(mi.price_minor::text, 'null'), ',' order by mi.position), '-')
    from public.menu_items mi where mi.menu_id = pg_temp.c(p_menu)::bigint;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('a70a0000-0000-0000-0000-000000000001', 'adm@atom.test',  'Quan Ly'),
    ('a70a0000-0000-0000-0000-000000000002', 'dinh@atom.test', 'Dinh Thi'),
    ('a70a0000-0000-0000-0000-000000000003', 'teo@atom.test',  'Teo Van'),
    ('a70a0000-0000-0000-0000-000000000004', 'bown@atom.test', 'Be Owner')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code)
values ('atom-a', 'Atom A', 'ATMA'), ('atom-b', 'Atom B', 'ATMB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('atom-a', 'a70a0000-0000-0000-0000-000000000001', 'owner',  'ADM'),
  ('atom-a', 'a70a0000-0000-0000-0000-000000000002', 'member', 'DINH'),
  ('atom-a', 'a70a0000-0000-0000-0000-000000000003', 'member', 'TEO'),
  ('atom-b', 'a70a0000-0000-0000-0000-000000000004', 'owner',  'BOWN')
) as u(slug, pid, role, code) on u.slug = o.slug;

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'atom-a' union all
select 'org_b', id::text from public.organizations where slug = 'atom-b' union all
select 'adm',  'a70a0000-0000-0000-0000-000000000001' union all
select 'dinh', 'a70a0000-0000-0000-0000-000000000002' union all
select 'teo',  'a70a0000-0000-0000-0000-000000000003' union all
select 'bown', 'a70a0000-0000-0000-0000-000000000004';

-- `settled` is two weeks back, so it is never the current billing week.
-- `sweep` and `sweep_off` are a weekday apart, and no other day here shares
-- sweep's weekday with an open menu.
insert into ctx
select k, (private.today_in(o.timezone) + n)::text
  from public.organizations o
  cross join (values ('open', 14), ('late', 15), ('drafty', 16), ('called', 17),
                     ('locked', 18), ('fresh', 21), ('empty', 23), ('twice', 24),
                     ('sweep', 29), ('sweep_off', 30), ('sweep_draft', 36),
                     ('settled', -14)) as d(k, n)
 where o.slug = 'atom-a';

-- TEO eats on open's weekday and on fresh's, which is the same one.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
values (pg_temp.c('org_a')::bigint, pg_temp.c('teo')::uuid,
        extract(isodow from pg_temp.c('open')::date)::int, true);

-- Menus are built as the connection's own role, which every guard exempts.
create function pg_temp.menu(p_org text, p_day text, p_cutoff timestamptz,
                             p_dishes text[], p_prices int[]) returns bigint
language plpgsql as $fn$
declare v_menu bigint; i int;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, p_cutoff, pg_temp.c('adm')::uuid)
  returning id into v_menu;
  for i in 1 .. coalesce(array_length(p_dishes, 1), 0) loop
    insert into public.menu_items (menu_id, org_id, name, price_minor, position)
    values (v_menu, pg_temp.c(p_org)::bigint, p_dishes[i], p_prices[i], i - 1);
    insert into ctx values ('i_' || p_day || '_' || i, currval(pg_get_serial_sequence('public.menu_items', 'id'))::text);
  end loop;
  insert into ctx values ('m_' || p_day, v_menu::text);
  return v_menu;
end $fn$;

do $$
declare
  v_future timestamptz := now() + interval '10 days';
  v_period bigint;
begin
  perform pg_temp.menu('org_a', 'open',   v_future, array['Com ga', 'Pho', 'Het'], array[45000, 50000, 40000]);
  update public.menu_items set is_available = false where id = pg_temp.c('i_open_3')::bigint;
  perform pg_temp.menu('org_a', 'late',   v_future, array['Bun cha'], array[40000]);
  perform pg_temp.menu('org_a', 'drafty', v_future, array['Chao'], array[30000]);
  perform pg_temp.menu('org_a', 'called', v_future, array['Mi'], array[null]::int[]);
  perform pg_temp.menu('org_a', 'locked', v_future, array['Bun bo', 'Banh mi'], array[null, 30000]);
  perform pg_temp.menu('org_a', 'settled', now() - interval '15 days',
                       array['Com tam', 'Xoi'], array[35000, null]);
  perform pg_temp.menu('org_a', 'sweep',       v_future, array['Ga'], array[1000]);
  perform pg_temp.menu('org_a', 'sweep_off',   v_future, array['Ga'], array[1000]);
  perform pg_temp.menu('org_a', 'sweep_draft', v_future, array['Ga'], array[1000]);

  -- Office B's menu on sweep's own date, published and open.
  insert into ctx values ('sweep_b', pg_temp.c('sweep'));
  perform pg_temp.menu('org_b', 'sweep_b', v_future, array['Ga'], array[1000]);

  update public.menus set status = 'published'
   where id in (pg_temp.c('m_open')::bigint, pg_temp.c('m_late')::bigint,
                pg_temp.c('m_called')::bigint, pg_temp.c('m_locked')::bigint,
                pg_temp.c('m_settled')::bigint, pg_temp.c('m_sweep')::bigint,
                pg_temp.c('m_sweep_off')::bigint, pg_temp.c('m_sweep_b')::bigint);

  -- ADM's own record of a closed day, which is the one order off the clock.
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('m_late')::bigint, pg_temp.c('late')::date,
          pg_temp.c('adm')::uuid, 'admin', pg_temp.c('adm')::uuid);
  update public.menus set order_cutoff_at = now() - interval '1 hour'
   where id = pg_temp.c('m_late')::bigint;

  update public.menus set status = 'cancelled' where id = pg_temp.c('m_called')::bigint;

  -- On the locked day: DINH chose, TEO's standing order chose, ADM recorded
  -- one, and the unpriced dish is what two of them had.
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  select pg_temp.c('org_a')::bigint, pg_temp.c('m_locked')::bigint, pg_temp.c('locked')::date,
         pg_temp.c(w)::uuid, s, pg_temp.c(w)::uuid
    from (values ('dinh', 'member'), ('teo', 'standing'), ('adm', 'admin')) as x(w, s);
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
                                  item_name_snapshot, unit_price_minor)
  select o.id, o.org_id, o.profile_id, o.menu_id,
         pg_temp.c(case when o.source = 'admin' then 'i_locked_2' else 'i_locked_1' end)::bigint, '', 0
    from public.orders o where o.menu_id = pg_temp.c('m_locked')::bigint;
  update public.menus set status = 'locked' where id = pg_temp.c('m_locked')::bigint;

  -- A settled week: DINH's member order and ADM's admin one, billed and closed.
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  select pg_temp.c('org_a')::bigint, pg_temp.c('m_settled')::bigint, pg_temp.c('settled')::date,
         pg_temp.c(w)::uuid, s, pg_temp.c(w)::uuid
    from (values ('dinh', 'member'), ('adm', 'admin')) as x(w, s);
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id,
                                  item_name_snapshot, unit_price_minor)
  select o.id, o.org_id, o.profile_id, o.menu_id, pg_temp.c('i_settled_1')::bigint, '', 0
    from public.orders o where o.menu_id = pg_temp.c('m_settled')::bigint;
  update public.menus set status = 'locked' where id = pg_temp.c('m_settled')::bigint;
  v_period := public.ensure_billing_period(pg_temp.c('org_a')::bigint, pg_temp.c('settled')::date);
  perform public.run_billing(v_period);
  update public.billing_periods set status = 'closed', closed_at = now() where id = v_period;
  insert into ctx values ('p_settled', v_period::text);
end $$;

insert into probe values
  ('control: the settled week is closed',
   (select status from public.billing_periods where id = pg_temp.c('p_settled')::bigint), 'closed'),
  ('control: the locked day is locked',
   (select status from public.menus where id = pg_temp.c('m_locked')::bigint), 'locked'),
  ('control: the late day is published with its cutoff passed',
   (select status || ' ' || (order_cutoff_at < now())::text from public.menus
     where id = pg_temp.c('m_late')::bigint), 'published true'),
  ('control: publishing open put TEO on it by his rule',
   pg_temp.order_of('m_open', 'teo'), 'standing placed -');

---------------------------------------------------------- M set_my_order

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('M0 the role really was downgraded', current_user::text, 'authenticated');

  insert into probe values ('M1 a member chooses a dish',
    pg_temp.order_for('m_open', 'i_open_1'), 'ok 1');
  reset role;
end $$;

insert into ctx values ('line_m1', pg_temp.line_id('m_open', 'dinh')),
                       ('order_m1', (select id::text from public.orders
                                      where menu_id = pg_temp.c('m_open')::bigint
                                        and profile_id = pg_temp.c('dinh')::uuid));
insert into probe values
  ('M1 as a member order with one line, named and priced by the trigger',
   pg_temp.order_of('m_open', 'dinh'), 'member placed Com ga@45000');

do $$
declare r record;
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  select * into r from public.set_my_order(pg_temp.c('m_open')::bigint,
                                           pg_temp.c('i_open_2')::bigint, '  ít cay  ');
  insert into probe values ('M2 changing the dish answers the same order and the new line',
    format('%s %s %s', r.order_id = pg_temp.c('order_m1')::bigint, r.item_name_snapshot,
           r.line_total_minor),
    't Pho 50000');
  reset role;
end $$;

insert into ctx values ('line_m2', pg_temp.line_id('m_open', 'dinh'));
insert into probe values
  ('M2 the dish line is replaced, not edited: one line, a new row',
   (select count(*)::text || ' ' || (pg_temp.c('line_m2') <> pg_temp.c('line_m1'))::text
      from public.order_items where order_id = pg_temp.c('order_m1')::bigint),
   '1 true'),
  ('M2 and the order is still the member''s', pg_temp.order_of('m_open', 'dinh'), 'member placed Pho@50000'),
  ('M2 the note is kept trimmed',
   (select note from public.order_items where id = pg_temp.c('line_m2')::bigint), 'ít cay');

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));

  insert into probe values ('M3 a dish from another menu is refused by the snapshot trigger',
    pg_temp.order_for('m_open', 'i_sweep_b_1'),
    '23503 dish ' || pg_temp.c('i_sweep_b_1') || ' is not on this menu');
  insert into probe values ('M3 a dish that is off today is refused',
    pg_temp.order_for('m_open', 'i_open_3'), '55000 "Het" is not available today');

  -- TEO has a standing order with no dish yet, and nothing of his own.
  perform pg_temp.act_as(pg_temp.c('teo'));
  insert into probe values ('M4 a standing order takes a dish',
    pg_temp.order_for('m_open', 'i_open_1'), 'ok 1');

  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('M5 another office''s owner is refused',
    pg_temp.order_for('m_open', 'i_open_1'), '42501 you are not a member of that office');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('M6 a menu past its cutoff is refused, in the trigger''s words',
    pg_temp.order_for('m_late', 'i_late_1'),
    '55000 ordering for ' || pg_temp.dm('late') || ' closed at '
      || (select to_char(order_cutoff_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
            from public.menus where id = pg_temp.c('m_late')::bigint));
  insert into probe values ('M7 a draft is refused',
    pg_temp.order_for('m_drafty', 'i_drafty_1'),
    '55000 the menu for ' || pg_temp.dm('drafty') || ' is draft, not open for ordering');
  insert into probe values ('M8 a cancelled day is refused',
    pg_temp.order_for('m_called', 'i_called_1'),
    '55000 the menu for ' || pg_temp.dm('called') || ' was cancelled');
  insert into probe values ('M10 a settled week is refused',
    pg_temp.order_for('m_settled', 'i_settled_1'),
    '55000 lunch on ' || pg_temp.dm('settled')
      || ' is on a week that has been settled, so the record can no longer be changed');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('M9 an admin''s own admin order is off the clock',
    pg_temp.order_for('m_late', 'i_late_1'), 'ok 1');
  insert into probe values ('M10 but not off the settled week',
    pg_temp.order_for('m_settled', 'i_settled_1'),
    '55000 lunch on ' || pg_temp.dm('settled')
      || ' is on a week that has been settled, so the record can no longer be changed');
  insert into probe values ('M9 and an admin''s member order is on the clock like anyone''s',
    pg_temp.order_for('m_drafty', 'i_drafty_1'),
    '55000 the menu for ' || pg_temp.dm('drafty') || ' is draft, not open for ordering');
  reset role;
end $$;

insert into probe values
  ('M3 the refusals left the line as it was',
   pg_temp.line_id('m_open', 'dinh') || ' ' || pg_temp.order_of('m_open', 'dinh'),
   pg_temp.c('line_m2') || ' member placed Pho@50000'),
  ('M4 and it stays a standing order', pg_temp.order_of('m_open', 'teo'), 'standing placed Com ga@45000'),
  ('M5 the refusal wrote no order', pg_temp.order_of('m_open', 'bown'), 'none'),
  ('M6 a refused new order leaves no order row behind', pg_temp.order_of('m_late', 'dinh'), 'none'),
  ('M9 the admin order took the dish', pg_temp.order_of('m_late', 'adm'), 'admin placed Bun cha@40000'),
  ('M10 the settled lines are untouched',
   pg_temp.order_of('m_settled', 'dinh') || ' / ' || pg_temp.order_of('m_settled', 'adm'),
   'member placed Com tam@35000 / admin placed Com tam@35000');

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  update public.orders set status = 'cancelled', cancelled_at = now()
   where id = pg_temp.c('order_m1')::bigint;
  insert into probe values ('M11 a cancelled order is taken back up by choosing again',
    pg_temp.order_for('m_open', 'i_open_1', ''), 'ok 1');
  reset role;
end $$;

insert into probe values
  ('M11 the same order, placed again, with the new dish',
   (select (id = pg_temp.c('order_m1')::bigint)::text || ' ' || status || ' '
           || coalesce(cancelled_at::text, 'null')
      from public.orders where id = pg_temp.c('order_m1')::bigint),
   'true placed null'),
  ('M11 an emptied note arrives as none',
   (select coalesce(note, 'null') from public.order_items where order_id = pg_temp.c('order_m1')::bigint),
   'null');

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('M12 no dish clears the line and keeps the order',
    pg_temp.order_for('m_open', null), 'ok 1');
  reset role;
end $$;

insert into probe values
  ('M12 placed with no line', pg_temp.order_of('m_open', 'dinh'), 'member placed -'),
  ('M13 anon cannot call it',
   has_function_privilege('anon', 'public.set_my_order(bigint, bigint, text)', 'execute')::text, 'false'),
  ('M13 a signed-in member can',
   has_function_privilege('authenticated', 'public.set_my_order(bigint, bigint, text)', 'execute')::text, 'true');

---------------------------------------------------------- P publish_menu

create function pg_temp.publish(p_org text, p_day text, p_dishes jsonb) returns text
language sql as $fn$
  select pg_temp.attempt(format(
    'select * from public.publish_menu(%s, %L::date, %L::timestamptz, %L::jsonb, %L, %L::jsonb)',
    pg_temp.c(p_org), pg_temp.c(p_day), now() + interval '9 days', p_dishes, 'raw ' || p_day,
    '{"readBy":"test"}'));
$fn$;

do $$
declare r record;
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));

  select * into r from public.publish_menu(
    pg_temp.c('org_a')::bigint, pg_temp.c('fresh')::date, now() + interval '9 days',
    '[{"id": null, "name": "Ga", "price_minor": 45000}, {"name": "Ca", "price_minor": null}]',
    'raw fresh', '{"readBy":"test"}');
  insert into ctx values ('m_fresh', r.menu_id::text);
  insert into probe values ('P1 a new day answers the standing orders it made, as a first publish',
    format('%s %s', r.standing_orders, r.was_update), '1 f');
  reset role;
end $$;

insert into ctx select 'i_fresh_ga', id::text from public.menu_items
                 where menu_id = pg_temp.c('m_fresh')::bigint and name = 'Ga';
insert into probe values
  ('P1 published, with its dishes in order and the unpriced one unpriced',
   (select status from public.menus where id = pg_temp.c('m_fresh')::bigint)
     || ' ' || pg_temp.dishes_of('m_fresh'),
   'published 0:Ga@45000,1:Ca@null'),
  ('P1 the evidence is kept beside it',
   (select source_text || ' ' || (parse_meta ->> 'readBy') || ' ' || (published_by = pg_temp.c('adm')::uuid)::text
      from public.menus where id = pg_temp.c('m_fresh')::bigint),
   'raw fresh test true'),
  ('P1 TEO is on it by his rule', pg_temp.order_of('m_fresh', 'teo'), 'standing placed -');

do $$
declare r record;
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  select * into r from public.publish_menu(
    pg_temp.c('org_a')::bigint, pg_temp.c('fresh')::date, now() + interval '8 days',
    jsonb_build_array(jsonb_build_object('name', 'Tom', 'price_minor', 60000),
                      jsonb_build_object('id', pg_temp.c('i_fresh_ga')::bigint,
                                         'name', 'Ga nuong', 'price_minor', 47000)),
    'raw fresh 2', '{}');
  insert into probe values ('P2 a republish is an update that orders nobody new',
    format('%s %s %s', r.menu_id = pg_temp.c('m_fresh')::bigint, r.standing_orders, r.was_update),
    't 0 t');

  -- DINH chooses Tom, so Tom can no longer be removed.
  perform pg_temp.act_as(pg_temp.c('dinh'));
  perform pg_temp.order_for('m_fresh', 'i_fresh_ga');
  perform * from public.set_my_order(pg_temp.c('m_fresh')::bigint,
    (select id from public.menu_items where menu_id = pg_temp.c('m_fresh')::bigint and name = 'Tom'), null);

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('P3 removing a dish somebody chose is refused by its foreign key',
    left(pg_temp.attempt(format(
      'select * from public.publish_menu(%s, %L::date, now() + interval ''2 days'', %L::jsonb, %L, %L::jsonb)',
      pg_temp.c('org_a'), pg_temp.c('fresh'),
      jsonb_build_array(jsonb_build_object('id', pg_temp.c('i_fresh_ga')::bigint,
                                           'name', 'Ga ran', 'price_minor', 1)),
      'raw fresh 3', '{}')), 5),
    '23503');

  insert into probe values ('P4 a new day with no dish is refused by the lifecycle',
    pg_temp.publish('org_a', 'empty', '[]'),
    '55000 cannot publish a menu with no available dishes');
  insert into probe values ('P5 two dishes of one name are refused',
    left(pg_temp.publish('org_a', 'twice',
      '[{"name": "Pho", "price_minor": 1}, {"name": " pho ", "price_minor": 2}]'), 5),
    '23505');
  insert into probe values ('P7 a locked day is refused before anything changes',
    pg_temp.publish('org_a', 'locked', '[{"name": "Bun bo", "price_minor": 1}]'),
    '55000 the menu is locked; dishes can no longer be changed');
  insert into probe values ('P8 so is a cancelled one',
    pg_temp.publish('org_a', 'called', '[{"name": "Mi", "price_minor": 1}]'),
    '55000 the menu is cancelled; dishes can no longer be changed');
  insert into probe values ('P9 not a list is refused',
    pg_temp.publish('org_a', 'empty', '{"name": "Mi"}'),
    '22023 the dishes arrive as a list');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('P6 a member is refused',
    pg_temp.publish('org_a', 'empty', '[{"name": "Mi", "price_minor": 1}]'),
    '42501 only an admin of this office can publish its menu');
  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('P6 another office''s owner is refused',
    pg_temp.publish('org_a', 'empty', '[{"name": "Mi", "price_minor": 1}]'),
    '42501 only an admin of this office can publish its menu');
  reset role;
end $$;

insert into probe values
  ('P2 the kept dish kept its id and took the new name and place; the dropped one is gone',
   pg_temp.dishes_of('m_fresh') || ' '
     || (select (id = pg_temp.c('i_fresh_ga')::bigint)::text from public.menu_items
          where menu_id = pg_temp.c('m_fresh')::bigint and name = 'Ga nuong'),
   '0:Tom@60000,1:Ga nuong@47000 true'),
  ('P3 the refused republish changed nothing: dishes, cutoff and the evidence as they were',
   pg_temp.dishes_of('m_fresh') || ' '
     || (select source_text || ' ' || (order_cutoff_at > now() + interval '7 days')::text
           from public.menus where id = pg_temp.c('m_fresh')::bigint),
   '0:Tom@60000,1:Ga nuong@47000 raw fresh 2 true'),
  ('P4 P5 P6 the refused new days left no menu behind',
   (select count(*)::text from public.menus
     where org_id = pg_temp.c('org_a')::bigint
       and service_date in (pg_temp.c('empty')::date, pg_temp.c('twice')::date)),
   '0'),
  ('P7 the locked day is as it was',
   pg_temp.dishes_of('m_locked') || ' '
     || (select (order_cutoff_at > now() + interval '9 days')::text
           from public.menus where id = pg_temp.c('m_locked')::bigint),
   '0:Bun bo@null,1:Banh mi@30000 true'),
  ('P10 anon cannot call it',
   has_function_privilege('anon',
     'public.publish_menu(bigint, date, timestamptz, jsonb, text, jsonb)', 'execute')::text,
   'false');

-------------------------------------------------- A apply_caterer_prices

create function pg_temp.price(p_prices jsonb) returns text
language plpgsql as $fn$
declare r record;
begin
  select * into r from public.apply_caterer_prices(pg_temp.c('org_a')::bigint, p_prices);
  return format('%s %s %s', r.dishes, r.menu_items, r.order_items);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $fn$;

create function pg_temp.dish(p_key text, p_price int) returns jsonb
language sql stable as $fn$
  select jsonb_build_object('price_minor', p_price,
                            'menu_item_ids', jsonb_build_array(pg_temp.c(p_key)::bigint));
$fn$;

do $$ begin
  set local role authenticated;

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('A1 a member is refused',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_locked_1', 40000))),
    '42501 only an admin of this office can bill a week');
  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('A1 another office''s owner is refused',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_locked_1', 40000))),
    '42501 only an admin of this office can bill a week');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('A2 one dish that may not change refuses the whole list',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_locked_1', 40000),
                                    pg_temp.dish('i_locked_2', 35000))),
    '55000 the menu is locked; dishes can no longer be changed');
  insert into probe values ('A3 a price below zero is refused',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_locked_1', -1))),
    '23514 a price has to be zero or more, and under a billion');
  insert into probe values ('A5 a dish in a settled week is refused',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_settled_2', 20000))),
    '55000 lunch on ' || pg_temp.dm('settled')
      || ' is on a week that has been settled, so the record can no longer be changed');
  insert into probe values ('A6 a dish on a cancelled day is refused',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_called_1', 20000))),
    '55000 the menu is cancelled; dishes can no longer be changed');
  reset role;
end $$;

insert into probe values
  ('A2 A3 nothing was priced: not the dish, not a line',
   pg_temp.dishes_of('m_locked') || ' ' || pg_temp.order_of('m_locked', 'dinh'),
   '0:Bun bo@null,1:Banh mi@30000 member placed Bun bo@null'),
  ('A5 the settled dish is still unpriced',
   (select coalesce(price_minor::text, 'null') from public.menu_items
     where id = pg_temp.c('i_settled_2')::bigint), 'null'),
  ('A6 the cancelled dish is still unpriced',
   (select coalesce(price_minor::text, 'null') from public.menu_items
     where id = pg_temp.c('i_called_1')::bigint), 'null');

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('A4 a missing price on a locked day is filled in, dish and lines',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_locked_1', 40000))), '1 1 2');
  insert into probe values ('A7 an empty list prices nothing', pg_temp.price('[]'), '0 0 0');
  insert into probe values ('A8 another office''s dish is not reached',
    pg_temp.price(jsonb_build_array(pg_temp.dish('i_sweep_b_1', 5))), '1 0 0');
  reset role;
end $$;

insert into probe values
  ('A4 a member''s and a standing order''s lines on the locked day take the price',
   pg_temp.order_of('m_locked', 'dinh') || ' / ' || pg_temp.order_of('m_locked', 'teo'),
   'member placed Bun bo@40000 / standing placed Bun bo@40000'),
  ('A4 the admin''s line on the other dish is left alone',
   pg_temp.order_of('m_locked', 'adm'), 'admin placed Banh mi@30000'),
  ('A8 the other office''s dish kept its price',
   (select price_minor::text from public.menu_items where id = pg_temp.c('i_sweep_b_1')::bigint),
   '1000'),
  ('A9 anon cannot call it',
   has_function_privilege('anon', 'public.apply_caterer_prices(bigint, jsonb)', 'execute')::text,
   'false');

----------------------------------------------- L the sweep stays in its office

-- A rule switched on inside this transaction. pgrowlocks then says which
-- menus the sweep holds FOR NO KEY UPDATE. Publishing them above did that
-- too, and the lock lasts until rollback, so each is first rewritten into a
-- version held by nothing stronger than the foreign keys' FOR KEY SHARE.
update public.menus set source_text = 'swept'
 where id in (pg_temp.c('m_sweep')::bigint, pg_temp.c('m_sweep_off')::bigint,
              pg_temp.c('m_sweep_draft')::bigint, pg_temp.c('m_sweep_b')::bigint);

insert into probe values
  ('L0 control: before the rule, none of the four is held for no key update',
   (select count(*)::text from public.menus m
      join extensions.pgrowlocks('public.menus') l on l.locked_row = m.ctid
     where m.source_text = 'swept'
       and l.modes && array['For No Key Update', 'For Update']),
   '0');

do $$ begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
  values (pg_temp.c('org_a')::bigint, pg_temp.c('dinh')::uuid,
          extract(isodow from pg_temp.c('sweep')::date)::int, true);
  reset role;
end $$;

insert into probe values
  ('L1 the sweep holds its own office''s open and draft menus of that weekday, and nothing else',
   (select string_agg(k, ',' order by k)
      from (values ('m_sweep'), ('m_sweep_off'), ('m_sweep_draft'), ('m_sweep_b')) as x(k)
     where pg_temp.c(k)::bigint in (
             select m.id from public.menus m
             join extensions.pgrowlocks('public.menus') l on l.locked_row = m.ctid
            where l.modes && array['For No Key Update', 'For Update'])),
   'm_sweep,m_sweep_draft'),
  ('L2 and orders on the open one', pg_temp.order_of('m_sweep', 'dinh'), 'standing placed -'),
  ('L2 not on another weekday', pg_temp.order_of('m_sweep_off', 'dinh'), 'none');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
