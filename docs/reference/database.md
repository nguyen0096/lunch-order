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
| `materialize_on_publish.sql` | publishing a menu creates an order for everyone whose weekday rule covers it | no, rolls back |
| `hardening.sql` | the rules under [Invariants](#invariants) on offices, owners, short codes, money and Telegram links | no, rolls back |
| `hardening_follow_up.sql` | link tokens closed to admins, an outbox no browser writes, the invitation preview and the former-offices answer | no, rolls back |
| `removal_and_chat_binding.sql` | only the bot binds a Telegram chat; a removed member stays out of the join code and old invitations, somebody who left does not; an admin or owner adds them back | no, rolls back |
| `payment_notifications.sql` | money arriving tells the payer, an unmatched transfer tells that office's admins and owners, once, behind a switch, and nobody else | no, rolls back |
| `standing_exceptions.sql` | a skip keeps publishing from ordering for you, a plan makes it order with no dish; only your own row, only in your office, only after today on a day with no published menu and no order of yours; exceptions survive rule changes | no, rolls back |
| `atomic_writes.sql` | `set_my_order`, `publish_menu` and `apply_caterer_prices` refuse what the guards would have, in their words, across offices, past the cutoff and on a settled week, and a refusal part way leaves nothing written; a weekday rule's sweep holds only its own office's menus of that weekday | no, rolls back |
| `atomic_writes_race.sql` | two sessions at once over dblink: two taps leave one dish, cancelling lunch and an order in flight wait for each other, pricing the week and a correction do not deadlock, nor a republish and an off-menu record, one office's sweep does not hold another's menus, a skip during a publish is refused, two drains never claim one message | **yes, then removes them**; local only, needs `dblink` |
| `function_grants.sql` | no function in `public` is callable by a signed-in person unless listed as intended | no, rolls back |

`isolation.sql` needs fixtures around it:

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
- **One bank account belongs to one live office.** The SePay webhook routes by
  the account number, so `organizations_account_number_uk` is unique on the
  whitespace-folded number among offices not deleted.
- **Only an owner makes an owner.** The guard on `memberships` fires on insert
  and update, and nothing inserts a membership directly.
- **A short code never overlaps a colleague's.** `payer_from_memo` credits the
  longest reference inside a memo, so `enforce_short_code` refuses a code whose
  reference contains, or sits inside, another member's. A member changes their
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
  whose menu is absent or a draft and on which they have no order row. No
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
  rows by (org, date, id), the billing week's advisory lock, dish rows, the
  order row, its lines. Nothing that holds a menu `FOR UPDATE` may then wait on
  a dish, a line, an order or a week, because a correction holds the week and
  then takes the menu `FOR KEY SHARE`. So a menu is taken `FOR SHARE` to order
  on it and `FOR NO KEY UPDATE` to change it, never `FOR UPDATE`. The hourly
  tick's plain `UPDATE` of due menus, in scan order, is the one known exception;
  see [Decisions](../decisions.md#platform).
- **A dish choice replaces the dish line.** The line is deleted and a fresh
  `order_items` row written, never updated in place, and the member's own new
  order is `source = 'member'`.
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
