-- A webhook secret per office, because one shared secret is a forgery hole.
--
-- The SePay endpoint routes a delivery to an office by the accountNumber in the
-- payload. With a single secret in the function's environment, every office
-- that points a webhook at that endpoint holds the key that every OTHER
-- office's deliveries are checked with. An admin of one office could then POST
-- a payload carrying another office's account number and a provider_txn_id they
-- invented, and trg_payment_apply would credit a statement in an office they
-- are not a member of -- marking their own people paid in somebody else's
-- books, or simply corrupting them. A tenant boundary that one tenant can write
-- through is not a boundary.
--
-- So the secret belongs to the office, and the webhook checks the one belonging
-- to whoever the account number resolved to.
--
-- NOT A COLUMN ON organizations. organizations_select is
-- `id = any(private.my_org_ids())` over the whole row, so every member of an
-- office can read every column of it. That is deliberate and right for
-- payment_config, which members need in order to pay at all, and it is exactly
-- why a secret cannot sit beside it.
--
-- RLS ON AND NO POLICY AT ALL. Not an omission: it is the strongest statement
-- this schema can make that nothing holding a member's JWT may read this.
-- PostgREST returns zero rows to anon, to authenticated and to a member of the
-- office alike. supabase/tests/isolation.sql measures that rather than
-- asserting it. The Edge Function reaches the row over a direct connection as
-- the table's owner (supabase/functions/_shared/db.ts, asSystem), which RLS
-- does not apply to.
--
-- Re-runnable throughout, because migrations here get applied by hand as often
-- as by the GitHub integration.

create table if not exists public.org_webhook_secrets (
  org_id bigint primary key references public.organizations(id) on delete cascade,
  -- What SePay sends as `Authorization: Bearer Apikey <secret>`, compared in
  -- constant time by the function. Long enough that guessing is not a strategy:
  -- `openssl rand -hex 32` produces 64 characters.
  secret text not null check (length(btrim(secret)) >= 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.org_webhook_secrets enable row level security;

drop trigger if exists org_webhook_secrets_set_updated_at on public.org_webhook_secrets;
create trigger org_webhook_secrets_set_updated_at before update on public.org_webhook_secrets
  for each row execute function extensions.moddatetime(updated_at);

-- Load-bearing, not decoration. The grants migration revoked ALL on the tables
-- that existed when it ran, but Supabase's default privileges grant ALL on
-- every NEW public table to anon and authenticated, and this table was created
-- afterwards. RLS with no policy would still return zero rows; this makes the
-- privilege match the intent, so that a policy added here by mistake one day
-- cannot quietly open a table nobody meant to grant in the first place.
revoke all on public.org_webhook_secrets from anon, authenticated;

comment on table public.org_webhook_secrets is
  'Per-office webhook secrets. RLS on with no policy on purpose: only a '
  'connection acting as the table owner (the Edge Function, via asSystem) '
  'reads this. It must never be exposed through PostgREST.';
