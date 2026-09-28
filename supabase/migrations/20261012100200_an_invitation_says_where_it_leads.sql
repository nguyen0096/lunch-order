-- An invitation says where it leads before you accept it.
--
-- An invitee is in no office yet, so `invitations_admin_all` shows them
-- nothing, and the join page could only say "you've been invited to an office
-- lunch board" and ask them to accept blind. This answers, for one token, the
-- three things the page needs: which office, as what, and whether the link
-- still works.
--
-- Nothing else leaves: not the address the invitation was sent to, not who
-- sent it, not an id. The token is the credential, and holding it already
-- entitles somebody to find out all of this by pressing Accept, which answers
-- 'not valid', 'already used' and 'expired' in so many words. So this opens no
-- oracle accept_invitation does not: a token is a v4 uuid from
-- gen_random_uuid(), 122 random bits, and nobody enumerates that space.
--
-- A token that matches nothing, or whose office was deleted, returns no row
-- rather than raising, so the page can tell "not valid" from "could not ask".
--
-- Signed-in callers only. The app shows the sign-in page before the join page
-- (src/web/App.tsx) and keeps the token across the Google redirect, and an
-- anonymous Telegram sign-in is `authenticated` too, so nobody who can reach
-- the page is refused.

create or replace function public.invitation_preview(p_token uuid)
returns table(org_name text, role text, expires_at timestamptz, state text)
language sql
stable
security definer
set search_path to ''
as $fn$
  select o.name,
         i.role,
         i.expires_at,
         case
           when i.accepted_at is not null then 'used'
           when i.expires_at < now()      then 'expired'
           else 'valid'
         end
    from public.invitations i
    join public.organizations o on o.id = i.org_id and o.deleted_at is null
   where i.token = p_token;
$fn$;

revoke execute on function public.invitation_preview(uuid) from public, anon;
grant  execute on function public.invitation_preview(uuid) to authenticated;
