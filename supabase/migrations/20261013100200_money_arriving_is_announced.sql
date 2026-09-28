-- Money arriving is announced on Telegram.
--
-- A payment credited to somebody tells them, in their own chat, what arrived
-- and where their account now stands. A bank transfer that matches nobody
-- tells the office's admins and owners, so somebody assigns it under
-- Payments. Each is an automatic message with its own switch in
-- org_notifications, on by default like the other three.
--
-- `payment_ack` has been in the outbox's kind CHECK since 20260911100900 and
-- nothing wrote it until now. `payment_unmatched` is new.
--
-- Queued from trg_payment_apply, in the insert's own transaction, once the
-- payer is known. A SePay redelivery inserts nothing (payments_provider_txn_uk,
-- ON CONFLICT DO NOTHING), so the trigger never runs a second time, and the
-- dedupe key names the payment besides.
--
-- A move tells nobody, with one exception: applying a payment that matched
-- nobody to a person tells that person, since nobody told them when it came
-- in. Moving money from one person to another, and voiding a manual payment,
-- are an admin correcting the record, and the admin doing it is the one to
-- explain it.
--
-- parse_mode is 'none' for both, as for every automatic message: the memo is
-- the sender's own text and goes out verbatim, with nothing to escape.

------------------------------------------------------------------ the kinds

alter table public.org_notifications drop constraint org_notifications_kind_check;
alter table public.org_notifications add constraint org_notifications_kind_check
  check (kind in ('menu_published','cutoff_warning','weekly_bill',
                  'payment_ack','payment_unmatched'));

alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in
    ('menu_published','register_reminder','cutoff_warning',
     'weekly_preview','weekly_bill','payment_reminder','payment_ack',
     'transfer_offer','transfer_decided','bill_correction','announcement',
     'bug_report','payment_unmatched'));

------------------------------------------------------------------ the bodies

-- Reads the balance as it stands now, so it has to be rendered after the
-- payment is credited. v_account_balance is security_invoker and every caller
-- is a definer, so the org and profile predicates are the only scoping.
create or replace function private.payment_ack_message(
  p_payment_id bigint, p_matched_later boolean default false)
returns text
language sql
stable
set search_path to ''
as $fn$
  select 'Received '
      || private.money_text(p.amount_minor, o.currency_minor_units, o.currency)
      || ' for lunch at ' || o.name
      || case when p_matched_later
              then ', sent on ' || to_char(p.received_at at time zone o.timezone, 'DD/MM')
                   || ' and matched to you by an admin'
              else '' end
      || '. '
      || case when bal.balance_minor > 0
              then 'You owe ' || private.money_text(bal.balance_minor::bigint,
                                   o.currency_minor_units, o.currency) || '.'
              when bal.balance_minor < 0
              then 'You are ' || private.money_text((-bal.balance_minor)::bigint,
                                   o.currency_minor_units, o.currency) || ' in credit.'
              else 'You are all paid up.' end
    from public.payments p
    join public.organizations o on o.id = p.org_id
    join public.v_account_balance bal on bal.org_id = p.org_id
                                     and bal.profile_id = p.profile_id
   where p.id = p_payment_id;
$fn$;

-- The memo is capped: it is whatever the sender typed, and the message only
-- has to let an admin recognise the transfer.
create or replace function private.payment_unmatched_message(p_payment_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select private.money_text(p.amount_minor, o.currency_minor_units, o.currency)
      || ' arrived for ' || o.name || ' at '
      || to_char(p.received_at at time zone o.timezone, 'HH24:MI "on" DD/MM')
      || ' and matched nobody. '
      || case when nullif(btrim(p.memo), '') is null
              then 'It came with no transfer message.'
              else 'Transfer message: "'
                   || case when length(btrim(p.memo)) > 200
                           then left(btrim(p.memo), 200) || '...'
                           else btrim(p.memo) end
                   || '".' end
      || ' Open Payments in the app to assign it to somebody.'
    from public.payments p
    join public.organizations o on o.id = p.org_id
   where p.id = p_payment_id;
$fn$;

revoke execute on function private.payment_ack_message(bigint, boolean)
  from public, anon, authenticated;
revoke execute on function private.payment_unmatched_message(bigint)
  from public, anon, authenticated;

------------------------------------------------------------------ the enqueue

-- INSERT ... SELECT, so somebody with no linked chat produces no row. A manual
-- payment on nobody was recorded by an admin who already knows, so only a
-- payment the bank reported is announced as unmatched.
create or replace function private.queue_payment_notice(
  p_payment_id bigint, p_matched_later boolean default false)
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_pay public.payments%rowtype;
begin
  select * into v_pay from public.payments p where p.id = p_payment_id;
  if not found or v_pay.voided_at is not null then return; end if;

  if v_pay.profile_id is not null then
    if not (select c.enabled from private.notification_config(v_pay.org_id, 'payment_ack') c) then
      return;
    end if;
    insert into public.notification_outbox
      (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
    select v_pay.org_id,
           'org:' || v_pay.org_id || ':payment_ack:' || v_pay.id
             || ':profile:' || mem.profile_id::text,
           'payment_ack', tl.chat_id, mem.profile_id,
           private.payment_ack_message(v_pay.id, p_matched_later), 'none'
      from public.memberships mem
      join public.telegram_links tl
        on tl.membership_id = mem.id and tl.chat_id is not null
     where mem.org_id = v_pay.org_id
       and mem.profile_id = v_pay.profile_id
       and mem.status = 'active'
    on conflict (dedupe_key) do nothing;
    return;
  end if;

  if v_pay.provider = 'manual'
     or not (select c.enabled from private.notification_config(v_pay.org_id, 'payment_unmatched') c) then
    return;
  end if;
  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
  select v_pay.org_id,
         'org:' || v_pay.org_id || ':payment_unmatched:' || v_pay.id
           || ':profile:' || mem.profile_id::text,
         'payment_unmatched', tl.chat_id, mem.profile_id,
         private.payment_unmatched_message(v_pay.id), 'none'
    from public.memberships mem
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
   where mem.org_id = v_pay.org_id
     and mem.role in ('admin','owner')
     and mem.status = 'active'
  on conflict (dedupe_key) do nothing;
end $fn$;

revoke execute on function private.queue_payment_notice(bigint, boolean)
  from public, anon, authenticated;

-- 20261011100300's definition, with the notice queued on both ways out.
create or replace function public.trg_payment_apply()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_profile uuid;
begin
  v_profile := coalesce(private.payer_from_memo(new.org_id, new.memo), new.profile_id);
  if v_profile is null then
    perform private.queue_payment_notice(new.id);
    return null;
  end if;

  if new.profile_id is distinct from v_profile then
    update public.payments set profile_id = v_profile where id = new.id;
  end if;
  perform private.reallocate(new.org_id, v_profile);
  update public.payments
     set matched_statement_id = private.payment_frontier(new.org_id, v_profile)
   where id = new.id;
  perform private.queue_payment_notice(new.id);
  return null;
end $function$;

revoke execute on function public.trg_payment_apply() from public, anon, authenticated;

-- move_payment writes this row after moving the money, so the payment already
-- names the new person.
create or replace function public.trg_payment_applied_notifies()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  perform private.queue_payment_notice(new.payment_id, true);
  return null;
end $fn$;

revoke execute on function public.trg_payment_applied_notifies()
  from public, anon, authenticated;

drop trigger if exists payment_corrections_notify_applied on public.payment_corrections;
create trigger payment_corrections_notify_applied
  after insert on public.payment_corrections
  for each row when (new.kind = 'move' and new.from_profile_id is null)
  execute function public.trg_payment_applied_notifies();

------------------------------------------------------------ the test message

-- 20261009100100's definition, taking the two new kinds. Each previews a real
-- payment: the admin's own latest for payment_ack, the office's latest
-- unmatched bank transfer for payment_unmatched.
create or replace function public.send_test_notification(p_org_id bigint, p_kind text)
returns table(queued integer)
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_actor  uuid := (select auth.uid());
  v_chat   bigint;
  v_menu   bigint;
  v_period bigint;
  v_pay    bigint;
  v_real   text;
begin
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can send a test message'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind is null
     or p_kind not in ('menu_published','cutoff_warning','weekly_bill',
                       'payment_ack','payment_unmatched') then
    raise exception
      'a test can be sent for menu_published, cutoff_warning, weekly_bill, payment_ack or payment_unmatched'
      using errcode = 'check_violation';
  end if;

  select tl.chat_id into v_chat
    from public.memberships mem
    join public.telegram_links tl on tl.membership_id = mem.id
   where mem.org_id = p_org_id and mem.profile_id = v_actor;

  if v_chat is null then
    raise exception
      'connect Telegram first: open the bot and finish /start, then the test will arrive in your own chat'
      using errcode = 'no_data_found';
  end if;

  if p_kind in ('menu_published','cutoff_warning') then
    select m.id into v_menu
      from public.menus m
     where m.org_id = p_org_id
       and m.status = 'published'
       and m.order_cutoff_at > now()
     order by m.service_date
     limit 1;

    if v_menu is null then
      select m.id into v_menu
        from public.menus m
       where m.org_id = p_org_id and m.status in ('published','locked')
       order by m.service_date desc
       limit 1;
    end if;

    if v_menu is null then
      raise exception 'there is no published menu to preview yet; publish one first'
        using errcode = 'no_data_found';
    end if;

    v_real := case p_kind
                when 'menu_published' then private.menu_message(v_menu)
                else private.cutoff_message(v_menu)
              end;
  elsif p_kind = 'weekly_bill' then
    select st.billing_period_id into v_period
      from public.billing_statements st
      join public.billing_periods bp on bp.id = st.billing_period_id
     where st.org_id = p_org_id and st.profile_id = v_actor
     order by bp.period_start desc
     limit 1;

    if v_period is null then
      raise exception
        'you have no billed week yet, so there is no weekly bill to preview'
        using errcode = 'no_data_found';
    end if;

    v_real := private.weekly_bill_message(v_period, v_actor);
  elsif p_kind = 'payment_ack' then
    -- The admin's own payment only: somebody else's would show their balance.
    select p.id into v_pay
      from public.payments p
     where p.org_id = p_org_id and p.profile_id = v_actor and p.voided_at is null
     order by p.received_at desc, p.id desc
     limit 1;

    if v_pay is null then
      raise exception
        'you have no payment on record here yet, so there is no receipt to preview'
        using errcode = 'no_data_found';
    end if;

    v_real := private.payment_ack_message(v_pay);
  else
    select p.id into v_pay
      from public.payments p
     where p.org_id = p_org_id and p.profile_id is null
       and p.provider <> 'manual' and p.voided_at is null
     order by p.received_at desc, p.id desc
     limit 1;

    if v_pay is null then
      raise exception
        'no bank transfer here has matched nobody yet, so there is nothing to preview'
        using errcode = 'no_data_found';
    end if;

    v_real := private.payment_unmatched_message(v_pay);
  end if;

  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode,
     related_menu_id, related_billing_period_id)
  values (p_org_id,
          'org:' || p_org_id || ':test:' || p_kind || ':'
            || pg_catalog.gen_random_uuid()::text,
          p_kind, v_chat, v_actor,
          'Test message, sent to you alone. This is what your office receives.'
            || E'\n\n' || v_real,
          'none', v_menu, v_period);

  return query select 1;
end $fn$;

revoke execute on function public.send_test_notification(bigint, text) from public, anon;
grant  execute on function public.send_test_notification(bigint, text) to authenticated;
