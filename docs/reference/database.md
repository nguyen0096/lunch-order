# Database

Where the schema lives, how it reaches production, the tests that prove it, and
the rules no change may break.

## Migrations

`supabase/migrations/`, applied in filename order. A push to `main` applies them
through the Supabase GitHub integration. By hand:

```bash
supabase db push
```

## Tests

SQL tests live in `supabase/tests/`, each with a header saying what it proves
and whether it rolls back. The ones to know first:

| File | Proves | Leaves data behind |
| --- | --- | --- |
| `isolation.sql` | no table shows one org's rows to a member of another | no, with the fixtures below |
| `invitations.sql` | the invitation path, the only way a non-member gets in | no, rolls back |
| `materialize_on_publish.sql` | `publish_menu` on a new day orders for every weekday rule and plan and for nobody who skipped or left, gives a one-dish menu's orders the dish, is announced once by the hourly tick, and a republish orders nobody twice and revives no cancelled order; a day begins published, only through `publish_menu` (a browser's direct insert is refused), and never becomes a draft; members read every menu. Calls the hourly tick, so never against production | no, rolls back |
| `transfer_consent.sql` | an admin's own meal is an offer like anybody's; an admin cannot insert a pass on somebody else's meal or answer somebody else's offer on the table, not by naming its owner as creator nor by setting `lunch.pass_by_admin`, and the refusals write and send nothing; `record_pass` and `undo_pass` still audit, message and move the bill | no, rolls back |
| `weekly_reference.sql` | the same ISO week billed a year apart gives one person the same reference without an error; a week-style memo names its person, and the newest holder of a short code that changed hands between the two years; the money lands on that person's statement | no, rolls back |
| `hardening.sql` | the rules under [Invariants](#invariants) on offices, owners, short codes, money and Telegram links | no, rolls back |
| `hardening_follow_up.sql` | link tokens closed to admins, an outbox no browser writes, the invitation preview and the former-offices answer | no, rolls back |
| `removal_and_chat_binding.sql` | only the bot binds a Telegram chat; a removed member stays out of the join code and old invitations, somebody who left does not; an admin or owner adds them back | no, rolls back |
| `payment_notifications.sql` | money arriving tells the payer, an unmatched transfer tells that office's admins and owners, once, behind a switch, and nobody else | no, rolls back |
| `standing_exceptions.sql` | a skip keeps publishing from ordering for you, a plan makes it order with no dish; only your own row, only in your office, only after today on a day with no menu; exceptions survive rule changes | no, rolls back |
| `atomic_writes.sql` | `set_my_order`, `publish_menu` and `apply_caterer_prices` refuse what the guards would have, in their words, across offices, past the cutoff and on a settled week, and a refusal part way leaves nothing written; a weekday rule's sweep holds only its own office's menus of that weekday | no, rolls back |
| `cancelling_lunch.sql` | cancelling lunch re-bills its week at once: somebody whose only meal of the week was that day gets their credit back, somebody with another meal keeps it, nobody else and no other office moves; a week with no period is cancelled without one being made, and a settled week cannot be cancelled from a browser and is not re-billed by the service role | no, rolls back |
| `atomic_writes_race.sql` | two sessions at once over dblink: two taps leave one dish, cancelling lunch and an order in flight wait for each other, pricing the week waits for a correction holding its day rather than deadlocking, nor a republish and an off-menu record, one office's sweep does not hold another's menus, a skip during a publish is refused, two drains never claim one message | **yes, then removes them**; local only, needs `dblink` |
| `zero_due_week.sql` | the hourly tick bills and closes a week in which somebody's only order has no dish: 0-due weeks are paid and dated, credit and advance payments untouched, the weekly bill sent only to who owes | no, rolls back |
| `one_dish.sql` | a one-dish menu gives every undecided slot its dish, marked as the system's, at publish, on a removal down to one and for a slot made later; a second dish takes back only those lines and asks only those people with Telegram, once; nothing after the cutoff, in a settled week, on a rename or in another office | no, rolls back |
| `one_dish_race.sql` | over dblink: a dish added while a member chooses the one dish, both ways round, and a publish while a weekday rule is turned on, both ways round | **yes, then removes them**; local only, needs `dblink` |
| `rebill_statements.sql` | a re-bill leaves every statement equal to its lines: a person's last meal of the week leaving (removed after an off-menu or menu correction, passed on, cancelled) deletes the statement and returns their credit, a changed dish or price updates it, a second meal shrinks it; credit over two weeks, a settled week, and a waived week whose lines go (a meal re-added is charged afresh, waiving it again says it is gone); declined and withdrawn passes move nothing, and nobody deletes a pass; the other office unchanged | no, rolls back |
| `rebill_race.sql` | over dblink, three or four sessions on one person: payments arriving held open, a re-bill of their week (a removal, a reprice) and a payment moved (matched to this week, to another week, a stray applied, one that arrived while the re-bill waited), voided, or the week waived; each waits rather than deadlocks and nobody is left owing | **yes, then removes them**; local only, needs `dblink` |
| `admin_orders.sql` | the Orders screen's writes: only an admin of the office may call `correct_meal`, `correct_meal_off_menu`, `remove_meal`, `record_pass`, `answer_pass` or `undo_pass`; a cancelled, menu-less or settled day is refused in their words, and `reprice_dish` refuses a cancelled day too; exact money on both sides of every write and nobody else moved; lines and statements agree with the record and nothing is billed twice; a pass is recorded, answered, withdrawn and undone, chains are refused, a correction after a pass lands on the payer; each write's audit row and message, including "ordered lunch for you" ahead; a member's own offer is always pending and a browser cannot write `undone`. No fixture holds credit, so no figure depends on a statement left behind by a week's last meal leaving | no, rolls back |
| `admin_orders_race.sql` | over dblink: an admin answering an offer while the recipient accepts it, both ways round and with the week held by a third correction, never deadlocks; a pass meets the member cancelling or offering the same meal, both ways round; an undo waits for a correction on the same meal; a member's offer taken while the real `record_pass` holds the order goes through, and `record_pass` then names it, with `record_pass` paused between its order lock and its insert by a test-only trigger the file creates and drops (R7); cancelling lunch waits for a correction in flight and cancels the order it wrote (R8); cancelling lunch and a correction on another day of the same week wait for each other, both ways round, and leave every statement the sum of its lines (R9, R10), including when the correction creates the week's first billing period, so nothing stays billed on a cancelled order (R11, R12) | **yes, then removes them**; local only, needs `dblink` |
| `caterer_template.sql` | an owner or admin saves the office's caterer template and null restores the default; one without `{dishes}`, with an unknown placeholder or over 2000 characters is refused; a member or another office's admin changes nothing | no, rolls back |
| `function_grants.sql` | no function in `public` is callable by a signed-in person unless listed as intended | no, rolls back |

The dblink files connect back to the database as the current user over TCP.
On a local Supabase stack that means running them as `supabase_admin` with
`-h 127.0.0.1`: `postgres` is not a superuser there, and dblink refuses a
non-superuser without a password.

`isolation.sql` needs fixtures around it, and so do `invitations.sql` and
`sharing.sql`:

```bash
psql "$DATABASE_URL" -f supabase/tests/seed_fixtures.sql
psql "$DATABASE_URL" -f supabase/tests/isolation.sql      # must print ALL PASS
psql "$DATABASE_URL" -f supabase/tests/teardown_fixtures.sql
```

It is the most important test here: it walks every table as a member of one org
and asserts zero rows of another org are visible. Each check carries a positive
control, because a test that passes only because the session was never
downgraded to `authenticated` is worse than no test at all.

Run it after any policy change. It is not yet wired into CI, which it should be.

The race files (`*_race.sql`) open dblink sessions back into the database,
which needs a superuser that connects without a password. Locally that is
`supabase_admin` over TCP inside the container; `postgres` is refused, and
dblink cannot reach the database from the host:

```bash
docker exec -i <db container> psql -h 127.0.0.1 -U supabase_admin -d postgres \
  -f - < supabase/tests/rebill_race.sql
```

For the scripts that seed a realistic office to click through, see
[Test by hand](../how-to/test-by-hand.md).

## Invariants

These are not style preferences. Breaking one corrupts money or leaks data.

- **Never `current_date`.** The database session runs in UTC and "today" is
  per-org. Use `private.today_in(org.timezone)`.
- **Amounts are integer minor units** with a per-org currency. VND has no
  sub-unit, so the integer is dong. No floats, ever.
- **Every domain table carries `org_id`**, and a composite foreign key proves it
  agrees with the parent row. That is what lets RLS be one indexed predicate
  instead of a join.
- **An office is founded only through `create_organization`.** Nobody inserts
  into `organizations` directly.
- **The caterer template names the dishes and only known placeholders.**
  `organizations_caterer_message_template_ck` refuses a template without
  `{dishes}`, with any `{word}` other than `{companyName}`, `{servingDate}`,
  `{dishes}`, `{total}` and `{unchosen}`, or over 2000 characters. Null is the
  app's default wording.
- **One bank account belongs to one live office.** The SePay webhook routes by
  the account number, so `organizations_account_number_uk` is unique on the
  whitespace-folded number among offices not deleted.
- **Only an owner makes an owner.** The guard on `memberships` fires on insert
  and update, and nothing inserts a membership directly.
- **A short code never overlaps a colleague's.** `payer_from_memo` credits the
  longest reference inside a memo, so `enforce_short_code` refuses a code whose
  reference contains, or sits inside, another member's. A week's reference
  (`billing_statements.payment_ref`) is not unique: the same ISO week a year
  later repeats it, and `payer_from_memo` takes a member's own reference first,
  then the longest statement reference, newest week first (20261022100200). A member changes their
  own once (`memberships.short_code_changes`); an admin or owner, uncounted.
- **Money moves only through `move_payment`, `void_payment` and
  `waive_statement`**, each of which checks for an admin or owner and writes
  `payment_corrections`. Admins read the billing tables and write none of them,
  except a `manual` payment.
- **A Telegram link stays in its membership's office**, by composite foreign
  key, and a browser can clear `chat_id` but never set it.
- **Only the bot binds a chat.** A chat id is trusted only when it arrived in
  an update that passed the webhook secret. The browser's `join_with_code`
  takes no chat; `private.join_office_with_code`, which joins and binds in one
  transaction, is executable by the database owner and `service_role` only.
  `join_with_code` has one signature; 20261014100000 dropped the
  four-argument one that took a chat.
- **Leaving and being removed are different rows.** Both set `status` to
  `inactive`; `memberships.removed_at` and `removed_by` say which, and only the
  `memberships_removal` trigger writes them: a member going inactive by their
  own hand (only `leave_office` allows it) left, anyone else's hand removed
  them, and going active clears both. A removed member is refused by the join
  code, by the Telegram join and by any invitation whose `issued_at` is before
  `removed_at`. Only an admin or owner setting them active, or an invitation
  issued after the removal, brings them back. Rows inactive before this rule
  read as left.
- **Writing an invitation from the app issues it again**: fresh `issued_at` and
  expiry, and a new token when the old one was used.
- **A link token is its owner's alone.** No browser role holds SELECT on
  `telegram_links.link_token`; an admin reads the other columns (who is
  connected, since when) and nothing more. A member gets their own token from
  `my_telegram_link` or `create_my_telegram_link`, which answer for the
  caller's active membership only. The bot reads it as the connection's own
  role.
- **The outbox is written by the database alone.** No browser role holds
  INSERT, UPDATE or DELETE on `notification_outbox`; rows come from SECURITY
  DEFINER functions and triggers (`send_announcement` and
  `send_test_notification` for an admin or owner, taking every chat from the
  office's own links) and from the Edge Functions as the service role. Admins
  and owners read it; an admin who is not an owner reads no `bug_report` row.
- **A payment is announced once, from its own insert.** `trg_payment_apply`
  queues `payment_ack` to the payer or `payment_unmatched` to the office's
  admins and owners in the same transaction, keyed on the payment id, so a
  SePay redelivery (which inserts nothing) queues nothing. Applying an
  unmatched payment to somebody tells them; any other move, and a void, tells
  nobody.
- **An invitee sees one invitation, by its token, and only where it leads.**
  `invitation_preview` returns the office's name, the role, the expiry and
  whether it is still valid; never the address, the sender or an id.
- **A standing exception is written only by `set_standing_exception`**, for
  the caller, in an office they are an active member of, on a date after today
  that has no menu (and so no order row, by `orders_menu_date_fk`). No
  browser role holds INSERT, UPDATE or DELETE on `standing_order_exceptions`.
  Nothing deletes an exception when the weekday rule changes.
- **A write the app makes for one tap goes through one named function.**
  Choosing a dish is `set_my_order`, publishing a menu `publish_menu`, pricing
  the week `apply_caterer_prices`, each one transaction. A new multi-step write
  gets a function too, never a sequence of requests. Each is SECURITY DEFINER
  with `search_path = ''`, which the guard triggers exempt, so each repeats their
  checks itself: the caller (`my_org_ids`, `my_admin_org_ids`, or own row with
  no profile parameter), the day's stage and cutoff, and the settled week via
  `private.assert_week_open`, in the triggers' own words.
- **Locks are taken in one order**: `private.lock_office_materialize(org)`, menu
  rows by (org, date, id), a pass row (`meal_transfers`), the office-week key
  (`private.lock_office_week`, by office and week start), the billing week's
  advisory lock, dish rows, the order row, its lines. The office-week key
  exists because the week's lock is keyed on its period, which may not exist
  yet: `private.correction_period`, which can create the first period of a
  week and bill it, and `trg_menu_cancelled` both take it before looking the
  period up, so a cancel never misses a period a correction is creating, and
  nothing takes it while holding a week. A correction holds its
  day's menu `FOR SHARE` (`FOR NO KEY UPDATE` to add a dish) before the week,
  so cancelling lunch waits for it. Cancelling lunch holds the menu and takes
  the office-week key and the week before it writes the orders and re-bills
  (`trg_menu_cancelled`). A member answering an offer locks the pass
  and then, from `meal_transfers_rebill`, the week, so `answer_pass` and
  `undo_pass` take the pass before the week; `record_pass` reads the live pass
  without locking it and leaves the rest to `transfers_one_live_uk`, naming the
  offer that won the slot. These and `remove_meal` take the order
  `FOR NO KEY UPDATE`, not `FOR UPDATE`: a member's offer holds its pass slot
  and then takes the order `FOR KEY SHARE` through its foreign key, and
  `FOR UPDATE` would make the two wait on each other (40P01). Nothing
  that holds a menu `FOR UPDATE` may then wait on a dish, a line, an order or a
  week, because a foreign key check takes the menu `FOR KEY SHARE`. So a menu
  is taken `FOR SHARE` to order on it and `FOR NO KEY UPDATE` to change it,
  never `FOR UPDATE`. The hourly
  tick's plain `UPDATE` of due menus, in scan order, is the one known exception;
  see [Decisions](../decisions.md#platform). Money comes after, in one order:
  the week, each person (the `lunch.reallocate:` advisory key, in profile
  order), payment rows, then statement rows. `run_billing` holds the week,
  every person with a statement, a line or a billable order in the week, and
  then the payments pointing at its statements, before it writes a statement;
  `move_payment` and `void_payment` read the payment, take its people (both,
  for a move), then lock the payment and refuse if it moved meanwhile;
  `trg_payment_apply` and `waive_statement` take the person, then the
  statements. Which payments point at a person's statements changes only
  under that person's lock. `private.reallocate` takes its person's key again,
  which is a no-op when it is already held.
- **A statement is the sum of its lines.** Every re-bill recalculates every
  statement in the week, to zero when no line is left, reallocates each of
  those people, and then deletes a statement with no lines (waived or not).
  A payment that pointed at it is re-pointed at the person's newest week
  holding money (`private.payment_frontier`), or at nothing.
- **A pass is never deleted.** No browser role holds DELETE on
  `meal_transfers`; a pass ends as `declined`, `cancelled` or `undone`, which
  `enforce_transfer_rules` checks and `trg_transfer_rebills` bills.
- **An admin's pass goes through one of three functions.** `record_pass`
  (accepted at once), `answer_pass` (accept, decline or withdraw a pending
  offer on somebody's behalf) and `undo_pass` (accepted to `undone`) each
  check for an admin of the office, refuse a cancelled day and a settled week,
  re-bill, write `order_corrections` with the pass's `transfer_id`, and tell
  both people. They are the only way: on the table a browser, an admin
  included, may only offer its own meal (always pending, `created_by` the
  caller), accept or decline an offer made to it, or withdraw its own
  (`enforce_transfer_rules`, 20261022100100). The RPCs pass that trigger
  because they run as their owner (`private.is_service()`), which no browser
  can be; `lunch.pass_by_admin` only quiets the member-style message and
  admits nobody. Only `undo_pass` writes `undone`. A missing id
  and another office's id get the same refusal, `42501 only an admin of this
  office can correct the record`, from these and `remove_meal`, so nobody can
  probe ids across offices.
- **A day has a menu or none.** A menu starts out published, from
  `publish_menu`; no browser role holds INSERT on `menus`, and
  `menus_status_check` allows only `published`, `locked` and `cancelled`
  (20261022100000). Its insert materializes standing orders
  (`menus_materialize_on_insert`); nothing depends on a status update to
  publish.
- **A correction needs a day that is not cancelled.** `correct_meal`,
  `correct_meal_off_menu`, `remove_meal`, `reprice_dish` and the pass RPCs
  refuse a cancelled menu (`private.assert_menu_correctable`), so a correction
  can never revive an order or move a price on a cancelled day.
- **A browser writes no dish.** `menu_items` is written by `publish_menu` and
  the corrections, each holding the menu before the dish, because a dish
  change takes its menu from a row trigger and a delete has locked its row
  before that trigger runs (20261018100100).
- **A dish choice replaces the dish line.** The line is deleted and a fresh
  `order_items` row written, never updated in place, and the member's own new
  order is `source = 'member'`.
- **A week with nothing due is paid.** A placed order with no dish line bills
  at 0; a statement whose meals come to 0 is `paid`, takes none of the person's
  credit, and gets `paid_at` when it is settled (kept on a re-bill), since
  `billing_statements_paid_ck` ties `paid` to a date. The weekly bill goes only
  to somebody whose balance is above 0.
- **Only the system marks a line `auto_assigned`.** `private.settle_undecided`
  and `private.assign_only_dish` write it, as the definer, only while the day's
  stage is `open` and never in a settled week, which they check themselves
  because the guards exempt them. A write of a line by anybody but the
  service clears it (`guard_auto_assigned`), a browser holds no UPDATE on the
  column, a dish choice writes a fresh line, and offering the meal clears it
  (`trg_transfer_decides`). The dish count is settled from where it ends: once
  per `publish_menu`, once per statement on `menu_items` otherwise, after the
  menu is held `FOR NO KEY UPDATE`.
- **Order prices are snapshotted** by trigger on write, and again into
  `billing_lines` at period close, so editing a menu can never rewrite a past bill.
- **`VITE_`-prefixed variables are inlined into the browser bundle.** A secret
  behind that prefix is a full compromise. Check before shipping:

  ```bash
  grep -rn "SERVICE_ROLE\|BOT_TOKEN\|sb_secret_" dist/web/
  ```

## Related

- [Decisions: Security](../decisions.md#security) and
  [The shape of the money](../decisions.md#the-shape-of-the-money), for why
- [Why the advisor findings are left open](../explanation/advisor-findings.md)
- [Secrets](secrets.md)
