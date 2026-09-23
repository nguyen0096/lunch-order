# Backlog

Big pieces deliberately not started yet, with what is already true about each so
nobody re-derives it. Ordered by when they were raised, not by priority.

Everything here waits until the app is in daily use and the known defects are
closed.

## SePay: prove a payment arrived

Two halves, and the first is mostly done.

**The QR already carries the amount and the note.** `src/shared/vietqr.ts`
builds the EMVCo payload with field `54` set to the outstanding amount and
`62/08` set to the statement's `payment_ref`, so a payer scans and confirms
rather than typing. Verified against an independent implementation of the spec;
**never scanned by a real banking app**, which is the one check still owed.

**Showing that money arrived** is the actual work. The schema is ready and
unused: `payments` has `provider`, `provider_txn_id`, `amount_minor`, `memo` and
`raw`, `trg_payment_apply` moves `billing_statements.paid_minor` on insert, and
the Bill screen already renders `partial` and `paid`. What is missing is the
webhook that turns a SePay callback into a `payments` row, and a way to match
`memo` to `payment_ref`.

**The open question, which is the reason this is not trivial:** SePay is
configured per bank account by the account's owner. This app is multi-tenant, so
every office has its own account and would need its own SePay hookup. Before
building, find out whether one integration can receive callbacks for many
accounts, or whether each admin must register separately — and if the latter,
whether that is something a non-technical admin can actually complete. A payment
feature only some offices can switch on is a different product decision from one
everybody gets.

## Vietnamese interface

The content is already Vietnamese — dish names, member names — and the typeface
was chosen for it (see [decisions](decisions.md)). The interface around it is
English with no translation layer at all: every string is inline in the
component that shows it.

Two things to decide before starting. Database error messages are deliberately
surfaced verbatim because they are written for people ("ordering for 23/09
closed at 21:00 22/09"), so translating the interface without translating those
leaves a bilingual screen; the trigger messages would have to move too, or be
mapped client-side. And `organizations.locale` already exists and drives money
formatting, so there is a per-office answer available rather than a per-browser
guess.

## Reconsider the authorization approach

[decisions](decisions.md) records why there is no RBAC library: the browser
talks straight to Postgres through PostgREST, so there is no server tier for a
policy engine to sit in, and one shipped in the bundle would be advisory —
anyone can open devtools and skip it. Enforcement is RLS policies, column grants
and triggers.

That reasoning still holds, so revisiting it honestly means revisiting the
premise rather than shopping for a library: adopting one implies introducing a
server tier the app does not currently have, or generating policies from a
single declarative source instead of writing them by hand. The complaint worth
acting on is real — the rules are spread across policies, grants and triggers,
and only tests tie them together. Start by writing down what specifically has
been buggy or hard to scale, because that decides which of the two directions
helps.
