-- An admin's pass is always on the record: the direct table write is closed.
--
-- enforce_transfer_rules still let an admin insert a pass on somebody else's
-- meal straight into meal_transfers, and made it accepted at once. That pass
-- re-billed the week but wrote no order_corrections row and told nobody:
-- meal_transfers_notify_offer fires only for a pending insert, and
-- trg_transfer_notifies had nothing else to send. An admin could also answer
-- or withdraw somebody else's offer with a plain update, which sent the
-- member-style transfer_decided and wrote no audit row either.
--
-- Now a browser (and the Telegram bot, which acts as the member) may only
-- offer their own meal, answer an offer made to them, or withdraw their own.
-- Admins included: on somebody else's pass an admin uses record_pass,
-- answer_pass or undo_pass, which audit, re-bill and tell both people.
--
-- Those three are SECURITY DEFINER, so they run as the function owner and
-- pass private.is_service(), which a browser cannot: it is current_user, not
-- a setting. lunch.pass_by_admin stays what it was, a hint that keeps
-- trg_transfer_notifies quiet while an RPC sends its own words, and is not
-- what admits anybody here.
--
-- created_by is taken from the session rather than the row, so an admin
-- cannot pass somebody else's meal by naming its owner as the creator. And a
-- member's window (until the day is done) now holds for an admin on the
-- table too, as the Board already did.

create or replace function public.enforce_transfer_rules()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_order public.orders%rowtype;
  v_uid   uuid := (select auth.uid());
  v_stage text;
begin
  if private.is_service() then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'order % not found', new.order_id; end if;

  -- Who first, so an admin on somebody else's pass is told where to go
  -- whatever the day.
  if tg_op = 'INSERT' and v_uid is distinct from v_order.profile_id then
    raise exception 'only the person who ordered can offer this meal; an admin records a pass on the Orders screen'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE'
     and v_uid is distinct from old.from_profile_id and v_uid is distinct from old.to_profile_id then
    raise exception 'only the two people on a pass can change it; an admin answers or undoes it on the Orders screen'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.billing_lines bl
               join public.billing_periods bp on bp.id = bl.billing_period_id
              where bl.order_id = new.order_id and bp.status = 'closed') then
    raise exception 'that meal is already on a closed bill'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_stage := private.order_stage(new.order_id);
  if v_stage = 'done' then
    raise exception 'lunch on % is over, so it can no longer be passed to anybody',
      to_char(v_order.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'INSERT' then
    if v_order.status <> 'placed' then
      raise exception 'cannot transfer a % order', v_order.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.org_id          := v_order.org_id;
    new.from_profile_id := v_order.profile_id;
    new.created_by      := v_uid;
    new.status          := 'pending';
    new.decided_at      := null;
    new.decided_by      := null;
    new.undone_at       := null;
    new.undone_by       := null;

  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      if old.status <> 'pending' then
        raise exception 'this transfer is already %', old.status
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      if new.status not in ('accepted', 'declined', 'cancelled') then
        raise exception 'a pass can only be accepted, declined or withdrawn'
          using errcode = 'check_violation';
      end if;
      if new.status in ('accepted', 'declined') and v_uid is distinct from old.to_profile_id then
        raise exception 'only the person receiving the meal can accept or decline it'
          using errcode = 'insufficient_privilege';
      end if;
      if new.status = 'cancelled' and v_uid is distinct from old.from_profile_id then
        raise exception 'only the person who offered the meal can cancel it'
          using errcode = 'insufficient_privilege';
      end if;
      new.decided_at := now();
      new.decided_by := v_uid;
    end if;
  end if;
  return new;
end $function$;
