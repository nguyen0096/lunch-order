-- A removed admin could walk back in as an admin.
--
-- join_with_code hardcodes 'member' on the INSERT branch, and the comment above
-- the other branch says "a code shared in a group chat must not promote". It
-- does not promote. It reinstates, which for somebody who was removed is the
-- same outcome:
--
--   elsif v_mem.status <> 'active' then
--     update public.memberships m set status = 'active' where m.id = v_mem.id
--
-- Reproduced: an admin whose membership was set to status='inactive' called
-- join_with_code and came back active, still role='admin'. Deactivation is this
-- app's removal mechanism (my_org_ids filters on status), and the string that
-- undoes it is readable by every remaining member and usually pinned in a group
-- chat.
--
-- So the rule becomes what the comment always claimed: a join code grants
-- membership and nothing else, on every path. Coming back is easy, and coming
-- back with authority takes a deliberate act by somebody who already has it.
--
-- Consequence worth knowing: an owner who is deactivated and rejoins by code
-- returns as a member, and only another owner can restore them. Only an owner
-- can deactivate an owner (20260925100300), so that state is always something
-- an owner chose. create_organization remains the other way an owner exists.

create or replace function public.join_with_code(p_code text, p_display_name text, p_chat_id bigint)
returns table(org_id bigint, org_slug text, org_name text, role text)
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
    -- Re-tapping the link is how somebody who was deactivated comes back, and
    -- they come back as a member whatever they were before. Deactivation is how
    -- this app removes people; a string in a group chat must not undo the
    -- authority part of that.
    update public.memberships m set status = 'active', role = 'member'
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
