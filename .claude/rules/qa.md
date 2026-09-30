# QA: what a reviewer checks before a push

QA is done by a separate reviewer on the branch, read-only. It reports a
verdict (ship, ship with fixes, do not ship) and findings ranked by severity,
each with `file:line` and a concrete failure scenario. Every finding is
verified in the code before it is reported.

## Checklist

1. **Scope of the diff.** `git diff --stat origin/main..<branch>` lists only
   the intended files, and nothing already on `main` is deleted or reverted. A
   deletion of a file nobody else touched merges silently, so look.
2. **UI.** Every state of every changed screen (loading, empty, error, each day
   stage), phone and desktop widths, light and dark, design-system rules,
   keyboard and screen reader. Look at screenshots; build with `VITE_*`
   variables set, or the bundle is only the missing-config screen.
3. **Business logic.** The behaviour matches the rules in
   `docs/reference/ordering-rules.md` and makes sense for the people using it,
   including edge cases and money.
4. **Concurrency.** A write one person makes in one tap is one transaction.
   Locks follow the order in `docs/reference/database.md`. Risky pairs are
   tried with two real sessions, and a race test fails without the fix.
5. **Security.** No office sees or changes another office's data; permissions
   are checked in the database, not only in the UI.
6. **Real paths.** At least one check goes through the real Supabase API
   (PostgREST), since unit tests mock it and SQL tests bypass it.
7. **Docs.** Updated, accurate, in the right place
   ([documentation.md](documentation.md)).
8. **Checks run.** Typecheck, unit tests, build, every `supabase/tests/*.sql`
   on a fresh database, `deno check` for changed Edge Functions, and a negative
   control for each key new test.
