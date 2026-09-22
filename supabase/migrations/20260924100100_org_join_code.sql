-- Joining an org by typing a short code, for somebody who has no email address.
--
-- public.invitations cannot carry this. It is keyed `unique (org_id, email)` and
-- accept_invitation matches the signed-in address against the one the row names,
-- which is exactly the property that makes it safe and exactly the property a
-- Telegram joiner cannot satisfy. So the org grows a second, weaker door: one
-- shared bearer code, rotatable by an admin, that grants plain membership and
-- nothing else. Weaker because it is reusable and not addressed to anyone;
-- acceptable because it grants the lowest role and an admin can void it by
-- overwriting the column.

alter table public.organizations
  add column telegram_join_code text
    -- People retype these off a phone screen, so the alphabet drops the four
    -- characters that get confused for each other: O/0 and I/1.
    check (telegram_join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12}$');

create unique index organizations_join_code_uk
  on public.organizations (telegram_join_code)
  where telegram_join_code is not null;

-- Rotation needs no new grant, which was checked rather than assumed: the
-- organizations ACL is `authenticated=arw` at TABLE level with no column ACLs
-- at all, so a table-level UPDATE covers a column added afterwards, and the
-- organizations_update_admin policy already restricts the rows to an admin's
-- own orgs.
comment on column public.organizations.telegram_join_code is
  'Shared bearer code. Anyone who can read it can join this org as a member. Rotate by overwriting, revoke by nulling.';

-- The Telegram counterpart of accept_invitation, and deliberately built to the
-- same shape: SECURITY DEFINER because the caller is by definition not yet a
-- member and therefore no RLS policy could ever show them the org row, and the
-- only path in, so every check sits in one readable place.
--
-- Called by the freshly created anonymous user carrying their OWN token, so
-- auth.uid() is them and the function never takes an identity as an argument.
create or replace function public.join_with_code(
  p_code text, p_display_name text, p_chat_id bigint)
returns table (org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_org   public.organizations%rowtype;
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_mem   public.memberships%rowtype;
  v_taken bigint;
begin
  if v_uid is null then
    raise exception 'You need to sign in first.' using errcode = 'insufficient_privilege';
  end if;

  if v_name = '' then
    raise exception 'Tell me your name first, so people can see who ordered.'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) > 80 then
    raise exception 'That name is too long. Keep it under 80 characters.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked for the reason accept_invitation locks the invitation, but the lock
  -- is on the ORG rather than on one row per joiner: private.suggest_short_code
  -- picks a code by reading the org's other memberships, so two people tapping
  -- the same group link at once would otherwise be handed the same code and one
  -- of them would lose to memberships_code_uk.
  select * into v_org from public.organizations o
   where o.telegram_join_code = upper(btrim(coalesce(p_code, '')))
   for update;
  if not found then
    raise exception 'That join code is not valid.' using errcode = 'no_data_found';
  end if;
  if v_org.status <> 'active' then
    raise exception 'That group is not taking new members right now.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The name lands BEFORE the membership. suggest_short_code derives the code
  -- from profiles.full_name and the code is what appears in a bank transfer
  -- memo, so running it first would stamp everyone with the signup placeholder.
  update public.profiles p set full_name = v_name where p.id = v_uid;

  select * into v_mem from public.memberships m
   where m.org_id = v_org.id and m.profile_id = v_uid for update;
  if not found then
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_org.id, v_uid, 'member', private.suggest_short_code(v_org.id, v_uid))
    returning * into v_mem;
  elsif v_mem.status <> 'active' then
    -- Re-tapping the link is how somebody who was deactivated comes back. The
    -- role is never touched: a code shared in a group chat must not promote.
    update public.memberships m set status = 'active'
     where m.id = v_mem.id
    returning * into v_mem;
  end if;

  if p_chat_id is not null then
    select tl.membership_id into v_taken from public.telegram_links tl
     where tl.org_id = v_org.id and tl.chat_id = p_chat_id
       and tl.membership_id <> v_mem.id;
    if found then
      raise exception 'This Telegram chat is already linked to somebody else in %. An admin has to unlink it first.',
        v_org.name using errcode = 'unique_violation';
    end if;

    begin
      insert into public.telegram_links (membership_id, org_id, chat_id, linked_at)
      values (v_mem.id, v_org.id, p_chat_id, now())
      on conflict (membership_id) do update
        set chat_id = excluded.chat_id, linked_at = now();
    exception when unique_violation then
      -- telegram_links_chat_uk, lost to a concurrent joiner in the gap after the
      -- check above. Same situation, so the same sentence.
      raise exception 'This Telegram chat is already linked to somebody else in %. An admin has to unlink it first.',
        v_org.name using errcode = 'unique_violation';
    end;
  end if;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = v_uid
     where o.id = v_org.id;
end $$;

revoke execute on function public.join_with_code(text, text, bigint) from public, anon;
grant  execute on function public.join_with_code(text, text, bigint) to authenticated;
