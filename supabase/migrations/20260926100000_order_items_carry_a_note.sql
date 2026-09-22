-- "ít cơm", "không trứng", "more rice".
--
-- Ordering a dish by name is not quite ordering lunch. People want it without
-- the egg, with less rice, extra chilli, and today that goes to the admin over
-- chat and gets lost between the board and the caterer. The board is the
-- headcount an admin defends; it should carry the request too.
--
-- On order_items rather than orders because the note is about the dish: it is
-- read alongside a name and a price when somebody compiles the caterer's list.
-- An order with no dish chosen has nothing to qualify.
--
-- Short on purpose. This is a line in a message to a caterer, not a comment
-- thread, and a long one will not survive being read aloud down a phone.
-- `if not exists` so re-running the file is a no-op rather than an error, the
-- same reason the pg_cron migration unschedules before it schedules.
alter table public.order_items
  add column if not exists note text
    check (note is null or length(btrim(note)) between 1 and 120);

comment on column public.order_items.note is
  'How this person wants the dish. Goes to the caterer, so keep it short.';

-- Members already hold UPDATE on the two columns they may change. The note is a
-- third, and it is theirs: price and ownership stay withheld, which is what the
-- three-layer price snapshot depends on.
grant update (menu_item_id, quantity, note) on public.order_items to authenticated;
