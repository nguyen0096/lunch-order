-- The bot and the web app disagreed about how to write money.
--
-- formatMoney in src/shared/money.ts asks Intl for the org's locale and gets
-- `45.000 ₫`: a dot for thousands and the dong sign, which is what Vietnamese
-- readers expect. money_text asked to_char, whose group separator comes from
-- lc_numeric on the server, and got `45,000 VND`.
--
-- The same lunch therefore cost `45.000 ₫` on the board and `45,000 VND` in
-- Telegram. Nobody misreads it, but it makes one product look like two, and the
-- comma reads as a decimal point to the people this is built for.
--
-- Keyed on currency rather than a locale argument on purpose. Adding a
-- parameter would mean a new overload rather than a replacement, and updating
-- the one caller means restating the whole 150-line run_hourly_tick in this
-- file to change a single argument. Currency and locale are one to one in this
-- schema today (VND implies vi-VN), and the check constraint on
-- currency_minor_units is what keeps them so.

create or replace function private.money_text(
  p_amount_minor bigint, p_minor_units smallint, p_currency char(3))
returns text language sql stable set search_path = '' as $$
  select case
    when p_currency = 'VND' then
      -- Build with commas, then swap: to_char's own separator is whatever
      -- lc_numeric says, so asking for a dot directly is not portable.
      pg_catalog.replace(
        pg_catalog.to_char(p_amount_minor::numeric, 'FM999G999G999G990'),
        ',', '.') || ' ₫'
    else
      pg_catalog.to_char(
        p_amount_minor::numeric
          / pg_catalog.power(10::numeric, p_minor_units::numeric),
        'FM999G999G999G990' ||
        case when p_minor_units > 0
             then 'D' || pg_catalog.repeat('0', p_minor_units::int)
             else '' end) || ' ' || p_currency
  end;
$$;

revoke execute on function private.money_text(bigint, smallint, char) from public, anon, authenticated;
