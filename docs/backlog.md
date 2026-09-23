# Backlog

Big pieces deliberately not started yet, with what is already true about each so
nobody re-derives it. Ordered by when they were raised, not by priority.

Everything here waits until the app is in daily use and the known defects are
closed.

## Cancelling lunch does not cancel the charge

**Decide what "cancelled" is supposed to mean, then make it mean that.**

Reproduced against production. A published menu with one 45.000 order bills
45.000. Set the menu to `cancelled` and re-run billing: the order is still
`placed`, `v_order_charges` still returns 45.000, and the week still totals
45.000.

That is what the schema says, consistently: `v_order_charges` selects from
`orders` with no join to `menus` and no status predicate, `run_billing` filters
only on `order_status` and the date window, and no trigger on `menus` touches
orders. So this is a gap in the design rather than a broken implementation.

It matters because an admin pressing **Cancel lunch** is telling people lunch is
off, and will reasonably assume nobody pays for it. Today they still do. The
Menu screen now says so in the confirmation rather than pretending otherwise,
which is honest but is not an answer.

Three possible meanings, and they are genuinely different products:

- *The caterer did not deliver.* Nobody is charged, so cancelling should void
  the orders -- and it must refuse once a week is closed, like every other
  retroactive change.
- *The day was recorded by mistake.* Same outcome, different audit trail: the
  orders should be retracted rather than voided.
- *Lunch happened but is not on this menu.* Nothing should change, which is
  today's behaviour and probably not what the word means to anybody.

## Known defect: a skipped week strands its debt

**Not a presentation problem. The bill can understate what somebody owes.**

`run_billing` step 3 builds statements `from billing_lines ... group by
payer_profile_id`, so a statement exists only for a week you ate in.
Carry-forward then reads the immediately preceding period, finds no statement
for you, and rolls forward nothing.

Reproduced against production in a rolled-back transaction. One member eats in
week 1 (45.000, unpaid), eats nothing in week 2, eats in week 3 (50.000):

| | result |
| --- | --- |
| week 2 statement | none created |
| week 3 `carried_in_minor` | 0, not 45.000 |
| week 3 `total_due_minor` | 50.000, not 95.000 |
| actually outstanding | 140.000 |

So no single statement is the truth, which is why people end up paying week by
week. Summing the unsettled ones is *also* wrong: it double-counts every week
where carry-forward did work, and it does work whenever somebody eats in
consecutive weeks.

The fix is in the database, not the screen: carry an unpaid remainder into the
next period whether or not the person ate, which restores the invariant the Bill
screen already assumes -- that the newest statement carries everything. The
`delete` that prunes zero-line statements has to learn the same exception.

Only then does the screen work follow: one outstanding total at the top with one
QR, amount and reference, and the weeks below as history with per-week status,
each saying whether its remainder was rolled into the total above rather than
offering itself as separately payable.

Two smaller things on the same screen:

- A copy button for the **amount**, digits only with no currency glyph, because
  that is what gets pasted into a banking app's amount field. The reference
  already has one.
- `BillScreen`'s block comment claims it leads with "the oldest thing still
  unsettled" while the code takes the newest. The code is right.

## Paying in advance

Somebody wants to top up before they have eaten.

The schema is most of the way there and it is worth not inventing a second
mechanism: `carried_in_minor` has **no non-negative constraint**,
`total_due_minor` is generated as `meals_minor + carried_in_minor`, and
`outstandingMinor` in `api/billing.ts` already clamps at zero. So credit is
simply a negative carry-forward -- money rolls into next week exactly the way
debt does, with no new table and no second sum to keep consistent.

What is missing is a way to record money that arrives against no statement,
which is the same webhook the SePay entry needs. Do them together or the credit
has no way in.

Decide one thing first: whether a credit is refundable. "Roll it forward
forever" and "give it back when somebody leaves" are different products, and the
second needs a payout path this app has never had.

## An office is stuck with the settings it was born with

Creating an office from the app sends only a name and a slug, so
`create_organization` applies its defaults: `Asia/Ho_Chi_Minh`, `VND`, `vi-VN`,
and a 21:00 cutoff. Every one of those is right for the office this was built
for and wrong for anybody else, and **no screen can change the first three
afterwards** — only the cutoff reached a control.

The timezone is the one that actually breaks things rather than merely reading
oddly: it decides what "today" is, when a menu may be published, and when
ordering closes, so an office in the wrong zone gets a board that turns over at
the wrong hour. Settings names the zone read-only today, which was deliberate —
stating the thing that gives a time its meaning without pretending it is
editable — and that sentence is the line to change.

Either ask on the create form or add a control to Settings. Ask on the form only
if the answer can be defaulted from the browser, because a founder who does not
know their IANA zone name is worse off than one who is not asked. Changing it
later is the harder half: existing menus store `order_cutoff_at` as an instant,
so moving the zone reinterprets every future cutoff, and `enforce_org_timezone`
validates the name but says nothing about what it does to rows already written.

## SePay: prove a payment arrived

Two halves, and the first is mostly done.

**The QR already carries the amount and the note.** `src/shared/vietqr.ts`
builds the EMVCo payload with field `54` set to the outstanding amount and
`62/08` set to the statement's `payment_ref`, so a payer scans and confirms
rather than typing. Verified against an independent implementation of the spec;
**never scanned by a real banking app**, which is the one check still owed.

**Showing that money arrived** is the actual work, and the schema was built for
it: `payments` has `provider` (defaulting to `'sepay'`), `provider_txn_id`,
`amount_minor`, `memo` and `raw`; `trg_payment_apply` matches the memo against
`payment_ref` on insert and moves `paid_minor`; the Bill and Payments screens
already render `partial` and `paid`. What is missing is the endpoint.

### What the docs say (read 2026-09-23)

**The multi-tenant question has an answer, and it is Bank Hub.** It exists for
"software platforms with user bases": each office's admin authorises *their own*
bank account through a hosted link — a WebView embedded as an iframe or through
a JS SDK — authenticating with their bank directly, without handing us
credentials. We then receive that account's transactions. So one integration
serves every office, which is the thing that decides whether this is a feature
everybody gets. Terms are not published: "liên hệ SePay" for approval, contract
and fees.

Its limit is the bank list. Bank Hub names about ten — VPBank, TPBank,
VietinBank, ACB, BIDV, MBBank, OCB, KienLongBank, MSB, Sacombank — against the
36 in `src/shared/banks.ts`. An office banking elsewhere can still be *paid* by
QR; it just cannot be reconciled automatically.

Without Bank Hub the fallback is per-office: each owner registers their own
SePay account and points a webhook at us. It works, and it is exactly the
"every admin has to struggle through it" outcome worth avoiding.

### The webhook maps almost one-to-one onto `payments`

| SePay field | ours |
| --- | --- |
| `id` | `provider_txn_id` |
| `gateway` | the bank's brand name |
| `transactionDate` | `received_at` |
| `accountNumber` | which office this belongs to |
| `content` / `description` | `memo`, which `trg_payment_apply` reads |
| `transferAmount` | `amount_minor` |
| `transferType` (`in`/`out`) | only `in` is money owed to us |
| `referenceCode`, `code`, `subAccount`, `accumulated` | `raw` |

Two things fall out of that, both good. SePay retries up to seven times over
about 33 minutes until it gets a 200 — and `payments_provider_txn_uk`, unique on
`(org_id, provider, provider_txn_id)`, makes a retry a no-op rather than a
double credit. And `accountNumber` is how a webhook finds its office, which
makes `payment_config.vietqr.accountNumber` the routing key: it has to be right
for reconciliation, not just for the QR.

Authentication is API key, HMAC-SHA256, OAuth 2.0, or none, plus an IP
allowlist. The official Laravel package checks `Authorization: Bearer Apikey
<secret>`, so that is the shape to expect.

### Setting it up, once the endpoint exists

Two settings on the **bank account** in SePay, which is a different place from
the webhook and does a different job:

- **Lọc giao dịch theo từ khóa** — sync only transactions whose content carries
  the keyword. Set it to `LUNCH`. This is a *sync* filter: a transaction it
  excludes never enters SePay at all, so it cannot reach this app and cannot
  appear in "Money that matched nobody". The webhook-side option ("Chỉ gửi khi
  có mã thanh toán") is weaker — it only decides what is *delivered*; SePay has
  still received and stored the rest.
- **Đồng bộ giao dịch tiền ra** — off. Money leaving is never a payment to the
  office.

This is why `payment_ref` begins with `LUNCH`. The old `L39NGUY` could not be a
sync keyword: filtering on `L` would have matched almost every memo, which is no
filter at all.

Unconfirmed, and worth one question to SePay: whether an unsynced transaction
also escapes the monthly quota. The quota is defined as "tổng số lượng giao dịch
tiền vào" and SePay can only count what it holds, so it should — but the two are
documented in different places and never connected. The owner's position is that
the overage is small enough not to design around, so this is a curiosity rather
than a blocker.

The trade this makes, which is worth saying out loud: a genuine lunch payment
whose memo omits the reference entirely will not sync either, so it is invisible
to the app rather than landing in the unmatched list. That makes the reference
on the Bill screen load-bearing rather than merely helpful.

### What to decide before building

Whether to pursue Bank Hub, which needs a conversation with SePay and makes this
work for every office, or ship the per-office webhook first and treat Bank Hub
as the upgrade. The endpoint itself is the same either way; only who configures
it changes.

Sources: <https://developer.sepay.vn/vi/bankhub/tong-quan>,
<https://developer.sepay.vn/vi/sepay-webhooks>,
<https://github.com/sepayvn/laravel-sepay>.

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
