-- What an admin changed about a past day, and why.
--
-- `orders.created_by` is the only trail there is, and it answers a different
-- question: who first put this row here. It cannot tell "an admin recorded this
-- day as it happened" from "an admin changed it afterwards because the caterer
-- delivered an extra portion", and those are the two facts somebody reading a
-- disputed bill needs to tell apart.
--
-- A table rather than `corrected_at`/`corrected_by` columns on `orders`. A
-- column answers "was this corrected" and nothing else, it keeps only the last
-- correction, and it is a second answer that can disagree with this one. One
-- place per fact: the order says what the record IS, this says what was changed
-- and by whom. The screen joins on `order_id` for the marker it shows.
--
-- `summary` is rendered at write time, for the same reason
-- `notification_outbox.body` is: it has to still say what the admin saw after
-- the dish has been renamed, the menu redrawn or the person has left.

create table public.order_corrections (
  id           bigint generated always as identity primary key,
  org_id       bigint not null references public.organizations(id) on delete cascade,
  service_date date   not null,
  kind         text   not null check (kind in ('meal','off_menu','removal','reprice')),

  -- NO ACTION, not RESTRICT, and the difference is load-bearing. RESTRICT fires
  -- immediately, so it would refuse even a delete that removes this row in the
  -- same statement; NO ACTION waits until the statement ends and sees that the
  -- correction went too. Deleting an order on its own still fails, which is the
  -- point: the trail outlives the screen, never the other way round.
  order_id     bigint references public.orders(id),
  menu_item_id bigint references public.menu_items(id),
  profile_id   uuid   references public.profiles(id),

  summary      text not null,
  reason       text check (reason is null
                           or (length(btrim(reason)) >= 1 and length(btrim(reason)) <= 200)),
  made_by      uuid not null references public.profiles(id),
  made_at      timestamptz not null default now(),

  -- A reprice is about a dish on a day, not about one person's meal, so it
  -- carries no order and no member. Everything else is about one person, and
  -- only an off-menu correction names a dish, because that is the one case
  -- where the correction created it. For an ordinary meal the dish is on the
  -- order's own lines and a copy here would be a second answer.
  constraint order_corrections_shape_ck check (
    case kind
      when 'reprice'  then order_id is null
                       and profile_id is null
                       and menu_item_id is not null
      when 'off_menu' then order_id is not null
                       and profile_id is not null
                       and menu_item_id is not null
      else                 order_id is not null
                       and profile_id is not null
                       and menu_item_id is null
    end)
);

-- The marker the screen needs, and the week it lists.
create index order_corrections_order_idx     on public.order_corrections (order_id);
create index order_corrections_org_date_idx  on public.order_corrections (org_id, service_date desc, id desc);
create index order_corrections_item_idx      on public.order_corrections (menu_item_id);
create index order_corrections_profile_idx   on public.order_corrections (profile_id);
create index order_corrections_made_by_idx   on public.order_corrections (made_by);

alter table public.order_corrections enable row level security;

-- Supabase grants ALL on a new table in `public` to anon and authenticated, and
-- the blanket revoke in 20260911101100_grants.sql ran once, before this table
-- existed. So this is not tidying: without it, a signed-in browser could insert
-- its own version of what happened.
revoke all on public.order_corrections from anon, authenticated;
grant select on public.order_corrections to authenticated;

-- One policy, SELECT only. The RPCs write this table and they run as
-- SECURITY DEFINER, so a browser needs no write path at all -- and with no
-- INSERT, UPDATE or DELETE policy, RLS refuses those even if the grant above is
-- ever widened by accident. Two locks on the same door, as with
-- `org_webhook_secrets`.
--
-- Admin-only, and deliberately not "or your own rows": a reprice has no
-- profile_id, so a member-facing policy would have to invent who it belongs to.
-- What a member is told is the Telegram message, which is written for them.
create policy order_corrections_admin_select on public.order_corrections
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

comment on table public.order_corrections is
  'One row per admin correction to a past day. Written only by the correct_*/remove_meal/reprice_dish RPCs.';
