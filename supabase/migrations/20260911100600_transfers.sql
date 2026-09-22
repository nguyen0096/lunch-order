-- "I registered but someone else ate it." Recipient pays.
--
-- Recording a transfer charges another person money, so it starts pending and
-- becomes real only when the recipient accepts. An org admin recording one
-- (on verbal confirmation from both) inserts it already accepted.

create table public.meal_transfers (
  id              bigint generated always as identity primary key,
  org_id          bigint not null,
  order_id        bigint not null,
  from_profile_id uuid not null,
  to_profile_id   uuid not null,
  status          text not null default 'pending'
                    check (status in ('pending','accepted','declined','cancelled')),
  reason          text,
  created_by      uuid not null references public.profiles(id) on delete restrict,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references public.profiles(id),
  updated_at      timestamptz not null default now(),
  constraint transfers_order_fk foreign key (order_id, org_id)
    references public.orders (id, org_id) on update cascade on delete cascade,
  -- Recipients must be members of the same org: enforced structurally, not in code.
  constraint transfers_to_member_fk foreign key (org_id, to_profile_id)
    references public.memberships (org_id, profile_id) on update cascade on delete restrict,
  constraint transfers_not_self_ck check (to_profile_id <> from_profile_id),
  constraint transfers_decided_ck  check ((status = 'pending') = (decided_at is null))
);
-- At most one live transfer per order. Chains (A->B->C) are deliberately
-- unsupported: cancel and recreate. They only make "who pays" harder to reason about.
create unique index transfers_one_live_uk on public.meal_transfers (order_id)
  where status in ('pending','accepted');
create index transfers_to_idx      on public.meal_transfers (to_profile_id, org_id);
create index transfers_from_idx    on public.meal_transfers (from_profile_id, created_at desc);
create index transfers_created_by_idx on public.meal_transfers (created_by);
create index transfers_decided_by_idx on public.meal_transfers (decided_by);
create trigger meal_transfers_set_updated_at before update on public.meal_transfers
  for each row execute function extensions.moddatetime(updated_at);
alter table public.meal_transfers enable row level security;

create or replace function public.enforce_transfer_rules() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_uid   uuid := (select auth.uid());
  v_admin boolean;
begin
  if private.is_service() then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'order % not found', new.order_id; end if;
  v_admin := v_order.org_id = any ((select private.my_admin_org_ids())::bigint[]);

  -- Never mutate a bill that has already been frozen.
  if exists (select 1 from public.billing_lines bl
               join public.billing_periods bp on bp.id = bl.billing_period_id
              where bl.order_id = new.order_id and bp.status = 'closed') then
    raise exception 'that meal is already on a closed bill'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'INSERT' then
    if v_order.status <> 'placed' then
      raise exception 'cannot transfer a % order', v_order.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.org_id          := v_order.org_id;
    new.from_profile_id := v_order.profile_id;
    if new.created_by <> v_order.profile_id and not v_admin then
      raise exception 'only the person who ordered, or an admin, can pass this meal on'
        using errcode = 'insufficient_privilege';
    end if;
    -- An admin recording it has already confirmed with both people verbally.
    if v_admin then
      new.status := 'accepted'; new.decided_at := now(); new.decided_by := v_uid;
    end if;

  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'this transfer is already %', old.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.status in ('accepted','declined')
       and v_uid is distinct from old.to_profile_id and not v_admin then
      raise exception 'only the person receiving the meal can accept or decline it'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'cancelled'
       and v_uid is distinct from old.from_profile_id and not v_admin then
      raise exception 'only the person who offered the meal can cancel it'
        using errcode = 'insufficient_privilege';
    end if;
    new.decided_at := now();
    new.decided_by := v_uid;
  end if;
  return new;
end $$;

create trigger meal_transfers_rules before insert or update on public.meal_transfers
  for each row execute function public.enforce_transfer_rules();

-- Breaks the orders <-> meal_transfers RLS cycle; see the orders_select_incoming
-- policy. SECURITY DEFINER so the inner read is not itself policy-checked.
create or replace function private.order_offered_to_me(p_order_id bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.meal_transfers t
                  where t.order_id = p_order_id
                    and t.to_profile_id = (select auth.uid())
                    and t.status in ('pending','accepted'));
$$;
grant execute on function private.order_offered_to_me(bigint) to authenticated;
