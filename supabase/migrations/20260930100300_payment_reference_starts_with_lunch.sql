-- A payment reference that a webhook filter can key on, and a payer can read.
--
-- It was 'L' + ISO week + short code: L39NGUY. Two problems, one of them new.
--
-- SePay can be told to deliver a webhook only for transactions whose memo
-- carries a given payment-code prefix ("tiền tố mã thanh toán"). That is how an
-- office reconciles from a bank account that is also somebody's own: their
-- salary and their private transfers never carry the prefix, so they never reach
-- this app at all. It is the only route to that separation on a personal
-- account, because virtual accounts at BIDV are business-only.
--
-- A prefix of 'L' cannot carry that weight. Any memo with an L and two digits
-- would match, and the filter would leak exactly the transactions it exists to
-- keep out. 'LUNCH' collides with nothing anybody types by accident.
--
-- The second problem is older and simpler: L39NGUY tells the person typing it
-- nothing. LUNCH39NGUY says what the money is for, in the one place they are
-- guaranteed to look.
--
-- Forward only. `payment_ref` is written once, when run_billing first creates a
-- statement, and its `on conflict` list deliberately omits the column -- so
-- every reference already issued keeps its text, keeps matching the transfers
-- people have already sent, and nothing that has been quoted to anybody moves.
-- LUNCH + 2 + a 2-to-8 character short code is 9 to 15 characters, inside the
-- column's own 4-to-24 CHECK.
create or replace function private.payment_ref(p_org_id bigint, p_period_start date, p_profile_id uuid)
returns text
language plpgsql
stable
set search_path to ''
as $fn$
declare v_code text;
begin
  select m.short_code into v_code from public.memberships m
   where m.org_id = p_org_id and m.profile_id = p_profile_id;
  return 'LUNCH' || to_char(p_period_start, 'IW') || coalesce(v_code, 'X');
end
$fn$;
