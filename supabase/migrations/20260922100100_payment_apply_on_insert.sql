-- Crediting a payment becomes a consequence of recording one.
--
-- apply_payment_to_statement() added to paid_minor every time it was called.
-- The payments insert is already idempotent -- payments_provider_txn_uk makes a
-- webhook redelivery a no-op -- but a handler that swallows the duplicate-key
-- error and then calls apply anyway credits the statement twice, and nothing
-- downstream notices because paid_minor has no ceiling.
--
-- An AFTER INSERT trigger inherits that unique constraint: no row, no trigger,
-- so the credit happens exactly as often as the payment does. Same move as
-- menus_materialize_on_publish, where materializing is an intrinsic
-- consequence of publishing rather than a step a caller has to remember.
--
-- Matching is containment, not equality. A bank memo arrives as free text with
-- the reference buried in it ("CT DEN TK ... L37NEIL ..."), so it is folded to
-- A-Z0-9 first and the statement whose payment_ref appears inside it wins.
--
-- A payment that matches nothing is still recorded. Someone typing the wrong
-- reference is the normal case, and the row is the evidence an admin needs to
-- reconcile by hand; rejecting it would throw the only record of the money away.

create or replace function public.trg_payment_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_memo text;
  v_st   public.billing_statements%rowtype;
begin
  v_memo := upper(regexp_replace(
              public.unaccent_fallback(coalesce(new.memo, '')), '[^A-Za-z0-9]', '', 'g'));
  if v_memo = '' then return null; end if;

  -- payment_ref is unique per org, but one can be a prefix of another
  -- ('L37AB' inside 'L37ABC'), so the longest match wins and an already
  -- settled statement loses to one that is still owed.
  select st.* into v_st
    from public.billing_statements st
   where st.org_id = new.org_id
     and position(st.payment_ref in v_memo) > 0
   order by (st.status in ('unpaid','partial')) desc,
            length(st.payment_ref) desc,
            st.billing_period_id desc
   limit 1;
  if not found then return null; end if;

  update public.payments set matched_statement_id = v_st.id where id = new.id;

  update public.billing_statements
     set paid_minor = paid_minor + new.amount_minor
   where id = v_st.id
  returning * into v_st;

  update public.billing_statements set
    status  = case when v_st.paid_minor >= v_st.total_due_minor then 'paid'
                   when v_st.paid_minor > 0                     then 'partial'
                   else 'unpaid' end,
    paid_at = case when v_st.paid_minor >= v_st.total_due_minor then coalesce(v_st.paid_at, now())
                   else null end
   where id = v_st.id;

  return null;
end $$;

-- AFTER, so the payment row exists before anything points at it, and so the
-- unique constraint has already decided whether this delivery is the first one.
create trigger payments_apply_on_insert
  after insert on public.payments
  for each row execute function public.trg_payment_apply();

-- Removed rather than left beside the trigger. It is ungranted, but an
-- ungranted double-credit is still a double-credit waiting for its first
-- caller, and nothing in the repo calls it.
drop function if exists public.apply_payment_to_statement(bigint, bigint);

-- Belt and braces. The ALTER DEFAULT PRIVILEGES in the grants migration already
-- withholds EXECUTE from PUBLIC on functions created here, and a trigger
-- function needs no runtime grant anyway, but this one is SECURITY DEFINER in
-- `public` and PostgREST exposes that schema at /rest/v1/rpc/<name>. It is the
-- exact shape of hole the grants migration was written to close.
revoke execute on function public.trg_payment_apply() from public, anon, authenticated;
