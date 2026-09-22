# Lunch Order

Multi-tenant lunch ordering for offices. An admin publishes the day's menu, members
tick what they want in a web app, and a Telegram bot handles the nudging. Weekly
settlement is computed automatically, with optional bank reconciliation.

Built for Persefoni's Vietnam office first, which is why VietQR and Vietnamese menu
parsing come first, but the schema is multi-tenant from the first migration.

## Status

Written but not yet verified against a live database. The schema, the web app, the
scheduled jobs and the Telegram bot are all in the repo and the unit tests pass, but
the Supabase project they were built against is unreachable, so nothing since
`20260911210000` has ever been applied or run.

Before trusting any of it, stand the project back up and work through
`supabase/tests/`, starting with `isolation.sql`.

Known to be unfinished: no billing UI on the web app, no payment webhook, and only
three of the outbox's nine `kind` values are ever enqueued.

## Stack

- **Postgres on Supabase** — the browser talks to it directly and org-scoped RLS is
  the security boundary. Business rules that need legible error messages (order
  cutoff, menu lifecycle, transfer transitions) are triggers rather than policies.
- **Edge Functions (Deno)** for the Telegram bot and the payment webhook, i.e. only
  the things that must never reach the browser.
- **pg_cron** for scheduling. Jobs run hourly in UTC and select the orgs whose local
  clock has just crossed a threshold, so a customer in a new timezone needs no new job.
- **React + Vite** SPA, served as static assets by a Cloudflare Worker. There is
  no Worker script: the bundle talks to Supabase directly, so nothing needs to run
  at the edge.

## Develop

```bash
npm install
cp .env.example .env      # fill in the Supabase URL and publishable key
npm run dev
npm run typecheck && npm test
```

## Deploy

`main` deploys itself. Once `check` passes, CI builds `dist/web` and uploads it to the
`lunch-order` Worker as static assets. Routing is hash based, so `index.html` is the
only HTML entry point and no history fallback is configured; a 404 from the Worker
means a genuinely missing file.

Not Vercel: its Hobby plan is non-commercial-use only and this is a company internal
tool, while Cloudflare's free static asset bandwidth is unmetered and permits
commercial use.

One-time setup, in order:

1. **Create the Worker.** From a machine logged in with `npx wrangler login`, run
   `npm run deploy`. The first deploy creates `lunch-order` and prints its
   `https://lunch-order.<your-subdomain>.workers.dev` URL, which you need for step 3.
2. **Add four repository settings** under *Settings > Secrets and variables > Actions*:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | secret | token from the *Edit Cloudflare Workers* template |
   | `CLOUDFLARE_ACCOUNT_ID` | secret | account ID from the Cloudflare dashboard |
   | `VITE_SUPABASE_URL` | variable | same value as in `.env.example` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | variable | the publishable key |

   The two `VITE_` values are variables rather than secrets on purpose: Vite inlines
   them into the bundle, so they are public the moment anyone loads the page. They are
   still required. Without them the build succeeds and the app reports a config error
   to every visitor instead.
3. **Allow the origin in Supabase Auth.** Google sign-in passes
   `redirectTo: window.location.origin`, so add the Worker URL from step 1 under
   *Authentication > URL Configuration > Redirect URLs*. Until you do, sign-in
   completes at Google and then bounces to the project's default site URL.

To ship without CI, or to check a build before merging, `npm run deploy` does the same
build and upload from your machine.

## Database

Migrations are in `supabase/migrations/`, applied in filename order.

```bash
supabase db push
```

Verify a deployment:

```bash
psql "$DATABASE_URL" -f supabase/tests/seed_fixtures.sql
psql "$DATABASE_URL" -f supabase/tests/isolation.sql      # must print ALL PASS
psql "$DATABASE_URL" -f supabase/tests/teardown_fixtures.sql
```

`isolation.sql` is the most important test here: it walks every table as a member of
one org and asserts zero rows of another org are visible. Each check carries a
positive control, because a test that passes only because the session was never
downgraded to `authenticated` is worse than no test at all.

## Invariants

These are not style preferences. Breaking one corrupts money or leaks data.

- **Never `current_date`.** The database session runs in UTC and "today" is per-org.
  Use `private.today_in(org.timezone)`.
- **Amounts are integer minor units** with a per-org currency. VND has no sub-unit,
  so the integer is dong. No floats, ever.
- **Every domain table carries `org_id`**, and a composite foreign key proves it
  agrees with the parent row. That is what lets RLS be one indexed predicate instead
  of a join.
- **Order prices are snapshotted** by trigger on write, and again into `billing_lines`
  at period close, so editing a menu can never rewrite a past bill.
- **`VITE_`-prefixed variables are inlined into the browser bundle.** A secret behind
  that prefix is a full compromise. Check with
  `grep -rn "SERVICE_ROLE\|BOT_TOKEN" dist/web/` before shipping.

## Not related to nexus-infra

This started inside the `nexus-infra` working tree and was split out into its own
repository. It shares none of that project's conventions and must not call anything
in it.

The split was not cosmetic. GitHub Actions only reads workflows from the repository
root, so while this lived at `app/lunch-order/` inside `nexus-infra`, the CI
described above had never once executed.

## Known advisor findings, and why

`mcp__supabase__get_advisors` reports two things that are deliberate:

**`multiple_permissive_policies` (29).** Most tables carry a member policy and a
separate admin policy for the same action. Merging them into one OR'd policy would
satisfy the linter and save a policy evaluation per query, at the cost of making the
security model harder to read and audit — and auditability is the point of keeping
every policy in one file. Because both `my_org_ids()` and `my_admin_org_ids()` fold
to InitPlans evaluated once per statement, the real cost is small. Revisit if a
customer ever gets large enough for it to show up in `pg_stat_statements`.

**`unused_index` (7).** Expected: the database has no production traffic yet. These
indexes back the cron queries and the outbox drain. Re-check after a month of real
use before removing any.

**`anon_security_definer_function_executable`** was a genuine hole, not a false
positive, and is fixed. Postgres grants `EXECUTE` to `PUBLIC` on every new function
and PostgREST exposes `public` at `/rest/v1/rpc/<name>`, so `run_billing`,
`settle_outbox` and `apply_payment_to_statement` were all callable by anon — the last
would have let a stranger mark any bill paid. The grants migration now revokes
function execute wholesale and grants back only `create_organization`.

## Menu parsing

Two paths, both landing in the same editable table, with nothing written until
the admin presses Publish.

**Read with AI** posts the message to the `parse-assist` Edge Function, which
calls DeepSeek's Anthropic-compatible endpoint. Requires a secret:

```bash
supabase secrets set DEEPSEEK_API_KEY=sk-...
```

Without it the function returns 501 and the button reports that plainly.

Deploy with `scripts/deploy-functions.sh`, never by pasting file contents into an
API call: the running function drifts from the repo silently and the next person
debugs code that is not what is executing.

Three things keep this from being a liability:

- **Admin-only.** The caller's JWT is verified and their `admin`/`owner` role
  checked against the org before any request leaves. An unauthenticated LLM
  proxy is someone else's token bill.
- **The shape is forced, then distrusted.** A tool schema with
  `additionalProperties: false` and `price` typed `integer` constrains the
  output; `validateAssist` in `src/shared/menuSchema.ts` re-checks it anyway and
  fails loudly on a float price, a blank name, or 60+ items. A schema is a
  strong constraint, not a guarantee.
- **It cannot reach a bill unseen.** The result populates a preview, then an
  editable table. A human sets every price that ends up in `menu_items`.

The caterer's message is untrusted input: it goes in a delimited user turn, the
system prompt states its contents are data, and the tool schema means the only
route back is a list of dishes and prices.

**Quick parse** is the offline regex parser in `src/shared/menuParser.ts`. It is
free, instant, and handles the notations seen so far (`45k`, `40.000đ`, numbered
and bulleted lists, `nghìn`). Kept because most days it is right and costs
nothing, and because it still works when DeepSeek is down or unfunded.

## Manual end-to-end testing

```bash
psql "$DATABASE_URL" -f supabase/tests/mock_office.sql   # 5 colleagues, password lunch1234
psql "$DATABASE_URL" -f supabase/tests/mock_week.sql     # a week of menus in every state
psql "$DATABASE_URL" -f supabase/tests/invitations.sql    # asserts the join path; rolls back
psql "$DATABASE_URL" -f supabase/tests/materialize_on_publish.sql  # rolls back
psql "$DATABASE_URL" -f supabase/tests/teardown_mock_office.sql
```

`mock_office.sql` creates real email/password logins on deliberately personal
addresses, so you can sign in as each person and see the board as they do. It
needs the **Email** provider enabled in Supabase Auth with *Confirm email* off.

### Moving time

There are two mechanisms, because one is not enough.

**The browser clock** shifts with `?now=` in a dev build. Both placements work,
because both get typed:

```
http://localhost:5173/#/o/persefoni-vn/orders?now=2026-09-16
http://localhost:5173/?now=2026-09-16T10:00:00+07:00#/o/persefoni-vn/orders
```

A bare date anchors to midday UTC, so it cannot land on the previous day in a
zone west of UTC. A banner says the clock is shifted, and the override is
compiled out of production builds entirely.

That changes what the UI *shows* — which week, the countdown, whether a day
looks locked. It does **not** move the database, which enforces the order cutoff
with its own `now()`. A write the real cutoff forbids is still refused by the
trigger. This is correct, not a limitation to work around: it is the same
mechanism that stops a member with a wrong system clock ordering late.

**So to test behaviour rather than appearance, move the data.** `mock_week.sql`
seeds a menu for every state — locked, cutoff passed, open, draft, absent —
relative to today, which is what actually exercises the rules.
