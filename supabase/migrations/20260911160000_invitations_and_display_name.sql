-- Joining an org by invitation, so membership is not tied to an email domain.
--
-- An invitee is by definition not yet a member, so no RLS policy could let them
-- see their own invitation row: every policy on that table is org-scoped, and
-- they are in no org. A SECURITY DEFINER function is therefore the only
-- possible path in, and it is deliberately the ONLY one -- it is the single
-- place where a stranger gains access to a tenant's data, so all the checks
-- live together where they can be read at once.

create or replace function public.accept_invitation(p_token uuid)
returns table (org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv   public.invitations%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_code  text;
begin
  if v_uid is null then
    raise exception 'You need to sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select lower(p.email) into v_email from public.profiles p where p.id = v_uid;

  -- Locked because the row is about to be marked accepted, and two clicks on
  -- the same link should not produce two memberships.
  select * into v_inv from public.invitations i where i.token = p_token for update;
  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'no_data_found';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'That invitation has already been used.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'That invitation has expired. Ask an admin for a new one.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The invitation names an address. Honouring it for a different account
  -- would turn a forwarded link into an open door, so the signed-in email must
  -- match. Case-insensitive, because people capitalise inconsistently.
  if lower(v_inv.email) <> v_email then
    raise exception 'This invitation was sent to %. You are signed in as %.',
      v_inv.email, v_email using errcode = 'insufficient_privilege';
  end if;

  -- Already a member: accept the link and return the org rather than failing,
  -- so clicking an old link is harmless.
  if exists (select 1 from public.memberships m
              where m.org_id = v_inv.org_id and m.profile_id = v_uid) then
    update public.invitations set accepted_at = now() where id = v_inv.id;
  else
    v_code := private.suggest_short_code(v_inv.org_id, v_uid);
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_inv.org_id, v_uid, v_inv.role, v_code);
    update public.invitations set accepted_at = now() where id = v_inv.id;
  end if;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = v_uid
     where o.id = v_inv.org_id;
end $$;

revoke execute on function public.accept_invitation(uuid) from public, anon;
grant  execute on function public.accept_invitation(uuid) to authenticated;

-- Admins need to read back the token to build a link. The existing
-- invitations_admin_all policy already permits that; this just states the
-- intent for anyone auditing the table.
comment on column public.invitations.token is
  'Bearer capability. Anyone with this token and the matching email address can join the org.';

-- Display name is per-org: the same person may be "Neil" in one office and
-- their full legal name in another. The column and its grant already exist;
-- this backfills it so the UI has something to show rather than falling back
-- to the profile every time.
update public.memberships m
   set display_name = p.full_name
  from public.profiles p
 where p.id = m.profile_id and m.display_name is null;
