-- An admin records, answers and undoes a pass, on the record.
--
-- Until now an admin recorded a pass by inserting a meal_transfers row, which
-- enforce_transfer_rules made accepted at once. Nobody was told, nothing went
-- into order_corrections, and nothing returned a balance. An accepted pass
-- could not be undone at all: the trigger refuses any change from `accepted`.
--
-- Three RPCs, each one transaction, audited, messaged and re-billed:
--
--   * record_pass(order, to, reason): a pass that is accepted at once.
--   * answer_pass(pass, 'accept' | 'decline' | 'withdraw', reason): a member's
--     waiting offer, answered or withdrawn on their behalf.
--   * undo_pass(pass, reason): an accepted pass reversed. It ends as `undone`,
--     a status of its own, so the record can tell "never happened" (declined,
--     cancelled) from "happened and was reversed".
--
-- Re-billing is the existing meal_transfers_rebill trigger, which now fires on
-- `undone` too. Each pass write is also an order_corrections row, which gains a
-- transfer_id and four kinds.
--
-- Lock order. A member answering an offer updates the pass row and then, from
-- meal_transfers_rebill, waits on the billing week. So these take the pass row
-- before the week, never after it: menu (FOR SHARE) -> pass -> week -> order.
-- Taking the week first deadlocks against a member's own accept. The order is
-- taken FOR NO KEY UPDATE: a member's offer holds its pass slot and then takes
-- the order FOR KEY SHARE through its foreign key, which FOR UPDATE would block.
--
-- A missing row and another office's row get one answer, 42501, so nobody can
-- probe ids across offices.
--
-- enforce_transfer_rules is also tightened for browsers. A member's insert is
-- always a pending offer, whatever status it carries, and the only change a
-- browser may make is from pending to accepted, declined or cancelled. Before,
-- a member could insert their own offer as `accepted` and charge a colleague
-- without asking, and a pending offer could be set to any status.

------------------------------------------------------------------ the columns

alter table public.meal_transfers drop constraint meal_transfers_status_check;
alter table public.meal_transfers add constraint meal_transfers_status_check
  check (status in ('pending', 'accepted', 'declined', 'cancelled', 'undone'));

-- decided_at and decided_by keep the acceptance; these say who reversed it.
alter table public.meal_transfers
  add column undone_at timestamptz,
  add column undone_by uuid references public.profiles(id);
alter table public.meal_transfers add constraint transfers_undone_ck
  check ((status = 'undone') = (undone_at is not null and undone_by is not null));
create index transfers_undone_by_idx on public.meal_transfers (undone_by);

alter table public.order_corrections
  add column transfer_id bigint references public.meal_transfers(id);
create index order_corrections_transfer_idx on public.order_corrections (transfer_id);

alter table public.order_corrections drop constraint order_corrections_kind_check;
alter table public.order_corrections add constraint order_corrections_kind_check
  check (kind in ('meal', 'off_menu', 'removal', 'reprice',
                  'pass', 'pass_declined', 'pass_withdrawn', 'pass_undone'));

alter table public.order_corrections drop constraint order_corrections_shape_ck;
alter table public.order_corrections add constraint order_corrections_shape_ck check (
  case
    when kind = 'reprice' then order_id is null and profile_id is null
                           and menu_item_id is not null and transfer_id is null
    when kind = 'off_menu' then order_id is not null and profile_id is not null
                            and menu_item_id is not null and transfer_id is null
    when kind like 'pass%' then order_id is not null and profile_id is not null
                            and menu_item_id is null and transfer_id is not null
    else order_id is not null and profile_id is not null
     and menu_item_id is null and transfer_id is null
  end);

comment on table public.order_corrections is
  'One row per admin change to the record. Written only by the correct_*, remove_meal, reprice_dish and *_pass RPCs.';

------------------------------------------------------------ the browser's path

-- As in 20261001100000, with a member's insert held to a pending offer and a
-- browser's update held to answering one.
create or replace function public.enforce_transfer_rules()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_order public.orders%rowtype;
  v_uid   uuid := (select auth.uid());
  v_admin boolean;
  v_stage text;
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

  if not v_admin then
    v_stage := private.order_stage(new.order_id);
    if v_stage = 'done' then
      raise exception 'lunch on % is over, so it can no longer be passed to anybody',
        to_char(v_order.service_date, 'DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if v_order.status <> 'placed' then
      raise exception 'cannot transfer a % order', v_order.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.org_id          := v_order.org_id;
    new.from_profile_id := v_order.profile_id;
    new.undone_at       := null;
    new.undone_by       := null;

    if new.created_by <> v_order.profile_id and not v_admin then
      raise exception 'only the person who ordered, or an admin, can pass this meal on'
        using errcode = 'insufficient_privilege';
    end if;

    -- Recording someone else's arrangement, not giving away your own meal.
    if v_admin and new.created_by <> v_order.profile_id then
      new.status := 'accepted'; new.decided_at := now(); new.decided_by := v_uid;
    else
      new.status := 'pending'; new.decided_at := null; new.decided_by := null;
    end if;

  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'this transfer is already %', old.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.status not in ('accepted', 'declined', 'cancelled') then
      raise exception 'a pass can only be accepted, declined or withdrawn'
        using errcode = 'check_violation';
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
end $function$;

-- As in 20261009100200, silent while an admin's RPC answers the offer: that RPC
-- tells both people in its own words.
create or replace function public.trg_transfer_notifies()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_to   uuid;
  v_kind text;
  v_key  text;
  v_body text;
begin
  if current_setting('lunch.pass_by_admin', true) = 'on' then return null; end if;

  if tg_op = 'INSERT' then
    v_to   := new.to_profile_id;
    v_kind := 'transfer_offer';
    v_key  := 'org:' || new.org_id || ':transfer_offer:' || new.id;
    v_body := private.transfer_offer_message(new.id);
  else
    v_to   := new.from_profile_id;
    v_kind := 'transfer_decided';
    v_key  := 'org:' || new.org_id || ':transfer_decided:' || new.id || ':' || new.status;
    v_body := private.transfer_decided_message(new.id);
  end if;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
  select new.org_id, v_key, v_kind, tl.chat_id, v_to, v_body, 'none'
    from public.memberships mem
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
   where mem.org_id = new.org_id
     and mem.profile_id = v_to
     and mem.status = 'active'
  on conflict (dedupe_key) do nothing;

  return null;
end $fn$;

drop trigger if exists meal_transfers_rebill on public.meal_transfers;
create trigger meal_transfers_rebill
  after insert or update of status on public.meal_transfers
  for each row
  when (new.status in ('accepted', 'declined', 'cancelled', 'undone'))
  execute function public.trg_transfer_rebills();

------------------------------------------------------------------- the words

-- The meal as one phrase: `Bún bò Huế, 50.000 ₫`, or `lunch` with no dish.
create or replace function private.meal_phrase(p_order_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select coalesce(private.order_dishes(p_order_id) || ', '
                    || private.order_amount_text(p_order_id),
                  'no dish recorded');
$fn$;

-- The audit row's line, rendered when it is written.
create or replace function private.pass_summary(p_transfer_id bigint, p_event text)
returns text
language sql
stable
set search_path to ''
as $fn$
  select private.member_name(t.org_id, t.from_profile_id) || ': '
      || private.meal_phrase(o.id) || ' on ' || to_char(o.service_date, 'DD/MM') || ', '
      || case p_event
           when 'recorded'  then 'passed to ' || private.member_name(t.org_id, t.to_profile_id)
           when 'accepted'  then 'passed to ' || private.member_name(t.org_id, t.to_profile_id)
                                 || ', accepted for them'
           when 'declined'  then 'offer to ' || private.member_name(t.org_id, t.to_profile_id)
                                 || ' declined for them'
           when 'withdrawn' then 'offer to ' || private.member_name(t.org_id, t.to_profile_id)
                                 || ' withdrawn'
           else 'pass to ' || private.member_name(t.org_id, t.to_profile_id) || ' undone'
         end
    from public.meal_transfers t
    join public.orders o on o.id = t.order_id
   where t.id = p_transfer_id;
$fn$;

-- One reader's message: what the admin did, from where this reader stands,
-- the reason if one was given, and their own balance.
create or replace function private.pass_body(
  p_transfer_id bigint, p_recipient uuid, p_actor uuid, p_reason text, p_event text)
returns text
language plpgsql
stable
set search_path to ''
as $fn$
declare
  t      public.meal_transfers%rowtype;
  o      public.orders%rowtype;
  v_by   text;
  v_from text;
  v_to   text;
  v_day  text;
  v_meal text;
  v_giver boolean;
  v_lines text[];
begin
  select * into t from public.meal_transfers where id = p_transfer_id;
  select * into o from public.orders where id = t.order_id;
  v_by    := private.member_name(t.org_id, p_actor);
  v_from  := private.member_name(t.org_id, t.from_profile_id);
  v_to    := private.member_name(t.org_id, t.to_profile_id);
  v_day   := to_char(o.service_date, 'DD/MM');
  v_meal  := private.meal_phrase(o.id);
  v_giver := p_recipient = t.from_profile_id;

  v_lines := array[case p_event
    when 'recorded' then case when v_giver
      then v_by || ' recorded that ' || v_to || ' had your lunch on ' || v_day
           || ' (' || v_meal || '), so it is on ' || v_to || '''s bill rather than yours.'
      else v_by || ' recorded that you had ' || v_from || '''s lunch on ' || v_day
           || ' (' || v_meal || '), so it is on your bill.' end
    when 'accepted' then case when v_giver
      then v_by || ' accepted your lunch on ' || v_day || ' (' || v_meal || ') for '
           || v_to || ', so it is on ' || v_to || '''s bill rather than yours.'
      else v_by || ' accepted ' || v_from || '''s lunch on ' || v_day
           || ' (' || v_meal || ') for you, so it is on your bill.' end
    when 'declined' then case when v_giver
      then v_by || ' declined your lunch on ' || v_day || ' for ' || v_to
           || ', so it is still yours and on your bill.'
      else v_by || ' declined ' || v_from || '''s lunch on ' || v_day
           || ' for you, so nothing moved to your bill.' end
    when 'withdrawn' then case when v_giver
      then v_by || ' withdrew your offer of lunch on ' || v_day || ' to ' || v_to
           || ', so it is still yours and on your bill.'
      else v_by || ' withdrew ' || v_from || '''s offer of lunch on ' || v_day
           || ', so there is nothing to answer.' end
    else case when v_giver
      then v_by || ' undid the pass of your lunch on ' || v_day || ' (' || v_meal
           || ') to ' || v_to || ', so it is back on your bill.'
      else v_by || ' undid the pass of ' || v_from || '''s lunch on ' || v_day
           || ' (' || v_meal || '), so it is no longer on your bill.' end
  end];

  -- Verbatim, and safe because parse_mode is 'none'.
  if p_reason is not null then
    v_lines := v_lines || p_reason;
  end if;

  v_lines := v_lines || private.balance_line(t.org_id, p_recipient);
  return array_to_string(v_lines, E'\n');
end $fn$;

-- Both people, each with Telegram linked and still in the office, once each.
create or replace function private.enqueue_pass(
  p_transfer_id bigint, p_period_id bigint, p_actor uuid, p_reason text, p_event text)
returns void
language plpgsql
set search_path to ''
as $fn$
declare t public.meal_transfers%rowtype;
begin
  select * into t from public.meal_transfers where id = p_transfer_id;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
     related_billing_period_id)
  select t.org_id,
         'org:' || t.org_id || ':bill_correction:transfer:' || t.id || ':' || p_event
           || ':profile:' || r.who::text || ':'
           || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         'bill_correction',
         tl.chat_id,
         r.who,
         private.pass_body(t.id, r.who, p_actor, p_reason, p_event),
         'none',
         p_period_id
    from unnest(array[t.from_profile_id, t.to_profile_id]) as r(who)
    join public.memberships mem
      on mem.org_id = t.org_id and mem.profile_id = r.who and mem.status = 'active'
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
  on conflict (dedupe_key) do nothing;
end $fn$;

------------------------------------------------------------------ the RPCs

-- "Tèo's lunch went to Dinh." Accepted at once: the admin has the agreement.
-- An admin's own meal is recorded the same way, audited and messaged like
-- anybody else's; the Board still sends their own offer through acceptance.
create or replace function public.record_pass(
  p_order_id bigint, p_to_profile_id uuid, p_reason text default null)
returns table(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor    uuid := (select auth.uid());
  v_reason   text;
  o          public.orders%rowtype;
  v_status   text;
  v_period   bigint;
  v_live     public.meal_transfers%rowtype;
  v_transfer bigint;
begin
  -- A missing order and another office's get the same answer, so an id
  -- cannot be probed across offices.
  select * into o from public.orders where id = p_order_id;
  if not found or not (o.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  if p_to_profile_id is not distinct from o.profile_id then
    raise exception 'a meal cannot be passed to the person whose meal it is'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.org_id = o.org_id and m.profile_id = p_to_profile_id
                    and m.status = 'active') then
    raise exception 'that person is not a member of this office'
      using errcode = 'no_data_found';
  end if;

  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  v_period := private.correction_period(o.org_id, o.service_date);

  select * into o from public.orders where id = p_order_id for no key update;
  if o.status <> 'placed' then
    raise exception 'nothing is recorded for % on %, so there is no meal to pass',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- No chains: one live pass per meal. A plain read, because a pass row is
  -- never taken after the week; the unique index is the backstop for a member
  -- offering it in the same instant.
  select * into v_live from public.meal_transfers t
   where t.order_id = o.id and t.status in ('pending', 'accepted');
  if found then
    if v_live.status = 'pending' then
      raise exception '%''s lunch on % is already offered to %, so answer or withdraw that offer first',
        private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
        private.member_name(o.org_id, v_live.to_profile_id)
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    raise exception '%''s lunch on % is already passed to %, so undo that pass first',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
      private.member_name(o.org_id, v_live.to_profile_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  begin
    insert into public.meal_transfers
      (org_id, order_id, from_profile_id, to_profile_id, status, reason,
       created_by, decided_at, decided_by)
    values (o.org_id, o.id, o.profile_id, p_to_profile_id, 'accepted', v_reason,
            v_actor, now(), v_actor)
    returning id into v_transfer;
  exception when unique_violation then
    -- A member's offer took the slot while this waited on it. Read again, as
    -- that offer has committed, and say whose it is.
    select * into v_live from public.meal_transfers t
     where t.order_id = o.id and t.status in ('pending', 'accepted');
    raise exception '%''s lunch on % is already offered to %, so answer or withdraw that offer first',
      private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM'),
      coalesce(private.member_name(o.org_id, v_live.to_profile_id), 'somebody')
      using errcode = 'object_not_in_prerequisite_state';
  end;

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (o.org_id, o.service_date, 'pass', o.id, o.profile_id, v_transfer,
          private.pass_summary(v_transfer, 'recorded'), v_reason, v_actor);

  perform private.enqueue_pass(v_transfer, v_period, v_actor, v_reason, 'recorded');

  return query select v_transfer,
                      private.account_balance(o.org_id, o.profile_id),
                      private.account_balance(o.org_id, p_to_profile_id);
end $fn$;

-- A member's waiting offer, answered or withdrawn for them.
create or replace function public.answer_pass(
  p_transfer_id bigint, p_answer text, p_reason text default null)
returns table(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  t        public.meal_transfers%rowtype;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
  v_new    text;
  v_event  text;
  v_kind   text;
begin
  select * into t from public.meal_transfers where id = p_transfer_id;
  if not found or not (t.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  case p_answer
    when 'accept'   then v_new := 'accepted';  v_event := 'accepted';  v_kind := 'pass';
    when 'decline'  then v_new := 'declined';  v_event := 'declined';  v_kind := 'pass_declined';
    when 'withdraw' then v_new := 'cancelled'; v_event := 'withdrawn'; v_kind := 'pass_withdrawn';
    else
      raise exception 'an offer is answered with accept, decline or withdraw'
        using errcode = 'check_violation';
  end case;

  select * into o from public.orders where id = t.order_id;
  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  select * into t from public.meal_transfers where id = p_transfer_id for no key update;
  v_period := private.correction_period(t.org_id, o.service_date);
  select * into o from public.orders where id = t.order_id for no key update;

  if t.status <> 'pending' then
    raise exception 'that offer has already been answered: it is %',
      case t.status when 'cancelled' then 'withdrawn' else t.status end
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_new = 'accepted' then
    if o.status <> 'placed' then
      raise exception 'nothing is recorded for % on %, so there is no meal to accept',
        private.member_name(o.org_id, o.profile_id), to_char(o.service_date, 'DD/MM')
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if not exists (select 1 from public.memberships m
                    where m.org_id = t.org_id and m.profile_id = t.to_profile_id
                      and m.status = 'active') then
      raise exception '% is no longer in this office, so the offer cannot be accepted for them',
        private.member_name(t.org_id, t.to_profile_id)
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  perform set_config('lunch.pass_by_admin', 'on', true);
  update public.meal_transfers x
     set status = v_new, decided_at = now(), decided_by = v_actor
   where x.id = p_transfer_id;
  perform set_config('lunch.pass_by_admin', '', true);

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (t.org_id, o.service_date, v_kind, o.id, o.profile_id, t.id,
          private.pass_summary(t.id, v_event), v_reason, v_actor);

  perform private.enqueue_pass(t.id, v_period, v_actor, v_reason, v_event);

  return query select t.id,
                      private.account_balance(t.org_id, t.from_profile_id),
                      private.account_balance(t.org_id, t.to_profile_id);
end $fn$;

-- An accepted pass reversed: the meal goes back on the giver's bill.
create or replace function public.undo_pass(p_transfer_id bigint, p_reason text default null)
returns table(transfer_id bigint, from_balance_minor bigint, to_balance_minor bigint)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text;
  t        public.meal_transfers%rowtype;
  o        public.orders%rowtype;
  v_status text;
  v_period bigint;
begin
  select * into t from public.meal_transfers where id = p_transfer_id;
  if not found or not (t.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can correct the record'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := private.short_text(p_reason, 200, 'reason');

  select * into o from public.orders where id = t.order_id;
  select mu.status into v_status from public.menus mu where mu.id = o.menu_id for share;
  perform private.assert_menu_correctable(v_status, o.service_date);

  select * into t from public.meal_transfers where id = p_transfer_id for no key update;
  v_period := private.correction_period(t.org_id, o.service_date);
  select * into o from public.orders where id = t.order_id for no key update;

  if t.status = 'pending' then
    raise exception 'that offer has not been accepted, so there is nothing to undo'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if t.status <> 'accepted' then
    raise exception 'that pass is already %',
      case t.status when 'cancelled' then 'withdrawn' else t.status end
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.meal_transfers x
     set status = 'undone', undone_at = now(), undone_by = v_actor
   where x.id = p_transfer_id;

  insert into public.order_corrections
    (org_id, service_date, kind, order_id, profile_id, transfer_id, summary, reason, made_by)
  values (t.org_id, o.service_date, 'pass_undone', o.id, o.profile_id, t.id,
          private.pass_summary(t.id, 'undone'), v_reason, v_actor);

  perform private.enqueue_pass(t.id, v_period, v_actor, v_reason, 'undone');

  return query select t.id,
                      private.account_balance(t.org_id, t.from_profile_id),
                      private.account_balance(t.org_id, t.to_profile_id);
end $fn$;

--------------------------------------------------------------------- grants

revoke execute on function public.trg_transfer_notifies() from public, anon, authenticated;
revoke execute on function private.meal_phrase(bigint) from public, anon, authenticated;
revoke execute on function private.pass_summary(bigint, text) from public, anon, authenticated;
revoke execute on function private.pass_body(bigint, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function private.enqueue_pass(bigint, bigint, uuid, text, text) from public, anon, authenticated;

revoke execute on function public.record_pass(bigint, uuid, text) from public, anon;
grant  execute on function public.record_pass(bigint, uuid, text) to authenticated;
revoke execute on function public.answer_pass(bigint, text, text) from public, anon;
grant  execute on function public.answer_pass(bigint, text, text) to authenticated;
revoke execute on function public.undo_pass(bigint, text) from public, anon;
grant  execute on function public.undo_pass(bigint, text) to authenticated;
