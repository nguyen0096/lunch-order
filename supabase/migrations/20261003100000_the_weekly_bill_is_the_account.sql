-- The weekly bill is the account, and the reference is the person's.
--
-- Three claims in the message people actually read, and the money migration
-- made all three false on the same morning.
--
--   * "Total <total_due_minor>" was the whole debt while carry-forward rolled
--     every unpaid week into the newest one. `carried_in_minor` is pinned to
--     zero now, so that number is one week's meals. Somebody three weeks
--     behind would be asked for the newest week and would pay it, which is
--     precisely the mistake the account was introduced to stop.
--   * " plus X still owed from before" hung off `carried_in_minor > 0`, which
--     can no longer happen. The sentence it used to add is now the part of the
--     truth that is missing, so it is replaced rather than deleted.
--   * `st.payment_ref` still carries the ISO week it was issued in. The Bill
--     screen and /me hand out `memberships.payment_ref`, which does not. Two
--     references for one person is the confusion a stable one exists to end,
--     and the loudest of the three surfaces was still quoting the old one.
--
-- And a fourth thing, which is not about wording. `v_account_balance` is
-- `security_invoker`, so it sums `public.payments` with the reader's own
-- privileges, and the only policy on that table is `payments_admin`. Every
-- member therefore read `credited_minor = 0` and a balance equal to everything
-- they had ever eaten: the Bill screen and /me would have told each of them
-- they owed money they had already paid, and a top-up could never show as
-- credit at all. It works for an admin, which is how this kind of thing
-- reaches production.
--
-- Rebuilt from 20260930100600 by one replacement in the per-person insert;
-- the rest of the function is unchanged, byte for byte. parse_mode stays
-- 'none', so there is no HTML and nothing to escape.

/**
 * A member can see the money they sent.
 *
 * Own rows only, the same shape as `billing_statements_select_own`. A payment
 * that matched nobody has a null `profile_id` and stays invisible until an
 * admin assigns it, which is what the Payments screen is for.
 */
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select to authenticated
  using (org_id = any ((select private.my_org_ids())::bigint[])
         and profile_id = (select auth.uid()));

/**
 * The stable reference is not optional.
 *
 * `short_code` is NOT NULL and `memberships_payment_ref` fills the column from
 * it on every insert and every rename, so the backfill in the money migration
 * left no null behind. Saying so in the schema is what lets the bill below,
 * the bot and the Bill screen quote `payment_ref` plainly instead of each
 * carrying its own fallback to a string built by hand.
 */
alter table public.memberships alter column payment_ref set not null;

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
                   || '. Put ' || mem.payment_ref
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
