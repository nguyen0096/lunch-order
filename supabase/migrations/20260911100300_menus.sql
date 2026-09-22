-- Menus and their dishes. org_id is carried on every child table and proven
-- consistent by composite FK, which is what keeps org-scoped RLS a single
-- indexed predicate instead of a join on every policy.

create table public.menus (
  id              bigint generated always as identity primary key,
  org_id          bigint not null references public.organizations(id) on delete cascade,
  service_date    date not null,
  status          text not null default 'draft'
                    check (status in ('draft','published','locked','cancelled')),
  order_cutoff_at timestamptz not null,
  -- The caterer's raw chat message, verbatim. The parser will be wrong
  -- sometimes and this is the evidence.
  source_text     text,
  parse_meta      jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  published_by uuid references public.profiles(id),
  locked_at    timestamptz,
  created_by   uuid not null references public.profiles(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint menus_org_date_uk unique (org_id, service_date),
  constraint menus_id_org_uk   unique (id, org_id),
  constraint menus_published_ck check (status <> 'published' or published_at is not null)
);
create index menus_open_idx on public.menus (org_id, service_date) where status = 'published';
create index menus_created_by_idx   on public.menus (created_by);
create index menus_published_by_idx on public.menus (published_by);
create trigger menus_set_updated_at before update on public.menus
  for each row execute function extensions.moddatetime(updated_at);
alter table public.menus enable row level security;

create table public.menu_items (
  id          bigint generated always as identity primary key,
  menu_id     bigint not null,
  org_id      bigint not null,
  name        text not null check (length(btrim(name)) between 1 and 200),
  price_minor integer not null check (price_minor >= 0 and price_minor < 1000000000),
  position    smallint not null default 0,
  is_available boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint menu_items_menu_fk foreign key (menu_id, org_id)
    references public.menus (id, org_id) on update cascade on delete cascade,
  -- composite target so order_items can prove the dish belongs to the order's menu
  constraint menu_items_id_menu_uk unique (id, menu_id)
);
create index menu_items_menu_pos_idx on public.menu_items (menu_id, position, id);
create index menu_items_org_idx      on public.menu_items (org_id);
create unique index menu_items_name_uk on public.menu_items (menu_id, lower(btrim(name)));
create trigger menu_items_set_updated_at before update on public.menu_items
  for each row execute function extensions.moddatetime(updated_at);
alter table public.menu_items enable row level security;

-- Lifecycle is a trigger rather than a set of policies: the legal transitions
-- are a state machine, and expressing one in RLS yields errors a user cannot act on.
create or replace function public.enforce_menu_lifecycle() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
         ('draft','published'), ('draft','cancelled'),
         ('published','locked'), ('published','cancelled'), ('published','draft'),
         ('locked','published'), ('locked','cancelled'))
    then
      raise exception 'illegal menu status transition % -> %', old.status, new.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;

    if new.status = 'published' then
      if not exists (select 1 from public.menu_items mi
                      where mi.menu_id = new.id and mi.is_available) then
        raise exception 'cannot publish a menu with no available dishes'
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      new.published_at := coalesce(new.published_at, now());
      new.published_by := coalesce(new.published_by, (select auth.uid()));
    end if;

    if new.status = 'locked' then
      new.locked_at := coalesce(new.locked_at, now());
    end if;

    -- Un-publishing would orphan orders that already exist, including the
    -- standing ones materialized at publish time.
    if new.status = 'draft'
       and exists (select 1 from public.orders o where o.menu_id = new.id) then
      raise exception 'cannot un-publish: orders already exist for this menu'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  if new.service_date is distinct from old.service_date and old.status <> 'draft' then
    raise exception 'cannot change the service date of a % menu', old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end $$;

create trigger menus_lifecycle before update on public.menus
  for each row execute function public.enforce_menu_lifecycle();

-- Editing a dish on a live menu would silently change what people already
-- ordered. Orders snapshot their price, so history is safe either way, but the
-- resulting split ("two people paid different amounts for the same dish") is a
-- support problem. Force it through an explicit, audited path.
create or replace function public.enforce_menu_item_frozen() returns trigger
language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if private.is_service() then return coalesce(new, old); end if;
  select m.status into v_status from public.menus m
   where m.id = coalesce(new.menu_id, old.menu_id);
  if v_status in ('locked','cancelled') then
    raise exception 'the menu is %; dishes can no longer be changed', v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end $$;

create trigger menu_items_frozen before insert or update or delete on public.menu_items
  for each row execute function public.enforce_menu_item_frozen();
