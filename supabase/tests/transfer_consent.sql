-- Who has to agree before a meal transfer becomes a charge, and what an admin
-- may write to meal_transfers directly.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/transfer_consent.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- Consent is keyed on whose meal it is, not on anybody's role. An admin giving
-- away their own lunch makes an offer like anybody, which the colleague
-- accepts or declines. Recording somebody else's arrangement is a correction,
-- and goes through record_pass, answer_pass or undo_pass, which audit it and
-- tell both people. The table refuses an admin's direct insert or answer on
-- somebody else's pass (20261022100100), which it used to accept silently.
--
-- Every refusal is judged by SQLSTATE and sentence, and by a row delta on the
-- passes, the audit and the outbox, after the role is proved downgraded.

begin;

create temp table probe (label text, got text, want text);
grant insert on probe to authenticated;
create temp table ctx (k text primary key, v text);
grant select, insert on ctx to authenticated;
create temp table cnt (step text primary key, t bigint, c bigint, n bigint);
grant select, insert on cnt to authenticated;

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

-- Passes, audit rows and outbox rows of office A. Called with the role reset,
-- so RLS never hides one from the count.
create function pg_temp.count_at(p_step text) returns void
language sql as $fn$
  insert into cnt
  select p_step,
         (select count(*) from public.meal_transfers where org_id = pg_temp.c('org_a')::bigint),
         (select count(*) from public.order_corrections where org_id = pg_temp.c('org_a')::bigint),
         (select count(*) from public.notification_outbox where org_id = pg_temp.c('org_a')::bigint);
$fn$;

create function pg_temp.delta(p_a text, p_b text) returns text
language sql stable as $fn$
  select (b.t - a.t) || ' passes, ' || (b.c - a.c) || ' audit, ' || (b.n - a.n) || ' messages'
    from cnt a, cnt b where a.step = p_a and b.step = p_b;
$fn$;

create function pg_temp.pass_of(p_order text) returns text
language sql stable as $fn$
  select coalesce(string_agg(t.status, ',' order by t.id), 'none')
    from public.meal_transfers t where t.order_id = pg_temp.c(p_order)::bigint;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('c0c00000-0000-0000-0000-000000000001', 'own@cons.test',  'Owner Oanh'),
    ('c0c00000-0000-0000-0000-000000000002', 'adm@cons.test',  'Admin An'),
    ('c0c00000-0000-0000-0000-000000000003', 'anh@cons.test',  'Anh Le'),
    ('c0c00000-0000-0000-0000-000000000004', 'binh@cons.test', 'Binh Tran'),
    ('c0c00000-0000-0000-0000-0000000000b1', 'bown@consb.test', 'Be Owner')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, short_code)
values ('cons-a', 'Consent A', 'Asia/Ho_Chi_Minh', 'CONA'),
       ('cons-b', 'Consent B', 'Asia/Ho_Chi_Minh', 'CONB');

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('cons-a', 'c0c00000-0000-0000-0000-000000000001', 'owner',  'OWN'),
  ('cons-a', 'c0c00000-0000-0000-0000-000000000002', 'admin',  'ADM'),
  ('cons-a', 'c0c00000-0000-0000-0000-000000000003', 'member', 'ANH'),
  ('cons-a', 'c0c00000-0000-0000-0000-000000000004', 'member', 'BINH'),
  ('cons-b', 'c0c00000-0000-0000-0000-0000000000b1', 'owner',  'BOWN')
) as u(slug, pid, role, code) on u.slug = o.slug;

-- Everybody in office A has Telegram, so a pass that tells nobody shows.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 810000 + m.id, now()
  from public.memberships m join public.organizations o on o.id = m.org_id
 where o.slug = 'cons-a';

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'cons-a' union all
select 'org_b', id::text from public.organizations where slug = 'cons-b' union all
select 'own',  'c0c00000-0000-0000-0000-000000000001' union all
select 'adm',  'c0c00000-0000-0000-0000-000000000002' union all
select 'anh',  'c0c00000-0000-0000-0000-000000000003' union all
select 'binh', 'c0c00000-0000-0000-0000-000000000004' union all
select 'bown', 'c0c00000-0000-0000-0000-0000000000b1' union all
select 'day',  (private.today_in('Asia/Ho_Chi_Minh') + 28)::text;

-- A day ahead, open, one dish, and an order for each of the four.
insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
values (pg_temp.c('org_a')::bigint, pg_temp.c('day')::date,
        (pg_temp.c('day')::date - 1)::timestamp at time zone 'Asia/Ho_Chi_Minh',
        pg_temp.c('own')::uuid);
insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, 'Com ga', 45000, 0 from public.menus m
 where m.org_id = pg_temp.c('org_a')::bigint;

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.c(w)::uuid, 'member', pg_temp.c(w)::uuid
  from public.menus m, (values ('own'), ('adm'), ('anh'), ('binh')) as x(w)
 where m.org_id = pg_temp.c('org_a')::bigint;
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o join public.menu_items mi on mi.menu_id = o.menu_id
 where o.org_id = pg_temp.c('org_a')::bigint;
insert into ctx
select 'o_' || x.w, o.id::text
  from (values ('own'), ('adm'), ('anh'), ('binh')) as x(w)
  join public.orders o on o.org_id = pg_temp.c('org_a')::bigint and o.profile_id = pg_temp.c(x.w)::uuid;

-- The insert a browser sends: from_profile_id and org_id are overwritten from
-- the order, created_by is whatever the caller claims.
create function pg_temp.offer(p_order text, p_to text, p_claimed_by text) returns text
language sql as $fn$
  select pg_temp.try(format(
    $q$insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
       values (%s, %s, %L::uuid, %L::uuid, %L::uuid)$q$,
    pg_temp.c('org_a'), pg_temp.c(p_order), pg_temp.c(p_claimed_by), pg_temp.c(p_to),
    pg_temp.c(p_claimed_by)));
$fn$;

create function pg_temp.answer(p_order text, p_status text) returns text
language sql as $fn$
  select pg_temp.try(format(
    $q$update public.meal_transfers set status = %L where order_id = %s and status = 'pending'$q$,
    p_status, pg_temp.c(p_order)));
$fn$;

------------------------------------------------------------------- controls

do $$ begin
  perform pg_temp.act('own');
  insert into probe values
    ('T0 control: role downgraded', current_role, 'authenticated'),
    ('T0 control: acting as the owner', (select auth.uid())::text, pg_temp.c('own')),
    ('T0 control: the owner can read every pass in the office, so a missing row is real',
     (select count(*)::text from public.meal_transfers), '0');
end $$;
reset role;

--------------------------------------- T1 an admin's own meal is an offer

select pg_temp.count_at('t1a');
do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('T1 the owner offers their own meal',
    pg_temp.offer('o_own', 'anh', 'own'), 'ok');
end $$;
reset role;
select pg_temp.count_at('t1b');

insert into probe values
  ('T1 it waits for the colleague', pg_temp.pass_of('o_own'), 'pending'),
  ('T1 the colleague is asked, and nothing is audited', pg_temp.delta('t1a', 't1b'),
   '1 passes, 0 audit, 1 messages'),
  ('T1 the ask went to Anh',
   (select string_agg(n.kind || ' ' || m.short_code, ',') from public.notification_outbox n
      join public.memberships m on m.org_id = n.org_id and m.profile_id = n.recipient_profile_id
     where n.org_id = pg_temp.c('org_a')::bigint), 'transfer_offer ANH');

do $$ begin
  perform pg_temp.act('anh');
  insert into probe values ('T1 the recipient accepts', pg_temp.answer('o_own', 'accepted'), 'ok');
end $$;
reset role;
insert into probe values
  ('T1 accepted, so Anh pays for it',
   (select payer_profile_id::text from public.v_order_charges where order_id = pg_temp.c('o_own')::bigint),
   pg_temp.c('anh'));

----------------------------- T2 somebody else's meal: not through the table

select pg_temp.count_at('t2a');
do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('T2 the owner cannot insert a pass on Anh''s meal',
    pg_temp.offer('o_anh', 'binh', 'own'),
    '42501 only the person who ordered can offer this meal; an admin records a pass on the Orders screen');
  insert into probe values ('T2 nor by naming Anh as its creator',
    pg_temp.offer('o_anh', 'binh', 'anh'),
    '42501 only the person who ordered can offer this meal; an admin records a pass on the Orders screen');
  -- The setting record_pass's siblings use to keep the member-style message
  -- quiet. It is not what admits an admin, so setting it changes nothing.
  perform set_config('lunch.pass_by_admin', 'on', true);
  insert into probe values ('T2 nor with lunch.pass_by_admin set by hand',
    pg_temp.offer('o_anh', 'binh', 'own'),
    '42501 only the person who ordered can offer this meal; an admin records a pass on the Orders screen');
  perform set_config('lunch.pass_by_admin', '', true);

  perform pg_temp.act('adm');
  insert into probe values ('T2 an admin who is not the owner cannot either',
    pg_temp.offer('o_binh', 'anh', 'adm'),
    '42501 only the person who ordered can offer this meal; an admin records a pass on the Orders screen');

  perform pg_temp.act('binh');
  insert into probe values ('T2 a member cannot pass a colleague''s meal',
    pg_temp.offer('o_anh', 'binh', 'binh'),
    '42501 only the person who ordered can offer this meal; an admin records a pass on the Orders screen');

  perform pg_temp.act('bown');
  -- The trigger reads the order through RLS, so another office's is not there.
  insert into probe values ('T2 another office''s owner cannot reach it',
    pg_temp.offer('o_anh', 'bown', 'bown'),
    'P0001 order ' || pg_temp.c('o_anh') || ' not found');
end $$;
reset role;
select pg_temp.count_at('t2b');
insert into probe values
  ('T2 the refusals wrote nothing and told nobody', pg_temp.delta('t2a', 't2b'),
   '0 passes, 0 audit, 0 messages'),
  ('T2 Anh still pays for her own meal',
   (select payer_profile_id::text from public.v_order_charges where order_id = pg_temp.c('o_anh')::bigint),
   pg_temp.c('anh'));

------------------------------- T3 somebody else's offer: not through the table

do $$ begin
  perform pg_temp.act('anh');
  insert into probe values ('T3 Anh offers her meal to Binh', pg_temp.offer('o_anh', 'binh', 'anh'), 'ok');
end $$;
reset role;

select pg_temp.count_at('t3a');
do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('T3 the owner cannot accept it for Binh',
    pg_temp.answer('o_anh', 'accepted'),
    '42501 only the two people on a pass can change it; an admin answers or undoes it on the Orders screen');
  insert into probe values ('T3 nor decline it',
    pg_temp.answer('o_anh', 'declined'),
    '42501 only the two people on a pass can change it; an admin answers or undoes it on the Orders screen');
  insert into probe values ('T3 nor withdraw it for Anh',
    pg_temp.answer('o_anh', 'cancelled'),
    '42501 only the two people on a pass can change it; an admin answers or undoes it on the Orders screen');
  insert into probe values ('T3 nor rewrite its reason',
    pg_temp.try(format($q$update public.meal_transfers set reason = 'x' where order_id = %s$q$,
      pg_temp.c('o_anh'))),
    '42501 only the two people on a pass can change it; an admin answers or undoes it on the Orders screen');
  insert into probe values ('T3 and a party to an accepted pass cannot undo it through the table either',
    pg_temp.try(format($q$update public.meal_transfers set status = 'undone' where order_id = %s$q$,
      pg_temp.c('o_own'))),
    '55000 this transfer is already accepted');
end $$;
reset role;
select pg_temp.count_at('t3b');
insert into probe values
  ('T3 the refusals wrote nothing and told nobody', pg_temp.delta('t3a', 't3b'),
   '0 passes, 0 audit, 0 messages'),
  ('T3 the offer still waits', pg_temp.pass_of('o_anh'), 'pending'),
  ('T3 and has no reason', (select coalesce(reason, 'none') from public.meal_transfers
                             where order_id = pg_temp.c('o_anh')::bigint), 'none');

do $$ begin
  perform pg_temp.act('binh');
  insert into probe values ('T3 Binh, the recipient, declines it himself',
    pg_temp.answer('o_anh', 'declined'), 'ok');
end $$;
reset role;
insert into probe values ('T3 declined', pg_temp.pass_of('o_anh'), 'declined');

---------------------------------------------------- T4 the RPCs still work

select pg_temp.count_at('t4a');
do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('T4 record_pass passes Binh''s meal to the admin',
    pg_temp.try(format($q$select public.record_pass(%s, %L::uuid, 'asked at lunch')$q$,
      pg_temp.c('o_binh'), pg_temp.c('adm'))), 'ok');
end $$;
reset role;
select pg_temp.count_at('t4b');
insert into probe values
  ('T4 accepted at once', pg_temp.pass_of('o_binh'), 'accepted'),
  ('T4 audited once, and both people told', pg_temp.delta('t4a', 't4b'),
   '1 passes, 1 audit, 2 messages'),
  ('T4 the audit row names the pass',
   (select kind || ' ' || (transfer_id = (select id from public.meal_transfers
                                           where order_id = pg_temp.c('o_binh')::bigint))::text
      from public.order_corrections where order_id = pg_temp.c('o_binh')::bigint), 'pass true'),
  ('T4 the admin pays for it',
   (select payer_profile_id::text from public.v_order_charges where order_id = pg_temp.c('o_binh')::bigint),
   pg_temp.c('adm'));

do $$ begin
  perform pg_temp.act('own');
  insert into probe values ('T4 undo_pass reverses it',
    pg_temp.try(format($q$select public.undo_pass(%s)$q$,
      (select id from public.meal_transfers where order_id = pg_temp.c('o_binh')::bigint))), 'ok');
end $$;
reset role;
select pg_temp.count_at('t4c');
insert into probe values
  ('T4 undone, audited, both told', pg_temp.pass_of('o_binh') || ' ' || pg_temp.delta('t4b', 't4c'),
   'undone 0 passes, 1 audit, 2 messages'),
  ('T4 and Binh pays again',
   (select payer_profile_id::text from public.v_order_charges where order_id = pg_temp.c('o_binh')::bigint),
   pg_temp.c('binh'));

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
