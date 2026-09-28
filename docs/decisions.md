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

**Its own repository.** GitHub Actions only reads workflows from the repository
root. While this lived at `app/lunch-order/` inside `nexus-infra`, CI had never
once executed.

## Security

**No RBAC library.** The browser talks directly to Postgres through PostgREST.
There is no server tier for Casbin or CASL to sit in, so a policy engine in the
bundle would be advisory: anyone can open devtools and skip it. Rules live where
the data is. Enforcement is 41 RLS policies, 143 column grants, and triggers;
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

**A removed member is told so.** `my_org_ids()` sees active memberships only,
so a removed member got the new-user screen, hedged to cover both. Now
`my_removed_offices` names the live offices where their own membership is
inactive, and nothing else. Leaving through `leave_office` also leaves the row
inactive and the row does not record which happened; the sentence is written
for the person who did not leave, because the one who did already knows.

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

**Two tabs for a member: Board and Bill.** Telegram took the daily act, so the
web app is the desktop surface. Standing days, the Telegram link and display
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
