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
needed its own trigger; the old one was BEFORE UPDATE only.

**A join code grants membership and nothing else, on every path.** It hardcoded
`'member'` on insert but the reactivation branch touched `status` alone, so a
deactivated admin returned as an admin by sending a string every remaining
member can read.

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

## Process

**A failed migration does not fail CI.** Migrations reach the database through
the Supabase GitHub integration; CI only typechecks, tests and deploys. Four
migrations applied, one failed on mismatched dollar quoting, every light stayed
green, and a security fix sat unapplied. `test/migrations.test.ts` now lints what
is statically checkable, verified by reintroducing the original bug and watching
it fail.

**Edge Functions have no type checking in CI.** `tsconfig.json` excludes them and
`supabase functions deploy` does not check either. `deno check` catches errors
`tsc` structurally cannot see, proven with a negative control. Not yet wired in;
it should be.
