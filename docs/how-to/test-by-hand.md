# Test by hand

Seed a realistic office, sign in as its people, and see the app as each of them
does. For the assertions that prove the database is sound, see the tests in
[Database](../reference/database.md#tests).

## Seed an office

```bash
psql "$DATABASE_URL" -f supabase/tests/mock_office.sql   # 5 colleagues, password lunch1234
psql "$DATABASE_URL" -f supabase/tests/mock_week.sql     # a week of menus in every state
psql "$DATABASE_URL" -f supabase/tests/invitations.sql    # asserts the join path; rolls back
psql "$DATABASE_URL" -f supabase/tests/materialize_on_publish.sql  # rolls back
```

`mock_office.sql` creates real email/password logins on deliberately personal
addresses, so you can sign in as each person and see the board as they do. It
needs the **Email** provider enabled in Supabase Auth with *Confirm email* off.

When you are done:

```bash
psql "$DATABASE_URL" -f supabase/tests/teardown_mock_office.sql
```

## Move time

There are two mechanisms, because one is not enough.

**The browser clock** shifts with `?now=` in a dev build. Both placements work,
because both get typed:

```text
http://localhost:5173/#/o/persefoni-vn/orders?now=2026-09-16
http://localhost:5173/?now=2026-09-16T10:00:00+07:00#/o/persefoni-vn/orders
```

A bare date anchors to midday UTC, so it cannot land on the previous day in a
zone west of UTC. A banner says the clock is shifted, and the override is
compiled out of production builds entirely.

That changes what the UI *shows*: which week, the countdown, whether a day looks
locked. It does **not** move the database, which enforces the order cutoff with
its own `now()`. A write the real cutoff forbids is still refused by the
trigger. This is correct, not a limitation to work around: it is the same
mechanism that stops a member with a wrong system clock ordering late.

**So to test behaviour rather than appearance, move the data.** `mock_week.sql`
seeds a menu for every state (locked, cutoff passed, open, cancelled, absent)
relative to today, which is what actually exercises the rules.
