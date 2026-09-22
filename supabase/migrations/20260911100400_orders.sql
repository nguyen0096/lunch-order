-- Orders as header + lines. An "intent to eat, dish not yet chosen" is an order
-- with zero lines; a flat orders.menu_item_id could only express that as a
-- nullable dish plus a nullable price that must be null together.

create table public.orders (
  id           bigint generated always as identity primary key,
  org_id       bigint not null,
  menu_id      bigint not null,
  service_date date   not null,
  profile_id   uuid   not null references public.profiles(id) on delete restrict,
  source       text not null default 'member' check (source in ('member','standing','admin')),
  status       text not null default 'placed' check (status in ('placed','cancelled')),
  placed_at    timestamptz not null default now(),
  cancelled_at timestamptz,
  created_by   uuid not null references public.profiles(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint orders_menu_fk foreign key (menu_id, org_id)
    references public.menus (id, org_id) on update cascade on delete restrict,
  -- You cannot order in an org you do not belong to: the FK has nowhere to point.
  constraint orders_member_fk foreign key (org_id, profile_id)
    references public.memberships (org_id, profile_id) on update cascade on delete restrict,
  -- composite target for order_items
  constraint orders_id_org_profile_menu_uk unique (id, org_id, profile_id, menu_id),
  constraint orders_id_org_uk unique (id, org_id),
  constraint orders_cancelled_ck check ((status = 'cancelled') = (cancelled_at is not null))
);
create unique index orders_menu_profile_uk on public.orders (menu_id, profile_id);
create index orders_profile_date_idx on public.orders (profile_id, service_date desc);
create index orders_org_date_idx     on public.orders (org_id, service_date) where status = 'placed';
create index orders_created_by_idx   on public.orders (created_by);
create trigger orders_set_updated_at before update on public.orders
  for each row execute function extensions.moddatetime(updated_at);
alter table public.orders enable row level security;

create table public.order_items (
  id                 bigint generated always as identity primary key,
  order_id           bigint not null,
  org_id             bigint not null,
  profile_id         uuid   not null,
  menu_id            bigint not null,
  menu_item_id       bigint not null,
  item_name_snapshot text not null,
  unit_price_minor   integer not null check (unit_price_minor >= 0),
  quantity           smallint not null default 1 check (quantity between 1 and 20),
  line_total_minor   integer generated always as (unit_price_minor * quantity) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- org_id/profile_id/menu_id here are denormalized for RLS speed, and this FK
  -- makes it impossible for the copies to disagree with the parent order.
  constraint order_items_order_fk foreign key (order_id, org_id, profile_id, menu_id)
    references public.orders (id, org_id, profile_id, menu_id)
    on update cascade on delete cascade,
  constraint order_items_menu_item_fk foreign key (menu_item_id, menu_id)
    references public.menu_items (id, menu_id) on update cascade on delete restrict
);
-- Two of the same dish is quantity = 2, never two rows: keeps aggregation unambiguous.
create unique index order_items_one_per_dish_uk on public.order_items (order_id, menu_item_id);
create index order_items_profile_idx   on public.order_items (profile_id);
create index order_items_org_idx       on public.order_items (org_id);
create index order_items_menu_item_idx on public.order_items (menu_item_id);
create trigger order_items_set_updated_at before update on public.order_items
  for each row execute function extensions.moddatetime(updated_at);
alter table public.order_items enable row level security;

-- PRICE SNAPSHOT, LAYER 1 of 3.
-- RLS lets a member insert their own order_items, so a hand-crafted PostgREST
-- call could supply unit_price_minor: 0. This overwrites UNCONDITIONALLY --
-- "fill if null" would leave that hole open. Layer 2 is column-level grants
-- (see the grants migration); layer 3 is the snapshot into billing_lines.
create or replace function public.snapshot_order_item() returns trigger
language plpgsql set search_path = '' as $$
declare v_item public.menu_items%rowtype;
begin
  select * into v_item from public.menu_items
   where id = new.menu_item_id and menu_id = new.menu_id;
  if not found then
    raise exception 'dish % is not on this menu', new.menu_item_id
      using errcode = 'foreign_key_violation';
  end if;
  if tg_op = 'INSERT' and not v_item.is_available then
    raise exception '"%" is not available today', v_item.name
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.item_name_snapshot := v_item.name;
  new.unit_price_minor   := v_item.price_minor;
  return new;
end $$;

-- Fires only on menu_item_id, so editing quantity keeps the price the member saw.
create trigger order_items_snapshot
  before insert or update of menu_item_id on public.order_items
  for each row execute function public.snapshot_order_item();

-- Cutoff and menu state live here rather than in RLS. A policy violation
-- surfaces as "new row violates row-level security policy", which tells a user
-- nothing; this raises a message the UI shows verbatim. RLS keeps its
-- index-only shape and answers only "is this row yours".
create or replace function public.enforce_order_window() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_menu public.menus%rowtype;
  v_tz   text;
begin
  if private.is_service() then return coalesce(new, old); end if;

  select * into v_menu from public.menus
   where id = coalesce(new.menu_id, old.menu_id);

  if v_menu.status = 'cancelled' then
    raise exception 'the menu for % was cancelled', v_menu.service_date
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Admins are exempt from the time window on purpose. After the cutoff they
  -- still have to resolve orders that have no dish chosen, and after locking
  -- they are the ones on the phone to the caterer, so they can add a late
  -- order. Members are held to the clock.
  if v_menu.org_id = any ((select private.my_admin_org_ids())::bigint[]) then
    return coalesce(new, old);
  end if;

  if v_menu.status <> 'published' then
    raise exception 'the menu for % is %, not open for ordering',
      v_menu.service_date, v_menu.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if now() >= v_menu.order_cutoff_at then
    select o.timezone into v_tz from public.organizations o where o.id = v_menu.org_id;
    raise exception 'ordering for % closed at %',
      v_menu.service_date,
      to_char(v_menu.order_cutoff_at at time zone v_tz, 'HH24:MI DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end $$;

create trigger orders_window before insert or update or delete on public.orders
  for each row execute function public.enforce_order_window();
create trigger order_items_window before insert or update or delete on public.order_items
  for each row execute function public.enforce_order_window();
