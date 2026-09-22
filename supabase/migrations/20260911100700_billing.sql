-- Weekly periods, per-order lines, per-person statements, and bank payments.

create table public.billing_periods (
  id           bigint generated always as identity primary key,
  org_id       bigint not null references public.organizations(id) on delete cascade,
  period_start date not null,
  period_end   date not null,                    -- inclusive
  status       text not null default 'open'
                 check (status in ('open','computing','closed','void')),
  computed_at timestamptz, closed_at timestamptz,
  closed_by   uuid references public.profiles(id),
  total_minor bigint  not null default 0,
  line_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint billing_periods_order_ck check (period_end >= period_start),
  constraint billing_periods_id_org_uk unique (id, org_id),
  -- Overlapping weeks made structurally impossible, so an order can never be
  -- legitimately claimed by two periods.
  constraint billing_periods_no_overlap
    exclude using gist (org_id with =, daterange(period_start, period_end, '[]') with &&)
    where (status <> 'void')
);
create index billing_periods_status_idx on public.billing_periods (org_id, status, period_start desc);
create index billing_periods_closed_by_idx on public.billing_periods (closed_by);
create trigger billing_periods_set_updated_at before update on public.billing_periods
  for each row execute function extensions.moddatetime(updated_at);
alter table public.billing_periods enable row level security;

create table public.billing_lines (
  id                  bigint generated always as identity primary key,
  org_id              bigint not null,
  billing_period_id   bigint not null,
  order_id            bigint not null references public.orders(id) on delete restrict,
  service_date        date not null,
  payer_profile_id    uuid not null references public.profiles(id) on delete restrict,
  original_profile_id uuid not null references public.profiles(id) on delete restrict,
  transfer_id         bigint references public.meal_transfers(id) on delete set null,
  amount_minor        integer not null check (amount_minor >= 0),
  description         text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_lines_period_fk foreign key (billing_period_id, org_id)
    references public.billing_periods (id, org_id) on update cascade on delete cascade,
  -- An order is billed at most once, ever. Not (period, order): global, so
  -- double-charging is structurally impossible rather than merely avoided.
  constraint billing_lines_order_uk unique (order_id)
);
create index billing_lines_period_payer_idx on public.billing_lines (billing_period_id, payer_profile_id);
create index billing_lines_payer_idx        on public.billing_lines (payer_profile_id);
create index billing_lines_original_idx     on public.billing_lines (original_profile_id);
create index billing_lines_transfer_idx     on public.billing_lines (transfer_id);
create trigger billing_lines_set_updated_at before update on public.billing_lines
  for each row execute function extensions.moddatetime(updated_at);
alter table public.billing_lines enable row level security;

-- A table, not a view: it carries payment state a recompute must never clobber.
create table public.billing_statements (
  id                bigint generated always as identity primary key,
  org_id            bigint not null,
  billing_period_id bigint not null,
  profile_id        uuid not null references public.profiles(id) on delete restrict,
  meal_count        integer not null default 0,
  meals_minor       bigint not null default 0 check (meals_minor >= 0),
  carried_in_minor  bigint not null default 0,   -- unpaid remainder of the prior period
  total_due_minor   bigint generated always as (meals_minor + carried_in_minor) stored,
  paid_minor        bigint not null default 0 check (paid_minor >= 0),
  -- ASCII only: bank memos strip diacritics. Unique per org so two customers
  -- can both use short codes.
  payment_ref       text not null check (payment_ref ~ '^[A-Z0-9]{4,24}$'),
  status            text not null default 'unpaid'
                      check (status in ('unpaid','partial','paid','waived')),
  paid_at timestamptz, marked_paid_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_statements_period_fk foreign key (billing_period_id, org_id)
    references public.billing_periods (id, org_id) on update cascade on delete cascade,
  constraint billing_statements_uk     unique (billing_period_id, profile_id),
  constraint billing_statements_ref_uk unique (org_id, payment_ref),
  constraint billing_statements_paid_ck check ((status = 'paid') = (paid_at is not null))
);
create index billing_statements_profile_idx on public.billing_statements (profile_id);
create index billing_statements_open_idx on public.billing_statements (org_id, status)
  where status in ('unpaid','partial');
create index billing_statements_marked_by_idx on public.billing_statements (marked_paid_by);
create trigger billing_statements_set_updated_at before update on public.billing_statements
  for each row execute function extensions.moddatetime(updated_at);
alter table public.billing_statements enable row level security;

create table public.payments (
  id              bigint generated always as identity primary key,
  org_id          bigint not null references public.organizations(id) on delete cascade,
  provider        text not null default 'sepay',
  provider_txn_id text not null,
  amount_minor    integer not null check (amount_minor > 0),
  memo            text,
  matched_statement_id bigint references public.billing_statements(id) on delete set null,
  received_at     timestamptz not null,
  raw             jsonb not null,
  created_at      timestamptz not null default now(),
  -- Webhook idempotency: a redelivery is a no-op.
  constraint payments_provider_txn_uk unique (org_id, provider, provider_txn_id)
);
create index payments_statement_idx on public.payments (matched_statement_id);
create index payments_org_time_idx  on public.payments (org_id, received_at desc);
alter table public.payments enable row level security;

-- THE recipient-pays rule, in exactly one place. Everything downstream reads
-- this rather than re-deriving it.
--
-- security_invoker means a member reading it sees only their own rows. Because
-- we do NOT use FORCE ROW LEVEL SECURITY, the same view read inside a
-- SECURITY DEFINER function owned by postgres returns everything, so the
-- billing run and the member UI share one definition of who pays.
create or replace view public.v_order_charges with (security_invoker = on) as
select o.id            as order_id,
       o.org_id,
       o.service_date,
       o.status        as order_status,
       o.profile_id    as placed_by_profile_id,
       t.id            as transfer_id,
       coalesce(t.to_profile_id, o.profile_id) as payer_profile_id,
       coalesce(i.amount_minor, 0) as amount_minor,
       coalesce(i.description, '') as description
from public.orders o
left join public.meal_transfers t
       on t.order_id = o.id and t.status = 'accepted'
left join lateral (
  select sum(oi.line_total_minor)::integer as amount_minor,
         string_agg(oi.item_name_snapshot ||
                    case when oi.quantity > 1 then ' x' || oi.quantity else '' end,
                    ', ' order by oi.id) as description
    from public.order_items oi where oi.order_id = o.id
) i on true;
