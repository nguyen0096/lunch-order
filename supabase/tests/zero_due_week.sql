-- A week somebody owes nothing for is billed, settled and messaged like any
-- other. Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/zero_due_week.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- A placed order with no dish line bills at 0. A statement whose meals come to
-- 0 is 'paid' with `paid_at` set, never 'paid' with `paid_at` null, which
-- `billing_statements_paid_ck` refuses. Before 20261017200000 that refusal
-- failed `run_billing`, and inside the hourly tick it rolled back the whole
-- office's hour: no statements, no close, no weekly bill, only a WARNING.
--
-- The week is billed by `private.run_hourly_tick` itself, with the office's
-- billing day set to today and its bill hour to 0, so what is probed is what
-- production does on a Monday.
--
--   ZERO  only order has no dish                      paid, nothing sent
--   MIX   one order with no dish, one Cơm gà 45.000   unpaid, sent
--   CRED  no dish, 30.000 paid weeks ago              paid, credit kept
--   ADV   Cơm gà 45.000, paid in advance              paid when the money came
--   OWE   no dish, 60.000 unpaid the week before       paid, sent the older debt

begin;

create temp table probe (label text, got text, want text);
create temp table ctx (k text primary key, v text);

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

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

create function pg_temp.uid(p_code text) returns uuid
language sql immutable as $fn$
  select ('cccccccc-0000-0000-0000-00000000000' || case p_code
            when 'ADM' then '1' when 'ZERO' then '2' when 'MIX' then '3'
            when 'CRED' then '4' when 'ADV' then '5' when 'OWE' then '6' end)::uuid;
$fn$;

-- `status meals_count meals_minor paid_minor paid_at?` for one person's week.
create function pg_temp.stmt(p_period text, p_code text) returns text
language sql stable as $fn$
  select coalesce((
    select st.status || ' ' || st.meal_count || ' ' || st.meals_minor || ' '
           || st.paid_minor || ' ' || case when st.paid_at is null then 'no-date' else 'dated' end
      from public.billing_statements st
     where st.billing_period_id = pg_temp.c(p_period)::bigint
       and st.profile_id = pg_temp.uid(p_code)), 'none');
$fn$;

create function pg_temp.balance(p_code text) returns text
language sql stable as $fn$
  select coalesce((select b.balance_minor::text from public.v_account_balance b
                    where b.org_id = pg_temp.c('org')::bigint
                      and b.profile_id = pg_temp.uid(p_code)), 'none');
$fn$;

create function pg_temp.sent(p_code text) returns text
language sql stable as $fn$
  select coalesce((select n.body from public.notification_outbox n
                    where n.kind = 'weekly_bill'
                      and n.recipient_profile_id = pg_temp.uid(p_code)), 'none');
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', pg_temp.uid(c), 'authenticated',
       'authenticated', lower(c) || '@zerow.test', 'x', now(), now(), now(),
       '{"provider":"google"}', format('{"full_name":"%s"}', initcap(c))::jsonb
  from unnest(array['ADM','ZERO','MIX','CRED','ADV','OWE']) c
on conflict (id) do nothing;

insert into public.organizations (slug, name, timezone, default_cutoff_local_time,
                                  short_code, telegram_group_chat_id)
values ('zero-week', 'Zero Week', 'Asia/Ho_Chi_Minh', '16:00', 'ZW', -100777);

insert into ctx
select 'org', id::text from public.organizations where slug = 'zero-week';
insert into ctx values ('today', private.today_in('Asia/Ho_Chi_Minh')::text);
-- The week the tick bills is the one holding yesterday; one before it holds
-- OWE's unpaid meal.
insert into ctx values
  ('d1',  (pg_temp.c('today')::date - 3)::text),
  ('d2',  (pg_temp.c('today')::date - 2)::text),
  ('d0',  (pg_temp.c('today')::date - 10)::text);

-- Billing day is today and the bill goes at hour 0, so this tick bills.
update public.organizations
   set billing_week_starts_on = extract(isodow from pg_temp.c('today')::date)::smallint
 where id = pg_temp.c('org')::bigint;
insert into public.org_notifications (org_id, kind, enabled, at_local_hour)
values (pg_temp.c('org')::bigint, 'weekly_bill', true, 0);

insert into public.memberships (org_id, profile_id, role, short_code)
select pg_temp.c('org')::bigint, pg_temp.uid(c),
       case c when 'ADM' then 'owner' else 'member' end, c
  from unnest(array['ADM','ZERO','MIX','CRED','ADV','OWE']) c;

-- Everybody linked, so a message not sent is a decision, not a missing chat.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 910000 + m.id, now()
  from public.memberships m where m.org_id = pg_temp.c('org')::bigint;

insert into public.menus (org_id, service_date, status, order_cutoff_at, created_by)
select pg_temp.c('org')::bigint, d, 'locked',
       (d::timestamp + time '16:00') at time zone 'Asia/Ho_Chi_Minh', pg_temp.uid('ADM')
  from unnest(array[pg_temp.c('d0')::date, pg_temp.c('d1')::date, pg_temp.c('d2')::date]) d;

insert into public.menu_items (menu_id, org_id, name, price_minor, position)
select m.id, m.org_id, v.nm, v.pr, v.pos
  from public.menus m
  join (values ('Cơm gà', 45000, 0), ('Bún bò', 60000, 1)) v(nm, pr, pos) on true
 where m.org_id = pg_temp.c('org')::bigint;

insert into public.orders (org_id, menu_id, service_date, profile_id, source, created_by)
select m.org_id, m.id, m.service_date, pg_temp.uid(v.who), 'member', pg_temp.uid(v.who)
  from public.menus m
  join (values ('d0','OWE'), ('d1','ZERO'), ('d1','MIX'), ('d2','MIX'),
               ('d1','CRED'), ('d2','ADV'), ('d1','OWE')) v(dk, who)
    on m.service_date = pg_temp.c(v.dk)::date
 where m.org_id = pg_temp.c('org')::bigint;

-- Dish lines for the priced orders only. The rest are placed with no dish.
insert into public.order_items (order_id, org_id, profile_id, menu_id, menu_item_id, quantity)
select o.id, o.org_id, o.profile_id, o.menu_id, mi.id, 1
  from public.orders o
  join public.menu_items mi on mi.menu_id = o.menu_id
  join (values ('d0','OWE','Bún bò'), ('d2','MIX','Cơm gà'), ('d2','ADV','Cơm gà')) v(dk, who, nm)
    on o.service_date = pg_temp.c(v.dk)::date and o.profile_id = pg_temp.uid(v.who)
   and mi.name = v.nm
 where o.org_id = pg_temp.c('org')::bigint;

-- OWE's older week, billed and settled unpaid.
do $$
declare v_p bigint;
begin
  v_p := public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d0')::date);
  perform public.run_billing(v_p);
  update public.billing_periods set status = 'closed', closed_at = now() where id = v_p;
  insert into ctx values ('p0', v_p::text);
end $$;

insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                             memo, received_at, raw, profile_id)
values (pg_temp.c('org')::bigint, 'manual', 'zw-cred', 30000, null,
        now() - interval '20 days', '{}', pg_temp.uid('CRED')),
       (pg_temp.c('org')::bigint, 'manual', 'zw-adv', 45000, null,
        now() - interval '5 days', '{}', pg_temp.uid('ADV'));

------------------------------------------------------------------- controls

insert into probe values
  ('control: four orders with no dish line',
   (select count(*)::text from public.orders o
     where o.org_id = pg_temp.c('org')::bigint and o.status = 'placed'
       and not exists (select 1 from public.order_items oi where oi.order_id = o.id)),
   '4'),
  ('control: OWE owes the older week', pg_temp.balance('OWE'), '60000'),
  ('control: CRED holds credit',       pg_temp.balance('CRED'), '-30000'),
  ('control: ADV paid ahead',          pg_temp.balance('ADV'), '-45000'),
  ('control: week not billed yet',
   (select count(*)::text from public.billing_periods bp
     where bp.org_id = pg_temp.c('org')::bigint
       and pg_temp.c('d1')::date between bp.period_start and bp.period_end), '0');

--------------------------------------------------------------- the tick

select private.run_hourly_tick();

insert into ctx
select 'p1', bp.id::text from public.billing_periods bp
 where bp.org_id = pg_temp.c('org')::bigint
   and pg_temp.c('d1')::date between bp.period_start and bp.period_end;

insert into probe values
  ('T1 the tick billed and closed the week',
   coalesce((select bp.status from public.billing_periods bp
              where bp.id = pg_temp.c('p1')::bigint), 'none'), 'closed'),
  ('T2 one statement per person with a meal',
   (select count(*)::text from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p1')::bigint), '5'),
  ('T3 ZERO: only a dishless order', pg_temp.stmt('p1', 'ZERO'), 'paid 1 0 0 dated'),
  ('T4 ZERO: settled when the week was',
   (select (st.paid_at = now())::text from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p1')::bigint
       and st.profile_id = pg_temp.uid('ZERO')), 'true'),
  ('T5 MIX: the dishless day adds a meal, not money',
   pg_temp.stmt('p1', 'MIX'), 'unpaid 2 45000 0 no-date'),
  ('T6 CRED: a zero week takes none of the credit', pg_temp.stmt('p1', 'CRED'), 'paid 1 0 0 dated'),
  ('T7 CRED: credit intact',                        pg_temp.balance('CRED'), '-30000'),
  ('T8 ADV: paid in advance', pg_temp.stmt('p1', 'ADV'), 'paid 1 45000 45000 dated'),
  ('T9 ADV: settled when the money arrived',
   (select (st.paid_at = now() - interval '5 days')::text from public.billing_statements st
     where st.billing_period_id = pg_temp.c('p1')::bigint
       and st.profile_id = pg_temp.uid('ADV')), 'true'),
  ('T10 OWE: zero week paid, older week still unpaid',
   pg_temp.stmt('p1', 'OWE') || ' / ' || pg_temp.stmt('p0', 'OWE'),
   'paid 1 0 0 dated / unpaid 1 60000 0 no-date'),
  ('T11 nobody who owes nothing is messaged',
   pg_temp.sent('ZERO') || ' / ' || pg_temp.sent('CRED') || ' / ' || pg_temp.sent('ADV'),
   'none / none / none'),
  ('T12 MIX is told the week',
   pg_temp.sent('MIX'),
   'Your lunch for ' || (select to_char(bp.period_start, 'DD/MM') || ' to ' || to_char(bp.period_end, 'DD/MM')
                           from public.billing_periods bp where bp.id = pg_temp.c('p1')::bigint)
     || ': 2 meals, 45.000 ₫. You owe 45.000 ₫ in total. Put ZW LUNCH MIX'
     || ' in the transfer message, the same one every week.'
     || ' It is required: only transfers carrying it reach the lunch app,'
     || ' so one sent without it leaves your bill unpaid with nothing for'
     || ' an admin to find.'),
  ('T13 OWE is told a 0 week and the older debt',
   split_part(pg_temp.sent('OWE'), '. Put ', 1),
   'Your lunch for ' || (select to_char(bp.period_start, 'DD/MM') || ' to ' || to_char(bp.period_end, 'DD/MM')
                           from public.billing_periods bp where bp.id = pg_temp.c('p1')::bigint)
     || ': 1 meal, 0 ₫. You owe 60.000 ₫ in total, earlier weeks included'),
  ('T14 the group hears five people and what they owe',
   coalesce((select split_part(n.body, ' is settled: ', 2) from public.notification_outbox n
              where n.kind = 'weekly_bill' and n.recipient_profile_id is null
                and n.org_id = pg_temp.c('org')::bigint), 'none'),
   '5 people, 90.000 ₫ in total. Your own statement is in the app.');

------------------------------------------------------------ afterwards

-- Only when the tick failed: so R1 shows the error the tick swallowed.
insert into ctx
select 'p1', public.ensure_billing_period(pg_temp.c('org')::bigint, pg_temp.c('d1')::date)::text
on conflict (k) do nothing;

-- Settle week again on the same data: the date a zero week was settled holds.
update public.billing_statements set paid_at = now() - interval '1 day'
 where billing_period_id = pg_temp.c('p1')::bigint and profile_id = pg_temp.uid('ZERO');

insert into probe values
  ('R1 a forced re-bill of the week runs',
   pg_temp.attempt(format('select * from public.run_billing(%s, true)', pg_temp.c('p1'))), 'ok 1'),
  ('R2 ZERO keeps the date it was settled',
   coalesce((select (st.paid_at = now() - interval '1 day')::text from public.billing_statements st
              where st.billing_period_id = pg_temp.c('p1')::bigint
                and st.profile_id = pg_temp.uid('ZERO')), 'none'), 'true');

-- Money arriving for somebody with only a zero week is credit.
insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                             memo, received_at, raw, profile_id)
values (pg_temp.c('org')::bigint, 'manual', 'zw-zero', 10000, null, now(), '{}',
        pg_temp.uid('ZERO'));

insert into probe values
  ('R3 ZERO: payment lands as credit', pg_temp.stmt('p1', 'ZERO') || ' / ' || pg_temp.balance('ZERO'),
   'paid 1 0 0 dated / -10000');

-- A zero week that gains a charge owes it, and goes back to paid when it is
-- taken away. Straight on the lines: this is reallocate's arithmetic, not a
-- correction's.
update public.billing_statements set meals_minor = 30000
 where billing_period_id = pg_temp.c('p1')::bigint and profile_id = pg_temp.uid('OWE');
select private.reallocate(pg_temp.c('org')::bigint, pg_temp.uid('OWE'));
insert into probe values
  ('R4 OWE: a charge on the zero week is owed', pg_temp.stmt('p1', 'OWE'), 'unpaid 1 30000 0 no-date');

update public.billing_statements set meals_minor = 0
 where billing_period_id = pg_temp.c('p1')::bigint and profile_id = pg_temp.uid('OWE');
select private.reallocate(pg_temp.c('org')::bigint, pg_temp.uid('OWE'));
insert into probe values
  ('R5 OWE: back to nothing due, back to paid', pg_temp.stmt('p1', 'OWE'), 'paid 1 0 0 dated');

--------------------------------------------------------------------- verdict

select label, got, want, case when got = want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
