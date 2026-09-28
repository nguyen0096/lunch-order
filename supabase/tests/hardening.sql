-- Offices, owners, short codes, money and Telegram links: the doors the
-- 20261011 migrations closed, and the ones they left open on purpose.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/hardening.sql
--
-- Builds its own fixtures and rolls everything back.
--
-- The traps from supabase/tests/isolation.sql apply. Each block asserts a
-- positive control that the role really was downgraded, a refusal is judged by
-- SQLSTATE and message rather than by having raised, and a write RLS filters
-- out is judged by the row count it reports, because it raises nothing.
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

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.name)
  from (values
    ('dddddddd-0000-0000-0000-000000000001', 'own@hard.test',  'Chu Nha'),
    ('dddddddd-0000-0000-0000-000000000002', 'adm@hard.test',  'Quan Ly'),
    ('dddddddd-0000-0000-0000-000000000003', 'dinh@hard.test', 'Dinh Thi'),
    ('dddddddd-0000-0000-0000-000000000004', 'teo@hard.test',  'Teo Van'),
    ('dddddddd-0000-0000-0000-000000000005', 'bown@hard.test', 'Be Owner'),
    ('dddddddd-0000-0000-0000-000000000006', 'bao@hard.test',  'Bao Ngoc'),
    ('dddddddd-0000-0000-0000-000000000007', 'new@hard.test',  'Moi Den'),
    ('dddddddd-0000-0000-0000-000000000008', 'qtn@hard.test',  'Quy Tu Nguyen'),
    ('dddddddd-0000-0000-0000-000000000009', 'qtn2@hard.test', 'Quang Thanh Ngo')
  ) as u(id, email, name)
on conflict (id) do nothing;

-- Spaces in the account on purpose: the trigger folds them away.
insert into public.organizations (slug, name, short_code, payment_config, telegram_join_code)
values ('hard-a', 'Hard A', 'HRDA',
        '{"vietqr":{"bankBin":"970436","accountNumber":"1234 5678 90","accountName":"HARD A"}}',
        'HRDJXKNA'),
       ('hard-b', 'Hard B', 'HRDB',
        '{"vietqr":{"bankBin":"970436","accountNumber":"999888777","accountName":"HARD B"}}',
        null),
       ('hard-c', 'Hard C', 'HRDC',
        '{"vietqr":{"bankBin":"970436","accountNumber":"5555666677","accountName":"HARD C"}}',
        null);
update public.organizations set deleted_at = now() where slug = 'hard-c';

insert into public.memberships (org_id, profile_id, role, short_code)
select o.id, u.pid::uuid, u.role, u.code from public.organizations o
join (values
  ('hard-a', 'dddddddd-0000-0000-0000-000000000001', 'owner',  'OWN'),
  ('hard-a', 'dddddddd-0000-0000-0000-000000000002', 'admin',  'ADM'),
  ('hard-a', 'dddddddd-0000-0000-0000-000000000003', 'member', 'DINH'),
  ('hard-a', 'dddddddd-0000-0000-0000-000000000004', 'member', 'TEO'),
  ('hard-a', 'dddddddd-0000-0000-0000-000000000006', 'member', 'BAO'),
  ('hard-a', 'dddddddd-0000-0000-0000-000000000008', 'member', 'QTN'),
  ('hard-b', 'dddddddd-0000-0000-0000-000000000005', 'owner',  'BOWN')
) as u(slug, pid, role, code) on u.slug = o.slug;

insert into ctx
select 'org_a', id::text from public.organizations where slug = 'hard-a' union all
select 'org_b', id::text from public.organizations where slug = 'hard-b' union all
select 'own',  'dddddddd-0000-0000-0000-000000000001' union all
select 'adm',  'dddddddd-0000-0000-0000-000000000002' union all
select 'dinh', 'dddddddd-0000-0000-0000-000000000003' union all
select 'teo',  'dddddddd-0000-0000-0000-000000000004' union all
select 'bown', 'dddddddd-0000-0000-0000-000000000005' union all
select 'bao',  'dddddddd-0000-0000-0000-000000000006' union all
select 'new',  'dddddddd-0000-0000-0000-000000000007';

insert into ctx
select 'm_' || m.short_code, m.id::text from public.memberships m
 where m.org_id = (select v::bigint from ctx where k = 'org_a');

-- Two closed weeks for DINH at 100.000 each, and a legacy weekly reference on
-- TEO's statement that nobody else's code may sit inside.
insert into public.billing_periods (org_id, period_start, period_end, status)
select (select v::bigint from ctx where k = 'org_a'), d, d + 6, 'closed'
  from (values (date '2026-06-01'), (date '2026-06-08')) as w(d);

insert into public.billing_statements (org_id, billing_period_id, profile_id, meal_count, meals_minor, payment_ref)
select bp.org_id, bp.id, p.pid::uuid, 5, 100000, p.ref || to_char(bp.period_start, 'MMDD')
  from public.billing_periods bp
  join (values ('dddddddd-0000-0000-0000-000000000003', 'LUNCHW'),
               ('dddddddd-0000-0000-0000-000000000004', 'LUNCH27TEO')) as p(pid, ref)
    on true
 where bp.org_id = (select v::bigint from ctx where k = 'org_a');

insert into ctx
select 'st_' || to_char(bp.period_start, 'MMDD'), st.id::text
  from public.billing_statements st
  join public.billing_periods bp on bp.id = st.billing_period_id
 where st.profile_id = 'dddddddd-0000-0000-0000-000000000003';
insert into ctx
select 'st_teo', min(st.id)::text from public.billing_statements st
 where st.profile_id = 'dddddddd-0000-0000-0000-000000000004';

-- A bank payment to TEO, and each person's Telegram link, connected.
insert into public.payments (org_id, provider, provider_txn_id, amount_minor, memo, received_at, raw)
values ((select v::bigint from ctx where k = 'org_a'), 'sepay', 'hard-sepay-1', 100000,
        'HRDA LUNCH TEO', now(), '{}');
insert into ctx select 'pay_sepay', id::text from public.payments where provider_txn_id = 'hard-sepay-1';

insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
select m.id, m.org_id, 880000 + m.id, now() from public.memberships m
 where m.org_id = (select v::bigint from ctx where k = 'org_a');

------------------------------------------------- C1: one way to found an office

insert into probe
select 'C1 the account number is stored without its spaces',
       (select payment_config #>> '{vietqr,accountNumber}' from public.organizations where slug = 'hard-a'),
       '1234567890';

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('C1 control: role downgraded', (current_role = 'authenticated')::text, 'true');

  insert into probe values ('C1 a member cannot insert an office directly',
    left(pg_temp.attempt($q$insert into public.organizations (slug, name) values ('squat', 'Squat')$q$), 5),
    '42501');

  perform pg_temp.act_as(pg_temp.c('bown'));
  insert into probe values ('C1 another office cannot take an account in use, spaces or not',
    pg_temp.attempt(format($q$update public.organizations
         set payment_config = '{"vietqr":{"bankBin":"970436","accountNumber":"12 345 678 90"}}'
       where id = %s$q$, pg_temp.c('org_b'))),
    '23505 another office already receives its lunch payments into account 1234567890. One bank account can serve one office.');
  insert into probe values ('C1 an account that is not one is refused',
    pg_temp.attempt(format($q$update public.organizations
         set payment_config = '{"vietqr":{"bankBin":"970436","accountNumber":"1-2"}}'
       where id = %s$q$, pg_temp.c('org_b'))),
    '23514 that account number is not one a bank would accept: 4 to 19 letters or digits');
  insert into probe values ('C1 a deleted office gives its account up',
    pg_temp.attempt(format($q$update public.organizations
         set payment_config = '{"vietqr":{"bankBin":"970436","accountNumber":"5555666677"}}'
       where id = %s$q$, pg_temp.c('org_b'))),
    'ok 1');
  reset role;
end $$;

insert into probe
select 'C1 the rule holds for the service role too',
       left(pg_temp.attempt(format($q$update public.organizations
         set payment_config = jsonb_build_object('vietqr', jsonb_build_object('accountNumber', '1234567890'))
       where id = %s$q$, (select v from ctx where k = 'org_b'))), 5),
       '23505';

insert into probe
select 'C1 organizations grants no INSERT to authenticated or anon',
       (has_table_privilege('authenticated', 'public.organizations', 'insert')
        or has_table_privilege('anon', 'public.organizations', 'insert'))::text,
       'false';

--------------------------------------------------- H1: only an owner makes one

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H1 control: acting as the admin',
    ((select auth.uid())::text = pg_temp.c('adm'))::text, 'true');

  insert into probe values ('H1 an admin cannot insert a membership at all',
    left(pg_temp.attempt(format($q$insert into public.memberships (org_id, profile_id, role, short_code)
         values (%s, '%s', 'owner', 'NEWO')$q$, pg_temp.c('org_a'), pg_temp.c('new'))), 5),
    '42501');

  insert into probe values ('H1 an admin cannot promote a member to owner',
    pg_temp.attempt(format($q$update public.memberships set role = 'owner' where id = %s$q$,
                           pg_temp.c('m_TEO'))),
    '42501 only an owner can appoint or stand down another owner');

  insert into probe values ('H1 an admin still appoints an admin',
    pg_temp.attempt(format($q$update public.memberships set role = 'admin' where id = %s$q$,
                           pg_temp.c('m_TEO'))),
    'ok 1');
  perform pg_temp.attempt(format($q$update public.memberships set role = 'member' where id = %s$q$,
                                 pg_temp.c('m_TEO')));

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('H1 a member cannot switch their own membership off',
    pg_temp.attempt(format($q$update public.memberships set status = 'inactive' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '42501 leave an office from Settings; your own membership cannot be switched on or off directly');
  reset role;
end $$;

-- The trigger measured on its own, with the grant put back for this
-- transaction only: a grant restored by mistake one day must still meet it.
grant insert on public.memberships to authenticated;

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H1 delete-then-reinsert: the delete is an admin''s to make',
    pg_temp.attempt(format($q$delete from public.memberships where id = %s$q$, pg_temp.c('m_BAO'))),
    'ok 1');
  insert into probe values ('H1 delete-then-reinsert: the reinsert as owner is refused',
    pg_temp.attempt(format($q$insert into public.memberships (org_id, profile_id, role, short_code)
         values (%s, '%s', 'owner', 'BAO')$q$, pg_temp.c('org_a'), pg_temp.c('bao'))),
    '42501 only an owner can appoint another owner');

  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('H1 an owner may appoint another owner',
    pg_temp.attempt(format($q$insert into public.memberships (org_id, profile_id, role, short_code)
         values (%s, '%s', 'owner', 'BAO')$q$, pg_temp.c('org_a'), pg_temp.c('bao'))),
    'ok 1');
  reset role;
end $$;

revoke insert on public.memberships from authenticated;

---------------------------------------------------- H2: short codes

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('H2 control: acting as DINH',
    ((select auth.uid())::text = pg_temp.c('dinh'))::text, 'true');

  insert into probe values ('H2 a code containing a colleague''s is refused',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'TEOX' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '23505 TEOX is too close to TEO in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person''s.');
  insert into probe values ('H2 a code inside a colleague''s is refused',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'TE' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '23505 TE is too close to TEO in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person''s.');
  insert into probe values ('H2 a code inside a colleague''s old weekly reference is refused',
    pg_temp.attempt(format($q$update public.memberships set short_code = '27TE' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '23505 27TE is too close to an earlier weekly reference in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person''s.');
  insert into probe values ('H2 a refused code does not use up the change',
    (select short_code_changes::text from public.memberships where id = pg_temp.c('m_DINH')::bigint), '0');

  insert into probe values ('H2 the first change of your own is allowed',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'dnh' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    'ok 1');
  insert into probe values ('H2 it is stored folded, with its reference, and counted',
    (select short_code || ' ' || payment_ref || ' ' || short_code_changes
       from public.memberships where id = pg_temp.c('m_DINH')::bigint),
    'DNH LUNCHDNH 1');
  insert into probe values ('H2 the second change of your own is refused',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'DIN' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '55000 you have already changed your short code once in this office; an admin can change it again for you');
  insert into probe values ('H2 a member cannot reset their own count',
    left(pg_temp.attempt(format($q$update public.memberships set short_code_changes = 0 where id = %s$q$,
                                pg_temp.c('m_DINH'))), 5),
    '42501');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H2 an admin changes anybody''s code, any number of times',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'DIN' where id = %s$q$,
                           pg_temp.c('m_DINH')))
      || ' ' || pg_temp.attempt(format($q$update public.memberships set short_code = 'DINH' where id = %s$q$,
                           pg_temp.c('m_DINH'))),
    'ok 1 ok 1');
  insert into probe values ('H2 and that is not counted against the member',
    (select short_code_changes::text from public.memberships where id = pg_temp.c('m_DINH')::bigint), '1');
  insert into probe values ('H2 an admin changes their own code freely',
    pg_temp.attempt(format($q$update public.memberships set short_code = 'AD' where id = %s$q$,
                           pg_temp.c('m_ADM')))
      || ' ' || pg_temp.attempt(format($q$update public.memberships set short_code = 'ADM' where id = %s$q$,
                           pg_temp.c('m_ADM'))),
    'ok 1 ok 1');
  insert into probe values ('H2 an admin is held to the overlap rule too',
    left(pg_temp.attempt(format($q$update public.memberships set short_code = 'OWNX' where id = %s$q$,
                                pg_temp.c('m_ADM'))), 5),
    '23505');
  reset role;
end $$;

insert into probe
select 'H2 a suggestion steps around an overlap instead of extending it',
       private.suggest_short_code((select v::bigint from ctx where k = 'org_a'),
                                  'dddddddd-0000-0000-0000-000000000009'),
       'QT01';

-- Joining and founding take the code the person picked.
update public.app_settings set enabled = true where key = 'office_creation';

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('new'));
  insert into probe values ('H2 joining with a code that overlaps is refused',
    pg_temp.attempt($q$select * from public.join_with_code('HRDJXKNA', 'Moi Den', null, 'TEO1')$q$),
    '23505 TEO1 is too close to TEO in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person''s.');
  insert into probe values ('H2 joining with a code of your own',
    pg_temp.attempt($q$select * from public.join_with_code('HRDJXKNA', 'Moi Den', null, 'moi')$q$),
    'ok 1');
  insert into probe values ('H2 and it is yours, with the one change still to come',
    (select short_code || ' ' || short_code_changes from public.memberships
      where org_id = pg_temp.c('org_a')::bigint and profile_id = pg_temp.c('new')::uuid),
    'MOI 0');
  insert into probe values ('H2 founding an office with a code of your own',
    pg_temp.attempt($q$select * from public.create_organization('hard-new', 'Hard New', p_short_code => 'MD')$q$),
    'ok 1');
  insert into probe values ('H2 and the founder holds it',
    (select m.short_code || ' ' || m.role from public.memberships m
       join public.organizations o on o.id = m.org_id
      where o.slug = 'hard-new' and m.profile_id = pg_temp.c('new')::uuid),
    'MD owner');
  reset role;
end $$;

------------------------------------------------------------ H3: money

do $$
declare v_pay bigint;
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H3 control: the admin reads payments at all',
    (select count(*)::text from public.payments where org_id = pg_temp.c('org_a')::bigint), '1');

  insert into probe values ('H3 an admin cannot update a payment',
    left(pg_temp.attempt(format($q$update public.payments set profile_id = '%s' where id = %s$q$,
                                pg_temp.c('adm'), pg_temp.c('pay_sepay'))), 5), '42501');
  insert into probe values ('H3 an admin cannot delete a payment',
    left(pg_temp.attempt(format($q$delete from public.payments where id = %s$q$, pg_temp.c('pay_sepay'))), 5),
    '42501');
  insert into probe values ('H3 an admin cannot update a statement',
    left(pg_temp.attempt(format($q$update public.billing_statements set paid_minor = 100000 where id = %s$q$,
                                pg_temp.c('st_0601'))), 5), '42501');
  insert into probe values ('H3 an admin cannot delete a billing line',
    left(pg_temp.attempt(format($q$delete from public.billing_lines where org_id = %s$q$, pg_temp.c('org_a'))), 5),
    '42501');
  insert into probe values ('H3 an admin cannot delete a billing period',
    left(pg_temp.attempt(format($q$delete from public.billing_periods where org_id = %s$q$, pg_temp.c('org_a'))), 5),
    '42501');
  insert into probe values ('H3 an admin cannot record a payment as the bank',
    left(pg_temp.attempt(format($q$insert into public.payments
           (org_id, provider, provider_txn_id, amount_minor, memo, received_at, raw)
         values (%s, 'sepay', 'squatted-txn', 1000, 'x', now(), '{}')$q$, pg_temp.c('org_a'))), 5),
    '42501');

  -- 150.000 against two weeks of 100.000: the first is paid, the second is
  -- where the money got to.
  insert into public.payments (org_id, provider, provider_txn_id, profile_id, amount_minor, memo, received_at, raw)
  values (pg_temp.c('org_a')::bigint, 'manual', 'hard-manual-1', pg_temp.c('dinh')::uuid, 150000,
          'cash', now(), '{"source":"admin"}');
  reset role;
end $$;

insert into ctx select 'pay_manual', id::text from public.payments where provider_txn_id = 'hard-manual-1';

insert into probe
select 'H3 a manual payment with no reference lands on the person named',
       (select profile_id::text from public.payments where id = (select v::bigint from ctx where k = 'pay_manual')),
       (select v from ctx where k = 'dinh');
insert into probe
select 'H3 its weeks are redrawn: one paid, one partial',
       (select string_agg(status || ':' || paid_minor, ',' order by id)
          from public.billing_statements where profile_id = 'dddddddd-0000-0000-0000-000000000003'),
       'paid:100000,partial:50000';
insert into probe
select 'H3 it points at the week the money reached, not at the paid one',
       (select matched_statement_id::text from public.payments where id = (select v::bigint from ctx where k = 'pay_manual')),
       (select v from ctx where k = 'st_0608');

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('H3 a member cannot move a payment',
    pg_temp.attempt(format($q$select * from public.move_payment(%s, '%s')$q$,
                           pg_temp.c('pay_manual'), pg_temp.c('dinh'))),
    '42501 only an admin of this office can move a payment');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H3 an admin moves it to TEO',
    pg_temp.attempt(format($q$select * from public.move_payment(%s, '%s', 'was TEO''s cash')$q$,
                           pg_temp.c('pay_manual'), pg_temp.c('teo'))),
    'ok 1');
  insert into probe values ('H3 moving it where it already is says so',
    pg_temp.attempt(format($q$select * from public.move_payment(%s, '%s')$q$,
                           pg_temp.c('pay_manual'), pg_temp.c('teo'))),
    '55000 that payment is already on Teo Van');
  insert into probe values ('H3 a bank payment cannot be voided',
    pg_temp.attempt(format($q$select public.void_payment(%s, 'no')$q$, pg_temp.c('pay_sepay'))),
    '55000 only a payment recorded by hand can be voided; money the bank reported did arrive, so move it to the right person instead');
  insert into probe values ('H3 a void needs a reason',
    pg_temp.attempt(format($q$select public.void_payment(%s, '  ')$q$, pg_temp.c('pay_manual'))),
    '22023 say why this payment is being voided; the next admin to read the record will ask');
  reset role;
end $$;

insert into probe
select 'H3 after the move DINH owes both weeks again',
       (select string_agg(status || ':' || paid_minor, ',' order by id)
          from public.billing_statements where profile_id = 'dddddddd-0000-0000-0000-000000000003'),
       'unpaid:0,unpaid:0';
insert into probe
select 'H3 and TEO holds the money',
       (select credited_minor::text from public.v_account_balance
         where profile_id = 'dddddddd-0000-0000-0000-000000000004'
           and org_id = (select v::bigint from ctx where k = 'org_a')),
       '250000';

do $$
begin
  set local role authenticated;
  -- The owner, holding no admin row: an owner passes every door an admin does.
  perform pg_temp.act_as(pg_temp.c('own'));
  insert into probe values ('H3 an owner voids the manual payment',
    pg_temp.attempt(format($q$select public.void_payment(%s, 'typed twice')$q$, pg_temp.c('pay_manual'))),
    'ok 1');
  insert into probe values ('H3 a voided payment cannot be moved',
    pg_temp.attempt(format($q$select * from public.move_payment(%s, '%s')$q$,
                           pg_temp.c('pay_manual'), pg_temp.c('dinh'))),
    '55000 that payment was voided, so there is no money in it to move');

  insert into probe values ('H3 an owner waives a week',
    pg_temp.attempt(format($q$select public.waive_statement(%s, 'birthday')$q$, pg_temp.c('st_0601'))),
    'ok 1');

  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('H3 a member cannot waive their own week',
    pg_temp.attempt(format($q$select public.waive_statement(%s)$q$, pg_temp.c('st_0608'))),
    '42501 only an admin of this office can waive a week');
  reset role;
end $$;

insert into probe
select 'H3 the voided money counts towards nobody',
       (select credited_minor::text from public.v_account_balance
         where profile_id = 'dddddddd-0000-0000-0000-000000000004'
           and org_id = (select v::bigint from ctx where k = 'org_a')),
       '100000';
insert into probe
select 'H3 the waived week is waived, and paid_at is clear',
       (select status || ':' || coalesce(paid_at::text, 'null') || ':' || (marked_paid_by::text = (select v from ctx where k = 'own'))
          from public.billing_statements where id = (select v::bigint from ctx where k = 'st_0601')),
       'waived:null:true';
insert into probe
select 'H3 every door left a row on the record',
       (select string_agg(kind || ':' || coalesce(reason, '-') || ':' || summary, ' | ' order by id)
          from public.payment_corrections where org_id = (select v::bigint from ctx where k = 'org_a')),
       'move:was TEO''s cash:Moved 150.000 ₫ from Dinh Thi to Teo Van | void:typed twice:Voided 150.000 ₫ recorded by hand for Teo Van | waive:birthday:Waived Dinh Thi''s week of 01/06, 100.000 ₫';

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('H3 a member reads no correction',
    (select count(*)::text from public.payment_corrections), '0');
  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('H3 an admin reads them',
    (select count(*)::text from public.payment_corrections), '3');
  reset role;
end $$;

------------------------------------------------------- M1: Telegram links

do $$
begin
  set local role authenticated;
  perform pg_temp.act_as(pg_temp.c('dinh'));
  insert into probe values ('M1 control: DINH reads their own link',
    (select count(*)::text from public.telegram_links where membership_id = pg_temp.c('m_DINH')::bigint), '1');

  insert into probe values ('M1 a member cannot move their link to another office',
    left(pg_temp.attempt(format($q$update public.telegram_links set org_id = %s where membership_id = %s$q$,
                                pg_temp.c('org_b'), pg_temp.c('m_DINH'))), 5), '42501');
  insert into probe values ('M1 a member cannot point their link at a chat',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = 12345 where membership_id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '42501 a chat is connected from Telegram, by opening the link the app gives you');
  insert into probe values ('M1 a member can disconnect',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = null where membership_id = %s$q$,
                           pg_temp.c('m_DINH'))),
    'ok 1');

  perform pg_temp.act_as(pg_temp.c('adm'));
  insert into probe values ('M1 an admin cannot connect a colleague''s chat',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = 777 where membership_id = %s$q$,
                           pg_temp.c('m_DINH'))),
    '42501 a chat is connected from Telegram, by opening the link the app gives you');
  insert into probe values ('M1 an admin can disconnect a colleague',
    pg_temp.attempt(format($q$update public.telegram_links set chat_id = null where membership_id = %s$q$,
                           pg_temp.c('m_TEO'))),
    'ok 1');
  insert into probe values ('M1 an admin cannot delete a link',
    pg_temp.attempt(format($q$delete from public.telegram_links where membership_id = %s$q$,
                           pg_temp.c('m_OWN'))),
    'ok 0');
  reset role;
end $$;

insert into probe
select 'M1 a link naming an office its membership is not in is refused, whoever writes it',
       left(pg_temp.attempt(format($q$update public.telegram_links set org_id = %s where membership_id = %s$q$,
                                   (select v from ctx where k = 'org_b'), (select v from ctx where k = 'm_TEO'))), 5),
       '23503';

-------------------------------------------------- M2 and the loose ends

insert into probe
select 'M2 reallocate takes a lock before it reads',
       (pg_get_functiondef('private.reallocate(bigint, uuid)'::regprocedure) like '%pg_advisory_xact_lock%')::text,
       'true';

insert into probe
select 'L the private money helpers are nobody''s to call',
       (has_function_privilege('authenticated', 'private.reallocate(bigint, uuid)', 'execute')
        or has_function_privilege('authenticated', 'private.run_billing_inner(bigint, boolean)', 'execute')
        or has_function_privilege('authenticated', 'private.payer_from_memo(bigint, text)', 'execute'))::text,
       'false';

insert into probe
select 'L v_account_balance is read-only to members and closed to anon',
       (has_table_privilege('authenticated', 'public.v_account_balance', 'select')
        and not has_table_privilege('authenticated', 'public.v_account_balance', 'insert')
        and not has_table_privilege('authenticated', 'public.v_account_balance', 'truncate')
        and not has_table_privilege('anon', 'public.v_account_balance', 'select'))::text,
       'true';

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
