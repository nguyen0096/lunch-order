-- Accepting an invitation applies the role it carries, and reactivates a
-- membership that was deactivated.
--
-- The previous version treated "already a member" as nothing to do, which was
-- written for the harmless case of clicking a stale link twice. But it
-- silently discarded the invited role, so re-inviting someone as an admin left
-- them a member with no indication anything had been ignored.
--
-- Two deliberate limits on applying it:
--
--   * An owner's role is never changed by a link. Ownership is not something
--     an invitation should be able to alter, in either direction.
--   * A role is never LOWERED. A stale link should not quietly reduce
--     someone's access weeks later, and demotion deserves an explicit action
--     by an admin rather than a side effect of someone clicking a URL.
--
-- So the effect is: restore access, and raise the role if the invitation says
-- so. Anything else is a no-op, as before.

create or replace function public.accept_invitation(p_token uuid)
returns table (org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv   public.invitations%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_existing public.memberships%rowtype;
  v_rank  jsonb := '{"member":1,"admin":2,"owner":3}'::jsonb;
begin
  if v_uid is null then
    raise exception 'You need to sign in first.' using errcode = 'insufficient_privilege';
  end if;

  select lower(p.email) into v_email from public.profiles p where p.id = v_uid;

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
  if lower(v_inv.email) <> v_email then
    raise exception 'This invitation was sent to %. You are signed in as %.',
      v_inv.email, v_email using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing from public.memberships m
   where m.org_id = v_inv.org_id and m.profile_id = v_uid for update;

  if found then
    update public.memberships m set
      status = 'active',
      role = case
               when m.role = 'owner' then m.role                      -- never touch an owner
               when (v_rank ->> v_inv.role)::int > (v_rank ->> m.role)::int
                 then v_inv.role                                      -- raise only
               else m.role
             end
     where m.org_id = v_inv.org_id and m.profile_id = v_uid;
  else
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_inv.org_id, v_uid, v_inv.role,
            private.suggest_short_code(v_inv.org_id, v_uid));
  end if;

  update public.invitations set accepted_at = now() where id = v_inv.id;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = v_uid
     where o.id = v_inv.org_id;
end $$;

revoke execute on function public.accept_invitation(uuid) from public, anon;
grant  execute on function public.accept_invitation(uuid) to authenticated;
