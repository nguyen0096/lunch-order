-- Every automatic message has a switch, and the two with a clock have a time.
--
-- `private.run_hourly_tick` is the only thing in this database that sends a
-- message nobody asked for, and until now the three it sends were not
-- negotiable: the menu announcement, a warning 70 minutes before the cutoff,
-- and the weekly bill at 09:00 on the office's billing day. Each of those
-- numbers was a literal in the middle of a two-hundred-line function, so an
-- office that wanted the cutoff warning two hours early, or did not want the
-- group announcement at all, had no answer but a migration.
--
-- One row per office per kind, and NOTHING IS SEEDED. A missing row reads as
-- today's behaviour: the tick coalesces to `true`, `70` and `9`. That is the
-- whole compatibility story, and it is why `private.notification_config` below
-- holds those three defaults in one place rather than as five coalesces
-- scattered through the tick. An office that never opens the settings screen
-- keeps exactly the messages it has always had, and an office that deletes its
-- row goes back to them.
--
-- A row per kind rather than a column per number on `organizations`: the next
-- message kind is an INSERT, not an ALTER TABLE, and `organizations` is already
-- the row every query in the schema joins to.

create table public.org_notifications (
  org_id  bigint not null references public.organizations(id) on delete cascade,
  kind    text   not null check (kind in ('menu_published','cutoff_warning','weekly_bill')),
  enabled boolean not null default true,

  -- How long before the cutoff the warning goes out. Cutoff warning only.
  minutes_before integer,
  -- The office-local hour the weekly bill goes out on. Weekly bill only.
  at_local_hour  smallint,

  updated_at timestamptz not null default now(),

  primary key (org_id, kind),

  -- A reminder forty days before a cutoff is not a reminder, and there is no
  -- such hour as 25.
  --
  -- The floor of 60 is not cosmetic. The tick runs once an hour, and the window
  -- it tests is `cutoff <= now() + minutes_before`, so a window shorter than
  -- the gap between two ticks falls BETWEEN them: most days no tick would ever
  -- see the menu inside it and the warning would simply never be sent. 70 is
  -- the default rather than 60 because ten minutes of overlap absorbs a cron
  -- job that starts late; 60 is the smallest value that works at all, and only
  -- if the job is punctual.
  constraint org_notifications_minutes_ck
    check (minutes_before is null or minutes_before between 60 and 1440),
  constraint org_notifications_hour_ck
    check (at_local_hour is null or at_local_hour between 0 and 23),

  -- A kind carries only the timing that means anything for it. Without this, a
  -- settings screen could store `at_local_hour` against the cutoff warning, the
  -- tick would ignore it, and the admin would be looking at a number that does
  -- nothing. The menu announcement has no clock of its own at all: it goes out
  -- on the first tick after the menu is published.
  constraint org_notifications_shape_ck check (
    case kind
      when 'cutoff_warning' then at_local_hour  is null
      when 'weekly_bill'    then minutes_before is null
      else                       minutes_before is null and at_local_hour is null
    end)
);

create trigger org_notifications_set_updated_at
  before update on public.org_notifications
  for each row execute function moddatetime('updated_at');

alter table public.org_notifications enable row level security;

-- Supabase grants ALL on a new table in `public` to anon and authenticated, and
-- the blanket revoke in 20260911101100_grants.sql ran long before this table
-- existed. Without this line a signed-in browser could switch off any office's
-- messages, including one it does not belong to.
revoke all on public.org_notifications from anon, authenticated;
grant select, insert, update, delete on public.org_notifications to authenticated;

-- Admins only, for reading as well as writing. A member has nothing to do with
-- this table: what they are told about the schedule is the message itself.
-- DELETE is deliberately in the grant, because deleting the row is how an admin
-- says "back to the default" without having to know what the default is.
create policy org_notifications_admin_all on public.org_notifications
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));

comment on table public.org_notifications is
  'One row per office per automatic message kind. A missing row means the default: on, 70 minutes before a cutoff, 09:00 for the weekly bill.';

-- The defaults, in one place.
--
-- Every caller reads the settings through this rather than joining the table,
-- so `70` and `9` appear exactly once in the schema. It returns a row whether
-- or not one is stored, which is what lets the tick treat "no row" and "row
-- with the defaults in it" as the same thing without a left join at every use.
--
-- It fills in all three columns for every kind, including the timing that kind
-- does not have. The caller reads the one it needs; the shape CHECK above is
-- what stops anybody storing a number in the other one and expecting it to
-- matter.
create or replace function private.notification_config(p_org_id bigint, p_kind text)
returns table (enabled boolean, minutes_before integer, at_local_hour smallint)
language sql
stable
set search_path to ''
as $fn$
  select coalesce(n.enabled, true)                as enabled,
         coalesce(n.minutes_before, 70)          as minutes_before,
         coalesce(n.at_local_hour, 9)::smallint  as at_local_hour
    from (select p_org_id as org_id) ask
    left join public.org_notifications n
      on n.org_id = ask.org_id and n.kind = p_kind;
$fn$;

revoke execute on function private.notification_config(bigint, text)
  from public, anon, authenticated;

-- One person's weekly bill, lifted verbatim out of the tick.
--
-- Extracted rather than copied, because `public.send_test_notification`
-- (20261009100100) has to show an admin the REAL message and a second rendering
-- of it is how the preview and the Monday message start to disagree. The tick
-- below now calls this; the text is unchanged, character for character.
--
-- `v_account_balance` is `security_invoker = true` (20261006100100), so inside
-- the SECURITY DEFINER callers of this function it reads as `postgres` with RLS
-- skipped. The org and profile predicates here are therefore the only thing
-- scoping it, which is exactly why both are in the WHERE clause rather than
-- left to the caller.
create or replace function private.weekly_bill_message(p_period_id bigint, p_profile_id uuid)
returns text
language sql
stable
set search_path to ''
as $fn$
  select 'Your lunch for ' || to_char(bp.period_start, 'DD/MM') || ' to '
           || to_char(bp.period_end, 'DD/MM') || ': '
           || st.meal_count::text
           || case when st.meal_count = 1 then ' meal, ' else ' meals, ' end
           || private.money_text(st.meals_minor, o.currency_minor_units, o.currency)
           || '. You owe ' || private.money_text(bal.balance_minor::bigint,
                                o.currency_minor_units, o.currency)
           || ' in total'
           || case when bal.balance_minor > st.meals_minor
                   then ', earlier weeks included' else '' end
           || '. Put '
           || private.display_payment_ref(o.short_code, mem.short_code, mem.payment_ref)
           || ' in the transfer message, the same one every week.'
           || ' It is required: only transfers carrying it reach the lunch app,'
           || ' so one sent without it leaves your bill unpaid with nothing for'
           || ' an admin to find.'
    from public.billing_statements st
    join public.billing_periods    bp  on bp.id = st.billing_period_id
    join public.organizations      o   on o.id = st.org_id
    join public.memberships        mem on mem.org_id = st.org_id
                                      and mem.profile_id = st.profile_id
    join public.v_account_balance  bal on bal.org_id = st.org_id
                                      and bal.profile_id = st.profile_id
   where st.billing_period_id = p_period_id
     and st.profile_id = p_profile_id;
$fn$;

revoke execute on function private.weekly_bill_message(bigint, uuid)
  from public, anon, authenticated;

-- The tick, reprinted from the DEPLOYED definition rather than from
-- 20261005100000. The two had drifted in their comments -- production still
-- carried the pre-20261003100000 note above the per-member weekly bill, and its
-- join list was aligned differently -- while the executable SQL was identical.
-- Reprinting from what is actually running is the only way a reader can trust
-- this file against `pg_get_functiondef`.
--
-- Four things change and nothing else:
--
--   * the three settings are read once per office, at the top of the loop;
--   * each send is wrapped in its own `enabled` test;
--   * `interval '70 minutes'` becomes `make_interval(mins => ...)`;
--   * `v_hour >= 9` becomes `v_hour >= v_bill_hour`.
--
-- Note WHERE the weekly bill's switch sits. `enabled = false` skips the two
-- outbox inserts and nothing else: `run_billing` and the period close still
-- happen on schedule. An admin who does not want a Monday message has said
-- nothing about whether the week should be billed, and reading it the other way
-- would quietly stop the money instead.
--
-- `at_local_hour` does gate the whole block, because it is the clock for the
-- run and the message alike, exactly as the hardcoded 9 was. `>=` is kept for
-- the reason it was always there: a tick missed at the chosen hour is made good
-- an hour later rather than a week later.
--
-- A longer `minutes_before` cannot double-send. The dedupe key is
-- `org:<id>:cutoff_warning:<service_date>` plus `:group` or `:profile:<uuid>`,
-- it is globally unique, and every insert here is `on conflict do nothing`, so
-- however many consecutive ticks now see the same menu inside the window, only
-- the first writes a row. Widening the window widens which tick sends first, not
-- how many messages arrive. Narrowing it after a warning has gone out does not
-- recall it, and nothing here re-renders a body once it is enqueued.
create or replace function private.run_hourly_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  o            public.organizations%rowtype;
  v_today      date;
  v_hour       integer;
  v_period_id  bigint;
  v_period     public.billing_periods%rowtype;
  v_menu_on    boolean;
  v_cutoff_on  boolean;
  v_cutoff_min integer;
  v_bill_on    boolean;
  v_bill_hour  smallint;
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

      -- Read once per office, not once per insert. An office with no row in
      -- org_notifications gets true/70/9 here, which is what this function did
      -- before the table existed.
      select c.enabled into v_menu_on
        from private.notification_config(o.id, 'menu_published') c;
      select c.enabled, c.minutes_before into v_cutoff_on, v_cutoff_min
        from private.notification_config(o.id, 'cutoff_warning') c;
      select c.enabled, c.at_local_hour into v_bill_on, v_bill_hour
        from private.notification_config(o.id, 'weekly_bill') c;

      ------------------------------------------------------------ a. lock menus
      -- Not hour-gated: a cutoff is an instant per menu, not an hour of the
      -- day, and the update erases its own precondition.
      --
      -- Deliberately outside every switch above. Locking a menu whose cutoff
      -- has passed is the ordering rule, not a message, and an office that
      -- turned off the cutoff warning has not asked to keep ordering all night.
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
        if v_menu_on then
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
        end if;

        if v_cutoff_on then
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
             and m.order_cutoff_at <= now() + make_interval(mins => v_cutoff_min)
          on conflict (dedupe_key) do nothing;
        end if;
      end if;

      -- The same two announcements, to everybody who finished /start.
      --
      -- Outside the group guard on purpose. A private chat exists the moment
      -- somebody links; the group id is a fallback an admin may never set, and
      -- while it is null these two were the only rows the tick ever produced,
      -- so nothing reached anybody at all. The group copy stays where a group
      -- exists, because one message in the room beats five identical ones.
      --
      -- One switch covers both copies of a kind. An office that wants the menu
      -- in the room but not in five private chats is asking for a different
      -- setting than this one, and half-honouring the switch is worse than
      -- refusing it.
      if v_menu_on then
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
      end if;

      if v_cutoff_on then
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
           and m.order_cutoff_at <= now() + make_interval(mins => v_cutoff_min)
        on conflict (dedupe_key) do nothing;
      end if;

      -------------------------------------------------------------- c. billing
      -- The org's local week has turned over. `at_local_hour` rather than
      -- midnight because this is when the bill is delivered, and `>=` rather
      -- than `=` so a tick missed at that hour is made good at the next one
      -- instead of a week later.
      if extract(isodow from v_today)::integer = o.billing_week_starts_on
         and v_hour >= v_bill_hour then
        -- the week that just ended is the one containing yesterday
        v_period_id := public.ensure_billing_period(o.id, v_today - 1);

        -- NULL only when an older non-void period overlaps the week asked for,
        -- i.e. the org's week boundary was moved mid-history. Skip rather than
        -- bill the wrong seven days.
        if v_period_id is not null then
          select bp.* into v_period from public.billing_periods bp where bp.id = v_period_id;

          -- No `v_bill_on` here, and that is the point of the comment above the
          -- function: switching off the message does not stop the billing.
          if v_period.status <> 'closed' then
            perform public.run_billing(v_period_id);
            update public.billing_periods bp
               set status = 'closed', closed_at = now()
             where bp.id = v_period_id;
          end if;

          -- Outside that guard on purpose: a tick that closed the period and
          -- then died still owes everybody a message, and the dedupe keys make
          -- the second attempt free.
          if v_bill_on and o.telegram_group_chat_id is not null then
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
          --
          -- The body moved to `private.weekly_bill_message` unchanged. `mem`
          -- and `bal` stay in the join list because the chat lookup and the
          -- `still owes` test need them, not because the text does.
          if v_bill_on then
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
                   private.weekly_bill_message(v_period_id, st.profile_id),
                   'none',
                   v_period_id
              from public.billing_statements st
              join public.memberships    mem on mem.org_id = st.org_id
                                            and mem.profile_id = st.profile_id
              join public.v_account_balance bal on bal.org_id = st.org_id
                                               and bal.profile_id = st.profile_id
              join public.telegram_links tl  on tl.membership_id = mem.id
             where st.billing_period_id = v_period_id
               and st.status <> 'waived'
               and bal.balance_minor > 0
               and tl.chat_id is not null
            on conflict (dedupe_key) do nothing;
          end if;
        end if;
      end if;

    exception when others then
      raise warning 'hourly tick failed for org %: % (%)', o.id, sqlerrm, sqlstate;
    end;
  end loop;
end $$;
