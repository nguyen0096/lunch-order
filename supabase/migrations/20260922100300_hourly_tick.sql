-- The scheduled half of the app, which until now did not exist. No migration
-- ever called cron.schedule, so menus never locked, nothing was ever enqueued
-- for the bot, and run_billing() had no caller at all.
--
-- One driver, not one job per task and not one job per org. The job fires
-- hourly in UTC; every decision below is made from the org's OWN wall clock, so
-- onboarding a customer in a new timezone changes no schedule. That is why this
-- reads private.today_in()/private.local_now() and never current_date, which in
-- a UTC session is the wrong day for seven hours of every ICT day.
--
-- Everything is written so that running it again changes nothing:
--   * locking selects on status = 'published', which the lock itself removes
--   * every enqueue is `on conflict (dedupe_key) do nothing`
--   * a period is closed only while it is not already closed, and the weekly
--     messages are enqueued outside that guard, so a crash between closing and
--     enqueuing heals on the next tick instead of swallowing the bill
--
-- The other half is missing on purpose. Nothing drains the outbox, because
-- there is no Telegram sender yet; claim_outbox/settle_outbox are the seam it
-- will use and are deliberately untouched. Until then these rows pile up as
-- pending, which is the failure mode to want: an unsent message is recoverable,
-- an unrecorded one is not.

-- Amounts are integer minor units everywhere, and this is the only place they
-- are turned into something a person reads. The division is numeric, so no
-- float touches money. STABLE, not IMMUTABLE: to_char's separators come from
-- lc_numeric.
create or replace function private.money_text(
  p_amount_minor bigint, p_minor_units smallint, p_currency char(3))
returns text language sql stable set search_path = '' as $$
  select pg_catalog.to_char(
           p_amount_minor::numeric
             / pg_catalog.power(10::numeric, p_minor_units::numeric),
           'FM999G999G999G990' ||
           case when p_minor_units > 0
                then 'D' || pg_catalog.repeat('0', p_minor_units::int)
                else '' end)
         || ' ' || p_currency;
$$;

create or replace function private.run_hourly_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  o           public.organizations%rowtype;
  v_today     date;
  v_hour      integer;
  v_period_id bigint;
  v_period    public.billing_periods%rowtype;
begin
  for o in select org.* from public.organizations org
            where org.status = 'active'
            order by org.id
  loop
    -- One tenant's bad data must not cost every other tenant their hour, so
    -- each org is its own subtransaction. The warning reaches the Postgres log
    -- and the next tick retries; inside the billing window the `>=` test below
    -- means that retry is an hour away rather than a week.
    begin
      v_today := private.today_in(o.timezone);
      v_hour  := extract(hour from private.local_now(o.timezone))::integer;

      ------------------------------------------------------------ a. lock menus
      -- Not hour-gated: a cutoff is an instant per menu, not an hour of the
      -- day, and the update erases its own precondition.
      update public.menus m
         set status = 'locked'
       where m.org_id = o.id
         and m.status = 'published'
         and m.order_cutoff_at <= now();

      --------------------------------------------------------- b. notifications
      -- parse_mode is 'none' throughout: dish names and people's names go into
      -- the body verbatim, and Telegram rejects an unescaped & or < in HTML.
      if o.telegram_group_chat_id is not null then

        -- Enqueued from the tick rather than from a publish trigger: with no
        -- sender, up to an hour of scheduling latency is invisible, and holding
        -- every dedupe key in one function is what makes them auditable in one
        -- read. Worth moving to a trigger once the drain lands.
        insert into public.notification_outbox
          (org_id, dedupe_key, kind, chat_id, body, parse_mode, related_menu_id)
        select o.id,
               'org:' || o.id || ':menu_published:'
                 || to_char(m.service_date, 'YYYY-MM-DD') || ':group',
               'menu_published',
               o.telegram_group_chat_id,
               'Menu for ' || to_char(m.service_date, 'DD/MM') || E'\n'
                 || coalesce((select string_agg(
                                       '- ' || mi.name || '  '
                                         || private.money_text(mi.price_minor,
                                              o.currency_minor_units, o.currency),
                                       E'\n' order by mi.position, mi.id)
                                from public.menu_items mi
                               where mi.menu_id = m.id and mi.is_available), '')
                 || E'\nOrders close '
                 || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '.',
               'none',
               m.id
          from public.menus m
         where m.org_id = o.id
           and m.status = 'published'
           and m.order_cutoff_at > now()
        on conflict (dedupe_key) do nothing;

        -- 70 minutes, not 60, so consecutive ticks overlap by ten rather than
        -- risk a gap when the job starts a few seconds late. The overlap is
        -- free because the dedupe key absorbs it; a gap loses the day's warning.
        insert into public.notification_outbox
          (org_id, dedupe_key, kind, chat_id, body, parse_mode, related_menu_id)
        select o.id,
               'org:' || o.id || ':cutoff_warning:'
                 || to_char(m.service_date, 'YYYY-MM-DD') || ':group',
               'cutoff_warning',
               o.telegram_group_chat_id,
               'Last call: ordering for ' || to_char(m.service_date, 'DD/MM')
                 || ' closes at '
                 || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI') || '.',
               'none',
               m.id
          from public.menus m
         where m.org_id = o.id
           and m.status = 'published'
           and m.order_cutoff_at >  now()
           and m.order_cutoff_at <= now() + interval '70 minutes'
        on conflict (dedupe_key) do nothing;
      end if;

      -------------------------------------------------------------- c. billing
      -- The org's local week has turned over. 09:00 rather than midnight
      -- because this is when the bill is delivered, and `>=` rather than `=` so
      -- a tick missed at 09:00 is made good at 10:00 instead of a week later.
      if extract(isodow from v_today)::integer = o.billing_week_starts_on and v_hour >= 9 then
        -- the week that just ended is the one containing yesterday
        v_period_id := public.ensure_billing_period(o.id, v_today - 1);

        -- NULL only when an older non-void period overlaps the week asked for,
        -- i.e. the org's week boundary was moved mid-history. Skip rather than
        -- bill the wrong seven days.
        if v_period_id is not null then
          select bp.* into v_period from public.billing_periods bp where bp.id = v_period_id;

          if v_period.status <> 'closed' then
            perform public.run_billing(v_period_id);
            update public.billing_periods bp
               set status = 'closed', closed_at = now()
             where bp.id = v_period_id;
          end if;

          -- Outside that guard on purpose: a tick that closed the period and
          -- then died still owes everybody a message, and the dedupe keys make
          -- the second attempt free.
          if o.telegram_group_chat_id is not null then
            insert into public.notification_outbox
              (org_id, dedupe_key, kind, chat_id, body, parse_mode,
               related_billing_period_id)
            select o.id,
                   'org:' || o.id || ':weekly_bill:'
                     || to_char(v_period.period_start, 'YYYY-MM-DD') || ':group',
                   'weekly_bill',
                   o.telegram_group_chat_id,
                   'Lunch for ' || to_char(v_period.period_start, 'DD/MM') || ' to '
                     || to_char(v_period.period_end, 'DD/MM') || ' is settled: '
                     || count(*)::text || ' people, '
                     || private.money_text(sum(st.total_due_minor)::bigint,
                          o.currency_minor_units, o.currency)
                     || ' in total. Your own statement is in the app.',
                   'none',
                   v_period_id
              from public.billing_statements st
             where st.billing_period_id = v_period_id
            having count(*) > 0
            on conflict (dedupe_key) do nothing;
          end if;

          -- Only people who still owe, and only where the link was actually
          -- completed: telegram_links.chat_id stays null until the member
          -- finishes /start, and chat_id on the outbox is NOT NULL.
          insert into public.notification_outbox
            (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
             parse_mode, related_billing_period_id)
          select o.id,
                 'org:' || o.id || ':weekly_bill:'
                   || to_char(v_period.period_start, 'YYYY-MM-DD')
                   || ':profile:' || st.profile_id::text,
                 'weekly_bill',
                 tl.chat_id,
                 st.profile_id,
                 'Your lunch for ' || to_char(v_period.period_start, 'DD/MM') || ' to '
                   || to_char(v_period.period_end, 'DD/MM') || ': '
                   || st.meal_count::text || ' meals, '
                   || private.money_text(st.meals_minor, o.currency_minor_units, o.currency)
                   || case when st.carried_in_minor > 0
                           then ' plus ' || private.money_text(st.carried_in_minor,
                                              o.currency_minor_units, o.currency)
                                || ' still owed from before'
                           else '' end
                   || '. Total ' || private.money_text(st.total_due_minor,
                                      o.currency_minor_units, o.currency)
                   || '. Put ' || st.payment_ref || ' in the transfer message.',
                 'none',
                 v_period_id
            from public.billing_statements st
            join public.memberships    mem on mem.org_id = st.org_id
                                          and mem.profile_id = st.profile_id
            join public.telegram_links tl  on tl.membership_id = mem.id
           where st.billing_period_id = v_period_id
             and st.status in ('unpaid','partial')
             and tl.chat_id is not null
          on conflict (dedupe_key) do nothing;
        end if;
      end if;

    exception when others then
      raise warning 'hourly tick failed for org %: % (%)', o.id, sqlerrm, sqlstate;
    end;
  end loop;
end $$;

-- Ungranted deliberately: cron is the only caller, and cron runs it as the job
-- owner (postgres), which private.is_service() recognises, so the business-rule
-- triggers exempt it. `authenticated` holds USAGE on `private` only so RLS
-- policies can reach the helpers there; leaving PUBLIC EXECUTE on a function
-- that closes billing periods would make PostgREST's schema config the only
-- thing standing in the way.
revoke execute on function private.run_hourly_tick() from public;
