-- Leaving, or being removed, gives back the meals passed to the person and
-- declines the offers waiting for them; the People screen's preview says so
-- first. Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/leaving_returns_passes.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- An accepted pass to the person on a day still open goes back to its giver,
-- who pays again and is told; if the giver has gone too, the meal is
-- cancelled. Past the cutoff the person keeps the meal and its bill. A pending
-- offer to them is declined, the giver told, nothing billed. All in the
-- leaving's transaction (20261025100000). `removal_preview` lists the same
-- things for an admin of the office, and changes nothing (20261025100100).
-- Every money probe is an exact figure, and the people who must NOT have
-- moved are named too.
--
-- Negative controls: with 20261025100000 reverted (the 20261024100000
-- `cancel_leavers_open_orders`), the L1 to L4 pass and money probes fail;
-- without the placed-meal filter on declines, L0 lists and L1 declines the
-- offer left on STY's cancelled meal; with the 20261025100200 `claim_outbox`
-- reverted, L8 claims the messages of people who have gone; with it holding
-- back every private message to somebody gone, L8 fails RCV's correction and
-- RTW's weekly bill, which are meant for them.

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

create function pg_temp.ask(p_sql text) returns text
language plpgsql as $fn$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'null');
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

create function pg_temp.balance(p_step text, p_code text) returns text
language sql stable as $fn$
  select balance_minor::text from bal where step = p_step and code = p_code;
$fn$;

create function pg_temp.statements(p_period text) returns text
language sql stable as $fn$
  select coalesce(string_agg(m.short_code || ' ' || st.meals_minor || ' ' || st.meal_count
                             || case when st.meals_minor = (select coalesce(sum(bl.amount_minor), 0)
                                                              from public.billing_lines bl
                                                             where bl.billing_period_id = st.billing_period_id
                                                               and bl.payer_profile_id = st.profile_id)
                                     then '' else ' NOT THE SUM' end,
                             ', ' order by m.short_code), 'none')
    from public.billing_statements st
    join public.memberships m on m.org_id = st.org_id and m.profile_id = st.profile_id
   where st.billing_period_id = pg_temp.c(p_period)::bigint;
$fn$;

create function pg_temp.m(p_day text) returns bigint
language sql stable as $fn$
  select id from public.menus
   where org_id = pg_temp.c('org')::bigint and service_date = pg_temp.c(p_day)::date;
$fn$;

create function pg_temp.oid(p_day text, p_who text) returns bigint
language sql stable as $fn$
  select o.id from public.orders o
   where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid;
$fn$;

create function pg_temp.ostatus(p_day text, p_who text) returns text
language sql stable as $fn$
  select coalesce((select o.status from public.orders o
                    where o.menu_id = pg_temp.m(p_day) and o.profile_id = pg_temp.c(p_who)::uuid), 'none');
$fn$;

-- The pass on somebody's meal as `status by-whom reason`; `-` for a null.
create function pg_temp.pass(p_day text, p_who text) returns text
language sql stable as $fn$
  select t.status || ' '
         || coalesce((select ms.short_code from public.memberships ms
                       where ms.org_id = t.org_id
                         and ms.profile_id = coalesce(t.undone_by, t.decided_by)), '-')
         || ' ' || coalesce(t.reason, '-')
    from public.meal_transfers t
   where t.order_id = pg_temp.oid(p_day, p_who)
   order by t.id desc limit 1;
$fn$;

-- Every message queued for somebody, as `kind: body`, oldest first.
create function pg_temp.told(p_who text) returns text
language sql stable as $fn$
  select coalesce(string_agg(n.kind || ': ' || n.body, ' || ' order by n.id), 'nothing')
    from public.notification_outbox n
   where n.org_id = pg_temp.c('org')::bigint and n.recipient_profile_id = pg_temp.c(p_who)::uuid
     and n.id > pg_temp.c('outbox_mark')::bigint;
$fn$;

create function pg_temp.mark_outbox() returns void
language sql as $fn$
  insert into ctx values ('outbox_mark', (select coalesce(max(id), 0)::text from public.notification_outbox))
  on conflict (k) do update set v = excluded.v;
$fn$;

create function pg_temp.dm(p_day text) returns text
language sql stable as $fn$ select to_char(pg_temp.c(p_day)::date, 'DD/MM') $fn$;

-- The cutoff of a day, as the messages write it.
create function pg_temp.cut(p_day text) returns text
language sql stable as $fn$
  select to_char(m.order_cutoff_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM')
    from public.menus m where m.id = pg_temp.m(p_day);
$fn$;

create function pg_temp.preview(p_who text) returns text
language sql as $fn$
  select coalesce(string_agg(p.service_date::text || ' ' || p.action || ' '
                             || coalesce(p.dishes, '-') || ' ' || coalesce(p.other_name, '-'),
                             ' | ' order by p.service_date, p.action, p.dishes), 'nothing')
    from public.removal_preview(pg_temp.c('org')::bigint, pg_temp.c(p_who)::uuid) p;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.k || '@leavepass.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.k)
  from (values
    ('1eb00000-0000-0000-0000-000000000001', 'adm'),
    ('1eb00000-0000-0000-0000-000000000002', 'rcv'),
    ('1eb00000-0000-0000-0000-000000000003', 'giv'),
    ('1eb00000-0000-0000-0000-000000000004', 'gon'),
    ('1eb00000-0000-0000-0000-000000000005', 'off'),
    ('1eb00000-0000-0000-0000-000000000006', 'oft'),
    ('1eb00000-0000-0000-0000-000000000007', 'gtw'),
    ('1eb00000-0000-0000-0000-000000000008', 'rtw'),
    ('1eb00000-0000-0000-0000-000000000009', 'gth'),
    ('1eb00000-0000-0000-0000-00000000000a', 'rth'),
    ('1eb00000-0000-0000-0000-00000000000b', 'pxx'),
    ('1eb00000-0000-0000-0000-00000000000c', 'pyy'),
    ('1eb00000-0000-0000-0000-00000000000d', 'sty'),
    ('1eb00000-0000-0000-0000-0000000000b1', 'bown')
  ) as u(id, k)
on conflict (id) do nothing;

insert into ctx select split_part(email, '@', 1), id::text from auth.users where email like '%@leavepass.test';

insert into public.organizations (slug, name, timezone, short_code, telegram_join_code)
values ('leavepass-a', 'Leave Pass A', 'Asia/Ho_Chi_Minh', 'LPA', 'LPAJXKNA'),
       ('leavepass-b', 'Leave Pass B', 'Asia/Ho_Chi_Minh', 'LPB', 'LPBJXKNA');
insert into ctx values
  ('org',   (select id from public.organizations where slug = 'leavepass-a')::text),
  ('org_b', (select id from public.organizations where slug = 'leavepass-b')::text);

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c(case when x = 'bown' then 'org_b' else 'org' end)::bigint, pg_temp.c(x)::uuid,
       case when x in ('adm', 'bown') then 'owner' else 'member' end,
       upper(x) || 'X'
  from unnest(array['adm', 'rcv', 'giv', 'gon', 'off', 'oft', 'gtw', 'rtw', 'gth', 'rth',
                    'pxx', 'pyy', 'sty', 'bown']) as x;
insert into ctx select 'm_' || lower(left(ms.short_code, 3)), ms.id::text from public.memberships ms
 where ms.org_id = pg_temp.c('org')::bigint;

-- Everybody who gives or offers is on Telegram, and so is RCV.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select ms.id, ms.org_id, 900000 + ms.id, now() from public.memberships ms
 where ms.org_id = pg_temp.c('org')::bigint
   and ms.short_code in ('RCVX', 'GIVX', 'GONX', 'OFFX', 'OFTX', 'GTWX', 'GTHX', 'PXXX');

-- One week three weeks out: d1 and d2 open, d3 published with its cutoff gone.
do $$
declare v_t date; v_mon date;
begin
  v_t := private.today_in('Asia/Ho_Chi_Minh');
  v_mon := v_t - (extract(isodow from v_t)::int - 1) + 21;
  insert into ctx values ('d1', v_mon::text), ('d2', (v_mon + 1)::text), ('d3', (v_mon + 2)::text);
end $$;

create function pg_temp.day(p_org text, p_day text, p_cutoff timestamptz, p_dishes text[], p_prices int[])
returns bigint language plpgsql as $fn$
declare v_menu bigint;
begin
  insert into public.menus (org_id, service_date, order_cutoff_at, created_by)
  values (pg_temp.c(p_org)::bigint, pg_temp.c(p_day)::date, p_cutoff,
          pg_temp.c(case when p_org = 'org' then 'adm' else 'bown' end)::uuid)
  returning id into v_menu;
  insert into public.menu_items (menu_id, org_id, name, price_minor, position)
  select v_menu, pg_temp.c(p_org)::bigint, d, p, n - 1
    from unnest(p_dishes, p_prices) with ordinality as x(d, p, n);
  return v_menu;
end $fn$;

create function pg_temp.eat(p_org text, p_day text, p_who text, p_dish text) returns void
language plpgsql as $fn$
declare v_menu bigint; v_order bigint;
begin
  select id into v_menu from public.menus
   where org_id = pg_temp.c(p_org)::bigint and service_date = pg_temp.c(p_day)::date;
  insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
  values (pg_temp.c(p_org)::bigint, v_menu, pg_temp.c(p_day)::date, pg_temp.c(p_who)::uuid,
          'member', pg_temp.c(p_who)::uuid)
  returning id into v_order;
  insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
  select v_order, pg_temp.c(p_org)::bigint, pg_temp.c(p_who)::uuid, v_menu, mi.id, 1
    from public.menu_items mi where mi.menu_id = v_menu and mi.name = p_dish;
end $fn$;

-- A member offers their meal on a day, as the Board does; with p_accept the
-- recipient accepts it, as the Board does.
create function pg_temp.offer(p_day text, p_from text, p_to text, p_accept boolean) returns text
language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.act(p_from);
  v := pg_temp.try(format(
    'insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
     values (%s, %s, %L, %L, %L)', pg_temp.c('org'), pg_temp.oid(p_day, p_from),
     pg_temp.c(p_from), pg_temp.c(p_to), pg_temp.c(p_from)));
  if p_accept then
    perform pg_temp.act(p_to);
    v := v || ' ' || pg_temp.try(format(
      $q$update public.meal_transfers set status = 'accepted' where order_id = %s$q$,
      pg_temp.oid(p_day, p_from)));
  end if;
  perform set_config('role', 'postgres', true);
  return v;
end $fn$;

select pg_temp.day('org', 'd1', now() + interval '10 days', array['Com ga', 'Pho'], array[45000, 50000]);
select pg_temp.day('org', 'd2', now() + interval '10 days', array['Bun'], array[40000]);
select pg_temp.day('org', 'd3', now() + interval '10 days', array['Com ga', 'Pho'], array[45000, 50000]);
select pg_temp.day('org_b', 'd1', now() + interval '10 days', array['Com ga'], array[45000]);

select pg_temp.eat('org', 'd1', w, 'Com ga') from unnest(array['giv', 'gth', 'sty']) as w;
select pg_temp.eat('org', 'd1', w, 'Pho') from unnest(array['gon', 'pxx']) as w;
select pg_temp.eat('org', 'd2', w, 'Bun') from unnest(array['rcv', 'off', 'gtw']) as w;
select pg_temp.eat('org', 'd3', 'giv', 'Pho');
select pg_temp.eat('org', 'd3', 'oft', 'Com ga');
select pg_temp.eat('org_b', 'd1', 'bown', 'Com ga');

insert into probe values
  ('F0 GIV passes d1 and d3 to RCV, who accepts both',
   pg_temp.offer('d1', 'giv', 'rcv', true) || ' ' || pg_temp.offer('d3', 'giv', 'rcv', true), 'ok ok ok ok'),
  ('F0 GON passes d1 to RCV, accepted', pg_temp.offer('d1', 'gon', 'rcv', true), 'ok ok'),
  ('F0 OFF offers d2 to RCV and OFT d3, both waiting',
   pg_temp.offer('d2', 'off', 'rcv', false) || ' ' || pg_temp.offer('d3', 'oft', 'rcv', false), 'ok ok'),
  ('F0 GTW passes d2 to RTW, GTH d1 to RTH, PXX d1 to PYY, all accepted',
   pg_temp.offer('d2', 'gtw', 'rtw', true) || ' ' || pg_temp.offer('d1', 'gth', 'rth', true) || ' '
   || pg_temp.offer('d1', 'pxx', 'pyy', true), 'ok ok ok ok ok ok');

-- STY's offer of d2 to RCV was left waiting when she cancelled the meal (the
-- withdrawal skips a pass another transaction holds), so it is on a meal no
-- longer placed.
select pg_temp.eat('org', 'd2', 'sty', 'Bun');
update public.orders set status = 'cancelled', cancelled_at = now() where id = pg_temp.oid('d2', 'sty');
insert into public.meal_transfers (org_id, order_id, from_profile_id, to_profile_id, created_by)
values (pg_temp.c('org')::bigint, pg_temp.oid('d2', 'sty'), pg_temp.c('sty')::uuid,
        pg_temp.c('rcv')::uuid, pg_temp.c('sty')::uuid);

-- d3's cutoff passes after the passes were made, as it would on the day.
update public.menus set order_cutoff_at = now() - interval '1 hour' where id = pg_temp.m('d3');

insert into ctx values
  ('p_w', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date)::text),
  ('p_b', public.ensure_billing_period(pg_temp.c('org_b')::bigint, pg_temp.c('d1')::date)::text);
select public.run_billing(pg_temp.c(p)::bigint) is not null from unnest(array['p_w', 'p_b']) as p;

-- RCV paid 200 000 ahead, so what she keeps past the cutoff does not stop her leaving.
insert into public.payments (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
values (pg_temp.c('org')::bigint, 'leavepass-1', 200000, 'LUNCHRCVX', now(), '{}');

-- GON leaves: the meal passed to RCV is RCV's, so nothing of hers is cancelled.
do $$ begin
  perform pg_temp.act('gon');
  insert into probe values ('F0 GON leaves, cancelling nothing',
    pg_temp.ask(format('select public.leave_office(%s)::text', pg_temp.c('org'))), '0');
end $$;
reset role;

------------------------------------------------------------------- controls

select pg_temp.snap('k0');
select pg_temp.mark_outbox();
insert into probe values
  ('K0 control: d1 and d2 are open, d3 past its cutoff, one billing week',
   (select string_agg(case when m.order_cutoff_at > now() then 'open' else 'shut' end, ' '
                      order by m.service_date)
      from public.menus m where m.id in (pg_temp.m('d1'), pg_temp.m('d2'), pg_temp.m('d3')))
   || ' ' || (select count(distinct public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c(d)::date))::text
                from unnest(array['d1', 'd2', 'd3']) as d),
   'open open shut 1'),
  ('K0 control: the passes and offers are as set up',
   pg_temp.pass('d1', 'giv') || ' / ' || pg_temp.pass('d3', 'giv') || ' / ' || pg_temp.pass('d1', 'gon')
   || ' / ' || pg_temp.pass('d2', 'off') || ' / ' || pg_temp.pass('d3', 'oft'),
   'accepted RCVX - / accepted RCVX - / accepted RCVX - / pending - - / pending - -'),
  ('K0 control: STY''s offer waits on a cancelled meal',
   pg_temp.ostatus('d2', 'sty') || ' / ' || pg_temp.pass('d2', 'sty'), 'cancelled / pending - -'),
  ('K0 control: RCV pays for three passed meals and her own',
   pg_temp.statements('p_w'),
   'OFFX 40000 1, OFTX 45000 1, PYYX 50000 1, RCVX 185000 4, RTHX 45000 1, RTWX 40000 1, STYX 45000 1'),
  ('K0 control: RCV holds 15 000 of credit, the givers owe nothing, GON is gone',
   pg_temp.balance('k0', 'RCVX') || ' ' || pg_temp.balance('k0', 'GIVX') || ' ' || pg_temp.balance('k0', 'GONX') || ' '
   || (select status from public.memberships where id = pg_temp.c('m_gon')::bigint), '-15000 0 0 inactive');

-------------------------------------------- L0 the preview, and its isolation

do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L0 the preview of removing RCV lists every meal and pass, by day',
    pg_temp.preview('rcv'),
    pg_temp.c('d1') || ' cancel_passed Pho gon | ' || pg_temp.c('d1') || ' return Com ga giv | '
    || pg_temp.c('d2') || ' cancel Bun - | ' || pg_temp.c('d2') || ' decline Bun off | '
    || pg_temp.c('d3') || ' decline Com ga oft');
  insert into probe values ('L0 nothing for somebody with nothing open', pg_temp.preview('adm'), 'nothing');
  insert into probe values ('L0 nothing for somebody of another office', pg_temp.preview('bown'), 'nothing');
  perform pg_temp.act('sty');
  insert into probe values ('L0 a member cannot ask',
    pg_temp.ask(format('select count(*)::text from public.removal_preview(%s, %L::uuid)',
      pg_temp.c('org'), pg_temp.c('rcv'))),
    '42501 only an admin of this office can remove somebody');
  perform pg_temp.act('bown');
  insert into probe values ('L0 nor the owner of another office, in the same words',
    pg_temp.ask(format('select count(*)::text from public.removal_preview(%s, %L::uuid)',
      pg_temp.c('org'), pg_temp.c('rcv'))),
    '42501 only an admin of this office can remove somebody');
  insert into probe values ('L0 nor about an office that does not exist',
    pg_temp.ask(format('select count(*)::text from public.removal_preview(-1, %L::uuid)', pg_temp.c('rcv'))),
    '42501 only an admin of this office can remove somebody');
end $$;
reset role;
select pg_temp.snap('l0');
insert into probe values
  ('L0 asking changed nothing',
   pg_temp.moved('k0', 'l0') || ' / ' || pg_temp.pass('d1', 'giv') || ' / ' || pg_temp.ostatus('d2', 'rcv'),
   '- / accepted RCVX - / placed');

-------------------------------------------------------- L1 RCV leaves

do $$ begin
  perform pg_temp.act('rcv');
  insert into probe values
    ('L1 RCV is told her credit after leaving: 200 000 paid, less d3 alone',
     pg_temp.ask(format('select public.my_balance_after_leaving(%s)::text', pg_temp.c('org'))), '-150000');
  insert into probe values ('L1 asking changed nothing', pg_temp.pass('d1', 'giv'), 'accepted RCVX -');
  insert into probe values ('L1 RCV leaves; two open days of lunch come off her',
    pg_temp.ask(format('select public.leave_office(%s)::text', pg_temp.c('org'))), '2');
end $$;
reset role;
select pg_temp.snap('l1');
insert into probe values
  ('L1 GIV''s open d1 is his again; the pass is undone by RCV, saying why',
   pg_temp.ostatus('d1', 'giv') || ' / ' || pg_temp.pass('d1', 'giv'),
   'placed / undone RCVX undone: the person it was passed to left the office'),
  ('L1 GIV''s d3, past its cutoff, stays RCV''s', pg_temp.pass('d3', 'giv'), 'accepted RCVX -'),
  ('L1 GON''s d1, whose giver has gone, is cancelled, and the pass left as it was',
   pg_temp.ostatus('d1', 'gon') || ' / ' || pg_temp.pass('d1', 'gon'), 'cancelled / accepted RCVX -'),
  ('L1 the offers waiting for RCV are declined, by RCV, saying why, d3 included',
   pg_temp.pass('d2', 'off') || ' / ' || pg_temp.pass('d3', 'oft'),
   'declined RCVX declined: the person it was offered to left the office / '
   || 'declined RCVX declined: the person it was offered to left the office'),
  ('L1 the offered meals stay their owners''', pg_temp.ostatus('d2', 'off') || ' ' || pg_temp.ostatus('d3', 'oft'),
   'placed placed'),
  ('L1 RCV''s own open d2 is cancelled', pg_temp.ostatus('d2', 'rcv'), 'cancelled'),
  ('L1 the offer left waiting on STY''s cancelled meal is not declined, as the preview said',
   pg_temp.pass('d2', 'sty'), 'pending - -'),
  ('L1 money: GIV pays for d1 again, RCV keeps only d3; nobody else moved',
   pg_temp.moved('k0', 'l1'), 'GIVX 45000, RCVX -135000'),
  ('L1 the figure Settings gave is the one leaving left', pg_temp.balance('l1', 'RCVX'), '-150000'),
  ('L1 the week is re-billed at once, every statement its lines', pg_temp.statements('p_w'),
   'GIVX 45000 1, OFFX 40000 1, OFTX 45000 1, PYYX 50000 1, RCVX 50000 1, RTHX 45000 1, RTWX 40000 1, STYX 45000 1'),
  ('L1 GIV is told the meal is back, with the cutoff and his balance',
   pg_temp.told('giv'),
   'bill_correction: rcv left the office, so your lunch on ' || pg_temp.dm('d1')
   || ' (Com ga, 45.000 ₫) is yours again and back on your bill. Cancel it before '
   || pg_temp.cut('d1') || E' if you will not eat it.\nYou owe 45.000 ₫.'),
  ('L1 OFF and OFT are told their offers were declined',
   pg_temp.told('off') || ' / ' || pg_temp.told('oft'),
   'transfer_decided: rcv left the office, so your offer of lunch on ' || pg_temp.dm('d2')
   || ' was declined. It is still yours and still on your bill. / '
   || 'transfer_decided: rcv left the office, so your offer of lunch on ' || pg_temp.dm('d3')
   || ' was declined. It is still yours and still on your bill.'),
  ('L1 RCV and GON, who are gone, are told nothing',
   pg_temp.told('rcv') || ' / ' || pg_temp.told('gon'), 'nothing / nothing'),
  ('L1 no correction row is written: the system did this',
   (select count(*)::text from public.order_corrections where org_id = pg_temp.c('org')::bigint), '0');

------------------------------------------------- L2 an admin removes RTW

select pg_temp.mark_outbox();
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L2 the preview of removing RTW names the meal going back to GTW',
    pg_temp.preview('rtw'), pg_temp.c('d2') || ' return Bun gtw');
  insert into probe values ('L2 ADM removes RTW, as the People screen does', pg_temp.try(format(
    $q$update public.memberships set status = 'inactive' where id = %s$q$, pg_temp.c('m_rtw'))), 'ok');
end $$;
reset role;
select pg_temp.snap('l2');
insert into probe values
  ('L2 the pass is undone by ADM, saying RTW was removed', pg_temp.pass('d2', 'gtw'),
   'undone ADMX undone: the person it was passed to was removed from the office'),
  ('L2 money: GTW pays, RTW does not, nobody else moved', pg_temp.moved('l1', 'l2'), 'GTWX 40000, RTWX -40000'),
  ('L2 GTW is told RTW was removed',
   pg_temp.told('gtw'),
   'bill_correction: rtw was removed from the office, so your lunch on ' || pg_temp.dm('d2')
   || ' (Bun, 40.000 ₫) is yours again and back on your bill. Cancel it before '
   || pg_temp.cut('d2') || E' if you will not eat it.\nYou owe 40.000 ₫.');

------------------------------- L3 the service role removes RTH by hand

select set_config('request.jwt.claims', '', true);
update public.memberships set status = 'inactive' where id = pg_temp.c('m_rth')::bigint;
select pg_temp.snap('l3');
insert into probe values
  ('L3 with nobody signed in, the pass names RTH as who undid it', pg_temp.pass('d1', 'gth'),
   'undone RTHX undone: the person it was passed to was removed from the office'),
  ('L3 money: GTH pays, RTH does not', pg_temp.moved('l2', 'l3'), 'GTHX 45000, RTHX -45000');

------------------------- L4 one UPDATE removing a giver and her recipient

select pg_temp.mark_outbox();
update public.memberships set status = 'inactive'
 where id in (pg_temp.c('m_pxx')::bigint, pg_temp.c('m_pyy')::bigint);
select pg_temp.snap('l4');
insert into probe values
  ('L4 PXX''s meal passed to PYY is cancelled, not given back to somebody leaving',
   pg_temp.ostatus('d1', 'pxx') || ' / ' || pg_temp.pass('d1', 'pxx'), 'cancelled / accepted PYYX -'),
  ('L4 money: PYY stops paying, PXX is charged nothing', pg_temp.moved('l3', 'l4'), 'PYYX -50000'),
  ('L4 and nobody is told', pg_temp.told('pxx') || ' / ' || pg_temp.told('pyy'), 'nothing / nothing');

----------------------- L8 nothing is sent to somebody who has gone since

-- GTW was told in L2 that his meal came back; then he is removed too, before
-- the drain gets to it. Everything queued for RCV and PXX is older still.
update public.memberships set status = 'inactive' where id = pg_temp.c('m_gtw')::bigint;

-- An admin removes GIV's d3, past its cutoff, which RCV kept when she left and
-- still pays for: she is told, as the payer, though she has gone. And RTW,
-- removed, is sent the weekly bill the tick writes to anybody owing, any status.
do $$ begin
  perform pg_temp.act('adm');
  insert into probe values ('L8 ADM removes the d3 RCV kept', pg_temp.try(format(
    'select public.remove_meal(%s)', pg_temp.oid('d3', 'giv'))), 'ok');
end $$;
reset role;
insert into public.notification_outbox (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
select pg_temp.c('org')::bigint, 'leavepass:weekly_bill:rtw', 'weekly_bill', 900000 + pg_temp.c('m_rtw')::bigint,
       pg_temp.c('rtw')::uuid, 'You owe', 'none';
create temp table claimed as select * from public.claim_outbox(10000);
create function pg_temp.outbox_of(p_who text) returns text
language sql stable as $fn$
  select coalesce(string_agg(distinct n.status || ' ' || coalesce(n.last_error, '-'), ' | '), 'none')
    from public.notification_outbox n
   where n.org_id = pg_temp.c('org')::bigint and n.recipient_profile_id = pg_temp.c(p_who)::uuid;
$fn$;
insert into probe values
  ('L8 GTW''s "yours again", queued while he was here, is not sent now he has gone',
   pg_temp.outbox_of('gtw'), 'failed the recipient is no longer in the office'),
  ('L8 nor is anything queued for RCV before she left, or for PXX',
   (select string_agg(distinct n.status || ' ' || coalesce(n.last_error, '-'), ' | ')
      from public.notification_outbox n
     where n.org_id = pg_temp.c('org')::bigint and n.recipient_profile_id = pg_temp.c('rcv')::uuid
       and n.kind <> 'bill_correction') || ' / ' || pg_temp.outbox_of('pxx'),
   'failed the recipient is no longer in the office / failed the recipient is no longer in the office'),
  ('L8 RCV, gone, is sent the correction of the meal she still paid for',
   (select string_agg(n.status, ',') from public.notification_outbox n
     where n.org_id = pg_temp.c('org')::bigint and n.recipient_profile_id = pg_temp.c('rcv')::uuid
       and n.kind = 'bill_correction'), 'sending'),
  ('L8 RTW, removed, is sent the weekly bill',
   (select status from public.notification_outbox where dedupe_key = 'leavepass:weekly_bill:rtw'), 'sending'),
  ('L8 the people still here are sent theirs',
   pg_temp.outbox_of('giv') || ' / ' || pg_temp.outbox_of('off'), 'sending - / sending -'),
  ('L8 the drain claimed for anybody inactive only those two',
   (select string_agg(c.kind, ',' order by c.kind) from claimed c
     where c.org_id = pg_temp.c('org')::bigint and c.recipient_profile_id is not null
       and not exists (select 1 from public.memberships m
                        where m.org_id = c.org_id and m.profile_id = c.recipient_profile_id
                          and m.status = 'active')), 'bill_correction,weekly_bill');
select pg_temp.snap('l8');

------------------------------------------ L5 coming back revives nothing

do $$ begin
  perform pg_temp.act('rcv');
  insert into probe values ('L5 RCV rejoins with the code',
    pg_temp.try($q$select * from public.join_with_code('LPAJXKNA', 'rcv')$q$), 'ok');
  insert into probe values ('L5 and cannot accept OFF''s declined offer', pg_temp.try(format(
    $q$update public.meal_transfers set status = 'accepted' where order_id = %s$q$, pg_temp.oid('d2', 'off'))),
    '55000 this transfer is already declined');
end $$;
reset role;
select pg_temp.snap('l5');
insert into probe values
  ('L5 the passes stay as leaving left them',
   pg_temp.pass('d1', 'giv') || ' / ' || pg_temp.pass('d2', 'off'),
   'undone RCVX undone: the person it was passed to left the office / '
   || 'declined RCVX declined: the person it was offered to left the office'),
  ('L5 and nobody''s balance moved', pg_temp.moved('l8', 'l5'), '-');

----------------------------------------- L6 GIV can cancel the meal back

do $$ begin
  perform pg_temp.act('giv');
  insert into probe values ('L6 GIV cancels d1 on the Board, as the message says he can', pg_temp.try(format(
    $q$update public.orders set status = 'cancelled', cancelled_at = now() where id = %s$q$,
    pg_temp.oid('d1', 'giv'))), 'ok');
end $$;
reset role;
select public.run_billing(pg_temp.c('p_w')::bigint) is not null;
select pg_temp.snap('l6');
insert into probe values ('L6 and owes nothing for it', pg_temp.moved('l5', 'l6'), 'GIVX -45000');

---------------------------------------------- L7 everybody else, untouched

insert into probe values
  ('L7 across the file only the people named moved, each by an exact meal',
   pg_temp.moved('k0', 'l6'),
   'GTHX 45000, PYYX -50000, RCVX -185000, RTHX -45000, RTWX -40000'),
  ('L7 STY keeps her meal', pg_temp.ostatus('d1', 'sty'), 'placed'),
  ('L7 the other office''s order and statement are untouched',
   (select o.status from public.orders o where o.org_id = pg_temp.c('org_b')::bigint) || ' '
   || (select st.meals_minor::text from public.billing_statements st
        where st.billing_period_id = pg_temp.c('p_b')::bigint), 'placed 45000'),
  ('L7 every statement in the week is still the sum of its lines',
   (select count(*)::text from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p_w')::bigint
       and st.meals_minor <> (select coalesce(sum(bl.amount_minor), 0) from public.billing_lines bl
                               where bl.billing_period_id = st.billing_period_id
                                 and bl.payer_profile_id = st.profile_id)), '0'),
  ('L7 no cancelled meal has a billing line',
   (select count(*)::text from public.billing_lines bl join public.orders o on o.id = bl.order_id
     where o.org_id = pg_temp.c('org')::bigint and o.status <> 'placed'), '0'),
  ('L7 every billing line of a passed meal is on its recipient, every other on its owner',
   (select count(*)::text from public.billing_lines bl
      join public.orders o on o.id = bl.order_id
      left join public.meal_transfers t on t.order_id = o.id and t.status = 'accepted'
     where o.org_id = pg_temp.c('org')::bigint
       and bl.payer_profile_id <> coalesce(t.to_profile_id, o.profile_id)), '0');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
