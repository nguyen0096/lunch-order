-- A link token is its owner's alone.
--
-- `telegram_links_admin_select` let an admin read every link in the office,
-- and `authenticated` held SELECT on every column, so an admin could read a
-- colleague's `link_token`. The bot binds whichever chat redeems a token to
-- the membership it names, so an admin who opened `t.me/<bot>?start=<token>`
-- from their own Telegram became that colleague to the bot: ordering,
-- cancelling and accepting handovers in their name, and reading their bill.
--
-- RLS filters rows, not columns, and the admin needs the rows: the Messages
-- screen counts who is connected. So the column goes instead. `authenticated`
-- may read every column of telegram_links except `link_token`, under the same
-- two policies as before, and the token reaches a browser only through the
-- two functions below, which answer for the caller's own membership and
-- nobody else's.
--
-- The bot reads tokens as the connection's own role (asSystem in
-- supabase/functions/_shared/db.ts), and the service role holds the table
-- whole, so neither is touched.
--
-- Creating a link moves into a function too. The browser used to insert the
-- row and read the token back in a second request; with the column closed the
-- read cannot happen, and one call that mints-or-finds and answers is simpler
-- than a grant for the insert and a function for the read.

revoke select, insert on public.telegram_links from anon, authenticated;
grant select (membership_id, org_id, chat_id, linked_at, updated_at)
  on public.telegram_links to authenticated;

------------------------------------------------------------------- reading

-- Null row, not an error, for "no link yet": Preferences opens on that state.
create or replace function public.my_telegram_link(p_org_id bigint)
returns table(membership_id bigint, link_token uuid, linked boolean)
language sql
stable
security definer
set search_path to ''
as $fn$
  select tl.membership_id, tl.link_token, tl.chat_id is not null
    from public.memberships m
    join public.telegram_links tl on tl.membership_id = m.id
   where m.org_id = p_org_id
     and m.profile_id = (select auth.uid())
     and m.org_id = any ((select private.my_org_ids())::bigint[]);
$fn$;

------------------------------------------------------------------- minting

-- Mint on demand rather than on read: a token that exists only because
-- somebody opened Preferences is a credential nobody asked for.
create or replace function public.create_my_telegram_link(p_org_id bigint)
returns table(membership_id bigint, link_token uuid, linked boolean)
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_membership bigint;
begin
  select m.id into v_membership
    from public.memberships m
   where m.org_id = p_org_id
     and m.profile_id = (select auth.uid())
     and m.org_id = any ((select private.my_org_ids())::bigint[]);
  if v_membership is null then
    raise exception 'you are not a member of that office'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.telegram_links (membership_id, org_id)
  values (v_membership, p_org_id)
  on conflict on constraint telegram_links_pkey do nothing;

  return query
    select tl.membership_id, tl.link_token, tl.chat_id is not null
      from public.telegram_links tl
     where tl.membership_id = v_membership;
end $fn$;

revoke execute on function public.my_telegram_link(bigint)        from public, anon;
grant  execute on function public.my_telegram_link(bigint)        to authenticated;
revoke execute on function public.create_my_telegram_link(bigint) from public, anon;
grant  execute on function public.create_my_telegram_link(bigint) to authenticated;
