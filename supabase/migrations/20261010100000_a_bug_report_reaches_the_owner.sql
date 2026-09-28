-- A bug report reaches the owner, and nobody else reads it.
--
-- "Owner" is `memberships.role = 'owner'` in the office the report was sent
-- from. There is no app-wide owner in this schema: `app_settings` is flipped by
-- the service role and has no person attached, and every other privilege is
-- scoped to an office. An office may have more than one owner, and each of them
-- is told.
--
-- Written by the reporter straight into the table, under RLS, rather than
-- through an RPC. The row is the reporter's own words about their own session,
-- so there is nothing to render on their behalf; what reaches Telegram is still
-- rendered here, by a trigger, from the stored row, and never by the browser.
--
-- The reporter cannot read the row back, their own included. Only an owner of
-- the office can, which is also why the client inserts with `return=minimal`.

create table public.bug_reports (
  id          bigint generated always as identity primary key,
  org_id      bigint not null references public.organizations(id) on delete cascade,
  -- Never supplied by the browser: the insert grant below leaves it out, so the
  -- default is the only value it can take.
  reporter_id uuid   not null default auth.uid()
                     references public.profiles(id) on delete cascade,
  description text   not null check (length(description) between 1 and 2000),

  -- What the browser knew when the report was sent. Each is optional because a
  -- report without them is still worth having, and each is capped because none
  -- of them is typed by the reporter and a hostile one could be anything.
  route       text check (length(route)       <= 500),
  app_version text check (length(app_version) <= 100),
  user_agent  text check (length(user_agent)  <= 500),
  viewport    text check (length(viewport)    <= 40),

  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index bug_reports_org_idx      on public.bug_reports (org_id, created_at desc);
create index bug_reports_reporter_idx on public.bug_reports (reporter_id, created_at desc);

alter table public.bug_reports enable row level security;

-- Supabase grants ALL on a new public table to anon and authenticated, and the
-- blanket revoke in 20260911101100_grants.sql ran long before this table
-- existed.
revoke all on public.bug_reports from anon, authenticated;
grant insert (org_id, description, route, app_version, user_agent, viewport)
  on public.bug_reports to authenticated;
grant select on public.bug_reports to authenticated;
grant update (resolved_at) on public.bug_reports to authenticated;

create policy bug_reports_insert_own on public.bug_reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid())
              and org_id = any ((select private.my_org_ids())::bigint[]));

create policy bug_reports_select_owner on public.bug_reports
  for select to authenticated
  using (org_id = any ((select private.my_owner_org_ids())::bigint[]));

create policy bug_reports_update_owner on public.bug_reports
  for update to authenticated
  using      (org_id = any ((select private.my_owner_org_ids())::bigint[]))
  with check (org_id = any ((select private.my_owner_org_ids())::bigint[]));

comment on table public.bug_reports is
  'Bug reports from the web app. Inserted by the reporter, read and resolved by an owner of the office.';

------------------------------------------------------------ the outbox kind

-- Restated in full because a CHECK has no ALTER that adds a value: the eleven
-- that were there are verbatim, so a diff shows one value added.
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in
    ('menu_published','register_reminder','cutoff_warning',
     'weekly_preview','weekly_bill','payment_reminder','payment_ack',
     'transfer_offer','transfer_decided','bill_correction','announcement',
     'bug_report'));

-- `outbox_admin` lets every admin read every outbox row in their office, and a
-- queued bug report carries the description verbatim. Left alone, that policy
-- would hand a report to every admin through the queue while the table itself
-- refuses them.
drop policy outbox_admin on public.notification_outbox;
create policy outbox_admin on public.notification_outbox
  for all to authenticated
  using      (org_id = any ((select private.my_admin_org_ids())::bigint[])
              and (kind <> 'bug_report'
                   or org_id = any ((select private.my_owner_org_ids())::bigint[])))
  with check (org_id = any ((select private.my_admin_org_ids())::bigint[])
              and (kind <> 'bug_report'
                   or org_id = any ((select private.my_owner_org_ids())::bigint[])));

------------------------------------------------------------------ helpers

-- Telegram's HTML mode needs exactly these three escaped, `&` first so the
-- entities the other two produce are not escaped again.
-- https://core.telegram.org/bots/api#html-style
create or replace function private.telegram_html(p_text text)
returns text
language sql
immutable
set search_path to ''
as $fn$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$fn$;

create or replace function private.bug_report_message(p_report_id bigint)
returns text
language sql
stable
set search_path to ''
as $fn$
  select '<b>Bug report</b> from '
      || private.telegram_html(private.member_name(r.org_id, r.reporter_id))
      || ', ' || private.telegram_html(og.name) || E'\n\n'
      || private.telegram_html(r.description) || E'\n\n'
      || 'Page: '    || private.telegram_html(coalesce(r.route, 'unknown')) || E'\n'
      || 'Version: ' || private.telegram_html(coalesce(r.app_version, 'unknown')) || E'\n'
      || 'Browser: ' || private.telegram_html(coalesce(r.user_agent, 'unknown')) || E'\n'
      || 'Screen: '  || private.telegram_html(coalesce(r.viewport, 'unknown')) || E'\n'
      || 'Sent: '    || to_char(r.created_at at time zone og.timezone, 'HH24:MI DD/MM/YYYY')
      || E'\n\n' || 'Report #' || r.id || '. Open Bug reports in the app to mark it resolved.'
    from public.bug_reports r
    join public.organizations og on og.id = r.org_id
   where r.id = p_report_id;
$fn$;

revoke execute on function private.telegram_html(text)         from public, anon, authenticated;
revoke execute on function private.bug_report_message(bigint)  from public, anon, authenticated;

------------------------------------------------------------------ triggers

-- SECURITY DEFINER because the reporter cannot read their own earlier reports,
-- and counting them is the point.
--
-- Ten an hour per person per office. Every report is a Telegram message to the
-- owner, and a member holding Enter should not be able to make the owner mute
-- the bot.
create or replace function public.trg_bug_report_before_insert()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_recent integer;
begin
  new.description := private.short_text(new.description, 2000, 'bug report');
  if new.description is null then
    raise exception 'a bug report needs a description of what went wrong'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_recent
    from public.bug_reports r
   where r.org_id = new.org_id
     and r.reporter_id = new.reporter_id
     and r.created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'you have sent 10 bug reports in the last hour; the owner has them all, so try again later'
      using errcode = 'program_limit_exceeded';
  end if;

  new.route       := nullif(btrim(new.route), '');
  new.app_version := nullif(btrim(new.app_version), '');
  new.user_agent  := nullif(btrim(new.user_agent), '');
  new.viewport    := nullif(btrim(new.viewport), '');
  return new;
end $fn$;

-- INSERT ... SELECT, as in `trg_transfer_notifies`: an owner who never finished
-- /start has no chat_id, so produces no row rather than an error, and the
-- report waits on the Bug reports screen instead.
create or replace function public.trg_bug_report_notifies()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_body text := private.bug_report_message(new.id);
begin
  insert into public.notification_outbox
    (org_id, dedupe_key, kind, chat_id, recipient_profile_id, body, parse_mode)
  select new.org_id,
         'org:' || new.org_id || ':bug_report:' || new.id || ':profile:' || mem.profile_id::text,
         'bug_report', tl.chat_id, mem.profile_id, v_body, 'HTML'
    from public.memberships mem
    join public.telegram_links tl
      on tl.membership_id = mem.id and tl.chat_id is not null
   where mem.org_id = new.org_id
     and mem.role = 'owner'
     and mem.status = 'active'
  on conflict (dedupe_key) do nothing;
  return null;
end $fn$;

revoke execute on function public.trg_bug_report_before_insert() from public, anon, authenticated;
revoke execute on function public.trg_bug_report_notifies()      from public, anon, authenticated;

create trigger bug_reports_before_insert
  before insert on public.bug_reports
  for each row execute function public.trg_bug_report_before_insert();

create trigger bug_reports_notify
  after insert on public.bug_reports
  for each row execute function public.trg_bug_report_notifies();
