-- The weekly bill quotes the reference the Bill screen shows.
--
-- `TEST LUNCH DINH`: the office, the word, the person. One string per person,
-- the same every week, which is what lets somebody save it as a repeating
-- transfer. The office code earns its place because a SePay account is often
-- also somebody's own, or serves two offices, and the prefix is what an admin
-- reads in the bank statement.
--
-- Matching is untouched. `private.payer_from_memo` strips every
-- non-alphanumeric character and looks for `memberships.payment_ref` inside
-- what is left, so this normalises to `TESTLUNCHDINH`, which still contains
-- `LUNCHDINH`. No stored reference is rewritten: `memberships.payment_ref` and
-- `billing_statements.payment_ref` keep their `^[A-Z0-9]{4,24}$` shape and
-- their values.
--
-- Space, not underscore: a Vietnamese transfer note carries letters, digits
-- and spaces intact and several banks drop or refuse the rest. It is also the
-- only separator somebody retyping the memo can reach without a modifier key.
--
-- Composed in two places, deliberately and identically: `composePaymentRef` in
-- `src/shared/paymentRef.ts` for the web, and this function for the message
-- the hourly tick pushes. Both fold their inputs, and both fall back to the
-- bare `payment_ref` rather than emit a reference the database cannot match.

create or replace function private.display_payment_ref(
  p_office      text,
  p_member_code text,
  /** `memberships.payment_ref`: the matchable core, and the fallback. */
  p_core        text
) returns text
language sql
immutable
set search_path = ''
as $fn$
  -- The invariant enforced rather than assumed: whatever is displayed must
  -- still contain the core, folded the way payer_from_memo folds a memo.
  -- `payment_ref` and `short_code` are two columns kept in step by a trigger,
  -- not one derived from the other, so they can in principle disagree.
  select case
           when coalesce(p_core, '') = '' then ''
           when position(upper(p_core) in
                  upper(regexp_replace(s.composed, '[^A-Za-z0-9]', '', 'g'))) > 0
             then s.composed
           else p_core
         end
    from (
      select array_to_string(array_remove(array[
               nullif(upper(regexp_replace(coalesce(p_office, ''),
                                           '[^A-Za-z0-9]', '', 'g')), ''),
               'LUNCH',
               nullif(upper(regexp_replace(coalesce(p_member_code, ''),
                                           '[^A-Za-z0-9]', '', 'g')), '')
             ], null), ' ') as composed
    ) s;
$fn$;

revoke execute on function private.display_payment_ref(text, text, text)
  from public, anon, authenticated;

-- Unchanged but for the one expression that hands out the reference, which now
-- names the office as well as the person.
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
               private.menu_message(m.id),
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
               private.cutoff_message(m.id),
               'none',
               m.id
          from public.menus m
         where m.org_id = o.id
           and m.status = 'published'
           and m.order_cutoff_at >  now()
           and m.order_cutoff_at <= now() + interval '70 minutes'
        on conflict (dedupe_key) do nothing;
      end if;

      -- The same two announcements, to everybody who finished /start.
      --
      -- Outside the group guard on purpose. A private chat exists the moment
      -- somebody links; the group id is a fallback an admin may never set, and
      -- while it is null these two were the only rows the tick ever produced,
      -- so nothing reached anybody at all. The group copy stays where a group
      -- exists, because one message in the room beats five identical ones.
      insert into public.notification_outbox
        (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
         parse_mode, related_menu_id)
      select o.id,
             'org:' || o.id || ':menu_published:'
               || to_char(m.service_date, 'YYYY-MM-DD')
               || ':profile:' || mm.profile_id::text,
             'menu_published',
             tl.chat_id,
             mm.profile_id,
             private.menu_message(m.id),
             'none',
             m.id
        from public.menus m
        join public.memberships mm
          on mm.org_id = o.id and mm.status = 'active'
        join public.telegram_links tl
          on tl.membership_id = mm.id and tl.chat_id is not null
       where m.org_id = o.id
         and m.status = 'published'
         and m.order_cutoff_at > now()
      on conflict (dedupe_key) do nothing;

      insert into public.notification_outbox
        (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body,
         parse_mode, related_menu_id)
      select o.id,
             'org:' || o.id || ':cutoff_warning:'
               || to_char(m.service_date, 'YYYY-MM-DD')
               || ':profile:' || mm.profile_id::text,
             'cutoff_warning',
             tl.chat_id,
             mm.profile_id,
             private.cutoff_message(m.id),
             'none',
             m.id
        from public.menus m
        join public.memberships mm
          on mm.org_id = o.id and mm.status = 'active'
        join public.telegram_links tl
          on tl.membership_id = mm.id and tl.chat_id is not null
       where m.org_id = o.id
         and m.status = 'published'
         and m.order_cutoff_at >  now()
         and m.order_cutoff_at <= now() + interval '70 minutes'
      on conflict (dedupe_key) do nothing;

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

          -- Only people whose ACCOUNT is short, and only where the link was
          -- actually completed: telegram_links.chat_id stays null until the
          -- member finishes /start, and chat_id on the outbox is NOT NULL.
          --
          -- The week is the occasion for the message, not the number in it.
          -- `total_due_minor` is one week's meals now that nothing carries
          -- forward, so quoting it would ask somebody three weeks behind for
          -- the newest week alone. `balance_minor` is what they owe, and it is
          -- cast because sum(bigint) is numeric and money_text takes bigint.
          --
          -- `bal.balance_minor > 0` in place of the old unpaid/partial test.
          -- The allocation spends credits oldest week first, so the two agree
          -- on everybody who ate something that cost money; the balance is the
          -- fact this message is actually about, and the one it asks them to
          -- settle.
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
                   || st.meal_count::text
                   || case when st.meal_count = 1 then ' meal, ' else ' meals, ' end
                   || private.money_text(st.meals_minor, o.currency_minor_units, o.currency)
                   || '. You owe ' || private.money_text(bal.balance_minor::bigint,
                                        o.currency_minor_units, o.currency)
                   || ' in total'
                   || case when bal.balance_minor > st.meals_minor
                           then ', earlier weeks included' else '' end
                   || '. Put '
                   || private.display_payment_ref(o.short_code, mem.short_code,
                                                  mem.payment_ref)
                   || ' in the transfer message, the same one every week.'
                   || ' It is required: only transfers carrying it reach the lunch app,'
                   || ' so one sent without it leaves your bill unpaid with nothing for'
                   || ' an admin to find.',
                 'none',
                 v_period_id
            from public.billing_statements   st
            join public.memberships       mem on mem.org_id = st.org_id
                                             and mem.profile_id = st.profile_id
            join public.v_account_balance bal on bal.org_id = st.org_id
                                             and bal.profile_id = st.profile_id
            join public.telegram_links     tl on tl.membership_id = mem.id
           where st.billing_period_id = v_period_id
             and st.status <> 'waived'
             and bal.balance_minor > 0
             and tl.chat_id is not null
          on conflict (dedupe_key) do nothing;
        end if;
      end if;

    exception when others then
      raise warning 'hourly tick failed for org %: % (%)', o.id, sqlerrm, sqlstate;
    end;
  end loop;
end $$;

