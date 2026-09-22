-- The documented backoff was never the real one.
--
-- claim_outbox sets attempts = attempts + 1 when it hands a row out, so by the
-- time settle_outbox reads the column the current attempt is already counted.
-- power(3, attempts) therefore starts at 3 minutes, not 1, and the first delay
-- the comment promised has never happened.
--
-- Only the comment is wrong, so only the comment changes. 3m as a first retry
-- is right for this queue: a Telegram outage that clears in under a minute is
-- rare, and every message here is a reminder rather than something a person is
-- waiting on. Changing the schedule would also move max_attempts, which is what
-- decides when a row stops being retried at all.
--
-- Replaced through a migration rather than edited in place. The old text is
-- inside the function body, which means it is stored in pg_proc: editing the
-- applied migration would correct the repo and leave the database saying the
-- wrong thing, and nothing would ever reconcile them.

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
           -- Exponential backoff over the attempt claim_outbox already counted:
           -- 3m, 9m, 27m, 81m, then failed at max_attempts.
           next_attempt_at = now() + (interval '1 minute' * power(3, attempts)),
           last_error = p_error
     where id = p_id;
  end if;
end $$;

-- create or replace keeps the existing ACL, so this changes nothing today. It
-- is restated because the grants migration's revoke is what keeps this off
-- PostgREST's /rest/v1/rpc, and a reader of this file should not have to go
-- and check that.
revoke execute on function public.settle_outbox(bigint, boolean, bigint, text)
  from public, anon, authenticated;
