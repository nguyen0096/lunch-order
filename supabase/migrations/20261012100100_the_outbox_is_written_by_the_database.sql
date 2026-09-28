-- The outbox is written by the database, never by a browser.
--
-- `outbox_admin` was `for all`, and `authenticated` held INSERT, UPDATE and
-- DELETE on notification_outbox. An admin could therefore POST a row naming
-- any `chat_id` with any body, and outbox-drain, which trusts the queue, would
-- send it from the bot: to a chat outside the office, to a colleague as though
-- the office had said it, or as a copy of the weekly bill with the numbers
-- changed. They could equally rewrite a queued row before the drain claimed
-- it, or delete the ones they did not want sent.
--
-- Nothing in the web app writes the table. Announcements and test messages
-- already go through send_announcement and send_test_notification
-- (20261009100100), which check the caller is an admin of the office (owners
-- included, since my_admin_org_ids counts both) and take every recipient and
-- chat from the office's own members. Every other row is written by a
-- SECURITY DEFINER function or trigger, or by the Edge Functions as the
-- service role. So the grant goes and the policy is narrowed to reading.
--
-- The read keeps 20261010100000's rule: an admin who is not an owner sees no
-- bug_report row, because a queued report carries the description verbatim.

drop policy if exists outbox_admin on public.notification_outbox;
drop policy if exists outbox_admin_select on public.notification_outbox;

revoke insert, update, delete, truncate on public.notification_outbox from anon, authenticated;
revoke select on public.notification_outbox from anon;

create policy outbox_admin_select on public.notification_outbox
  for select to authenticated
  using (org_id = any ((select private.my_admin_org_ids())::bigint[])
         and (kind <> 'bug_report'
              or org_id = any ((select private.my_owner_org_ids())::bigint[])));
