-- An admin's correction did not reach the bill until the week closed.
--
-- Passing a meal to somebody else moves who is charged for it:
-- `v_order_charges.payer_profile_id` follows the transfer immediately. But the
-- bill is not built from that view at read time, it is built from
-- `billing_lines`, which only change when `run_billing` runs. And nothing runs
-- it when a transfer is recorded: the hourly tick calls it once, on the
-- morning it CLOSES the week.
--
-- So the case this app is supposed to be good at failed quietly. An admin
-- reviewing the week asks "did anyone swap?", records that Quy gave Wednesday
-- to Dinh, and nothing on any screen moves. Measured before this migration:
-- after the admin's write, `v_order_charges` said DINH and `billing_lines`
-- still said QUYT, and would have gone on saying it for days.
--
-- Re-bill the week the meal belongs to, as soon as the transfer settles.
-- Cheap: one period, a few dozen rows, and `run_billing` was already written
-- to be re-run.
--
-- Only an OPEN period. A closed one is a bill people have been sent, and
-- `enforce_transfer_rules` already refuses a transfer whose meal is on one, so
-- reaching a closed period here would mean a rule above had failed.

create or replace function public.trg_transfer_rebills()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare v_period bigint;
begin
  select bp.id into v_period
    from public.orders o
    join public.billing_periods bp
      on bp.org_id = o.org_id
     and o.service_date between bp.period_start and bp.period_end
   where o.id = new.order_id
     and bp.status not in ('closed', 'void');
  if v_period is null then return null; end if;

  perform public.run_billing(v_period);
  return null;
end $function$;

drop trigger if exists meal_transfers_rebill on public.meal_transfers;
create trigger meal_transfers_rebill
  after insert or update of status on public.meal_transfers
  for each row
  -- Only the states that change who pays. A pending offer changes nobody, and
  -- re-billing on every keystroke of an offer nobody has answered is work for
  -- an answer that has not arrived.
  when (new.status in ('accepted', 'declined', 'cancelled'))
  execute function public.trg_transfer_rebills();

revoke all on function public.trg_transfer_rebills() from public, anon, authenticated;
