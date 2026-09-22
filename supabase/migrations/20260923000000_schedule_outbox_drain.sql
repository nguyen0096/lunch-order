-- The second job the hourly tick said belonged here. There is a sender now, so
-- the queue can be drained.
--
-- Every minute, not every hour: settle_outbox backs off in 1m/3m/9m/27m/81m
-- steps and next_attempt_at is a timestamp, so an hourly job would round every
-- one of those up to the next hour and make a transient Telegram blip cost an
-- afternoon. A cutoff warning that arrives an hour late is not a warning.
--
-- Postgres cannot call an Edge Function, so this goes out through pg_net and
-- comes back in over HTTPS. The function URL and the shared secret are read
-- from Vault rather than written here, for two different reasons:
--
--   * the secret must not exist in the migration history, which is committed
--     to git and readable by everyone who can clone the repo
--   * the URL is per project, so a hardcoded one would send a branch or a
--     restored copy of this database at production's bot
--
-- Vault rather than a settings table because vault.decrypted_secrets is
-- encrypted at rest and is already where this project puts provider
-- credentials (see the comment on organizations.payment_config). A settings
-- table would be one more thing with RLS to get right.
--
-- Before this job does anything, three secrets must exist:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<publishable key>',         'publishable_key');
--   select vault.create_secret('<OUTBOX_DRAIN_SECRET>',     'outbox_drain_secret');
-- Until then the job raises, which is visible in the Postgres log and leaves
-- the queue untouched. Pending rows are recoverable; that is the failure mode
-- to want.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The request lives in a function rather than inline in the cron command so the
-- three secrets are read in one place, and so a missing one says which.
--
-- Two independent gates protect the endpoint. `publishable_key` satisfies the
-- platform's own JWT check, which is why the drain is deployed WITH
-- verify_jwt on, and it is not a secret: anyone with the web app has it.
-- X-Outbox-Secret is the gate that actually decides, and the function compares
-- it in constant time.
create or replace function private.drain_outbox_now() returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text; v_secret text;
begin
  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'publishable_key';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'outbox_drain_secret';

  if v_url is null or v_secret is null then
    raise exception
      'outbox drain is not configured: vault needs project_url and outbox_drain_secret';
  end if;

  -- Asynchronous by design. pg_net queues the request and the transaction
  -- commits immediately, so a slow Telegram cannot hold a cron worker open.
  return net.http_post(
    url     => v_url || '/functions/v1/outbox-drain',
    body    => '{}'::jsonb,
    headers => jsonb_build_object(
                 'Content-Type',    'application/json',
                 'Authorization',   'Bearer ' || coalesce(v_key, ''),
                 'X-Outbox-Secret', v_secret),
    timeout_milliseconds => 60000);
end $$;

-- Same reasoning as run_hourly_tick(): cron is the only caller. Note that the
-- grants migration's default-privileges revoke names public and anon but not
-- authenticated, so a new function is not ungranted by inheritance and this
-- has to say so. It is in `private`, which PostgREST does not expose, and now
-- it is not executable either.
revoke execute on function private.drain_outbox_now() from public, anon, authenticated;

-- Unschedule-then-schedule so re-running the migration is not an error, matching
-- the hourly tick's job.
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lunch_outbox_drain';

select cron.schedule('lunch_outbox_drain', '* * * * *',
                     $job$select private.drain_outbox_now();$job$);
