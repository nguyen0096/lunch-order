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
-- already shares. Never a zero: 0 is a real price. Everything else in the
-- message is unchanged, character for character, from 20260930100200, which is
-- also what production runs.
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
         || coalesce((select string_agg(
                               '- ' || mi.name || '  '
                                 || coalesce(private.money_text(mi.price_minor,
                                               o.currency_minor_units, o.currency),
                                             'price to come'),
                               E'\n' order by mi.position, mi.id)
                        from public.menu_items mi
                       where mi.menu_id = m.id and mi.is_available), '')
         || E'\nOrders close '
         || to_char(m.order_cutoff_at at time zone o.timezone, 'HH24:MI DD/MM') || '.'
    from public.menus m
    join public.organizations o on o.id = m.org_id
   where m.id = p_menu_id;
$fn$;

revoke execute on function private.menu_message(bigint) from public, anon, authenticated;
