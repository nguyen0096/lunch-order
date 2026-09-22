-- An unconfigured drain is a waiting state, not a failure.
--
-- The job runs every minute and raised when Vault had no project_url or
-- outbox_drain_secret, so between the migration landing and the bot shipping it
-- logged 1440 errors a day, all of them saying the same foreseeable thing. A
-- cron job that screams once a minute about a condition you already know about
-- trains everyone to ignore its log, which is where a real failure would go.
--
-- NOTICE rather than silence: the queue not draining still needs to be findable
-- when somebody sets the secrets, mistypes one, and wonders why nothing sends.
-- The difference is that pg_cron records the run as succeeded, so a genuine
-- failure is once again the only thing that shows up as one.
--
-- The secrets are still required, and nothing sends until they exist:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<publishable key>',         'publishable_key');
--   select vault.create_secret('<OUTBOX_DRAIN_SECRET>',     'outbox_drain_secret');

create or replace function private.drain_outbox_now() returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text; v_secret text; v_pending bigint;
begin
  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'publishable_key';
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = 'outbox_drain_secret';

  if v_url is null or v_secret is null then
    -- Report the backlog, because "not configured" matters a great deal more
    -- once messages are actually piling up behind it than it does at zero.
    select count(*) into v_pending from public.notification_outbox
     where status = 'pending';
    raise notice
      'outbox drain not configured (vault needs project_url and outbox_drain_secret); % pending',
      v_pending;
    return null;
  end if;

  return net.http_post(
    url     => v_url || '/functions/v1/outbox-drain',
    body    => '{}'::jsonb,
    headers => jsonb_build_object(
                 'Content-Type',    'application/json',
                 'Authorization',   'Bearer ' || coalesce(v_key, ''),
                 'X-Outbox-Secret', v_secret),
    timeout_milliseconds => 60000);
end $$;

revoke execute on function private.drain_outbox_now() from public, anon, authenticated;
