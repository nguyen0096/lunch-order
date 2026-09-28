-- Money arriving is announced: the payer is told, an unmatched transfer
-- reaches the office's admins and owners, and nothing else is sent.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/payment_notifications.sql
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

-- A bank transfer as outbox-drain's sibling, the sepay function, writes it.
create function pg_temp.bank(p_org text, p_txn text, p_amount integer, p_memo text) returns bigint
language plpgsql as $fn$
declare v_id bigint;
begin
  insert into public.payments (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
  values (pg_temp.c(p_org)::bigint, p_txn, p_amount, p_memo,
          timestamptz '2026-10-13 05:30:00+00', '{}')
  on conflict on constraint payments_provider_txn_uk do nothing
  returning id into v_id;
  return v_id;
end $fn$;

-- What the outbox holds for one payment, as kind:recipient-code, sorted.
create function pg_temp.sent(p_payment bigint) returns text
language sql stable as $fn$
  select coalesce(string_agg(ob.kind || ':' || m.short_code, ',' order by ob.kind, m.short_code), '(none)')
    from public.notification_outbox ob
    join public.memberships m on m.org_id = ob.org_id and m.profile_id = ob.recipient_profile_id
   where ob.dedupe_key like '%:payment\_%:' || p_payment || ':profile:%'
$fn$;

create function pg_temp.body(p_payment bigint, p_code text) returns text
language sql stable as $fn$
  select ob.body
    from public.notification_outbox ob
    join public.memberships m on m.org_id = ob.org_id and m.profile_id = ob.recipient_profile_id
   where ob.dedupe_key like '%:payment\_%:' || p_payment || ':profile:%'
     and m.short_code = p_code
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('abababab-0000-0000-0000-000000000001', 'own@pay.test',  'Chu Nha'),
    ('abababab-0000-0000-0000-000000000002', 'adm@pay.test',  'Quan Ly'),
    ('abababab-0000-0000-0000-000000000003', 'nol@pay.test',  'Khong Lien'),
    ('abababab-0000-0000-0000-000000000004', 'dinh@pay.test', 'Dinh Thi'),
    ('abababab-0000-0000-0000-000000000005', 'teo@pay.test',  'Teo Van'),
    ('abababab-0000-0000-0000-000000000006', 'bao@pay.test',  'Bao Ngoc'),
    ('abababab-0000-0000-0000-000000000007', 'gone@pay.test', 'Da Di'),
    ('abababab-0000-0000-0000-000000000008', 'bown@pay.test', 'Be Owner'),
    ('abababab-0000-0000-0000-000000000009', 'badm@pay.test', 'Be Admin'),
    ('abababab-0000-0000-0000-00000000000a', 'rmv@pay.test',  'Bi Moi')
  ) as u(id, email, name)
on conflict (id) do nothing;

insert into public.organizations (slug, name, short_code)
values ('pay-a', 'Pay A', 'PAYA'), ('pay-b', 'Pay B', 'PAYB');

insert into public.memberships (org_id, profile_id, role, short_code, status)
select o.id, u.pid::uuid, u.role, u.code, u.status from public.organizations o
join (values
  ('pay-a', 'abababab-0000-0000-0000-000000000001', 'owner',  'OWN',  'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000002', 'admin',  'ADM',  'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000003', 'admin',  'NOL',  'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000004', 'member', 'DINH', 'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000005', 'member', 'TEO',  'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000006', 'member', 'BAO',  'active'),
  ('pay-a', 'abababab-0000-0000-0000-000000000007', 'member', 'GONE', 'inactive'),
  ('pay-a', 'abababab-0000-0000-0000-00000000000a', 'member', 'RMV',  'active'),
  ('pay-b', 'abababab-0000-0000-0000-000000000008', 'owner',  'BOWN', 'active'),
  ('pay-b', 'abababab-0000-0000-0000-000000000009', 'admin',  'BADM', 'active')
) as u(slug, pid, role, code, status) on u.slug = o.slug;

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'pay-a' union all
select 'org_b', id::text from public.organizations where slug = 'pay-b' union all
select 'own',  'abababab-0000-0000-0000-000000000001' union all
select 'adm',  'abababab-0000-0000-0000-000000000002' union all
select 'dinh', 'abababab-0000-0000-0000-000000000004' union all
select 'teo',  'abababab-0000-0000-0000-000000000005' union all
select 'bao',  'abababab-0000-0000-0000-000000000006' union all
select 'bown', 'abababab-0000-0000-0000-000000000008' union all
select 'rmv',  'abababab-0000-0000-0000-00000000000a' union all
select 'm_rmv', id::text from public.memberships
 where profile_id = 'abababab-0000-0000-0000-00000000000a';

-- Everybody connected except TEO and NOL. GONE's link outlived the removal.
insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 770000 + m.id, now() from public.memberships m
 where m.org_id in (pg_temp.c('org_a')::bigint, pg_temp.c('org_b')::bigint)
   and m.short_code not in ('TEO', 'NOL');

-- One closed week of 100.000 for DINH.
insert into public.billing_periods (org_id, period_start, period_end, status)
values (pg_temp.c('org_a')::bigint, date '2026-10-05', date '2026-10-11', 'closed');
insert into public.billing_statements (org_id, billing_period_id, profile_id, meal_count, meals_minor, payment_ref)
select bp.org_id, bp.id, pg_temp.c('dinh')::uuid, 5, 100000, 'PAYW1005DINH'
  from public.billing_periods bp where bp.org_id = pg_temp.c('org_a')::bigint;

------------------------------------------------------ P: the payer is told

insert into ctx values ('p1', pg_temp.bank('org_a', 'pay-1', 40000, 'PAYA LUNCHDINH')::text);

insert into probe values ('P1 a matched transfer queues one message, to the payer',
  pg_temp.sent(pg_temp.c('p1')::bigint), 'payment_ack:DINH');
insert into probe values ('P1 it says what arrived and what is still owed',
  pg_temp.body(pg_temp.c('p1')::bigint, 'DINH'),
  'Received 40.000 ₫ for lunch at Pay A. You owe 60.000 ₫.');
insert into probe values ('P1 to the payer''s own linked chat, as plain text',
  (select ob.chat_id = tl.chat_id and ob.parse_mode = 'none' and ob.org_id = pg_temp.c('org_a')::bigint
     from public.notification_outbox ob
     join public.memberships m on m.org_id = ob.org_id and m.profile_id = ob.recipient_profile_id
     join public.telegram_links tl on tl.membership_id = m.id
    where ob.kind = 'payment_ack' and ob.recipient_profile_id = pg_temp.c('dinh')::uuid)::text,
  'true');

insert into probe values ('P2 a redelivery of the same transfer inserts nothing',
  coalesce(pg_temp.bank('org_a', 'pay-1', 40000, 'PAYA LUNCHDINH')::text, '(none)'), '(none)');
insert into probe values ('P2 and queues nothing',
  (select count(*)::text from public.notification_outbox
    where kind = 'payment_ack' and recipient_profile_id = pg_temp.c('dinh')::uuid), '1');

insert into ctx values ('p3', pg_temp.bank('org_a', 'pay-3', 60000, 'lunchdinh thanks')::text);
insert into probe values ('P3 paying off the rest says so',
  pg_temp.body(pg_temp.c('p3')::bigint, 'DINH'),
  'Received 60.000 ₫ for lunch at Pay A. You are all paid up.');

-- Recorded by an admin in the browser, which holds no grant on the outbox.
do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into public.payments (org_id, provider, provider_txn_id, profile_id, amount_minor, memo, received_at, raw)
  values (pg_temp.c('org_a')::bigint, 'manual', 'pay-cash-bao', pg_temp.c('bao')::uuid, 5000,
          'cash', now(), '{"source":"admin"}');
  reset role;
end $$;
insert into ctx select 'p4', id::text from public.payments where provider_txn_id = 'pay-cash-bao';
insert into probe values ('P4 cash an admin records tells the person, who is now in credit',
  pg_temp.body(pg_temp.c('p4')::bigint, 'BAO'),
  'Received 5.000 ₫ for lunch at Pay A. You are 5.000 ₫ in credit.');

insert into ctx values ('p5', pg_temp.bank('org_a', 'pay-5', 30000, 'LUNCHTEO')::text);
insert into probe values ('P5 a payer with no linked chat is sent nothing',
  pg_temp.sent(pg_temp.c('p5')::bigint), '(none)');
insert into probe values ('P5 and the money still reached them',
  (select profile_id::text from public.payments where id = pg_temp.c('p5')::bigint), pg_temp.c('teo'));

insert into ctx values ('p6', pg_temp.bank('org_a', 'pay-6', 30000, 'LUNCHGONE')::text);
insert into probe values ('P6 a removed member is not messaged, linked or not',
  pg_temp.sent(pg_temp.c('p6')::bigint), '(none)');

-- RMV is linked and active until an admin removes them from People, which is
-- the path that stamps removed_at.
do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('P7 an admin removes RMV',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_rmv'))), 'ok 1');
  reset role;
end $$;
insert into probe values ('P7 control: the removal is on the record and the link outlived it',
  (select m.status || ' ' || (m.removed_at is not null)::text || ' ' || m.removed_by::text
          || ' ' || (tl.chat_id is not null)::text
     from public.memberships m left join public.telegram_links tl on tl.membership_id = m.id
    where m.id = pg_temp.c('m_rmv')::bigint),
  'inactive true ' || pg_temp.c('adm') || ' true');

insert into ctx values ('p7', pg_temp.bank('org_a', 'pay-7', 30000, 'LUNCHRMV')::text);
insert into probe values ('P7 a member removed by an admin is not messaged about money arriving',
  (select count(*)::text from public.notification_outbox
    where kind = 'payment_ack' and recipient_profile_id = pg_temp.c('rmv')::uuid), '0');
insert into probe values ('P7 control: the transfer did arrive',
  (select count(*)::text from public.payments where id = pg_temp.c('p7')::bigint), '1');

------------------------------------------- U: an unmatched transfer is raised

insert into ctx values ('u1', pg_temp.bank('org_a', 'pay-u1', 25000, 'tien com <b>&amp; Tuan')::text);
insert into probe values ('U1 it reaches the office''s linked admins and owners, and nobody else',
  pg_temp.sent(pg_temp.c('u1')::bigint), 'payment_unmatched:ADM,payment_unmatched:OWN');
insert into probe values ('U1 with the amount, the time, the memo verbatim and where to fix it',
  pg_temp.body(pg_temp.c('u1')::bigint, 'OWN'),
  '25.000 ₫ arrived for Pay A at 12:30 on 13/10 and matched nobody. Transfer message: "tien com <b>&amp; Tuan". Open Payments in the app to assign it to somebody.');
insert into probe values ('U1 as plain text, so nothing in the memo is markup',
  (select string_agg(distinct parse_mode, ',') from public.notification_outbox
    where dedupe_key like '%:payment_unmatched:' || pg_temp.c('u1') || ':%'), 'none');

insert into ctx values ('u2', pg_temp.bank('org_a', 'pay-u2', 1000, '')::text);
insert into probe values ('U2 an empty memo is said to be empty',
  pg_temp.body(pg_temp.c('u2')::bigint, 'ADM'),
  '1.000 ₫ arrived for Pay A at 12:30 on 13/10 and matched nobody. It came with no transfer message. Open Payments in the app to assign it to somebody.');

insert into ctx values ('u3', pg_temp.bank('org_a', 'pay-u3', 1000, repeat('x', 300))::text);
insert into probe values ('U3 a long memo is cut at 200 characters',
  (select length(substring(pg_temp.body(pg_temp.c('u3')::bigint, 'ADM') from '"([^"]*)"'))::text), '203');

insert into ctx values ('u4', pg_temp.bank('org_b', 'pay-u4', 9000, 'PAYA LUNCHDINH')::text);
insert into probe values ('U4 another office''s transfer naming A''s reference matches nobody there',
  (select coalesce(profile_id::text, '(none)') from public.payments where id = pg_temp.c('u4')::bigint), '(none)');
insert into probe values ('U4 and reaches that office''s admins and owners only',
  pg_temp.sent(pg_temp.c('u4')::bigint), 'payment_unmatched:BADM,payment_unmatched:BOWN');

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into public.payments (org_id, provider, provider_txn_id, amount_minor, memo, received_at, raw)
  values (pg_temp.c('org_a')::bigint, 'manual', 'pay-cash-nobody', 7000, 'float', now(), '{}');
  reset role;
end $$;
insert into probe values ('U5 cash recorded on nobody is not raised with the admins',
  pg_temp.sent((select id from public.payments where provider_txn_id = 'pay-cash-nobody')), '(none)');

-------------------------------------------------------------- S: the switch

insert into public.org_notifications (org_id, kind, enabled)
values (pg_temp.c('org_a')::bigint, 'payment_ack', false),
       (pg_temp.c('org_a')::bigint, 'payment_unmatched', false);

insert into ctx values ('s1', pg_temp.bank('org_a', 'pay-s1', 1000, 'LUNCHDINH')::text);
insert into ctx values ('s2', pg_temp.bank('org_a', 'pay-s2', 1000, 'no reference')::text);
insert into ctx values ('s3', pg_temp.bank('org_b', 'pay-s3', 1000, 'no reference')::text);
insert into probe values ('S1 switched off, the payer is told nothing',
  pg_temp.sent(pg_temp.c('s1')::bigint), '(none)');
insert into probe values ('S1 and the money is still credited',
  (select profile_id::text from public.payments where id = pg_temp.c('s1')::bigint), pg_temp.c('dinh'));
insert into probe values ('S2 switched off, the admins are told nothing',
  pg_temp.sent(pg_temp.c('s2')::bigint), '(none)');
insert into probe values ('S3 one office''s switch leaves another office alone',
  pg_temp.sent(pg_temp.c('s3')::bigint), 'payment_unmatched:BADM,payment_unmatched:BOWN');

delete from public.org_notifications where org_id = pg_temp.c('org_a')::bigint;

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('S4 an admin may store the switch for both kinds',
    pg_temp.attempt(format($q$insert into public.org_notifications (org_id, kind, enabled)
        values (%s, 'payment_ack', true), (%s, 'payment_unmatched', true)$q$,
        pg_temp.c('org_a'), pg_temp.c('org_a'))), 'ok 2');
  reset role;
end $$;
delete from public.org_notifications where org_id = pg_temp.c('org_a')::bigint;

------------------------------------------------- M: moving and voiding money

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  perform public.move_payment(pg_temp.c('u1')::bigint, pg_temp.c('dinh')::uuid, null);
  reset role;
end $$;
insert into probe values ('M1 applying a stray to somebody tells them, once',
  (select count(*)::text from public.notification_outbox
    where dedupe_key = 'org:' || pg_temp.c('org_a') || ':payment_ack:' || pg_temp.c('u1')
                       || ':profile:' || pg_temp.c('dinh')), '1');
insert into probe values ('M1 and says an admin matched it',
  pg_temp.body(pg_temp.c('u1')::bigint, 'DINH'),
  'Received 25.000 ₫ for lunch at Pay A, sent on 13/10 and matched to you by an admin. You are 26.000 ₫ in credit.');

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  perform public.move_payment(pg_temp.c('u1')::bigint, pg_temp.c('bao')::uuid, null);
  perform public.void_payment(pg_temp.c('p4')::bigint, 'counted twice');
  reset role;
end $$;
insert into probe values ('M2 moving it on from one person to another tells nobody new',
  pg_temp.sent(pg_temp.c('u1')::bigint),
  'payment_ack:DINH,payment_unmatched:ADM,payment_unmatched:OWN');
insert into probe values ('M3 voiding cash tells nobody',
  pg_temp.sent(pg_temp.c('p4')::bigint), 'payment_ack:BAO');

------------------------------------------- I: the office and the browser

insert into probe values ('I1 every payment message is addressed inside its own office',
  (select count(*)::text from public.notification_outbox ob
    where ob.kind in ('payment_ack','payment_unmatched')
      and not exists (select 1 from public.memberships m join public.telegram_links tl on tl.membership_id = m.id
                       where m.org_id = ob.org_id and m.profile_id = ob.recipient_profile_id
                         and tl.chat_id = ob.chat_id)), '0');

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('I2 another office''s owner reads none of A''s payment messages',
    (select count(*)::text from public.notification_outbox
      where org_id = pg_temp.c('org_a')::bigint), '0');
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('I3 a member reads none, their own receipt included',
    (select count(*)::text from public.notification_outbox), '0');
  insert into probe values ('I4 a member cannot queue a payment message',
    left(pg_temp.attempt(format($q$insert into public.notification_outbox
           (org_id, dedupe_key, kind, chat_id, body, parse_mode)
         values (%s, 'x', 'payment_ack', 1, 'Received a lot', 'none')$q$, pg_temp.c('org_a'))), 5), '42501');
  reset role;
end $$;

insert into probe
select 'I5 the enqueue is not callable from a browser',
       has_function_privilege('authenticated', 'private.queue_payment_notice(bigint, boolean)', 'execute')::text,
       'false';

------------------------------------------------------------ T: the test

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('T1 an admin with no payment of their own gets a reason, not a receipt',
    pg_temp.attempt(format('select public.send_test_notification(%s, %L)', pg_temp.c('org_a'), 'payment_ack')),
    'P0002 you have no payment on record here yet, so there is no receipt to preview');
  insert into probe values ('T2 the unmatched alert previews the latest stray',
    pg_temp.attempt(format('select public.send_test_notification(%s, %L)', pg_temp.c('org_a'), 'payment_unmatched')),
    'ok 1');
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('T3 a member cannot ask for a test',
    left(pg_temp.attempt(format('select public.send_test_notification(%s, %L)', pg_temp.c('org_a'), 'payment_ack')), 5),
    '42501');
  reset role;
end $$;

insert into probe values ('T2 to the asking admin alone, previewing the real message',
  (select string_agg(m.short_code || ':' || (ob.body like 'Test message, sent to you alone.%'
                       and ob.body like '%1.000 ₫ arrived for Pay A%')::text, ',')
     from public.notification_outbox ob
     join public.memberships m on m.org_id = ob.org_id and m.profile_id = ob.recipient_profile_id
    where ob.dedupe_key like '%:test:payment_unmatched:%'), 'ADM:true');

insert into public.payments (org_id, provider, provider_txn_id, profile_id, amount_minor, memo, received_at, raw)
values (pg_temp.c('org_a')::bigint, 'manual', 'pay-cash-own', pg_temp.c('own')::uuid, 2000, 'cash', now(), '{}');
do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('T4 an owner with a payment previews their own receipt',
    pg_temp.attempt(format('select public.send_test_notification(%s, %L)', pg_temp.c('org_a'), 'payment_ack')),
    'ok 1');
  reset role;
end $$;
insert into probe values ('T4 which reads as the real one does',
  (select body from public.notification_outbox where dedupe_key like '%:test:payment_ack:%'),
  E'Test message, sent to you alone. This is what your office receives.\n\nReceived 2.000 ₫ for lunch at Pay A. You are 2.000 ₫ in credit.');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
