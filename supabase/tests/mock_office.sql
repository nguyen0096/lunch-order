-- A believable office for manual end-to-end testing: five colleagues on
-- personal addresses, standing orders, a published menu, and a week of history.
--
-- These are real auth.users with email/password logins, so you can actually
-- sign in as each one and see the app as they see it. That requires the Email
-- provider to be enabled in Supabase Auth, with "Confirm email" turned OFF
-- (these rows are pre-confirmed, but new signups would otherwise stall).
--
-- Password for every mock account: lunch1234
--
-- Run teardown_mock_office.sql to remove them. Never run this against a
-- database with real users in the same org.

\set org_slug 'persefoni-vn'

do $$
declare
  v_org bigint;
  v_pw  text := extensions.crypt('lunch1234', extensions.gen_salt('bf'));
  r record;
  v_uid uuid;
begin
  select id into v_org from public.organizations where slug = 'persefoni-vn';
  if v_org is null then raise exception 'org persefoni-vn not found'; end if;

  for r in
    select * from (values
      -- Personal addresses on purpose: this is the invited-member case, not
      -- the auto-join-by-domain one.
      ('mock.mai@gmail.com',   'Mai Phạm',      'member', 2),
      ('mock.binh@gmail.com',  'Bình Trần',     'member', 3),
      ('mock.chi@outlook.com', 'Chi Lê',        'member', 4),
      ('mock.duc@yahoo.com',   'Đức Hoàng',     'admin',  5),
      ('mock.lan@gmail.com',   'Lan Nguyễn',    'member', 6)
    ) as t(email, full_name, role, seq)
  loop
    -- auth.users has no plain unique constraint on email (Supabase uses a
    -- conditional index), so ON CONFLICT cannot bind to it. Check first.
    select id into v_uid from auth.users where email = r.email;
    if v_uid is null then
      v_uid := extensions.uuid_generate_v4();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data)
      values (
        '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
        r.email, v_pw, now(), now(), now(),
        '{"provider":"email","providers":["email"]}',
        jsonb_build_object('full_name', r.full_name));
    end if;

    -- An identity row is what makes email/password sign-in work; the trigger
    -- on auth.users has already created the profile.
    insert into auth.identities (
      provider_id, user_id, identity_data, provider, last_sign_in_at,
      created_at, updated_at)
    values (
      v_uid::text, v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', r.email, 'email_verified', true),
      'email', now(), now(), now())
    on conflict (provider, provider_id) do nothing;

    insert into public.memberships (org_id, profile_id, role, short_code, display_name)
    values (v_org, v_uid, r.role,
            private.suggest_short_code(v_org, v_uid), r.full_name)
    on conflict (org_id, profile_id) do nothing;

    -- A spread of standing orders, so the board has something to show and the
    -- projection has something to project.
    insert into public.standing_orders (org_id, profile_id, weekday, is_enabled)
    select v_org, v_uid, w, true
      from unnest(case r.seq
             when 2 then array[1,3,5]      -- Mon Wed Fri
             when 3 then array[1,2,3,4,5]  -- every weekday
             when 4 then array[2,4]        -- Tue Thu
             when 5 then array[1]          -- Mondays only
             else array[]::int[] end) as w
    on conflict do nothing;
  end loop;
end $$;

select p.email, m.display_name, m.role, m.short_code,
       (select count(*) from public.standing_orders s
         where s.profile_id = m.profile_id) as standing_days
from public.memberships m
join public.profiles p on p.id = m.profile_id
join public.organizations o on o.id = m.org_id
where o.slug = 'persefoni-vn'
order by m.role desc, p.email;
