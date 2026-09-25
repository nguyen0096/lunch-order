-- Somebody offers you their lunch, and you find out when you happen to ask.
--
-- `transfer_offer` and `transfer_decided` have been in the outbox's kind CHECK
-- since the first migration and nothing has ever enqueued either. So a handover
-- lands silently: the bot renders Accept and Decline, but only inside the reply
-- to a `/order` the recipient chose to send, and the board shows it only to
-- somebody already looking. The person being given a lunch is the one person
-- who has no reason to be looking.
--
-- A trigger rather than an enqueue in the bot, for the reason the bot cannot be
-- the place: a transfer offered from the web never passes through it, and both
-- surfaces can accept and decline. `notification_outbox`'s only policy is
-- `outbox_admin`, so a member acting on their own meal could not insert one
-- anyway, and routing a member's own action through the service role is exactly
-- what `_shared/db.ts` forbids. The precedent is `meal_transfers_rebill`
-- (20261004100000), an AFTER trigger on this same table with a WHEN clause;
-- this is its sibling.
--
-- Not switchable in `org_notifications`. That table is for the messages nobody
-- asked for, on a clock. These two answer something a colleague just did to
-- your lunch, like `bill_correction`, and an office that turns them off has
-- turned off the feature rather than a broadcast.

create or replace function private.transfer_offer_message(p_transfer_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select private.member_name(t.org_id, t.from_profile_id)
      || ' has offered you their lunch on ' || to_char(o.service_date, 'DD/MM')
      || case when private.order_dishes(o.id) is null then ''
              else ': ' || private.order_dishes(o.id) end
      || '. Send me /order to take it or turn it down, or open the app.'
    from public.meal_transfers t
    join public.orders o on o.id = t.order_id
   where t.id = p_transfer_id;
$fn$;

create or replace function private.transfer_decided_message(p_transfer_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select private.member_name(t.org_id, t.to_profile_id)
      || case t.status
           when 'accepted' then ' took your lunch on '
           else ' turned down your lunch on '
         end
      || to_char(o.service_date, 'DD/MM')
      || case t.status
           -- Which way the money went is the whole point of being told.
           when 'accepted' then ', so it is on their bill rather than yours.'
           else ', so it is still yours and still on your bill.'
         end
    from public.meal_transfers t
    join public.orders o on o.id = t.order_id
   where t.id = p_transfer_id;
$fn$;

revoke execute on function private.transfer_offer_message(bigint)
  from public, anon, authenticated;
revoke execute on function private.transfer_decided_message(bigint)
  from public, anon, authenticated;

-- INSERT ... SELECT, which is the only correct shape here: `chat_id` is NOT
-- NULL on the outbox, so a recipient who never finished /start produces no row
-- rather than an error. The dedupe key carries the transfer and, for a decision,
-- the decision itself, so accepting after declining is a second message rather
-- than a swallowed one.
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
  if tg_op = 'INSERT' then
    v_to   := new.to_profile_id;
    v_kind := 'transfer_offer';
    v_key  := 'org:' || new.org_id || ':transfer_offer:' || new.id;
    v_body := private.transfer_offer_message(new.id);
  else
    -- The person who offered it is the one waiting for an answer.
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

revoke execute on function public.trg_transfer_notifies()
  from public, anon, authenticated;

drop trigger if exists meal_transfers_notify_offer on public.meal_transfers;
create trigger meal_transfers_notify_offer
  after insert on public.meal_transfers
  for each row when (new.status = 'pending')
  execute function public.trg_transfer_notifies();

-- An admin recording somebody else's arrangement writes `accepted` straight
-- away (`enforce_transfer_rules`), which is an INSERT and not an UPDATE, so it
-- fires neither trigger. That is right: nobody is waiting on an answer to a
-- swap that was recorded as already agreed.
drop trigger if exists meal_transfers_notify_decision on public.meal_transfers;
create trigger meal_transfers_notify_decision
  after update of status on public.meal_transfers
  for each row when (old.status = 'pending' and new.status in ('accepted','declined'))
  execute function public.trg_transfer_notifies();
