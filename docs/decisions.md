# Decisions

Why this app is the way it is. One entry per decision that would otherwise be
re-argued. Where a number appears it was measured, not estimated.

## Platform

**Postgres on Supabase, not Cloudflare D1.** D1 is SQLite: no row-level
security, no IANA timezone database (`today_in(org.timezone)` is impossible), no
exclusion constraints for non-overlapping billing weeks, no advisory locks, no
column privileges. The schema *is* the application, and every one of those is
load-bearing. Moving would mean rewriting the backend to land on weaker
guarantees.

**Cloudflare Workers for the SPA, not Vercel.** Vercel's Hobby plan is
[non-commercial use only](https://vercel.com/docs/limits/fair-use-guidelines)
and explicitly counts work by a paid employee. This is a company tool.
Cloudflare's static asset bandwidth is unmetered on the free plan and permits
commercial use. The app is a static bundle; nothing Vercel is good at is used.

**A write the app makes for one tap is one transaction, in a named function.**
PostgREST commits every request on its own, so an action the browser sent as
several requests was committed piece by piece. Three did that, and each had a
wrong outcome that was reachable, not theoretical: choosing a dish (delete the
line, insert one) interleaved across two devices as delete, delete, insert,
insert and left two dishes billed on one order; publishing a menu refused part
way left a published menu with some dishes changed; and pricing the week on
Settle week was refused on a locked menu for every member's and standing order,
because the re-snapshot ran as an admin browser through `enforce_order_window`,
and a refusal part way left some dishes priced and the rest not. They are now
`set_my_order`, `publish_menu` and `apply_caterer_prices`, and the bot calls
`set_my_order` too.

Each is SECURITY DEFINER, which every guard trigger exempts through
`private.is_service()`. So each checks for itself, in the triggers' own words,
what RLS and the triggers would have checked: who may (`my_org_ids`,
`my_admin_org_ids`, or the caller's own order with no profile parameter), the
menu's status and cutoff, and the settled week, the last under the week's
shared advisory lock so a settle cannot land between the check and the write.
Only `snapshot_order_item` still runs, because it has no exemption: prices are
copied by the trigger alone. A dish choice deletes the line and writes a fresh
row rather than updating it, and a new order is `source = 'member'`; an
existing one keeps its source.

Locks are taken in one order: the office's materialize lock, menu rows by
(org, date, id), the billing week's lock, dish rows, the order row, its lines.
The corrections take the week's lock first and then reach a menu only through a
foreign key's `FOR KEY SHARE`, so nothing that holds a menu `FOR UPDATE` may
then wait on a dish, a line, an order or a week. Nothing does any more: a menu
is taken `FOR SHARE` to order on it and `FOR NO KEY UPDATE` to change it,
neither of which blocks `FOR KEY SHARE`. Two first drafts broke the rule and
deadlocked, both reproduced in `atomic_writes_race.sql`: `apply_caterer_prices`
against a correction on the same week (R3), and `publish_menu` against
`correct_meal_off_menu` recording the dish it was repricing (R7).
`materialize_standing_orders` had held its menu `FOR UPDATE` since the first
migration and could deadlock the same way against a correction's order for a
standing member; it takes `FOR NO KEY UPDATE` too.

One case is left open. The hourly tick locks an office's due menus with a plain
`UPDATE` in scan order and then bills a week, which is the opposite order to
`apply_caterer_prices`. They meet only if a week's menu is still published past
its cutoff at billing hour while an admin settles that week. The loser is either
Settle week, which can be pressed again, or that office's tick subtransaction,
which the next hour retries.

Materializing standing orders was the other lock problem. A weekday rule or an
exception ran `materialize_open_menus`, which locked every office's open menus
ordered by date alone: two offices' writes could deadlock, and every member
toggling a weekday held up every admin everywhere. Now a rule change sweeps its
own office's menus of its weekday, an exception its own date, under the office's
materialize lock, in (date, id) order, drafts included so a publish made straight
on the table is waited out. `publish_menu` and `set_standing_exception` take the
same lock, which closes the gap one transaction opened: a skip written while a
brand new menu was being published found no menu, and the publish could not see
the skip.

Direct table writes stay granted for now, because the SPA deployed before these
functions still makes them. Revoking INSERT, UPDATE and DELETE on `orders`,
`order_items`, `menus` and `menu_items` for `authenticated` is a later
migration, once that build is gone.

**Its own repository.** GitHub Actions only reads workflows from the repository
root. While this lived at `app/lunch-order/` inside `nexus-infra`, CI had never
once executed.

## Security

**No RBAC library.** The browser talks directly to Postgres through PostgREST.
There is no server tier for Casbin or CASL to sit in, so a policy engine in the
bundle would be advisory: anyone can open devtools and skip it. Rules live where
the data is. Enforcement is 50 RLS policies, column grants that leave
`authenticated` able to update 85 columns and insert into 99 (counted on a local
database built from the migrations, 2026-09-28), and triggers;
`isAdmin()` in the client is three lines and governs affordances only.

**Function grants are enforced by a test, not by a default.** The grants
migration ends with `alter default privileges ... revoke execute on functions
from public, anon`, and it does not work. Measured: a probe function created as
`postgres`, with a default-ACL entry containing no PUBLIC grant, still came out
`=X/postgres`, so anon could execute it. Adding `authenticated` to the revoke
removes that entry and leaves `=X` behind, which is the one that matters. Two
functions had already inherited it. `supabase/tests/function_grants.sql` fails
if a function in `public` is reachable without being on an allowlist.

**Only an owner may appoint or remove an owner.** `enforce_membership_role`
guarded only your own row, so two admins could promote each other in two
statements, or either could delete the owner. All three reproduced live. DELETE
needed its own trigger; the old one was BEFORE UPDATE only. INSERT was missed
as well: an admin could insert a membership with role `owner`, or delete a
member and insert them back as one. The guard now fires on INSERT, and a
browser holds no INSERT on `memberships` at all, because joining goes through
`join_with_code`, `accept_invitation` and `create_organization`.

**An owner holds every right an admin does.** `my_admin_org_ids()` counts
`role in ('admin','owner')`, and every admin policy and RPC goes through it, so
there is no door an admin passes and an owner does not. The rights that are
the owner's alone (appointing owners, the payment account, deleting the office,
reading bug reports) are additions on top, never subtractions.

**Your own membership is not switched on or off directly.** The column grant on
`status` let a member PATCH their own row to `inactive`, walking out without
`leave_office`'s checks, or back to `active` after an admin removed them.
Leaving is `leave_office`; coming back is a join code.

**An office is founded one way.** `organizations_insert` was `with check
(true)`, so any JWT, an anonymous one included, could insert an office past
the `office_creation` switch and without an owner. There is no INSERT policy or
grant on `organizations` now; `create_organization` is the door.

**A short code is picked on the way in and changed once after that.** It is
the payment reference, and `payer_from_memo` credits the longest reference
found inside a memo, so a member who set theirs to extend a colleague's
(`DINHC` over `DINH`) took any transfer whose memo ran on past the reference.
The rules, decided by the product owner and enforced by
`enforce_short_code`: no code may contain, or sit inside, another active
member's reference or another person's old weekly reference in the same
office; a member picks theirs when joining or founding and may change it once
more, counted in `memberships.short_code_changes`; an admin or owner may change
anybody's, their own included, at any time, uncounted. Suggestions step around
an overlap (`QT01` beside `QTN`) instead of extending it (`QTN1`).

**Money moves through three RPCs, on the record.** Admins held UPDATE and
DELETE on `payments`, `billing_statements`, `billing_lines` and
`billing_periods`, so a balance could be edited with no trace and no
reallocation, and an admin could insert a `sepay` row with a transaction id
the bank would later send, which `on conflict do nothing` then swallowed as a
redelivery. Now an admin inserts manual payments only, and everything else is
`move_payment`, `void_payment` (manual payments only) and `waive_statement`,
each writing `payment_corrections`. Not `order_corrections`: that table is
about a meal on a day, and a payment has neither.

**A Telegram link belongs to its membership's office, and only the bot
connects a chat.** A member could PATCH their link's `org_id` to another
office and read its `payment_config` through `/bill`. A composite foreign key
to `memberships (id, org_id)` makes the office the membership's; column grants
leave a browser only `chat_id` and `linked_at`; a trigger lets a browser clear
`chat_id` and never set it.

**A link token is its owner's alone, even from an admin.** Admins read every
`telegram_links` row in their office, which the Messages screen needs to count
who is connected, and that included `link_token`. The bot binds whichever chat
redeems a token to the membership it names, so an admin who opened a
colleague's deep link became that colleague in the bot. RLS filters rows, not
columns, so the column went instead: no browser role may select it, and a
member reads their own through `my_telegram_link` and mints it through
`create_my_telegram_link`. Admins keep link status and lose nothing the web
app used.

**Nobody writes the outbox from a browser, owners included.** `outbox_admin`
was `for all`, so an admin could queue any body to any `chat_id`, rewrite a
queued row, or delete one, and outbox-drain sends what the queue says. Every
message a person may cause already goes through a SECURITY DEFINER function
that checks for an admin or owner and takes the chats from the office's own
links, so the write grants went and the policy reads only. It keeps the bug
report rule: an admin who is not an owner reads no `bug_report` row.

**An invitation says where it leads before it is accepted.** The preview
answers with the office's name, the role, the expiry and a state, for whoever
holds the token and is signed in. The token is the credential, and pressing
Accept already reveals as much, so this opens nothing new. Invitation tokens
are `gen_random_uuid()` v4 uuids, 122 random bits: enumeration is not a
threat worth a rate limit.

**A removed member is told so, and somebody who left is not told they were
removed.** `my_org_ids()` sees active memberships only, so a removed member got
the new-user screen, hedged to cover both. `my_former_offices` names the live
offices where their own membership is inactive and says whether an admin
removed them; it replaced `my_removed_offices`, which could not tell. Somebody
who left is told they are no longer a member and that the join code brings them
back, which is also true of a row inactive from before removals were recorded.

**A removal is two columns, not a third status.** `removed_at` and `removed_by`
on `memberships`, null for somebody who left. Every policy, index and helper
reads `status = 'active'`, and a third value would have meant touching all of
them and refusing the `'inactive'` a browser bundle already loaded still
sends. The rule "an invitation issued before the removal does not work" needs
the moment of removal anyway, and a status cannot carry one. A trigger writes
both columns, so the People screen's plain `status` PATCH and `leave_office`
record themselves without either knowing: you going inactive is leaving,
anybody else making you inactive is removing you.

**Existing inactive rows count as left.** Nothing recorded which happened, so
the migration picks the reading that locks nobody out: a person removed before
2026-09-28 can still come back by code, exactly as they could the day before.
An admin who wants them out for good adds them back and removes them again.

**Only the bot binds a Telegram chat.** `join_with_code` took a chat id from
whoever called it, so anybody with an office's join code could bind a
colleague's (or a stranger's) Telegram chat to their own membership from a
browser. A chat id is worth trusting only when it arrived in an update that
passed the webhook secret, so the chat-binding join is
`private.join_office_with_code`, which only the database owner and
`service_role` can execute, and the bot calls it over its own connection with
a profile it resolved from that same chat or has just signed up for it. The
browser's `join_with_code` takes no chat at all.

**The deploy window is closed on the database's side.** The Supabase
integration applies migrations on the push to `main`; the Edge Functions and
the SPA deploy after CI passes, minutes later. The old four-argument
`join_with_code` stays for that window and for tabs loaded before it, and
refuses any non-null chat, so the hole closes when the migration lands. The
cost is that an old bot's Telegram joins fail with "Joining from Telegram is
being updated" until the new bot is live. A new bot that lands first falls back
to the old public call when the private function is missing. Both were removed
once both were deployed: 20261014100000 drops the four-argument signature, and
the bot calls only `private.join_office_with_code`.

**The deploy registers Telegram's webhook.** `setWebhook` was a manual step,
and Telegram keeps the previous `allowed_updates` whenever the field is left
out, so a new update type the bot handled stayed undelivered until somebody
remembered. `deploy.yml` now calls it after every functions deploy with the list
in `supabase/functions/telegram/allowed_updates.json`, and reads it back with
`getWebhookInfo`. Before that it posts an empty update to the function with
GitHub's copy of `TELEGRAM_WEBHOOK_SECRET` and fails on a 401: two copies of
one secret that disagree take the bot down, and this is the one place both are
in reach. Asking the function was chosen over comparing the digest `supabase
secrets list` prints, because what that digest is computed from is not
documented. The job gates the release, since a bot Telegram cannot reach is a
failed deploy. Without the Telegram GitHub secrets it warns and leaves the
webhook alone rather than failing a deploy that is otherwise fine.

**Writing an invitation issues it again.** The app upserts on
`(org_id, email)` and the upsert kept the row as it was, so re-inviting
somebody whose invitation had been used returned the used row and the People
screen showed nothing. A removed member's only way back by invitation is a new
one, so an app-side write now refreshes `issued_at` and the expiry, and replaces
the token when the old one was spent.

**A join code grants membership and nothing else, on every path.** It hardcoded
`'member'` on insert but the reactivation branch touched `status` alone, so a
deactivated admin returned as an admin by sending a string every remaining
member can read.

**Anonymous sign-ins are on, and the advisor is right to flag them.** Joining
from Telegram must not require an email address, so a visitor can arrive holding
a real JWT whose role is `authenticated` -- the same role every policy here is
written against. Supabase's linter therefore reports all twenty tables as
reachable by anonymous users, and they are. What makes it safe is that
`private.my_org_ids()` returns nothing for a subject with no membership row, and
every policy goes through it. Measured, against production: 17 checks, all zero
rows, including the join code itself.
`supabase/tests/anonymous.sql` is that measurement, kept.

**Detection, not prevention, for the join code.** It is shared in a group chat,
so it will eventually reach someone it should not; designing as though it will
not is wishful. The People screen shows when the code was last set and who
joined recently, and deactivation is the remedy. Expiry was rejected: a code
that silently stops working produces a new joiner saying "it doesn't work" and
an admin with no idea why, which is a worse day than the leak.

## The Telegram bot

**It acts as the member, never as the service.** `private.is_service()` is true
for `service_role`, and every business-rule trigger opens with
`if private.is_service() then return ...`. A service-role bot silently skips the
order cutoff, the menu lifecycle check and transfer consent. Demonstrated: the
same insert refused with `the menu for 23/09 was cancelled` as a member, and
accepted as the service.

**It signs nothing.** The project uses ES256 JWT signing keys and Supabase does
not let anyone export the private key (`"key_ops":["verify"]`). The legacy HS256
secret still verifies today, which is exactly the trap: it would work until
somebody revokes it. Instead the bot connects with the auto-injected
`SUPABASE_DB_URL` and becomes the member inside a transaction (`set local role
authenticated` plus `request.jwt.claims`). `SET LOCAL ROLE` cannot be used
inside a `SECURITY DEFINER` function; Postgres refuses it with `42501`.

**`/order`, not `/today`.** Ordering closes the night before, so the command
named "today" was about tomorrow for most of the day. `/cancel` separately
matched `service_date = today` while `/order` resolved the next open day, so
after the cutoff a member could place an order the bot then said did not exist.
One function now answers "which day" for both.

**A bug report goes to the office's owner, through the outbox.** "Owner" is
`memberships.role = 'owner'` in the office the report was sent from: there is
no app-wide owner in the schema, and every privilege is scoped to an office. An
`AFTER INSERT` trigger on `bug_reports` enqueues one `bug_report` row per owner
with a linked chat, the same shape as `trg_transfer_notifies`, so an owner who
never finished `/start` produces no row and reads the report on the Bug reports
screen instead. It is the one database-rendered message in `HTML` rather than
`none`, and every user-supplied field goes through `private.telegram_html`
(`&`, `<`, `>`, per the Bot API). `outbox_admin` now hides `bug_report` rows
from admins who are not owners, because the queued body carries the report
verbatim and the table's own policy would otherwise be one join away from
meaningless.

**Money arriving is announced, from the payment's own insert.** Somebody who
transfers wants to know it landed, and an admin wants to know about the one
that landed on nobody. `trg_payment_apply` already decides whose money it is,
so it queues the message once it has: `payment_ack` to the payer's own chat
("Received 40.000 ₫ for lunch at Acme. You owe 60.000 ₫."), or, for a bank
transfer that names nobody, `payment_unmatched` to every admin and owner of that
office with a linked chat, carrying the amount, the time and the transfer
message. Same transaction as the insert, keyed on the payment id, so a SePay
redelivery, which inserts nothing, queues nothing. Both are switches in
`org_notifications`, on when no row exists, and both have a test message. Cash
an admin records on nobody raises nothing: the admin already knows.

Moves are mostly silent. Applying an unmatched payment to somebody tells them,
because nobody did when it arrived; it is one trigger on the
`payment_corrections` row `move_payment` already writes. Moving money from one
person to another, and voiding cash, are an admin correcting the record, and a
second automatic message saying the first was wrong explains less than the
admin doing it can. Plain text (`none`) like every other automatic message, so
the memo goes out verbatim with nothing to escape.

## The shape of a day

**A day has five stages, and only two of them are stored.** `no menu -> open ->
locked -> closed -> done`. `locked` is the order cutoff, which the admin sets.
`closed` is the office's own start of day, when the kitchen begins; `done` is
its end of day, when lunch has been eaten. Both live on `organizations` as
`business_day_starts_at` and `business_day_ends_at`.

The last two are derived on every read, by `private.day_stage` in the database
and `dayStage` in `shared/gating.ts`, never written to a column. A stored stage
needs a job to advance it, the hourly tick is the only job there is, and an hour
is long enough for somebody to hand on a meal that is already on a plate.
`menus.status` stays what it always was -- draft, published, locked, cancelled
-- and remains the thing a person sets. These two stages belong to the clock,
and the clock needs no column.

**What each stage forbids.** After `locked`, nobody changes an order, admin
included: the count has gone to the caterer, and `enforce_order_window` already
enforced that for members. After `done`, a member can no longer record a meal
passed to somebody else.

That last rule is the one that was missing entirely. `enforce_transfer_rules`
bounded a member's pass by the billing period and by nothing else, so a member
could still give away a lunch three days eaten, as long as the week had not
been billed. The week being open for billing is not the same fact as the day
being open for changes, and one had been standing in for the other.

**An admin is exempt from all of it, on purpose.** Correcting what was recorded
on a past day is most of why an admin touches an order or a transfer at all.
What an admin does to a finished day is bookkeeping about a lunch that happened.
What a member would be doing is changing who ate it.

**Un-publishing was removed rather than fixed.** A published menu is editable in
place, so un-publishing only ever hid a day from members while lunch went on
being cooked, which is a state with no meaning to anybody. Calling lunch off is
Cancel, which says so. The `published -> draft` transition is still legal in
`enforce_menu_lifecycle`; nothing in the app reaches it.

**Reopening went the same way, and further: the database refuses it.** It
existed for the cutoff that closed a day by mistake, and it paid for that with
a headcount that was never final, because the day an admin can reopen is a day
the caterer has already been told about. `refuse_reopen` now refuses
`locked -> published` outright for everybody but the service role. A day that
was got wrong is corrected against what was actually eaten, where it reaches
the bill, rather than by reopening ordering and calling a correction an order.

**A day ahead of its menu is skipped or planned, through one function.**
`standing_order_exceptions` existed from the start and the materializer always
read it; nothing wrote it until the Board did. The write is
`set_standing_exception(org, date, 'skip' | 'force' | null)`, and direct
writes to the table are revoked, because what makes an exception mean anything
is not something RLS can say: the date is after today in the office's zone, its
menu is absent or a draft, and the caller has no order row on it. After
publishing, the materializer has already run, so a skip written then would sit
beside an order that says the opposite. From that point the day is ordered or
cancelled like any other. The function takes no profile: it writes for
`auth.uid()` and nobody else, and admins do not get it for others.

It takes the office's materialize lock and then a `FOR SHARE` lock on the day's
draft menu before writing, so a publish arriving at the same moment waits and
its materializer sees the exception, and a skip arriving during a publish waits
and then sees the menu out.

**Exceptions outlive changes to the rule.** Turning a weekday off in Settings
does not clear its skips, and turning one on does not clear its plans. An
exception is a statement about a date: "not on 14/10" stays true if Tuesday is
dropped and added back, and "yes on 14/10" stays true if the rule covers it for
a while and then stops. Deleting them as redundant would be trivially safe for
the database and wrong for the person the moment the rule changed back. A
redundant one costs a row and changes nothing, so they stay. Settings counts only
the skips the rule still covers, on dates with no order row of mine, since those
are the ones the Board draws as skipped.

**One dish needs no choice, and the system says which lines it wrote.** With
one dish on the menu there is nothing to decide, so an undecided slot is an
order for it. The line carries `auto_assigned` so the answer can be taken back
when a second dish arrives, and only that line: a member who tapped the one
dish, or wrote a note on it, has answered the question, and asking again would
throw that answer away. That is why any write of their own clears the mark
rather than keeping it, and why offering the meal to somebody does too: taking
back a line that is on its way to a colleague would change what they accepted.
A system line does not block removing its dish either, because nobody chose it;
a line somebody did write still does. After the cutoff nothing moves: the count
has gone to the caterer.

Dish availability went at the same time. No screen ever set it, and it was a
second answer to "how many dishes does this menu have", which the one-dish rule
needs to have exactly one answer.

**No horizon.** A member may skip or plan any date after today, however far
ahead, and the Board pages forward without limit. The projection is a pure
function of the rule and the exceptions over whatever week is on screen, so
there is no window to maintain, and a limit would only be a number somebody
has to justify when a person asks why they cannot mark their holiday.

## The shape of the money

**Money belongs to a person, not to a week.** A week is a charge, a payment is
a credit, and what somebody owes is the sum of one minus the sum of the other.
It used to be neither: `trg_payment_apply` read the memo, found the one
statement whose `payment_ref` was inside it, and added the whole amount to that
week's `paid_minor`.

Everything followed from that one line. Measured against production: a 397.000
statement paid 794.000 carries `greatest(total_due - paid, 0) = 0` into the
next week, so the other 397.000 simply left the books. Paying three weeks at
once settled one of them. Paying before you had eaten had nothing to attach to,
so there was no such thing as a top-up. And the reference changed every Monday,
so nobody could save the transfer in their banking app.

A negative balance is now money in hand rather than an error, which is the
whole of the credit feature: no new table, no second sum to keep consistent.
`public.v_account_balance` is the one place it is computed.

**`paid_minor` survives as an allocation, not as a record.** A person's credits
are spread across their weeks oldest first and recomputed whenever either side
moves, so every screen that asked "is this week settled" goes on working and
goes on having an answer. What changes is that the answer is derived and may
move. The money may not: `payments` is append-only and nothing deletes from it.
That is the invariant that was ever worth having. It used to be stated as
"nothing decrements `paid_minor`", which confused the record of a payment with
the story told about it.

**One reference per person, for good.** `LUNCH` plus their short code, with no
ISO week in it. A reference that changes cannot be saved as a repeating
transfer, and the commonest way to get it wrong was to reuse last week's. It is
also the SePay sync keyword, so it is load-bearing rather than helpful: a
transfer whose memo omits it is never synced, never reaches this app, and
appears in no unmatched list for anybody to chase.

Three surfaces hand it out -- the Bill screen, `/me`, and the weekly bill the
hourly tick pushes to Telegram -- and all three quote
`memberships.payment_ref`. `billing_statements.payment_ref` still carries the
week it was issued in and is kept only so that references already printed on
bills people are holding go on matching; `private.payer_from_memo` reads the
person's first and falls back to it, longest match winning.

**What a person is shown is that core with their office in front of it.**
`TEST LUNCH DINH`, composed by `composePaymentRef` in
`src/shared/paymentRef.ts` and stored nowhere. The prefix is for the human
reading a bank statement: a SePay account is often also somebody's own, and
`LUNCHDINH` alone does not say which lunch office it was for. Separated by
spaces, because a Vietnamese transfer note carries letters, digits and spaces
intact while `_`, `-` and `/` are dropped or refused. Matching is untouched:
`payer_from_memo` folds a memo to letters and digits before looking for the
core, so `TEST LUNCH DINH` arrives as `TESTLUNCHDINH` and still contains
`LUNCHDINH`, and `vietQrPayload` was widened to accept a space rather than the
composition being bent to fit it.

An ISO week was tried on the end of that and removed within the day. Somebody
three weeks behind has no single true week to name, which is precisely the
person the suffix was for, and a reference that changes weekly cannot be saved
as a repeating transfer -- which is this entry's own rule, restated.

**One bank account serves one office.** The SePay webhook finds the office
by the account number in the delivery, so two offices on one account made
every delivery `ambiguous_account` and dropped it, and a stranger could cause
that by inserting an office naming somebody else's account. The product owner
chose one office per account over routing by the office code in the memo.
`organizations_account_number_uk` is unique on the account with every
whitespace character removed (`private.account_number`), among offices not
deleted, so deleting an office gives its account up. The webhook matches on
the same expression.

**A member can read their own payments.** `v_account_balance` is
`security_invoker`, so it sums `public.payments` with the reader's own
privileges, and the only policy on that table was `payments_admin`. Every
member therefore read `credited_minor = 0` and a balance equal to everything
they had ever eaten. It worked perfectly for an admin, which is how this kind
of thing reaches production; it is the same shape as the bug the Payments
screen was already written around. `payments_select_own` is the fix, own rows
only, and a payment that matched nobody stays invisible because its
`profile_id` is null.

**`carried_in_minor` is pinned to zero and nothing reads it.** Carry-forward
put the same debt on two statements at once, so any sum over weeks counted it
twice and `leave_office` had a comment explaining that it could not add them
up. The column is kept rather than dropped because `total_due_minor` is
generated from it and a generated column cannot be changed in place; a trigger
zeroes it on write rather than a constraint refusing it, because silently
zeroing is kinder than failing a whole re-bill over one code path that has not
caught up.

## Interface

**Two tabs for a member: Board and Bill.** Telegram took much of the daily act,
so the web app keeps the two weekly questions. Standing days, the Telegram link and display
name are set once and live behind the avatar; a permanent tab for them competes
with the two weekly questions and loses.

**Tokens are enforced by the compiler.** `@theme` resets `--color-*` to
`initial`, dropping Tailwind's palette rather than extending it. Proved with a
probe build: `bg-amber-600` and `text-slate-500` emit **0** rules;
`bg-surface` and `text-muted` emit 1 each.

**The accent is never small text.** `#AF7305` on white is **3.98:1**, below AA
for body copy rather than near it. Black on ochre tops out at **5.28:1**, so
`--accent-fg` is `#1A1206` at 4.66:1 and softening it breaks AA on the first
nudge. 54 token pairs were computed; all pass.

**Be Vietnam Pro.** The content is `Cơm gà`, `Phở bò`, `Nguyễn`. Most faces stack
Vietnamese double diacritics badly or fake them. Self-hosted via Fontsource,
which preserves the `unicode-range` split so the Vietnamese subset loads only
when a Vietnamese codepoint is painted.

**The menu lives in a panel, not in the cells.** A grid of people by days cannot
also carry five days of dish lists. Showing the dish only when there is one dish
is a special case, not a design. The panel fills the dead space below the board
and means nobody orders blind.

**Fill, not glyph size.** Cell state was five marks distinguished by the size of
a dot. Size is the weakest visual channel available and five levels of it is four
too many. An admin should read the headcount as blocks of colour without
consulting a legend.

**Words, not icons, for direction.** A cell is (person, day), so a tap could mean
"give my meal to this person" or "pass this person's meal on". That ambiguity is
grammatical, not visual: two arrows ask people to memorise which is which, two
buttons that name their own direction need no legend. If an interface needs a
legend, the encoding has failed.

**The grid is the person picker.** Passing a meal is done by tapping the
recipient's cell. The old admin screen asked you to find a `person, date, dish`
triple in a flat dropdown while the screen was already showing every one of
them; the member's combobox was the same mistake.

**Every disabled control states its reason.** `Action` uses `aria-disabled`, not
`disabled`, because a disabled button leaves the tab order and stops emitting
pointer events, so neither a keyboard user nor a hovering mouse can reach the
explanation. The People screen looked broken for exactly this reason while
working correctly: every control was greyed with no reason given.

**Every mutation reports.** One `useAction` hook owns pending, success and
failure, and `run` resolves rather than rejects, which is what actually removes
`try/catch` from screens instead of merely discouraging it. A role change used to
succeed in silence, so a working feature was indistinguishable from a broken one.

**A word, not a tint, for what a day is.** The board's column heads painted
`surface-sunken` behind every day the reader could not act on. One grey covered
"no menu", "closed" and "cancelled" at once, so the commonest reading of it --
these are the days with a menu -- was not one of the three things it meant.
Heads carry the stage word instead. Colour on this screen now means one thing:
the accent is *ordered*.

**Below 640px the Board is a day, not a table.** The web app is used mainly on
phones, and at 360 the grid spent 49% of its width on names and left room for
one day. Tightened, with an 88px wrapping Who column and 76px days, it showed
three, but in 76px a dish name wraps word by word, a name in 88px does the
same, and the rest of the week is still a sideways scroll away. Any narrower
only trades names for dishes. A strip of the week above one day's list gives
both the width of the screen and keeps every control at 44px, at the cost of
the week at a glance, which the strip's marks keep for your own row. The cells
are shared with the grid, so the two layouts cannot drift apart.

**One week, two screens, one control.** The menu editor offered nineteen days
as a wrapping strip of cards while the board, one item above it in the nav,
showed five days and a pair of arrows. `WeekNav` is shared by both.

**A destructive action is quiet until it is confirmed.** `Cancel lunch` was a
solid red button at the top of the menu screen, louder than Publish, which is
what the screen is for. The entry point is an outline with danger-coloured
text; the red belongs on the button inside the dialog that does it.

**The bill copies two things, not one.** A person paying moves an amount and a
reference from this screen into their bank. The amount copies as plain digits:
`45.000 ₫` in a banking app's amount field fails, and on VND a grouping dot
read as a decimal point turns 45.000 into forty-five dong.

**On a phone the bill opens the bank app, and says it will not fill it in.**
VietQR's redirector (`dl.vietqr.io/pay`) documents `ba`, `am` and `tn` and its
app lists mark five apps `autofill: 1`, but on 2026-09-28 every app it was asked
for, on both platforms, resolved to the bare scheme (`acbone://`,
`intent://#Intent;scheme=acbone;...`) with all three dropped. So the button is
"Open ACB One", not "Pay in ACB One", it copies the reference on the way out
because that is the field whose loss cannot be put right, and the saved QR image
is the real shortcut: every one of those apps scans from the photo library. The
link carries `app` and nothing else. Sending `ba`, `am` and `tn` changed nothing
the redirector answered (checked again on 2026-09-29 with phone user agents:
the same `intent://` on Android, the same page on iOS), so all it did was hand
the office's account, the amount and the member's memo to a third party, which
is the leak the QR is built locally to avoid. If VietQR ever fills the transfer
in, adding the three back is the change; the how-to on refreshing the bank app
list has the check. The app list is a vendored snapshot, text only: the logos
are Play Store and App Store URLs, and loading them would tell Google and Apple
who opened a bill.

**Dish names are sentence-cased where a parse produces them.** Caterers write
in chat and chat is lower case. Not title case: `Cơm Gà` is not how Vietnamese
is written. Names are NFC-normalised wherever they are typed, too, which is not
cosmetic -- `menu_items` is unique on `lower(btrim(name))` and an iOS keyboard's
decomposed `Cơm` slips past that index as a second row on the same menu.

**One API module per screen, behind a barrel.** `api.ts` was 925 lines that
every screen imported, so any two people building any two screens edited the
same file. `src/web/api/` splits it by domain and `api.ts` re-exports, which
means no call site changed and none has to change again. All 38 exports were
diffed before and after.

**The caterer's order is a template the office words, and the admin edits it
each day.** The message was a literal, so an office that greets its caterer or
signs off retyped it daily. Placeholders carry data only (the product owner's
rule): `{unchosen}` is a number, not a sentence, and `{dishes}` has no notes,
because the admin words the notes for the caterer, often merging or dropping
them. The notes are listed beside the box instead. The edited text is not kept,
because it is copied as soon as it is written, and a day nobody ordered for has
no message, because nothing is sent.

## Process

**A failed migration does not fail CI.** Migrations reach the database through
the Supabase GitHub integration; CI only typechecks, tests and deploys. Four
migrations applied, one failed on mismatched dollar quoting, every light stayed
green, and a security fix sat unapplied. `test/migrations.test.ts` now lints what
is statically checkable, verified by reintroducing the original bug and watching
it fail.

**Edge Functions are type checked by `deno check`, not by `tsc`.**
`tsconfig.json` excludes them and `supabase functions deploy` does not check
either, so for a while nothing checked them at all. `deno check` catches errors
`tsc` structurally cannot see, proven with a negative control, and CI runs it
over `supabase/functions/*/index.ts` on every push.
