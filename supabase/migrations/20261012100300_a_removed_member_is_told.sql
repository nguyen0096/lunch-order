-- A removed member is told so.
--
-- my_org_ids() counts active memberships only, so somebody an admin removed
-- sees exactly what somebody who never joined sees, and the no-office page
-- had to hedge between the two. This names the offices a person is no longer
-- active in, and says nothing else: no role, no dates, no colleague. It is
-- their own membership row and the name of an office they were in.
--
-- An office that was deleted is left out. Nobody removed them from it, and
-- nobody there can add them back.
--
-- 'inactive' is also what leave_office writes, and the row does not record
-- which of the two happened. Somebody who left knows they did; the page's
-- sentence is written for the one who did not.

create or replace function public.my_removed_offices()
returns table(org_name text)
language sql
stable
security definer
set search_path to ''
as $fn$
  select o.name
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
   where m.profile_id = (select auth.uid())
     and m.status = 'inactive'
   order by o.name;
$fn$;

revoke execute on function public.my_removed_offices() from public, anon;
grant  execute on function public.my_removed_offices() to authenticated;
