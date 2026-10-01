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

## A debt is not chased in a week somebody did not eat

**Solved in the data, not yet in the reminder.** A skipped week used to strand
its debt: carry-forward read the immediately preceding period, found no
statement for somebody who had eaten nothing, and rolled forward nothing, so
the newest statement understated what they owed. Money belongs to a person now,
`v_account_balance` sums every unpaid week exactly once, and the Bill screen
and `/me` both lead with that number. Reproduced against production before the
change: week 1 45.000 unpaid, week 2 nothing eaten, week 3 50.000 billed as
50.000 rather than 95.000.

What remains is the push. The weekly bill built in `private.run_hourly_tick`
selects `from billing_statements` for the week that just closed, so it reaches
somebody only if they ate in it. Their account is stated correctly when it does
reach them, and somebody who ate nothing all week hears nothing at all while
still owing. Fixing it means driving that insert from the balance rather than
from the statement and writing a second sentence for the person with no meals
in the week, which is a different message rather than the same one with a zero
in it.

## Removing a dish somebody chose

The database refuses to remove a dish while any order line names it
(`order_items_menu_item_fk`), so a wrong dish on a published menu stays until
each of those orders is changed by hand on the Orders screen. The Menu screen
should list who chose it and let the admin move each order to another dish or
cancel it, then remove the dish, in one transaction. A line the system wrote on
a one-dish menu does not block removal; see
[One-dish menus](reference/ordering-rules.md#one-dish-menus).

## Paying in advance

**Mostly done.** Somebody can top up, and the money stays money. A payment
carries `profile_id` and credits the person's account rather than a week, so it
needs no statement to attach to; `v_account_balance` reports a negative balance
as credit, and the Bill screen and `/me` both say "in credit" and offer nothing
to transfer. The SePay webhook is the way in, and `private.payer_from_memo`
finds the person from their own stable reference without a statement existing.

A top-up is acknowledged like any payment: the Telegram receipt says "You are
5.000 ₫ in credit." Two things remain, and the first is a product decision that
has never been taken:

- **Whether a credit is refundable.** "Roll it forward forever" and "give it
  back when somebody leaves" are different products, and the second needs a
  payout path this app has never had. `leave_office` refuses on a positive
  balance and says nothing about a negative one, so today somebody in credit
  can walk away from it.
- **Nothing invites a top-up.** The reference and the QR appear only where
  something is owed, deliberately, because offering somebody a way to pay what
  they do not owe is an instruction to overpay. That leaves the person who
  genuinely wants to pay ahead typing the transfer by hand from a reference the
  screen is not showing them. A separate, explicitly-labelled control is the
  shape of the answer, not loosening the rule above.

## An office is stuck with the settings it was born with

Creating an office from the app sends only a name and a slug, so
`create_organization` applies its defaults: `Asia/Ho_Chi_Minh`, `VND`, `vi-VN`,
and a 21:00 cutoff. Every one of those is right for the office this was built
for and wrong for anybody else, and **no screen can change the first three
afterwards**: only the cutoff reached a control.

The timezone is the one that actually breaks things rather than merely reading
oddly: it decides what "today" is, when a menu may be published, and when
ordering closes, so an office in the wrong zone gets a board that turns over at
the wrong hour. Settings names the zone read-only today, which was deliberate:
stating the thing that gives a time its meaning without pretending it is
editable, and that sentence is the line to change.

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
`62/08` set to the payer's own `payment_ref`, so a payer scans and confirms
rather than typing. Verified against an independent implementation of the spec;
**never scanned by a real banking app**, which is the one check still owed.

**Showing that money arrived** now has an endpoint:
`supabase/functions/sepay` records a delivery as a payment, routed by the
account number and authenticated against that office's own webhook secret.
`private.payer_from_memo` finds whose money it is and the account takes it from
there, and the payer is told on Telegram what arrived and where their account
stands; a transfer that matches nobody is raised with the office's admins and
owners. What remains is which of the two ways an office is connected to it,
below, and a delivery from the real SePay rather than from a test.

### What the docs say (read 2026-09-23)

**The multi-tenant question has an answer, and it is Bank Hub.** It exists for
"software platforms with user bases": each office's admin authorises *their own*
bank account through a hosted link (a WebView embedded as an iframe or through
a JS SDK), authenticating with their bank directly, without handing us
credentials. We then receive that account's transactions. So one integration
serves every office, which is the thing that decides whether this is a feature
everybody gets. Terms are not published: "liên hệ SePay" for approval, contract
and fees.

Its limit is the bank list. Bank Hub names about ten (VPBank, TPBank,
VietinBank, ACB, BIDV, MBBank, OCB, KienLongBank, MSB, Sacombank) against the
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

Two things fall out of that, both good. SePay retries up to seven times, over
at most five hours, until it gets a 200, and `payments_provider_txn_uk`, unique on
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

- **Lọc giao dịch theo từ khóa**: sync only transactions whose content carries
  the keyword. Set it to `LUNCH`. This is a *sync* filter: a transaction it
  excludes never enters SePay at all, so it cannot reach this app and cannot
  appear in "Money that matched nobody". The webhook-side option ("Chỉ gửi khi
  có mã thanh toán") is weaker: it only decides what is *delivered*; SePay has
  still received and stored the rest.
- **Đồng bộ giao dịch tiền ra**: off. Money leaving is never a payment to the
  office.

This is why `payment_ref` begins with `LUNCH`. The old `L39NGUY` could not be a
sync keyword: filtering on `L` would have matched almost every memo, which is no
filter at all.

Unconfirmed, and worth one question to SePay: whether an unsynced transaction
also escapes the monthly quota. The quota is defined as "tổng số lượng giao dịch
tiền vào" and SePay can only count what it holds, so it should, but the two are
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

## The Board on a phone, next

Two ideas from the phone layout's review, left out of it on purpose:

- **Group the day's list by dish.** Whoever hands the boxes out reads a dish
  and finds the people, the reverse of the list's order. Grouping would serve
  that moment and cost the fixed row order everybody else relies on to find
  themselves.
- **Headcounts on the strip.** A number per chip is the admin's question
  across the week, and it competes for the 44px chip with my own state, which
  is the member's question. The list heading already counts the picked day.

## Vietnamese interface

The content is already Vietnamese (dish names, member names), and the typeface
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
policy engine to sit in, and one shipped in the bundle would be advisory:
anyone can open devtools and skip it. Enforcement is RLS policies, column grants
and triggers.

That reasoning still holds, so revisiting it honestly means revisiting the
premise rather than shopping for a library: adopting one implies introducing a
server tier the app does not currently have, or generating policies from a
single declarative source instead of writing them by hand. The complaint worth
acting on is real: the rules are spread across policies, grants and triggers,
and only tests tie them together. Start by writing down what specifically has
been buggy or hard to scale, because that decides which of the two directions
helps.

## Noted in passing

- Publishing a one-dish menu for today after the office's day has started gives its standing orders no dish (the stage is `closed`, so `private.settle_undecided` does nothing), but `private.menu_message` still says `Standing orders are down for <dish>.`
- An offer can still be accepted on a day whose lunch was just cancelled: the money is right (the cancelled order bills nothing), but `transfer_decided` tells the giver their offer was accepted for a lunch that will not happen.
