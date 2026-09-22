-- The schedule itself. The README has said pg_cron drives this app since the
-- first commit; nothing ever scheduled anything, so it did not.
--
-- One job at minute 0 of every UTC hour. Which orgs act, and on what, is
-- decided inside the tick from each org's own clock, so a customer in a new
-- timezone adds no job here.
--
-- Still one job, not two. A second job draining the outbox belongs here as
-- well, but there is no Telegram sender yet, so a drain would only mark rows
-- 'sending' and burn their five attempts against nothing.

-- pg_cron is not relocatable: CREATE EXTENSION always puts it in `cron`. No
-- grants follow it here, because Supabase's own event trigger hands the cron
-- schema to postgres as part of creating the extension.
create extension if not exists pg_cron;

-- Unschedule-then-schedule so re-running the migration is not an error. The
-- delete matches nothing on a first run, which is a no-op rather than a fault.
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'lunch_hourly_tick';

select cron.schedule('lunch_hourly_tick', '0 * * * *',
                     $job$select private.run_hourly_tick();$job$);
