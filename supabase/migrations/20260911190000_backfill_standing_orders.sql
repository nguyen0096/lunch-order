-- Backfill standing orders for menus published before the materialize-on-publish
-- trigger existed.
--
-- Those menus were published while nothing was listening, so the rules never
-- ran for them. materialize_open_menus() sweeps every published menu whose
-- cutoff has not passed and is idempotent -- it inserts nothing for a member
-- who already has an order, and cannot resurrect one they cancelled, because
-- the cancelled row still holds the (menu_id, profile_id) slot.
--
-- Safe to re-run. Menus whose cutoff has already passed are deliberately left
-- alone: adding someone to a headcount that has gone to the caterer would be
-- worse than the gap it fixes.
do $$
declare v_n integer;
begin
  select public.materialize_open_menus() into v_n;
  raise notice 'backfilled % standing order(s)', v_n;
end $$;
