-- A dish without a price is still on the menu.
--
-- Since 20260928100000 a dish may be published before the caterer names its
-- price. `private.menu_message` built each line as name || money_text(price),
-- and `money_text(NULL)` is NULL, so an unpriced dish's whole line was NULL and
-- `string_agg` skipped it. A menu of nothing but unpriced dishes announced
-- itself as "Menu for 29/09", a blank line, and the cutoff: no food at all.
--
-- The line now carries the words the bot's own /day uses for the same gap,
-- PRICE_TO_COME in src/shared/telegram.ts, which `private.order_amount_text`
-- already shares. Never a zero: 0 is a real price.
--
-- The list is also capped. Telegram refuses a sendMessage body over 4096
-- characters and the drain has no splitter, so a long menu used to be a message
-- nobody received. Dishes are listed in order until the list would pass 3800
-- characters, which leaves room for the header, the cutoff line, the count of
-- what was left out, and the preamble `send_test_notification` puts in front.
-- A dish name is at most 200 characters, so one line never spends that margin.
--
-- Everything else in the message is unchanged, character for character, from
-- 20260930100200, which is also what production runs.
--
-- The other builders that concatenate money or names were read for the same
-- bug and have none: every input they concatenate is NOT NULL, or is already
-- wrapped in coalesce or a case.

create or replace function private.menu_message(p_menu_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select 'Menu for ' || to_char(m.service_date, 'DD/MM') || E'\n'
         || coalesce(d.listed, '')
         || case when d.left_out = 0 then ''
                 else E'\nAnd ' || d.left_out
                      || case when d.left_out = 1 then ' more dish' else ' more dishes' end
                      || '. See the app for the full menu.'
            end
         || E'\nOrders close '
         || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '.'
    from public.menus m
    join public.organizations o on o.id = m.org_id
    cross join lateral (
      select string_agg(r.line, E'\n' order by r.n) filter (where r.upto <= 3800) as listed,
             count(*) filter (where r.upto > 3800) as left_out
        from (
          -- `upto` only grows, so once a line passes the cap every later line
          -- does too, and no dish is skipped in favour of a shorter one after it.
          select l.line, l.n,
                 sum(length(l.line) + 1) over (order by l.n) as upto
            from (
              select '- ' || mi.name || '  '
                       || coalesce(private.money_text(mi.price_minor,
                                     o.currency_minor_units, o.currency),
                                   'price to come') as line,
                     row_number() over (order by mi.position, mi.id) as n
                from public.menu_items mi
               where mi.menu_id = m.id and mi.is_available
            ) l
        ) r
    ) d
   where m.id = p_menu_id;
$fn$;

revoke execute on function private.menu_message(bigint) from public, anon, authenticated;
