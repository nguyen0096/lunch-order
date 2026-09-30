-- The office's template for the caterer's order: which templates the database
-- refuses, and who may save one.
-- Run against a scratch project or branch:
--   psql "$DATABASE_URL" -f supabase/tests/caterer_template.sql
--
-- Builds its own fixtures and rolls everything back.

begin;

create temp table probe (label text, got text, want text);

create temp table ctx (k text primary key, v text);
grant select on ctx to authenticated;

create function pg_temp.c(p_key text) returns text
language sql stable as $fn$ select v from ctx where k = p_key $fn$;

-- Saves a template as a signed-in person and answers the rows it changed, or
-- the refusal's SQLSTATE and constraint.
create function pg_temp.save_as(p_who text, p_org text, p_template text) returns text
language plpgsql as $fn$
declare
  v text;
  n int;
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', pg_temp.c(p_who)), true);
  set local role authenticated;
  begin
    update public.organizations set caterer_message_template = p_template
     where id = pg_temp.c(p_org)::bigint;
    get diagnostics n = row_count;
    v := n || ' row';
  exception when others then
    v := sqlstate || ' ' || coalesce(nullif(pg_temp.constraint_of(sqlerrm), ''), sqlerrm);
  end;
  reset role;
  return v;
end $fn$;

create function pg_temp.constraint_of(p_msg text) returns text
language sql immutable as $fn$ select substring(p_msg from '"([a-z_]+_ck)"') $fn$;

create function pg_temp.template_of(p_org text) returns text
language sql stable as $fn$
  select coalesce(caterer_message_template, '<null>') from public.organizations
   where id = pg_temp.c(p_org)::bigint;
$fn$;

------------------------------------------------------------------- fixtures

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated',
       u.code || '@catertpl.test', 'x', now(), now(), now(), '{"provider":"google"}',
       jsonb_build_object('full_name', u.code)
  from (values
    ('0c7e0000-0000-0000-0000-000000000001', 'own'),
    ('0c7e0000-0000-0000-0000-000000000002', 'adm'),
    ('0c7e0000-0000-0000-0000-000000000003', 'mem'),
    ('0c7e0000-0000-0000-0000-000000000004', 'badm')
  ) as u(id, code)
on conflict (id) do nothing;

insert into ctx
select split_part(email, '@', 1), id::text from auth.users where email like '%@catertpl.test';

insert into public.organizations (slug, name, short_code)
values ('catertpl-a', 'Cater A', 'CTA'), ('catertpl-b', 'Cater B', 'CTB');
insert into ctx
select 'org_a', id::text from public.organizations where slug = 'catertpl-a' union all
select 'org_b', id::text from public.organizations where slug = 'catertpl-b';

insert into public.memberships (org_id, profile_id, role, short_code)
values
  (pg_temp.c('org_a')::bigint, pg_temp.c('own')::uuid,  'owner',  'OWN'),
  (pg_temp.c('org_a')::bigint, pg_temp.c('adm')::uuid,  'admin',  'ADM'),
  (pg_temp.c('org_a')::bigint, pg_temp.c('mem')::uuid,  'member', 'MEM'),
  (pg_temp.c('org_b')::bigint, pg_temp.c('badm')::uuid, 'admin',  'BADM');

--------------------------------------------------------------------- checks

-- One statement per check, in order: a check reads what the ones before it
-- wrote, which rows of a single VALUES list would not see.
insert into probe values ('T1 an office starts on the default', pg_temp.template_of('org_a'), '<null>');
insert into probe values ('T2 an owner saves a template with every placeholder',
   pg_temp.save_as('own', 'org_a',
     'Chào chị, {companyName} {servingDate}\n{dishes}\n{total} {unchosen}'), '1 row');
insert into probe values ('T3 an admin saves one too', pg_temp.save_as('adm', 'org_a', 'Đặt {dishes}'), '1 row');
insert into probe values ('T4 and it is what is stored', pg_temp.template_of('org_a'), 'Đặt {dishes}');
insert into probe values ('T5 null goes back to the default', pg_temp.save_as('adm', 'org_a', null), '1 row');
insert into probe values ('T6 without {dishes} is refused',
   pg_temp.save_as('adm', 'org_a', 'Đặt cơm {servingDate}'),
   '23514 organizations_caterer_message_template_ck');
insert into probe values ('T7 an unknown placeholder is refused',
   pg_temp.save_as('adm', 'org_a', '{dishes} {dish}'),
   '23514 organizations_caterer_message_template_ck');
insert into probe values ('T8 braces that are not a placeholder are kept',
   pg_temp.save_as('adm', 'org_a', '{dishes} :-{ }'), '1 row');
insert into probe values ('T9 over 2000 characters is refused',
   pg_temp.save_as('adm', 'org_a', '{dishes}' || repeat('a', 2000)),
   '23514 organizations_caterer_message_template_ck');
insert into probe values ('T10 a member changes nothing', pg_temp.save_as('mem', 'org_a', 'Mem {dishes}'), '0 row');
insert into probe values ('T11 an admin of another office changes nothing',
   pg_temp.save_as('badm', 'org_a', 'B {dishes}'), '0 row');
insert into probe values ('T12 so the template is the last one an admin of A saved',
   pg_temp.template_of('org_a'), '{dishes} :-{ }');

--------------------------------------------------------------------- verdict

select label, got, want, case when got is not distinct from want then 'PASS' else 'FAIL' end as verdict
from probe order by label;

select case when exists (select 1 from probe where got is distinct from want)
            then 'SOME CHECKS FAILED' else 'ALL PASS' end as summary;

rollback;
