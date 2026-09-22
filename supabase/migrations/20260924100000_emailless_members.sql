-- Members who have no email address at all.
--
-- Telegram is the only interface most of these people will ever open, and
-- asking for an address just to seat somebody at a lunch table is friction for
-- nothing. A Supabase anonymous sign-in produces an ordinary auth.users row
-- with a null email and the usual `authenticated` role, so as far as the rest
-- of this schema is concerned such a person is a normal member. Three things
-- stood in the way, and the third was a hole rather than a nuisance.

-- 1. profiles.email was not null, so the signup trigger aborted the sign-in.
alter table public.profiles alter column email drop not null;

-- profiles_email_uk is `unique (lower(email))` with the default NULLS DISTINCT,
-- so any number of email-less members coexist. Checked against this database
-- rather than assumed: two null-email profiles insert cleanly, and two
-- EMPTY-STRING ones raise 23505 on that index. The '' case is why the trigger
-- below normalises rather than storing whatever auth hands it.
comment on column public.profiles.email is
  'Null for members who joined through Telegram. Unique across non-null values only.';

-- 2. handle_new_user derived both columns from the address: lower(new.email)
-- hit the not-null on email, and split_part(new.email,'@',1) then hit the
-- not-null on full_name. The placeholder name is deliberately bland and
-- deliberately not empty, because private.suggest_short_code folds full_name
-- into the code that appears in bank transfer memos; join_with_code replaces it
-- with the real name seconds later.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id,
          -- '' is not null and the SECOND such row collides on
          -- profiles_email_uk, so fold it here instead of trusting the caller.
          lower(nullif(btrim(new.email), '')),
          coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
                   nullif(btrim(new.raw_user_meta_data->>'name'), ''),
                   nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                   'New member'),
          new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

-- 3. accept_invitation gated on `lower(v_inv.email) <> v_email`. Against a null
-- v_email that expression is null, the IF is simply not taken, and the caller
-- falls through to the membership insert. Reproduced on this database: an
-- email-less account holding any token joined an invitation addressed to
-- somebody else and was granted the role it carried, admin included. Nulls do
-- not compare, so the absence of an address has to be its own branch.
--
-- Everything else here is unchanged from 20260911210000: never touch an owner's
-- role, raise it but never lower it, reactivate a deactivated membership.
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

  if found then
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

-- private.suggest_short_code does coalesce(p.full_name, p.email) and needs no
-- change: full_name is still not null, so the email branch was already dead
-- code and stays dead. Left alone on purpose rather than tidied, because
-- rewriting a function that assigns bank memo codes earns nothing.
