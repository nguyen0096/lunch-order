-- Outbound Telegram messages. An outbox rather than direct sends, so a retried
-- cron job cannot double-post and a transient Telegram outage self-heals.

create table public.notification_outbox (
  id         bigint generated always as identity primary key,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  -- Enqueue is exactly-once: a retried job uses the same key and conflicts.
  -- Keys are org-prefixed, e.g. 'org:12:weekly_bill:2026-09-07:group'.
  dedupe_key text not null,
  kind       text not null check (kind in
               ('menu_published','register_reminder','cutoff_warning',
                'weekly_preview','weekly_bill','payment_reminder','payment_ack',
                'transfer_offer','transfer_decided')),
  chat_id    bigint not null,
  recipient_profile_id uuid references public.profiles(id) on delete cascade,
  -- Rendered and FROZEN at enqueue, so what a member receives is what the
  -- admin saw, even if the underlying data moves afterwards.
  body       text not null,
  parse_mode text not null default 'HTML' check (parse_mode in ('HTML','MarkdownV2','none')),
  status     text not null default 'pending'
               check (status in ('pending','sending','sent','failed')),
  attempts   smallint not null default 0,
  max_attempts smallint not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at    timestamptz,
  -- Delivery is at-least-once; nothing makes an outbound HTTP call
  -- exactly-once. On retry, editMessageText on this id instead of sending
  -- again, so the reader sees one message however many attempts it took.
  provider_message_id bigint,
  related_menu_id           bigint references public.menus(id) on delete set null,
  related_billing_period_id bigint references public.billing_periods(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_outbox_dedupe_uk unique (dedupe_key)
);
-- Partial index sized to the queue, not the archive.
create index notification_outbox_due_idx on public.notification_outbox (next_attempt_at, id)
  where status in ('pending','sending');
create index notification_outbox_org_idx       on public.notification_outbox (org_id, created_at desc);
create index notification_outbox_recipient_idx on public.notification_outbox (recipient_profile_id);
create index notification_outbox_menu_idx      on public.notification_outbox (related_menu_id);
create index notification_outbox_period_idx    on public.notification_outbox (related_billing_period_id);
create trigger notification_outbox_set_updated_at before update on public.notification_outbox
  for each row execute function extensions.moddatetime(updated_at);
alter table public.notification_outbox enable row level security;

-- Claim a batch for sending. skip locked so two overlapping drains never fight
-- over the same row.
create or replace function public.claim_outbox(p_limit integer default 20)
returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.notification_outbox o
     set status = 'sending', attempts = o.attempts + 1
   where o.id in (
     select c.id from public.notification_outbox c
      where c.status = 'pending' and c.next_attempt_at <= now()
      order by c.next_attempt_at, c.id
      limit p_limit
      for update skip locked)
  returning o.*;
end $$;

create or replace function public.settle_outbox(
  p_id bigint, p_ok boolean, p_provider_message_id bigint default null,
  p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then
    update public.notification_outbox
       set status = 'sent', sent_at = now(), last_error = null,
           provider_message_id = coalesce(p_provider_message_id, provider_message_id)
     where id = p_id;
  else
    update public.notification_outbox
       set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           -- exponential backoff: 1m, 3m, 9m, 27m, 81m
           next_attempt_at = now() + (interval '1 minute' * power(3, attempts)),
           last_error = p_error
     where id = p_id;
  end if;
end $$;
