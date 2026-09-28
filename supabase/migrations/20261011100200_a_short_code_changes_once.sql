-- A short code is chosen on the way in, changes once after that, and never
-- sits inside somebody else's.
--
-- The takeover. `private.payer_from_memo` folds a memo to A-Z0-9 and credits
-- the member whose `payment_ref` (LUNCH + short code) appears inside it,
-- longest match first. People add words after the reference, so a colleague's
-- memo reads `TEST LUNCH DINH chuyen tien`, which folds to
-- `TESTLUNCHDINHCHUYENTIEN`. A member who sets their own code to `DINHC` holds
-- `LUNCHDINHC`: longer, also inside that memo, so it wins, and the colleague's
-- lunch money lands on the member's account. Nothing is logged, and the
-- colleague's bill says unpaid.
--
-- The rules, as the product owner set them:
--
--   * A code may not contain, or be contained in, another active member's
--     reference in the same office, compared as payer_from_memo compares them.
--     Equal codes were already refused by memberships_code_uk. Checked against
--     other people's weekly statement references as well, because
--     payer_from_memo falls back to those for bills printed before references
--     were per person (`LUNCH27DINH`), and a code of `27DI` would take them.
--   * A member picks their code when they join or found an office, and may
--     change it once after that. Counted here, not in the browser.
--   * An admin or owner may change anybody's code, their own included, at any
--     time, and that does not count against the person.
--
-- One advisory lock per office around the check: two people saving codes at
-- the same moment would each pass against the other's old code.
--
-- Production had no overlapping pair when this was written (read-only query
-- across every membership, active or not), so nothing existing is rewritten.

alter table public.memberships
  add column if not exists short_code_changes smallint not null default 0
    check (short_code_changes >= 0);

comment on column public.memberships.short_code_changes is
  'How many times the member changed their own short code after joining. Changes by an admin do not count.';

/**
 * Who a code would be confused with, or null when nobody.
 *
 * SECURITY DEFINER because the answer has to cover rows the caller cannot
 * read: a member sees no other member's statements. It returns the other
 * person's code, which every member of the office can already read, and for a
 * statement only the fact that one exists.
 */
create or replace function private.short_code_clash(
  p_org_id bigint, p_code text, p_profile_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $fn$
  with me as (select 'LUNCH' || upper(p_code) as ref)
  select coalesce(
    (select m.short_code
       from public.memberships m, me
      where m.org_id = p_org_id
        and m.status = 'active'
        and m.profile_id <> p_profile_id
        and (position(m.payment_ref in me.ref) > 0 or position(me.ref in m.payment_ref) > 0)
      order by m.id
      limit 1),
    (select 'an earlier weekly reference'
       from public.billing_statements st, me
      where st.org_id = p_org_id
        and st.profile_id <> p_profile_id
        and (position(st.payment_ref in me.ref) > 0 or position(me.ref in st.payment_ref) > 0)
      limit 1));
$fn$;

revoke execute on function private.short_code_clash(bigint, text, uuid) from public, anon;
-- The trigger below runs as whoever writes the row.
grant  execute on function private.short_code_clash(bigint, text, uuid) to authenticated;

create or replace function public.enforce_short_code()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_service boolean := private.is_service();
  v_changed boolean;
  v_clash   text;
begin
  new.short_code := upper(btrim(new.short_code));

  if tg_op = 'INSERT' then
    v_changed := true;
    if not v_service then new.short_code_changes := 0; end if;
  else
    v_changed := new.short_code is distinct from old.short_code;
    if not v_service then new.short_code_changes := old.short_code_changes; end if;

    if v_changed and not v_service
       and not (old.org_id = any ((select private.my_admin_org_ids())::bigint[])) then
      if old.short_code_changes >= 1 then
        raise exception 'you have already changed your short code once in this office; an admin can change it again for you'
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      new.short_code_changes := old.short_code_changes + 1;
    end if;
  end if;

  -- Coming back after being removed brings back a code that somebody who
  -- joined in the meantime may now overlap.
  if v_changed or (tg_op = 'UPDATE' and old.status <> 'active' and new.status = 'active') then
    perform pg_advisory_xact_lock(hashtextextended('lunch.short_code:' || new.org_id, 0));
    v_clash := private.short_code_clash(new.org_id, new.short_code, new.profile_id);

    if v_clash is not null and not v_changed and v_service then
      new.short_code := private.suggest_short_code(new.org_id, new.profile_id);
      v_clash := null;
    end if;

    if v_clash is not null then
      raise exception '% is too close to % in this office: one would match a transfer meant for the other. Pick a code that neither contains nor sits inside another person''s.',
        new.short_code, v_clash
        using errcode = 'unique_violation';
    end if;
  end if;

  -- Written here rather than left to memberships_payment_ref, which fires only
  -- when the statement names short_code, and the rejoin branch above does not.
  new.payment_ref := 'LUNCH' || new.short_code;
  return new;
end $fn$;

revoke execute on function public.enforce_short_code() from public, anon, authenticated;

drop trigger if exists memberships_payment_ref on public.memberships;
drop function if exists public.set_membership_payment_ref();

drop trigger if exists memberships_short_code_guard on public.memberships;
create trigger memberships_short_code_guard
  before insert or update on public.memberships
  for each row execute function public.enforce_short_code();

/**
 * Initials first, as before, and then a two-digit suffix on a shorter stem
 * rather than a growing one. The old `QTN`, `QTN1`, `QTN2` put every
 * newcomer's reference inside or around the first one's, which is the exact
 * overlap the guard above refuses.
 */
create or replace function private.suggest_short_code(p_org_id bigint, p_profile_id uuid)
returns text
language plpgsql
stable
set search_path to ''
as $fn$
declare v_src text; v_words text[]; v_base text; v_stem text; v_try text; v_n int := 0;
begin
  select public.unaccent_fallback(
           coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)))
    into v_src
    from public.profiles p where p.id = p_profile_id;

  v_words := array_remove(
    regexp_split_to_array(
      upper(regexp_replace(coalesce(v_src, ''), '[^A-Za-z0-9]+', ' ', 'g')), '\s+'),
    '');

  if array_length(v_words, 1) >= 2 then
    select string_agg(left(w, 1), '') into v_base
      from unnest(v_words) with ordinality as t(w, i)
     where i <= 4;
  else
    v_base := left(coalesce(v_words[1], ''), 3);
  end if;

  v_base := coalesce(nullif(left(v_base, 4), ''), 'USER');
  if length(v_base) < 2 then v_base := rpad(v_base, 2, 'X'); end if;
  v_stem := left(v_base, greatest(length(v_base) - 1, 1));

  loop
    v_try := case when v_n = 0 then v_base else v_stem || lpad(v_n::text, 2, '0') end;
    exit when not exists (select 1 from public.memberships m
                           where m.org_id = p_org_id and m.short_code = v_try
                             and m.profile_id <> p_profile_id)
          and private.short_code_clash(p_org_id, v_try, p_profile_id) is null;
    v_n := v_n + 1;
    if v_n > 99 then raise exception 'could not allocate a short code'; end if;
  end loop;
  return v_try;
end
$fn$;

revoke execute on function private.suggest_short_code(bigint, uuid) from public, anon, authenticated;

-------------------------------------------------- choosing it on the way in

-- The optional last argument is the code the person picked on the way in. A
-- blank one means "make it from my name", which is what every path did before.

drop function if exists public.create_organization(text, text, text, character, smallint, text);
create or replace function public.create_organization(
  p_slug text, p_name text,
  p_timezone text default 'Asia/Ho_Chi_Minh',
  p_currency character default 'VND',
  p_currency_minor_units smallint default 0,
  p_locale text default 'vi-VN',
  p_short_code text default null)
returns public.organizations
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_org  public.organizations;
  v_uid  uuid := (select auth.uid());
  v_code text := nullif(upper(btrim(coalesce(p_short_code, ''))), '');
begin
  if not coalesce((select s.enabled from public.app_settings s
                    where s.key = 'office_creation'), true) then
    raise exception 'founding an office is turned off here; ask a colleague for a join code'
      using errcode = 'insufficient_privilege';
  end if;
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_code is not null and v_code !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'a short code is 2 to 8 letters or digits'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into public.organizations (slug, name, timezone, currency, currency_minor_units, locale)
  values (lower(btrim(p_slug)), btrim(p_name), p_timezone, p_currency,
          p_currency_minor_units, p_locale)
  returning * into v_org;
  insert into public.memberships (org_id, profile_id, role, short_code)
  values (v_org.id, v_uid, 'owner',
          coalesce(v_code, private.suggest_short_code(v_org.id, v_uid)));
  return v_org;
end $function$;

revoke execute on function public.create_organization(text, text, text, character, smallint, text, text)
  from public, anon;
grant  execute on function public.create_organization(text, text, text, character, smallint, text, text)
  to authenticated;

-- Unchanged from 20260925100400 but for the code: the one picked is used when
-- a membership is created, and ignored when an old one is reactivated, because
-- coming back is not joining for the first time and the count must not reset.
drop function if exists public.join_with_code(text, text, bigint);
create or replace function public.join_with_code(
  p_code text, p_display_name text, p_chat_id bigint, p_short_code text default null)
returns table(org_id bigint, org_slug text, org_name text, role text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_org   public.organizations%rowtype;
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_code  text := nullif(upper(btrim(coalesce(p_short_code, ''))), '');
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

  update public.profiles p set full_name = v_name where p.id = v_uid;

  select * into v_mem from public.memberships m
   where m.org_id = v_org.id and m.profile_id = v_uid for update;
  if not found then
    insert into public.memberships (org_id, profile_id, role, short_code)
    values (v_org.id, v_uid, 'member',
            coalesce(v_code, private.suggest_short_code(v_org.id, v_uid)))
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
      join public.memberships m on m.org_id = o.id and m.profile_id = v_uid
     where o.id = v_org.id;
end $$;

revoke execute on function public.join_with_code(text, text, bigint, text) from public, anon;
grant  execute on function public.join_with_code(text, text, bigint, text) to authenticated;
