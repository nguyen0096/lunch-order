-- An admin passing on their OWN meal needs the recipient's consent like anyone
-- else. Only an admin recording someone ELSE'S arrangement skips it.
--
-- The original condition was just `if v_admin then accept`, which conflated
-- two different acts:
--
--   admin gives away their own lunch  -> a colleague is charged with no say.
--                                        Being an admin does not make that
--                                        consensual; they are still the sender.
--   admin records a swap between two  -> they have confirmed it with both
--   other members                        people, which IS the consent, and
--                                        making the recipient re-accept in the
--                                        app is friction for nothing.
--
-- So the test is not "are they an admin" but "are they the sender". An admin
-- acting as sender goes through acceptance; an admin acting as recorder does not.

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

    -- Recording someone else's arrangement, not giving away your own meal.
    if v_admin and new.created_by <> v_order.profile_id then
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
