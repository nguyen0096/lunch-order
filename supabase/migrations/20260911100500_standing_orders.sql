-- Weekday rules, materialized EAGERLY into real orders when a menu publishes.
--
-- Eager beats lazy on four counts: a computed-on-read order has no row for RLS
-- to attach to; overriding is then a plain UPDATE rather than negative-override
-- tombstones; the headcount an admin must defend to the caterer stays a
-- count(*); and non-retroactivity is free, whereas the lazy version needs
-- bitemporal rules whose subtle bugs silently rewrite billing history.
-- The dividend: no effective_from/effective_to and no exclusion constraint here.

create table public.standing_orders (
  org_id     bigint not null,
  profile_id uuid   not null,
  weekday    smallint not null check (weekday between 1 and 7),   -- ISO: 1=Mon
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (org_id, profile_id, weekday),
  constraint standing_member_fk foreign key (org_id, profile_id)
    references public.memberships (org_id, profile_id) on update cascade on delete cascade
);
create index standing_orders_lookup_idx on public.standing_orders (org_id, weekday)
  where is_enabled;
create trigger standing_orders_set_updated_at before update on public.standing_orders
  for each row execute function extensions.moddatetime(updated_at);
alter table public.standing_orders enable row level security;

-- 'skip' suppresses the rule for one date; 'force' opts in on a date the rule
-- does not cover, which is how someone pre-declares before a menu even exists.
create table public.standing_order_exceptions (
  org_id       bigint not null,
  profile_id   uuid   not null,
  service_date date   not null,
  action       text   not null check (action in ('skip','force')),
  created_at   timestamptz not null default now(),
  primary key (org_id, profile_id, service_date),
  constraint standing_exc_member_fk foreign key (org_id, profile_id)
    references public.memberships (org_id, profile_id) on update cascade on delete cascade
);
create index standing_exc_date_idx on public.standing_order_exceptions (org_id, service_date);
alter table public.standing_order_exceptions enable row level security;

-- Idempotent by construction. Republishing inserts nothing the second time, and
-- cannot resurrect an order the member already cancelled: that row still holds
-- the (menu_id, profile_id) slot, so the conflict fires and nothing happens.
create or replace function public.materialize_standing_orders(p_menu_id bigint)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_menu public.menus%rowtype;
  v_dow  int;
  v_n    int := 0;
begin
  select * into v_menu from public.menus where id = p_menu_id for update;
  if not found                       then raise exception 'menu % not found', p_menu_id; end if;
  if v_menu.status <> 'published'    then return 0; end if;
  if now() >= v_menu.order_cutoff_at then return 0; end if;

  v_dow := extract(isodow from v_menu.service_date)::int;

  with candidate as (
      select so.profile_id
        from public.standing_orders so
        join public.memberships m
          on m.org_id = so.org_id and m.profile_id = so.profile_id and m.status = 'active'
       where so.org_id = v_menu.org_id and so.weekday = v_dow and so.is_enabled
         and not exists (
               select 1 from public.standing_order_exceptions e
                where e.org_id = so.org_id and e.profile_id = so.profile_id
                  and e.service_date = v_menu.service_date and e.action = 'skip')
    union
      select e.profile_id
        from public.standing_order_exceptions e
        join public.memberships m
          on m.org_id = e.org_id and m.profile_id = e.profile_id and m.status = 'active'
       where e.org_id = v_menu.org_id and e.service_date = v_menu.service_date
         and e.action = 'force'
  ),
  inserted as (
    insert into public.orders
      (org_id, menu_id, service_date, profile_id, source, status, placed_at, created_by)
    select v_menu.org_id, v_menu.id, v_menu.service_date, c.profile_id,
           'standing', 'placed', now(), c.profile_id
      from candidate c
    on conflict (menu_id, profile_id) do nothing
    returning 1
  )
  select count(*)::int into v_n from inserted;
  return v_n;
end $$;

-- Sweep every menu still open for orders. Safe to call any number of times;
-- this is what catches a member who sets a rule after the menu was published.
create or replace function public.materialize_open_menus() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_total int := 0; r record;
begin
  for r in select m.id from public.menus m
            join public.organizations o on o.id = m.org_id and o.status = 'active'
           where m.status = 'published' and m.order_cutoff_at > now()
           order by m.service_date
  loop
    v_total := v_total + public.materialize_standing_orders(r.id);
  end loop;
  return v_total;
end $$;

-- Statement-level, not row-level: the sweep is global, so once per statement.
create or replace function public.trg_standing_materialize() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.materialize_open_menus(); return null; end $$;

create trigger standing_orders_materialize
  after insert or update of is_enabled on public.standing_orders
  for each statement execute function public.trg_standing_materialize();

create trigger standing_exceptions_materialize
  after insert or update of action on public.standing_order_exceptions
  for each statement execute function public.trg_standing_materialize();
