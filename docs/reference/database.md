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
