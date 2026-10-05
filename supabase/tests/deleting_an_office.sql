-- Deleting an office cancels every order it has not served, withdraws its
-- pending passes and sends nothing more for it. Run against a scratch project
-- or branch:
--   psql "$DATABASE_URL" -f supabase/tests/deleting_an_office.sql
--
-- Builds its own fixtures and rolls everything back. Calls the hourly tick and
-- the outbox claim, so never against production.
--
-- A day not yet over is today (before the office's end of day) and later,
-- before or after its cutoff; those orders are cancelled and their weeks
-- re-billed. A past day and a settled week keep theirs. Pending outbox rows
-- are marked failed, and the tick, materializing and the drain's claim skip a
-- deleted office (20261025100200).
--
-- Negative control: with 20261025100200 reverted (the old `delete_office`,
-- `claim_outbox`, `materialize_office`, `run_hourly_tick`,
-- `correction_period`, `join_office_with_code` and `accept_invitation`), D1 to
-- D5 fail.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;
create temp table bal (step text, code text, balance_minor bigint);

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

create function pg_temp.snap(p_step text) returns void
language sql as $fn$
  insert into bal
  select p_step, m.short_code, coalesce(b.balance_minor, 0)::bigint
    from public.memberships m
    left join public.v_account_balance b on b.org_id = m.org_id and b.profile_id = m.profile_id
   where m.org_id in (pg_temp.c('org')::bigint, pg_temp.c('org_b')::bigint);
$fn$;

create function pg_temp.moved(p_a text, p_b text) returns text
language sql stable as $fn$
  select coalesce(string_agg(a.code || ' ' || (b.balance_minor - a.balance_minor), ', ' order by a.code), '-')
    from bal a join bal b on b.code = a.code and b.step = p_b
   where a.step = p_a and a.balance_minor is distinct from b.balance_minor;
$fn$;

create function pg_temp.m(p_org text, p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c(p_org)::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.oid(p_day text, p_who text) returns bigint
language sql stable as $fn$
  select o.id from public.orders o
   where o.menu_id = pg_temp.m('org', p_day) and o.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

-- One person's orders on the days named, as `day:status`.
create function pg_temp.days(p_who text, p_days text[]) returns text
language sql stable as $fn$
  select string_agg(d || ':' || coalesce((
           select o.status from public.orders o
            where o.menu_id = pg_temp.m('org', d) and o.profile_id = pg_temp.c(p_who)::uuid), 'none'),
         ' ' order by n)
    from unnest(p_days) with ordinality as x(d, n);
$fn$;

-- Statements in the office not equal to their lines, and lines on cancelled orders.
create function pg_temp.books() returns text
language sql stable as $fn$
  select (select count(*) from public.billing_statements st
           where st.org_id = pg_temp.c('org')::bigint
             and st.meals_minor <> (select coalesce(sum(bl.amount_minor), 0) from public.billing_lines bl
                                     where bl.billing_period_id = st.billing_period_id
                                       and bl.payer_profile_id = st.profile_id))::text
         || ' off, '
         || (select count(*) from public.billing_lines bl join public.orders o on o.id = bl.order_id
              where o.org_id = pg_temp.c('org')::bigint and o.status <> 'placed')::text
         || ' cancelled billed';
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@deloffice.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1ed00000-0000-0000-0000-000000000001', 'own'),
    ('1ed00000-0000-0000-0000-000000000002', 'adm'),
    ('1ed00000-0000-0000-0000-000000000003', 'mon'),
    ('1ed00000-0000-0000-0000-000000000004', 'mtw'),
    ('1ed00000-0000-0000-0000-000000000005', 'nwc'),
    ('1ed00000-0000-0000-0000-0000000000b1', 'bown')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@deloffice.test';

-- The office's day runs until 23:59:59, so today is not over whenever this runs.
insert into public.organizations (slug, name, timezone, short_code, telegram_group_chat_id,
                                  business_day_starts_at, business_day_ends_at, telegram_join_code)
values ('deloffice-a', 'Del Office A', 'Asia/Ho_Chi_Minh', 'DOA', -1009001, '00:00:00', '23:59:59', 'DQAJXKNA'),
       ('deloffice-b', 'Del Office B', 'Asia/Ho_Chi_Minh', 'DOB', -1009002, '00:00:00', '23:59:59', 'DQBJXKNA');
insert into ctx values
  ('org',   (select id from public.organizations where slug = 'deloffice-a')::text),
  ('org_b', (select id from public.organizations where slug = 'deloffice-b')::text);

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c(case when x = 'bown' then 'org_b' else 'org' end)::bigint, pg_temp.c(x)::uuid,
       case when x in ('own', 'bown') then 'owner' when x = 'adm' then 'admin' else 'member' end,
       upper(x) || 'X'
  from unnest(array['own', 'adm', 'mon', 'mtw', 'bown']) as x;

-- MON eats every day by rule.
insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
select pg_temp.c('org')::bigint, pg_temp.c('mon')::uuid, d, true from generate_series(1, 7) as d;

-- past: three weeks back, settled. yday: yesterday. today. fut: in three
-- weeks, open, and its neighbour lck, locked past its cutoff.
do $$
declare v_t date := private.today_in('Asia/Ho_Chi_Minh');
begin
  insert into ctx values
    ('past', (v_t - 21)::text), ('yday', (v_t - 1)::text), ('today', v_t::text),
    ('fut', (v_t + 21)::text), ('lck', (v_t + 22)::text), ('more', (v_t + 23)::text),
    ('more2', (v_t + 24)::text);
end $$;

create function pg_temp.day(p_org text, p_day text, p_cutoff timestamptz) returns bigint
language plpgsql as $fn$
declare v_menu bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, p_cutoff,
          pg_temp.c(case when p_org = 'org' then 'own' else 'bown' end)::uuid)
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  values (v_menu, pg_temp.c(p_org)::bigint, 'Bun', 40000, 0);
  return v_menu;
end $fn$;

-- An order with Bun, for somebody who has none on the day yet.
create function pg_temp.eat(p_org text, p_day text, p_who text) returns void
language plpgsql as $fn$
declare v_order bigint;
begin
  select id into v_order from public.orders
   where menu_id = pg_temp.m(p_org, p_day) and profile_id = pg_temp.c(p_who)::uuid;
  if v_order is null then
    insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
    values (pg_temp.c(p_org)::bigint, pg_temp.m(p_org, p_day), pg_temp.c(p_day)::date,
            pg_temp.c(p_who)::uuid, 'member', pg_temp.c(p_who)::uuid)
    returning id into v_order;
  end if;
  delete from public.order_items where order_id = v_order;
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
  select v_order, pg_temp.c(p_org)::bigint, pg_temp.c(p_who)::uuid, pg_temp.m(p_org, p_day), mi.id, 1
    from public.menu_items mi where mi.menu_id = pg_temp.m(p_org, p_day);
end $fn$;

select pg_temp.day('org', d, now() - interval '1 hour') from unnest(array['past', 'yday', 'today', 'lck']) as d;
select pg_temp.day('org', 'fut', now() + interval '10 days');
update public.menus set status = 'locked' where id = pg_temp.m('org', 'lck');
select pg_temp.day('org_b', 'fut', now() + interval '10 days');

select pg_temp.eat('org', d, w)
  from unnest(array['past', 'yday', 'today', 'fut', 'lck']) as d, unnest(array['mon', 'mtw']) as w;
select pg_temp.eat('org_b', 'fut', 'bown');

-- MTW offers fut to MON, still waiting; and MON offered yday to MTW.
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
values (pg_temp.c('org')::bigint, pg_temp.oid('fut', 'mtw'), pg_temp.c('mtw')::uuid,
        pg_temp.c('mon')::uuid, pg_temp.c('mtw')::uuid),
       (pg_temp.c('org')::bigint, pg_temp.oid('yday', 'mon'), pg_temp.c('mon')::uuid,
        pg_temp.c('mtw')::uuid, pg_temp.c('mon')::uuid);

insert into ctx
select 'p_' || d, public.ensure_billing_period(pg_temp.c(o)::bigint, pg_temp.c(d)::date)::text
  from (values ('org', 'past'), ('org', 'yday'), ('org', 'today'), ('org', 'fut'), ('org', 'lck'))
       as x(o, d)
on conflict (k) do nothing;
insert into ctx values ('p_b', public.ensure_billing_period(pg_temp.c('org_b')::bigint, pg_temp.c('fut')::date)::text);
select public.run_billing(id) is not null from public.billing_periods
 where org_id in (pg_temp.c('org')::bigint, pg_temp.c('org_b')::bigint);
update public.billing_periods set status = 'closed', closed_at = now() where id = pg_temp.c('p_past')::bigint;

-- A message waiting for each office, one already sent.
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, body, parse_mode)
values (pg_temp.c('org')::bigint, 'deloffice:a:waiting', 'announcement', -1009001, 'waiting', 'none'),
       (pg_temp.c('org')::bigint, 'deloffice:a:sent', 'announcement', -1009001, 'sent', 'none'),
       (pg_temp.c('org_b')::bigint, 'deloffice:b:waiting', 'announcement', -1009002, 'waiting', 'none');
update public.notification_outbox set status = 'sent', sent_at = now() where dedupe_key = 'deloffice:a:sent';

------------------------------------------------------------------- controls

select pg_temp.snap('k0');
insert into probe values
  ('K0 control: by date the stages are done, done, closed, open, locked',
   (select string_agg(private.day_stage(m.org_id, m.service_date, m.status, m.order_cutoff_at), ', '
                      order by m.service_date)
      from public.menus m where m.org_id = pg_temp.c('org')::bigint),
   'done, done, closed, open, locked'),
  ('K0 control: everybody eats every day',
   pg_temp.days('mon', array['past', 'yday', 'today', 'lck', 'fut']) || ' / '
   || pg_temp.days('mtw', array['past', 'yday', 'today', 'lck', 'fut']),
   'past:placed yday:placed today:placed lck:placed fut:placed / '
   || 'past:placed yday:placed today:placed lck:placed fut:placed'),
  ('K0 control: MON and MTW each owe for five days, the settled one included',
   (select string_agg(code || ' ' || balance_minor, ', ' order by code) from bal
     where step = 'k0' and code in ('MONX', 'MTWX')), 'MONX 200000, MTWX 200000'),
  ('K0 control: two offers wait', (select count(*)::text from public.meal_transfers
     where org_id = pg_temp.c('org')::bigint and status = 'pending'), '2'),
  ('K0 control: the books add up', pg_temp.books(), '0 off, 0 cancelled billed');

-------------------------------------------------------- D0 only the owner

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('D0 an admin cannot delete the office',
    pg_temp.try(format('select public.delete_office(%s)', pg_temp.c('org'))),
    '42501 only an owner can delete an office');
  perform pg_temp.act('bown');
  insert into probe values ('D0 nor the owner of another office',
    pg_temp.try(format('select public.delete_office(%s)', pg_temp.c('org'))),
    '42501 only an owner can delete an office');
end $$;
reset role;
select pg_temp.snap('d0');
insert into probe values
  ('D0 the refusals changed nothing',
   pg_temp.days('mon', array['today', 'fut']) || ' / ' || pg_temp.moved('k0', 'd0') || ' / '
   || (select coalesce(deleted_at::text, 'live') from public.organizations where id = pg_temp.c('org')::bigint),
   'today:placed fut:placed / - / live');

--------------------------------------------------- D1 the owner deletes it

do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('D1 the owner deletes the office',
    pg_temp.try(format('select public.delete_office(%s)', pg_temp.c('org'))), 'ok');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.snap('d1');
insert into probe values
  ('D1 today and later are cancelled, before and after the cutoff; past days stay',
   pg_temp.days('mon', array['past', 'yday', 'today', 'lck', 'fut']) || ' / '
   || pg_temp.days('mtw', array['past', 'yday', 'today', 'lck', 'fut']),
   'past:placed yday:placed today:cancelled lck:cancelled fut:cancelled / '
   || 'past:placed yday:placed today:cancelled lck:cancelled fut:cancelled'),
  ('D1 both offers are withdrawn by the owner, saying why',
   (select string_agg(t.status || ' ' || ms.short_code || ' ' || t.reason, ' / ' order by t.id)
      from public.meal_transfers t
      join public.memberships ms on ms.org_id = t.org_id and ms.profile_id = t.decided_by
     where t.org_id = pg_temp.c('org')::bigint),
   'cancelled OWNX withdrawn: the office was deleted / cancelled OWNX withdrawn: the office was deleted'),
  ('D1 the weeks are re-billed: each keeps yesterday and the settled day', pg_temp.moved('d0', 'd1'),
   'MONX -120000, MTWX -120000'),
  ('D1 and the books still add up', pg_temp.books(), '0 off, 0 cancelled billed'),
  ('D1 the settled week is untouched',
   (select string_agg(st.meals_minor::text, ',') from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p_past')::bigint), '40000,40000'),
  ('D1 the message waiting is failed; the one sent stays sent',
   (select string_agg(n.status || ' ' || coalesce(n.last_error, '-'), ' / ' order by n.dedupe_key)
      from public.notification_outbox n where n.dedupe_key like 'deloffice:a:%'),
   'sent - / failed the office was deleted'),
  ('D1 the office is gone',
   (select (deleted_at is not null)::text from public.organizations where id = pg_temp.c('org')::bigint),
   'true');

------------------------------------------- D2 nothing more is sent for it

-- A day published past its cutoff, which the tick would lock in a live office.
select pg_temp.day('org', 'more', now() - interval '1 minute');
select private.run_hourly_tick();
insert into probe values
  ('D2 the hourly tick queues nothing for the deleted office',
   (select count(*)::text from public.notification_outbox n
     where n.org_id = pg_temp.c('org')::bigint and n.dedupe_key not like 'deloffice:%'), '0'),
  ('D2 nor locks its menus', (select status from public.menus where id = pg_temp.m('org', 'more')), 'published'),
  ('D2 and for the other office it still does',
   (select count(*)::text from public.notification_outbox n
     where n.org_id = pg_temp.c('org_b')::bigint and n.kind = 'menu_published'), '1');

-- A message queued for it by hand after the deletion is not claimed.
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, body, parse_mode)
values (pg_temp.c('org')::bigint, 'deloffice:a:late', 'announcement', -1009001, 'late', 'none');
create temp table claimed as select * from public.claim_outbox(10000);
insert into probe values
  ('D2 the drain claims nothing of the deleted office''s, and the other office''s as usual',
   (select count(*) filter (where org_id = pg_temp.c('org')::bigint)::text || ' '
           || (count(*) filter (where dedupe_key = 'deloffice:b:waiting') = 1)::text from claimed),
   '0 true');

------------------------------------------------- D3 materializing skips it

-- A day put in by hand, open, on MON's rule.
select pg_temp.day('org', 'more2', now() + interval '1 hour');
insert into probe values
  ('D3 putting a day in orders nothing for the rule',
   (select count(*)::text from public.orders where menu_id = pg_temp.m('org', 'more2')), '0'),
  ('D3 nor does materializing the office',
   private.materialize_office(pg_temp.c('org')::bigint)::text || ' '
   || (select count(*)::text from public.orders where menu_id = pg_temp.m('org', 'more2')), '0 0');
select public.materialize_open_menus();
insert into probe values
  ('D3 nor the sweep over every office',
   (select count(*)::text from public.orders where menu_id = pg_temp.m('org', 'more2')), '0'),
  ('D3 control: the rule covers that day, and MON is a member',
   (select count(*)::text from public.standing_orders so
      join public.memberships ms on ms.org_id = so.org_id and ms.profile_id = so.profile_id
     where so.profile_id = pg_temp.c('mon')::uuid and so.is_enabled and ms.status = 'active'
       and so.weekday = extract(isodow from pg_temp.c('more2')::date)::int), '1');

------------------------------- D5 nothing is changed in it, nobody joins it

-- NWC, in neither office, holds an invitation to each.
insert into public.invitations (org_id, email, role, invited_by)
values (pg_temp.c('org')::bigint, 'nwc@deloffice.test', 'member', pg_temp.c('own')::uuid),
       (pg_temp.c('org_b')::bigint, 'nwc@deloffice.test', 'member', pg_temp.c('bown')::uuid);
insert into ctx select 'inv_' || case when org_id = pg_temp.c('org')::bigint then 'a' else 'b' end, token::text
  from public.invitations where email = 'nwc@deloffice.test';

-- An admin's correction run as the owner of the deleted office would be: the
-- admin check is the RPC's first line, so this calls the period lock the
-- correction RPCs share, as one already past that check does.
insert into probe values
  ('D5 a correction past its admin check is refused once the office is deleted',
   pg_temp.try(format('select private.correction_period(%s, %L::date)', pg_temp.c('org'), pg_temp.c('yday'))),
   '55000 this office has been deleted, so nothing in it can be changed'),
  ('D5 control: the other office''s period is found as usual',
   pg_temp.try(format('select private.correction_period(%s, %L::date)', pg_temp.c('org_b'), pg_temp.c('fut'))),
   'ok');

do $$ begin
  perform pg_temp.act('nwc');
  insert into probe values
    ('D5 the deleted office''s join code joins nobody, in the words of a code that does not exist',
     pg_temp.try($q$select * from public.join_with_code('DQAJXKNA', 'nwc')$q$),
     'P0002 That join code is not valid.'),
    ('D5 nor does its invitation',
     pg_temp.try(format('select * from public.accept_invitation(%L::uuid)',
       pg_temp.c('inv_a'))),
     'P0002 That invitation link is not valid.'),
    ('D5 control: the other office''s code and invitation still work',
     pg_temp.try($q$select * from public.join_with_code('DQBJXKNA', 'nwc')$q$) || ' '
     || pg_temp.try(format('select * from public.accept_invitation(%L::uuid)',
       pg_temp.c('inv_b'))),
     'ok ok');
end $$;
reset role;
insert into probe values
  ('D5 NWC is in the other office only',
   (select string_agg(o.slug, ',') from public.memberships m join public.organizations o on o.id = m.org_id
     where m.profile_id = pg_temp.c('nwc')::uuid), 'deloffice-b');

--------------------------------------------- D4 the other office, untouched

select pg_temp.snap('d4');
insert into probe values
  ('D4 the other office''s order and bill are untouched',
   (select o.status from public.orders o where o.org_id = pg_temp.c('org_b')::bigint) || ' '
   || (select st.meals_minor::text from public.billing_statements st
        where st.billing_period_id = pg_temp.c('p_b')::bigint), 'placed 40000'),
  ('D4 across the file only the deleted office''s people moved', pg_temp.moved('k0', 'd4'),
   'MONX -120000, MTWX -120000');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
