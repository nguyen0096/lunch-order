-- Description: twelve weeks of plausible lunch history for the Test Office.
--
-- Run against a project where org `test-office` is scratch data:
--   psql "$DATABASE_URL" -f supabase/seed/test-office-history.sql
--
-- Re-running it is safe: everything it writes is deleted first, by date range
-- and org, so the script converges rather than piling week on week.
--
-- It refuses to touch any office but `test-office`. The whole point of a
-- history this size is that it is disposable, and the guard is what keeps
-- "disposable" true of this office and no other.
--
-- Written as service role on purpose. `enforce_order_window`,
-- `enforce_menu_not_in_past` and the rest all defer to `private.is_service()`,
-- which is what lets a past week be built at all -- no admin, and no UI, can
-- create an order on a menu that locked ten weeks ago.

begin;

do $seed$
declare
  v_org      bigint;
  v_tz       text;
  v_today    date;
  v_from     date;
  v_week     date;
  v_day      date;
  v_menu     bigint;
  v_order    bigint;
  v_period   bigint;
  v_person   record;
  v_item     bigint;
  v_price    bigint;
  v_dishes   bigint[];
  v_seed     bigint;
  v_weeks    constant int := 12;
  -- Dishes a caterer in Ho Chi Minh City actually sends, with the prices they
  -- actually charge. Two or three a day, drawn by the day's own seed.
  v_menu_pool constant text[] := array[
    'Cơm gà', 'Cơm tấm', 'Cơm sườn', 'Bún bò', 'Bún thịt nướng', 'Phở bò',
    'Phở gà', 'Mì Quảng', 'Hủ tiếu', 'Bánh canh', 'Cơm chiên dương châu',
    'Bún chả', 'Cháo lòng', 'Bánh mì thịt'
  ];
  v_price_pool constant bigint[] := array[
    40000, 45000, 45000, 50000, 50000, 55000, 55000, 60000, 45000, 50000,
    55000, 50000, 40000, 35000
  ];
begin
  select o.id, o.timezone into v_org, v_tz
    from public.organizations o where o.slug = 'test-office';
  if v_org is null then
    raise exception 'no office with slug test-office on this project; refusing to seed';
  end if;

  v_today := private.today_in(v_tz);
  -- Start on the Monday `v_weeks` weeks back, so every generated week is whole.
  v_from  := date_trunc('week', v_today)::date - (v_weeks * 7);

  ------------------------------------------------------------------ clean up
  -- Order matters: charges reference orders, statements reference periods.
  -- Only what this script wrote. A date range would take real payments
  -- recorded this week against an older statement with it.
  delete from public.payments p
   where p.org_id = v_org and p.provider_txn_id like 'seed-%';
  delete from public.billing_lines bl
   where bl.org_id = v_org and bl.service_date >= v_from and bl.service_date < date_trunc('week', v_today)::date;
  delete from public.billing_statements st
   where st.org_id = v_org
     and st.billing_period_id in (select id from public.billing_periods
                                   where org_id = v_org and period_start >= v_from
                                     and period_end < date_trunc('week', v_today)::date);
  delete from public.billing_periods bp
   where bp.org_id = v_org and bp.period_start >= v_from
     and bp.period_end < date_trunc('week', v_today)::date;
  -- Transfers hang off the order, not off a date of their own.
  delete from public.meal_transfers mt
   where mt.org_id = v_org
     and mt.order_id in (select id from public.orders where org_id = v_org
                          and service_date >= v_from
                          and service_date < date_trunc('week', v_today)::date);
  delete from public.order_items oi
   where oi.org_id = v_org
     and oi.menu_id in (select id from public.menus where org_id = v_org
                         and service_date >= v_from and service_date < date_trunc('week', v_today)::date);
  delete from public.orders o
   where o.org_id = v_org and o.service_date >= v_from
     and o.service_date < date_trunc('week', v_today)::date;
  delete from public.menu_items mi
   where mi.org_id = v_org
     and mi.menu_id in (select id from public.menus where org_id = v_org
                         and service_date >= v_from and service_date < date_trunc('week', v_today)::date);
  delete from public.menus m
   where m.org_id = v_org and m.service_date >= v_from
     and m.service_date < date_trunc('week', v_today)::date;

  ------------------------------------------------------------------ the weeks
  v_week := v_from;
  while v_week < date_trunc('week', v_today)::date loop
    for i in 0..4 loop
      v_day  := v_week + i;
      -- One stable number per day. Everything about the day is drawn from it,
      -- so the same script twice produces the same history.
      v_seed := abs(hashtext(v_day::text));

      -- A week in five without lunch: a holiday, a caterer's day off, the
      -- office out at a party. Screens have to survive a gap, so make one.
      continue when v_seed % 23 = 0;

      insert into public.menus (org_id, service_date, status, order_cutoff_at,
                                source_text, published_at, locked_at, created_by)
      values (v_org, v_day, 'locked',
              ((v_day - 1)::text || ' 21:00')::timestamp at time zone v_tz,
              'Thực đơn ' || to_char(v_day, 'DD/MM'),
              ((v_day - 2)::text || ' 09:00')::timestamp at time zone v_tz,
              (v_day::text || ' 08:30')::timestamp at time zone v_tz,
              '450bf72b-8d4a-4fe8-8aad-29fd7af39a97')
      returning id into v_menu;

      -- Two or three dishes, drawn without repeating within the day.
      v_dishes := '{}';
      for j in 0..(1 + (v_seed % 2)) loop
        declare
          v_pick int := 1 + ((v_seed / (7 ^ j)::bigint + j * 5) % array_length(v_menu_pool, 1));
        begin
          -- The last week's prices are deliberately left unsaid: that is the
          -- "caterer has not priced it yet" path, and it needs a week on it.
          v_price := case when v_week >= date_trunc('week', v_today)::date - 7 and j = 0
                          then null else v_price_pool[v_pick] end;
          insert into public.menu_items (menu_id, org_id, name, price_minor, position)
          values (v_menu, v_org, v_menu_pool[v_pick], v_price, j)
          on conflict do nothing
          returning id into v_item;
          if v_item is not null then v_dishes := v_dishes || v_item; end if;
          v_item := null;
        end;
      end loop;
      continue when array_length(v_dishes, 1) is null;

      -- Who ate. Everybody has their own rhythm: one eats nearly every day,
      -- one rarely, the rest in between, and nobody eats on the day they are
      -- off. Drawn from the day's seed and the person, so it is stable.
      for v_person in
        select m.profile_id, row_number() over (order by m.profile_id) as n
          from public.memberships m
         where m.org_id = v_org and m.status = 'active'
      loop
        continue when (abs(hashtext(v_day::text || v_person.profile_id::text)) % 10) < (2 + v_person.n % 4);

        insert into public.orders (org_id, menu_id, service_date, profile_id,
                                   source, status, placed_at, created_by)
        values (v_org, v_menu, v_day, v_person.profile_id,
                case when v_person.n % 3 = 0 then 'standing' else 'member' end,
                'placed',
                ((v_day - 1)::text || ' 18:00')::timestamp at time zone v_tz,
                v_person.profile_id)
        returning id into v_order;

        insert into public.order_items (order_id, org_id, profile_id, menu_id,
                                        menu_item_id, quantity)
        values (v_order, v_org, v_person.profile_id, v_menu,
                v_dishes[1 + (abs(hashtext(v_person.profile_id::text || v_day::text))
                              % array_length(v_dishes, 1))],
                1);
      end loop;
    end loop;

    ---------------------------------------------------------------- the bill
    v_period := public.ensure_billing_period(v_org, v_week);
    perform public.run_billing(v_period, true);

    -- Everything older than a fortnight is settled, because that is what a
    -- real book looks like: the argument is always about the last two weeks.
    if v_week < date_trunc('week', v_today)::date - 14 then
      insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                                   memo, received_at, raw)
      select v_org, 'manual', 'seed-' || st.id::text,
             st.total_due_minor - st.paid_minor,
             'CK ' || st.payment_ref,
             ((v_week + 7)::text || ' 10:00')::timestamp at time zone v_tz,
             jsonb_build_object('seed', true)
        from public.billing_statements st
       where st.billing_period_id = v_period
         and st.total_due_minor > st.paid_minor;
      update public.billing_periods set status = 'closed', closed_at = now()
       where id = v_period;
    end if;
    v_week := v_week + 7;
  end loop;

  ------------------------------------------------------- the interesting week
  -- A fortnight back: one person pays half, one is waived, the rest are owing.
  -- This is the week the Payments screen is for, so it is the week that has
  -- every status on it at once.
  select id into v_period from public.billing_periods
   where org_id = v_org and period_start = date_trunc('week', v_today)::date - 14;

  insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                               memo, received_at, raw)
  select v_org, 'sepay', 'seed-half-' || st.id::text,
         greatest((st.total_due_minor - st.paid_minor) / 2, 1000),
         'CK ' || st.payment_ref || ' tra truoc',
         (date_trunc('week', v_today)::date - 6)::text::timestamp at time zone v_tz,
         jsonb_build_object('seed', true)
    from public.billing_statements st
   where st.billing_period_id = v_period and st.total_due_minor > st.paid_minor
   order by st.payment_ref limit 1;

  update public.billing_statements st
     set status = 'waived'
   where st.id = (select id from public.billing_statements
                   where billing_period_id = v_period and status = 'unpaid'
                   order by payment_ref desc limit 1);

  -- Money that matched nobody, which is what the top of the Payments screen
  -- exists for. One is a typo'd reference, one carries none at all.
  insert into public.payments (org_id, provider, provider_txn_id, amount_minor,
                               memo, received_at, raw)
  values
    (v_org, 'sepay', 'seed-orphan-1', 250000, 'CK LUNCH39XXXX an trua',
     (v_today - 3)::text::timestamp at time zone v_tz, jsonb_build_object('seed', true)),
    (v_org, 'sepay', 'seed-orphan-2', 180000, 'NGUYEN VAN A chuyen tien',
     (v_today - 1)::text::timestamp at time zone v_tz, jsonb_build_object('seed', true));

  -- The current week is not seeded, but it now has twelve weeks behind it and
  -- its statements were computed when it had none. `carried_in_minor` is read
  -- at billing time and never refreshed, so without this the newest bill shows
  -- its own meals while the week below it says the remainder was carried in --
  -- the two sentences contradicting each other on one screen.
  select id into v_period from public.billing_periods
   where org_id = v_org and period_start = date_trunc('week', v_today)::date;
  if v_period is not null then
    perform public.run_billing(v_period, true);
  end if;

  raise notice 'seeded % weeks of history for office %', v_weeks, v_org;
end
$seed$;

commit;
