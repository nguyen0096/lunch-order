-- A Telegram chat is bound by Telegram, never by whoever holds a join code.
--
-- join_with_code(p_code, p_display_name, p_chat_id, ...) was granted to every
-- signed-in user and wrote p_chat_id into telegram_links as given. Anybody
-- holding an office's join code could call it from a browser with somebody
-- else's Telegram user id and bind that person's private chat to their own
-- membership. The bot then messaged the victim as that member, and refused
-- the victim's own join later with "already linked to somebody else".
--
-- A chat id is only worth trusting when it comes from an update Telegram sent,
-- and the one caller that can say so is the bot, after it has checked the
-- webhook secret. So the join is split:
--
--   * private.join_office_with_code(profile, code, name, short code, chat) does
--     the work, chat included. Nobody but the database owner and service_role
--     can execute it; the bot reaches it over its own Postgres connection, with
--     a profile it resolved from that same chat or has just signed up.
--   * public.join_with_code(p_code, p_display_name, p_short_code) is the
--     browser's door. It has no chat argument at all.
--   * The old four-argument signature stays for bundles and bot builds still
--     running when this lands. It accepts a null chat and refuses any other,
--     so nothing reaches telegram_links through it. Drop it once the SPA and
--     the telegram function from this change are both deployed.

create or replace function private.join_office_with_code(
  p_profile_id uuid, p_code text, p_display_name text,
  p_short_code text default null, p_chat_id bigint default null)
returns table(org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org   public.organizations%rowtype;
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_code  text := nullif(upper(btrim(coalesce(p_short_code, ''))), '');
  v_mem   public.memberships%rowtype;
  v_taken bigint;
begin
  if p_profile_id is null
     or not exists (select 1 from public.profiles p where p.id = p_profile_id) then
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
  if v_code is not null and v_code !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'A short code is 2 to 8 letters or digits.'
      using errcode = 'invalid_parameter_value';
  end if;

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

  update public.profiles p set full_name = v_name where p.id = p_profile_id;

  select * into v_mem from public.memberships m
   where m.org_id = v_org.id and m.profile_id = p_profile_id for update;
  if not found then
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_org.id, p_profile_id, 'member',
            coalesce(v_code, private.suggest_short_code(v_org.id, p_profile_id)))
    returning * into v_mem;
  elsif v_mem.status <> 'active' then
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
      raise exception 'This Telegram chat is already linked to somebody else in %. An admin has to unlink it first.',
        v_org.name using errcode = 'unique_violation';
    end;
  end if;

  return query
    select o.id, o.slug, o.name, m.role
      from public.organizations o
      join public.memberships m on m.org_id = o.id and m.profile_id = p_profile_id
     where o.id = v_org.id;
end $$;

revoke execute on function private.join_office_with_code(uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant  execute on function private.join_office_with_code(uuid, text, text, text, bigint)
  to service_role;

create or replace function public.join_with_code(
  p_code text, p_display_name text, p_short_code text default null)
returns table(org_id bigint, org_slug text, org_name text, role text)
language sql security definer set search_path = '' as $$
  select * from private.join_office_with_code(
    (select auth.uid()), p_code, p_display_name, p_short_code, null);
$$;

revoke execute on function public.join_with_code(text, text, text) from public, anon;
grant  execute on function public.join_with_code(text, text, text) to authenticated;

-- p_chat_id keeps no default, so PostgREST never picks this overload for a
-- call that leaves it out.
create or replace function public.join_with_code(
  p_code text, p_display_name text, p_chat_id bigint, p_short_code text default null)
returns table(org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_chat_id is not null then
    raise exception 'Joining from Telegram is being updated. Try again in a few minutes.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return query select * from private.join_office_with_code(
    (select auth.uid()), p_code, p_display_name, p_short_code, null);
end $$;

revoke execute on function public.join_with_code(text, text, bigint, text) from public, anon;
grant  execute on function public.join_with_code(text, text, bigint, text) to authenticated;
