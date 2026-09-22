-- Organizations, global profiles, and the membership join that scopes everything.

create table public.organizations (
  id       bigint generated always as identity primary key,
  slug     text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name     text not null check (length(btrim(name)) between 1 and 120),
  timezone text not null default 'Asia/Ho_Chi_Minh',
  currency char(3) not null default 'VND',
  -- 0 for VND (no sub-unit), 2 for USD. Amounts everywhere are integer minor units.
  currency_minor_units smallint not null default 0 check (currency_minor_units between 0 and 4),
  locale   text not null default 'vi-VN',
  default_cutoff_local_time time not null default '16:00',
  billing_week_starts_on smallint not null default 1 check (billing_week_starts_on between 1 and 7),
  -- Optional convenience: anyone signing in with this domain joins automatically.
  auto_join_email_domain text check (auto_join_email_domain is null
                                     or auto_join_email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  telegram_group_chat_id bigint,
  -- Non-secret VietQR parameters only. Provider credentials live in Vault.
  payment_config jsonb not null default '{}'::jsonb,
  status   text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_slug_uk on public.organizations (lower(slug));
create unique index organizations_autojoin_uk
  on public.organizations (lower(auto_join_email_domain))
  where auto_join_email_domain is not null;
create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function extensions.moddatetime(updated_at);
alter table public.organizations enable row level security;

-- Global identity: one row per auth user, no org. Signup is open; you see
-- nothing until you accept an invitation or create an org.
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_uk on public.profiles (lower(email));
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function extensions.moddatetime(updated_at);
alter table public.profiles enable row level security;

-- The org-scoped person. Other tables carry (org_id, profile_id) directly and
-- point here by composite FK, so RLS never needs a join.
create table public.memberships (
  id         bigint generated always as identity primary key,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  profile_id uuid   not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('member','admin','owner')),
  display_name text,
  -- Unique within the org, ASCII: it ends up in bank transfer memos, which
  -- strip diacritics.
  short_code text not null check (short_code ~ '^[A-Z0-9]{2,8}$'),
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_uk      unique (org_id, profile_id),
  constraint memberships_code_uk unique (org_id, short_code)
);
create index memberships_profile_idx on public.memberships (profile_id) where status = 'active';
create index memberships_org_idx     on public.memberships (org_id) where status = 'active';
create trigger memberships_set_updated_at before update on public.memberships
  for each row execute function extensions.moddatetime(updated_at);
alter table public.memberships enable row level security;

-- Org scoping. Returns an ARRAY rather than taking an org_id argument: the
-- planner hoists a zero-argument stable function into an InitPlan evaluated once
-- per statement, whereas is_member_of(org_id) would be a call per row.
create or replace function private.my_org_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
   where m.profile_id = (select auth.uid()) and m.status = 'active';
$$;

create or replace function private.my_admin_org_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(m.org_id), '{}')
    from public.memberships m
   where m.profile_id = (select auth.uid()) and m.status = 'active'
     and m.role in ('admin','owner');
$$;

grant execute on function private.my_org_ids(), private.my_admin_org_ids() to authenticated;

create table public.invitations (
  id         bigint generated always as identity primary key,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  email      text not null,
  role       text not null default 'member' check (role in ('member','admin')),
  token      uuid not null default gen_random_uuid(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  invited_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint invitations_token_uk unique (token),
  constraint invitations_email_uk unique (org_id, email)
);
create index invitations_email_idx on public.invitations (lower(email)) where accepted_at is null;
alter table public.invitations enable row level security;

-- Keyed on membership, not profile: one person may belong to two orgs with
-- different Telegram groups. Separate table because memberships is readable by
-- everyone in the org (the transfer picker needs names) and RLS cannot hide a
-- column -- a link token there would be readable by every colleague.
create table public.telegram_links (
  membership_id bigint primary key references public.memberships(id) on delete cascade,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  chat_id    bigint,
  link_token uuid not null default gen_random_uuid(),
  linked_at  timestamptz,
  updated_at timestamptz not null default now()
);
create unique index telegram_links_token_uk on public.telegram_links (link_token);
create unique index telegram_links_chat_uk  on public.telegram_links (org_id, chat_id)
  where chat_id is not null;
create trigger telegram_links_set_updated_at before update on public.telegram_links
  for each row execute function extensions.moddatetime(updated_at);
alter table public.telegram_links enable row level security;

-- Provision a profile on signup. No domain restriction: this is a product, so
-- anyone may authenticate. Visibility is governed by membership, not by email.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, lower(new.email),
          coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
                   nullif(btrim(new.raw_user_meta_data->>'name'), ''),
                   split_part(new.email, '@', 1)),
          new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Nobody may change their own role, not even an owner: privilege escalation
-- would otherwise be a single PATCH away.
create or replace function public.enforce_membership_role() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.is_service() then return new; end if;
  if new.role is distinct from old.role and new.profile_id = (select auth.uid()) then
    raise exception 'you cannot change your own role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger memberships_role_guard before update on public.memberships
  for each row execute function public.enforce_membership_role();

-- Short, ASCII, unique within the org. Derived from the name where possible so
-- a human can recognise it in a bank memo, with a numeric suffix on collision.
create or replace function private.suggest_short_code(p_org_id bigint, p_profile_id uuid)
returns text language plpgsql stable set search_path = '' as $$
declare v_base text; v_try text; v_n int := 0;
begin
  select upper(regexp_replace(public.unaccent_fallback(coalesce(p.full_name, p.email)), '[^A-Za-z0-9]', '', 'g'))
    into v_base from public.profiles p where p.id = p_profile_id;
  v_base := coalesce(nullif(left(v_base, 4), ''), 'USER');
  loop
    v_try := case when v_n = 0 then v_base else left(v_base, 3) || v_n::text end;
    exit when not exists (select 1 from public.memberships m
                           where m.org_id = p_org_id and m.short_code = v_try);
    v_n := v_n + 1;
    if v_n > 999 then raise exception 'could not allocate a short code'; end if;
  end loop;
  return v_try;
end $$;

-- The unaccent extension is not enabled by default on this project and is not
-- worth a dependency for one call, so fold the Vietnamese diacritics we care
-- about by hand. Bank memos strip them anyway.
create or replace function public.unaccent_fallback(p text) returns text
language sql immutable set search_path = '' as $$
  select translate(p,
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ' ||
    'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd' ||
    'AAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD');
$$;

-- Creating an org makes you its owner, in the same transaction, so there is no
-- window in which an org exists with nobody able to administer it.
create or replace function public.create_organization(
  p_slug text, p_name text, p_timezone text default 'Asia/Ho_Chi_Minh',
  p_currency char(3) default 'VND', p_currency_minor_units smallint default 0,
  p_locale text default 'vi-VN')
returns public.organizations
language plpgsql security definer set search_path = '' as $$
declare v_org public.organizations; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.organizations (slug, name, timezone, currency, currency_minor_units, locale)
  values (lower(btrim(p_slug)), btrim(p_name), p_timezone, p_currency,
          p_currency_minor_units, p_locale)
  returning * into v_org;
  insert into public.memberships (org_id, profile_id, role, short_code)
  values (v_org.id, v_uid, 'owner', private.suggest_short_code(v_org.id, v_uid));
  return v_org;
end $$;

-- Timezone validation. This cannot be a CHECK constraint: resolving a zone name
-- is not IMMUTABLE, and Postgres rejects non-immutable functions there.
create or replace function public.enforce_org_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'unknown timezone %', new.timezone using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;

create trigger organizations_tz_guard before insert or update of timezone
  on public.organizations
  for each row execute function public.enforce_org_timezone();
