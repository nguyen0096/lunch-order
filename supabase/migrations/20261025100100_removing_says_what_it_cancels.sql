-- What removing somebody would cancel, for the People screen to ask first.
--
-- Remove was one tap, and adding the person back restores none of what it
-- cancelled. The owner's rule (2026-10-05): Remove asks first, naming the
-- meals and passes it would change.
--
-- One row per meal or pass, from the same `private.leaving_effects` the
-- removal itself runs, so the list and the removal cannot disagree about which
-- days are open. Read-only and lock-free: it takes no lock a removal or an
-- order would wait on, unlike `my_balance_after_leaving`, which has to run the
-- leaving to know the balance it leaves. The list is what is true when it is
-- read; the removal reads again under its locks.
--
-- `action` is `cancel` (their own meal), `return` (a meal passed to them goes
-- back to `other_name`), `cancel_passed` (a meal passed to them whose giver,
-- `other_name`, has gone, so it is cancelled) or `decline` (an offer from
-- `other_name` is declined). `dishes` is null for a meal with no dish yet.
create or replace function public.removal_preview(p_org_id bigint, p_profile_id uuid)
returns table (action text, service_date date, dishes text, other_name text)
language plpgsql stable security definer set search_path to '' as $fn$
begin
  -- Same refusal for another office and for one that does not exist.
  if not (p_org_id = any ((select private.my_admin_org_ids())::bigint[])) then
    raise exception 'only an admin of this office can remove somebody'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select e.action, o.service_date, private.order_dishes(o.id),
         case when e.action = 'cancel' then null
              else private.member_name(p_org_id, o.profile_id) end
    from private.leaving_effects(array[p_org_id], array[p_profile_id]) e
    join public.orders o on o.id = e.order_id
   order by o.service_date, e.action, o.id;
end $fn$;

revoke execute on function public.removal_preview(bigint, uuid) from public, anon;
grant execute on function public.removal_preview(bigint, uuid) to authenticated;
