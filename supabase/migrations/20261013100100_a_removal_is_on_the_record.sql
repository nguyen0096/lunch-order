-- A removal is on the record, and a join code does not undo it.
--
-- leave_office and an admin's removal both wrote status = 'inactive', and the
-- row kept nothing else. So a removed member could walk straight back in with
-- the office's join code, or with an invitation that was sent before they were
-- removed, and the no-office page could not tell a removed member from one who
-- left.
--
-- The rules, as the product owner set them:
--
--   * Somebody who left comes back as before: the join code or an invitation.
--   * Somebody who was removed does not come back by the join code, nor by an
--     invitation issued before the removal. An admin or owner adding them back
--     does it, and so does an invitation issued after the removal.
--
-- `status` stays what it is, 'active' or 'inactive', because every policy and
-- index reads it that way. Why a membership is inactive is two new columns:
-- `removed_at` and `removed_by`, null for somebody who left. A trigger writes
-- them, so no path into memberships can forget to, and no browser can forge
-- them: a membership going inactive is a removal unless the member is the one
-- doing it, and leave_office is the only way a member does that
-- (20261011100100 refuses a member's own status change everywhere else).
--
-- Existing inactive rows are ambiguous: nothing recorded which happened. They
-- are left as "left" (removed_at null), so nobody is locked out by this
-- migration. The cost is that somebody removed before today can still rejoin
-- by code, which is what they could do yesterday; an admin who wants them out
-- for good removes them again after adding them back, or the row can be
-- stamped by hand: update public.memberships set removed_at = now() where ...

alter table public.memberships
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references public.profiles(id) on delete set null;

alter table public.memberships drop constraint if exists memberships_removed_is_inactive;
alter table public.memberships
  add constraint memberships_removed_is_inactive
  check (removed_at is null or status = 'inactive');

comment on column public.memberships.removed_at is
  'When an admin, owner or the service removed this member. Null for an active member and for one who left. Written by memberships_removal only.';
comment on column public.memberships.removed_by is
  'Who removed this member; null for the service, for somebody who left, and for an active member.';

create or replace function public.record_membership_removal()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare v_me uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if not private.is_service() then
      new.removed_at := null;
      new.removed_by := null;
    end if;
    return new;
  end if;

  if new.status = 'active' then
    new.removed_at := null;
    new.removed_by := null;
  elsif old.status = 'active' then
    if v_me is not distinct from new.profile_id then
      new.removed_at := null;
      new.removed_by := null;
    else
      new.removed_at := now();
      new.removed_by := v_me;
    end if;
  elsif not private.is_service() then
    new.removed_at := old.removed_at;
    new.removed_by := old.removed_by;
  end if;
  return new;
end $fn$;

revoke execute on function public.record_membership_removal() from public, anon, authenticated;

drop trigger if exists memberships_removal on public.memberships;
create trigger memberships_removal
  before insert or update on public.memberships
  for each row execute function public.record_membership_removal();

--------------------------------------------------------------- invitations

-- An invitation's upsert on (org_id, email) kept the old row as it was, so
-- inviting somebody whose earlier invitation had been used handed back the
-- used one, and the People screen, which lists only waiting invitations,
-- showed nothing at all. For a removed member that was the only invitation
-- there could be. Writing an invitation from the app now issues it again:
-- fresh dates, and a fresh token when the old one was spent. A waiting
-- invitation keeps its token, so a link already sent still works.
alter table public.invitations
  add column if not exists issued_at timestamptz not null default now();
update public.invitations set issued_at = created_at;

comment on column public.invitations.issued_at is
  'When an admin last issued this invitation. An invitation issued before its invitee was removed does not bring them back.';

create or replace function public.reissue_invitation()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if private.is_service() then return new; end if;
  new.issued_at  := now();
  new.expires_at := now() + interval '14 days';
  if old.accepted_at is not null then
    new.accepted_at := null;
    new.token := gen_random_uuid();
  end if;
  return new;
end $fn$;

revoke execute on function public.reissue_invitation() from public, anon, authenticated;

drop trigger if exists invitations_reissue on public.invitations;
create trigger invitations_reissue
  before update on public.invitations
  for each row execute function public.reissue_invitation();

-------------------------------------------------------------------- joining

-- Unchanged from 20261013100000 but for the refusal of a removed member.
-- 55000 rather than 42501: both surfaces turn 42501 into "You don't have
-- permission", and this sentence is the one the person needs.
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
  v_had   boolean;
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

  select * into v_mem from public.memberships m
   where m.org_id = v_org.id and m.profile_id = p_profile_id for update;
  v_had := found;
  if v_had and v_mem.status <> 'active' and v_mem.removed_at is not null then
    raise exception 'An admin removed you from %, so its join code will not bring you back. Ask an admin there to add you back.',
      v_org.name using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.profiles p set full_name = v_name where p.id = p_profile_id;

  if not v_had then
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

-- Unchanged from 20260924100000 but for the removal check.
create or replace function public.accept_invitation(p_token uuid)
returns table (org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv   public.invitations%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_existing public.memberships%rowtype;
  v_had   boolean;
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

  if v_email is null then
    raise exception 'This invitation was sent to %, and your account has no email address. Ask for a join code instead.',
      v_inv.email using errcode = 'insufficient_privilege';
  end if;
  if lower(v_inv.email) <> v_email then
    raise exception 'This invitation was sent to %. You are signed in as %.',
      v_inv.email, v_email using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing from public.memberships m
   where m.org_id = v_inv.org_id and m.profile_id = v_uid for update;
  v_had := found;

  if v_had and v_existing.status <> 'active' and v_existing.removed_at is not null
     and v_inv.issued_at < v_existing.removed_at then
    raise exception 'This invitation was sent before an admin removed you from %. Ask an admin there to add you back, or to invite you again.',
      (select o.name from public.organizations o where o.id = v_inv.org_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_had then
    update public.memberships m set
      status = 'active',
      role = case
               when m.role = 'owner' then m.role
               when (v_rank ->> v_inv.role)::int > (v_rank ->> m.role)::int
                 then v_inv.role
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

------------------------------------------------------------ the no-office page

-- my_removed_offices named every inactive office, left or removed alike. This
-- says which. A bundle still asking the old name gets an error, and the page
-- already has words for not knowing.
drop function if exists public.my_removed_offices();

create or replace function public.my_former_offices()
returns table(org_name text, removed boolean)
language sql
stable
security definer
set search_path to ''
as $fn$
  select o.name, m.removed_at is not null
    from public.memberships m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
   where m.profile_id = (select auth.uid())
     and m.status = 'inactive'
   order by o.name;
$fn$;

revoke execute on function public.my_former_offices() from public, anon;
grant  execute on function public.my_former_offices() to authenticated;
