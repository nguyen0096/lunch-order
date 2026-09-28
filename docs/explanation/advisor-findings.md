# Advisor findings

Why two things the Supabase advisors report are left as they are, and the one
that was not.

## Deliberate

**`multiple_permissive_policies` (29).** Most tables carry a member policy and a
separate admin policy for the same action. Merging them into one OR'd policy
would satisfy the linter and save a policy evaluation per query, at the cost of
making the security model harder to read and audit, and auditability is the
point of keeping every policy in one file. Because both `my_org_ids()` and
`my_admin_org_ids()` fold to InitPlans evaluated once per statement, the real
cost is small. Revisit if a customer ever gets large enough for it to show up in
`pg_stat_statements`.

**`unused_index` (7).** Expected while the database has little production
traffic. These indexes back the cron queries and the outbox drain. Re-check after
a month of real use before removing any.

The counts are what the advisors reported when this was written; a different
number is a reason to look, not necessarily a regression.

## Fixed

**`anon_security_definer_function_executable`** was a genuine hole, not a false
positive. Postgres grants `EXECUTE` to `PUBLIC` on every new function and
PostgREST exposes `public` at `/rest/v1/rpc/<name>`, so `run_billing`,
`settle_outbox` and `apply_payment_to_statement` were all callable by anon. The
last would have let a stranger mark any bill paid. The grants migration revokes
function execute and grants back only what members may call.

Its default-privileges guard for functions added later does not work: it cannot
remove Postgres's built-in `EXECUTE` to `PUBLIC`. So every new function in
`public` carries its own revoke, and `supabase/tests/function_grants.sql` fails
when one does not.

## Related

- [Database](../reference/database.md)
