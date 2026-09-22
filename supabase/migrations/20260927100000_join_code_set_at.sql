-- When the join code was last set.
--
-- The People screen leads with the code and says when it was last set, because
-- that sentence is half of the detection story: a code unchanged for a year has
-- had a year to reach somebody it should not.
--
-- organizations.updated_at cannot answer it. It moves when anything on the row
-- moves, so a timezone change would be reported to an admin as a rotation. A
-- number that is wrong in a way nobody can see is worse than no number.

alter table public.organizations
  add column telegram_join_code_set_at timestamptz;

comment on column public.organizations.telegram_join_code_set_at is
  'When telegram_join_code was last written. Owned entirely by the stamp_join_code_set_at trigger; a value sent by a client is discarded. Null means the code predates this column; do not read null as "never".';

-- Nullable and deliberately not backfilled. The codes that exist today were set
-- at a time nobody recorded, and stamping them with created_at or now() would
-- invent a fact the screen then reads out as though it had been measured. The
-- screen says "set before this was recorded" until the next rotation.

-- Stamped here rather than by whoever happens to be writing.
--
-- The obvious alternative is for the People screen to send the timestamp in the
-- same UPDATE that rotates the code, and it is wrong twice over: it is a promise
-- every future client has to remember to keep -- the documented
-- `update organizations set telegram_join_code = ...` in
-- docs/how-to/rotate-the-join-code.md would have broken it on day one -- and it
-- takes the reading from the browser's clock, which the browser's owner sets.
--
-- The `else` branch is the load-bearing one. Withholding a column grant does NOT
-- protect this column: `authenticated` holds UPDATE on organizations at table
-- level, and Postgres will not let a column-level REVOKE carve an exception out
-- of a table-level grant -- the revoke runs, reports success, and changes
-- nothing. Measured, not assumed: a client forged the stamp equally well before
-- and after the revoke. Discarding whatever arrived is what actually makes the
-- trigger the only writer, and it needs no grants to be true.
create or replace function public.stamp_join_code_set_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    new.telegram_join_code_set_at :=
      case when new.telegram_join_code is not null then now() else null end;
  elsif new.telegram_join_code is distinct from old.telegram_join_code then
    new.telegram_join_code_set_at := now();
  else
    new.telegram_join_code_set_at := old.telegram_join_code_set_at;
  end if;
  return new;
end
$fn$;

create trigger organizations_stamp_join_code
before insert or update on public.organizations
for each row execute function public.stamp_join_code_set_at();
