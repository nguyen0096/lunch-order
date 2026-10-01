-- A week's payment reference can repeat.
--
-- A statement's reference is 'LUNCH' || ISO week || short code, so the same
-- person billed in week 40 of two years gets the same one, and
-- billing_statements_ref_uk refused the second year's statement, failing the
-- whole re-bill. People reuse a payment note from one transfer to the next,
-- so the reference is not made unique by adding a year; it was never what
-- identified a statement.
--
-- private.payer_from_memo already settles a repeat: a member's own reference
-- first, then statements by longest reference and newest week, so a short code
-- that changed hands credits its newest holder.
--
-- That lookup filters on the office and tests each reference against the memo,
-- so it keeps an (org_id, payment_ref) index, no longer unique.

alter table public.billing_statements drop constraint billing_statements_ref_uk;
create index billing_statements_org_ref_idx on public.billing_statements (org_id, payment_ref);
