-- A Telegram link stays in the office its membership is in, and only the bot
-- connects a chat.
--
-- `telegram_links_own` checked that the membership was yours and nothing
-- else, and `authenticated` held UPDATE on every column. So a member could
-- PATCH their own link's `org_id` to an office they do not belong to. The bot
-- resolves a chat by joining `telegram_links.org_id` to organizations, so /bill
-- in that chat then printed the other office's name and `payment_config`: its
-- bank, account number and account holder. They could equally set `chat_id` to
-- anybody's chat, which is how the bot decides who is speaking.
--
-- Three locks:
--
--   * A composite foreign key, (membership_id, org_id) to memberships
--     (id, org_id). Whatever writes the row, the office is the membership's.
--   * Column grants. A browser inserts a link naming its membership and office
--     and nothing else; it updates `chat_id` and `linked_at` and nothing else.
--   * A trigger. `chat_id` is set by the bot alone, when somebody redeems
--     their link token in Telegram; from a browser, member or admin, it can
--     only be cleared, which is what disconnecting is.
--
-- `telegram_links_admin` is split the same way: an admin reads the office's
-- links (the Messages screen counts who is connected) and may disconnect one,
-- and cannot create, delete or point one anywhere.
--
-- Production had no link whose office disagreed with its membership's when
-- this was written, so the key validates on what is there.

alter table public.telegram_links
  drop constraint if exists telegram_links_membership_org_fk;
alter table public.memberships
  drop constraint if exists memberships_id_org_uk;
alter table public.memberships
  add constraint memberships_id_org_uk unique (id, org_id);

alter table public.telegram_links
  add constraint telegram_links_membership_org_fk
  foreign key (membership_id, org_id) references public.memberships (id, org_id)
  on delete cascade;

revoke insert, update on public.telegram_links from authenticated;
grant insert (membership_id, org_id) on public.telegram_links to authenticated;
grant update (chat_id, linked_at)    on public.telegram_links to authenticated;

create or replace function public.guard_telegram_link()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if private.is_service() then return new; end if;
  if new.chat_id is not null and new.chat_id is distinct from old.chat_id then
    raise exception 'a chat is connected from Telegram, by opening the link the app gives you'
      using errcode = 'insufficient_privilege';
  end if;
  if new.chat_id is null then
    new.linked_at := null;
  else
    new.linked_at := old.linked_at;
  end if;
  return new;
end $fn$;

revoke execute on function public.guard_telegram_link() from public, anon, authenticated;

drop trigger if exists telegram_links_guard on public.telegram_links;
create trigger telegram_links_guard
  before update on public.telegram_links
  for each row execute function public.guard_telegram_link();

drop policy if exists telegram_links_admin on public.telegram_links;
drop policy if exists telegram_links_admin_select on public.telegram_links;
drop policy if exists telegram_links_admin_update on public.telegram_links;

create policy telegram_links_admin_select on public.telegram_links
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[]));

create policy telegram_links_admin_update on public.telegram_links
  for update to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[]));
