# Ordering rules

How lunch ordering behaves today, as the database enforces it. Each rule names
the function, trigger or policy that holds it; the migration is the newest one
that defines it, under `supabase/migrations/`. What the screens show is in
[Screens](screens.md); why each rule exists is in [Decisions](../decisions.md).

Every date and clock time is in the office's own zone, `organizations.timezone`
(`Asia/Ho_Chi_Minh` by default). "Admin" means admin or owner throughout.

| Term | Means here |
| --- | --- |
| menu status | `published`, `locked` or `cancelled`. A day has a menu, which starts out published, or it has none |
| day stage | what the clock derives from the status: see [Day stages](#day-stages) |
| cutoff | `menus.order_cutoff_at`, one instant per menu. The Menu screen defaults it to the evening before at the office's default time, 21:00 |
| slot | one person on one menu. There is at most one order row per slot, cancelled included |
| standing rule | a member's weekdays (`standing_orders`); an exception (`skip` or `force`) overrides it for one date |
| settled week | a billing week whose period is `closed`. Nothing on it changes any more |

## Day stages

`private.day_stage` (20261022100000) derives the stage on every read; the Board
mirrors it in `dayStage` (`src/shared/gating.ts`). The word in brackets is what
the screens show.

| Stage | When | A member can | An admin can | Enforced by |
| --- | --- | --- | --- | --- |
| no menu (`No menu`) | no menu row for the date: no lunch | skip or plan a date after today | publish a menu for any date, a past one included. Nothing on Orders until it is published | `set_standing_exception` (20261022100000), `enforce_menu_not_in_past` (20260930100000) |
| open | published, before the cutoff | order, change, cancel, pass a meal | the same on the Board; edit dishes; cancel lunch; on Orders, anything below for anybody | `enforce_order_window` (20261003100100) |
| locked (`Closed`) | the cutoff passed | offer, accept, decline, withdraw a pass | on Orders, order, change or remove for anybody, their own row included, and pass, answer or undo a pass; fill in a missing price | `enforce_order_window`, `enforce_menu_item_frozen` (20260928100200) |
| closed (`Cooking`) | the office's start of day, `business_day_starts_at` (08:30) | the same as locked | the same as locked | `private.day_stage` |
| done (`Served`) | the office's end of day, `business_day_ends_at` (17:30) | nothing | the same as locked | `enforce_transfer_rules` (20261022100100) |
| cancelled (`Cancelled`) | lunch was called off | nothing | nothing | `enforce_order_window`, `enforce_menu_lifecycle`, `private.assert_menu_correctable` (20261022100000) |

A **settled week** overrides every stage: no insert, update or delete on an
order or its dishes, by anybody but the service role
(`refuse_write_to_settled_week`, 20261007100000), no correction
(`private.correction_period`, 20261007100200) and no pass
(`enforce_transfer_rules`). The hourly tick closes the week that ended
yesterday on the office's billing day at the weekly-bill hour; `settle_period`
closes a finished week on demand. A week holding a placed order with no price
stays open (`hold_period_open_while_unpriced`, 20260928100000).

## Menu lifecycle

| From → to | Allowed when | What it triggers | Enforced by |
| --- | --- | --- | --- |
| no menu → published | `publish_menu` with at least one dish, the only way a browser begins a day: no browser role holds INSERT on `menus` | standing slots become orders, if the date is today or later and the cutoff is ahead, with the dish if there is only one, whatever the stage; the menu message on the next hourly tick | `publish_menu` (20261023100000), `enforce_menu_lifecycle` (20261022100000), `menus_materialize_on_insert` (20260911180000), `trg_menu_published_materialize` (20261022100000), `run_hourly_tick` (20261009100000) |
| published → locked | the first hourly tick after the cutoff | nothing else | `run_hourly_tick` |
| published → cancelled | stage is open | every placed order on the menu is cancelled, their pending passes withdrawn, and the week re-billed | `enforce_menu_lifecycle`, `trg_menu_cancelled` (20261023100200) |
| locked → published | never | | `refuse_reopen` (20261006100000) |
| locked → cancelled | never in practice: the stage check refuses it | | `enforce_menu_lifecycle` |
| cancelled → anything | never | | `enforce_menu_lifecycle` |
| anything → draft | never: there is no draft | | `enforce_menu_lifecycle`, `menus_status_check` (20261022100000) |

- **Republishing** a published menu is an edit in place. It changes no status,
  so it materializes nothing and sends no new message (`publishMenu`,
  `src/web/api/menu.ts`).
- **The service date** never changes once the menu exists, and a browser
  never creates a menu in the past (`enforce_menu_lifecycle`,
  `enforce_menu_not_in_past`).
- **A past day** can be created and published by an admin. Publishing it
  materializes no standing orders: the admin records who ate
  (`trg_menu_published_materialize`, 20261022100000).
- **Cancelling lunch** cancels the orders, withdraws their pending passes
  ([Passing a meal](#passing-a-meal)) and re-bills the day's week in the
  same transaction, so a statement already written stops charging them and
  any credit it held is the person's again. A week with no billing period has
  nothing to re-bill, and a settled week is never re-billed. Exceptions stay. Nothing is sent to Telegram, and a menu message already
  sent is not withdrawn.

## Menu contents

| Change | published | locked | cancelled | Enforced by |
| --- | --- | --- | --- | --- |
| add a dish | yes | no; an off-menu dish only through Orders | no | `enforce_menu_item_frozen` (20260928100200), `correct_meal_off_menu` |
| rename or reprice | yes. Orders already placed keep the name and price they took | fill in a missing price only; other repricing through Orders | no | `enforce_menu_item_frozen`, `snapshot_order_item` (orders), `reprice_dish` |
| leave the price empty | yes; orders for it are held out of billing until priced | | | `v_order_charges.unpriced` (20260928100000) |
| remove | only if no order line names it, in any order status, other than a line the system wrote while the day is open ([One-dish menus](#one-dish-menus)) | no | no | `order_items_menu_item_fk` ON DELETE RESTRICT (orders), `trg_menu_items_hold_menu` |

Dish names are unique per menu, ignoring case and outer spaces
(`menu_items_name_uk`). Every dish on a menu is on offer. How many there are
matters in the database only for [One-dish menus](#one-dish-menus), and to
publish, which needs one. The Board uses the count too: with one dish,
`+` orders it outright; with several, `+` opens the chooser and the dice picks
one ([Ordering](screens.md#ordering)).

## Standing days

| Rule | Enforced by |
| --- | --- |
| A member sets their own weekdays, on or off (`is_enabled`); an admin can set anybody's | `standing_orders_own`, `standing_orders_admin` policies (rls) |
| A member skips a rule day or plans (`force`) a day off the rule, only for a date after today that has no menu. Only their own. Undoing removes the exception | `set_standing_exception` (20261022100000) |
| Nobody writes exceptions directly, admins included | revoke in 20261016100000 |
| Exceptions survive changes to the weekday rule | `set_standing_exception` never deletes them |
| At publish, each active member whose rule covers the weekday and has no skip, plus each active member with a force, gets an order: `source = standing`, no dish, or the dish on a one-dish menu | `materialize_standing_orders`, `publish_menu` (20261023100000) |
| Turning a weekday on, or writing an exception, re-runs that for every published menu still before its cutoff | `trg_standing_materialize` |
| Nothing is materialized after the cutoff, for a past date, or into a slot that already has a row. A slot the member cancelled stays cancelled | `materialize_standing_orders`, `orders_menu_profile_uk` |
| Turning a weekday off cancels nothing already created | no trigger on turning off |
| A member who left or was removed keeps their rule but gets no new standing orders, and the open ones already created are cancelled ([Leaving or being removed](#leaving-or-being-removed)). Coming back revives none: the rule orders again only into a slot with no row | `m.status = 'active'` in `materialize_standing_orders`, `orders_menu_profile_uk` |

On the Board, a day after today with no order row of mine shows `Standing` or
`Planned` when the rule and exceptions predict an order, and bare `+` or
`Skipped` otherwise (`projectStandingDays`, `src/shared/projection.ts`). It is
tappable only while the day has no menu
([Skipping and planning](screens.md#skipping-and-planning-a-day-ahead)).

## Orders

| Action | Who, when | Result | Enforced by |
| --- | --- | --- | --- |
| order | a member for themselves, on a published menu before the cutoff | `source = member`. The Board writes `member` for admins too | `set_my_order` (20261018100000), `orders_insert_own` (rls), `enforce_order_window` |
| choose or change the dish | same window | one call deletes the order's dish lines and writes one; name and price are copied from the dish then | `set_my_order`, `snapshot_order_item` |
| quantity | same window | 1 to 20 per dish; the Board always writes 1 | `order_items.quantity` check |
| note | same window | 1 to 120 characters, on the dish line, so an order with no dish has none | 20260926100000 |
| eating, no dish chosen | from a standing slot, an admin, or `set_my_order` with no dish | an order with no dish line, which a one-dish menu fills. The Board never creates one | `materialize_standing_orders`, `set_my_order` (20261018100000) |
| cancel (not eating) | same window, own order | `status = cancelled`; the row keeps the slot, and a pending pass on it is withdrawn. Ordering again revives the order, never a pass: a pending one left on it is withdrawn then too. No member delete | `orders_update_own` (rls), `enforce_order_window`, `orders_withdraw_pass` (20261023100100) |
| after the cutoff | nobody on the Board, admins included | refused with the cutoff in the sentence | `enforce_order_window` |
| order or put right for somebody | an admin, on any day whose menu is published or locked, before or after the cutoff, until the week is settled; their own row included. A cancelled day is refused (`lunch on 24/09 was cancelled`), a reprice included | set a person's dish, quantity and note (creating an `admin` order if there was none), add an off-menu dish (a name matching a dish already on the day is that dish at its price; one with no price yet is refused, `"Phở bò" is already on the menu with no price yet. Set its price with Reprice, then record this meal`, because pricing it for one person would leave everybody else's lines of it unpriced), remove a meal (cancel), or reprice a dish for everybody. Re-bills the week, writes `order_corrections`, tells the member | `correct_meal`, `correct_meal_off_menu`, `remove_meal` (20261021100000), `reprice_dish` (20261022100000) |
| an admin's order ahead | the member, before the cutoff | the member can still change or cancel it on the Board; it keeps `source = admin` | `set_my_order`, `enforce_order_window` |
| `source = admin` | only an admin may write it; it is exempt from the clock, not from a cancelled menu or a settled week | | `guard_order_source`, `enforce_order_window` (20261003100100) |

### Passing a meal

| Step | Who | Until | Enforced by |
| --- | --- | --- | --- |
| offer | the person whose placed order it is, an admin included | the day is done | `enforce_transfer_rules` (20261022100100) |
| accept or decline | the recipient; accept only while the order is placed | same | `enforce_transfer_rules` (20261023100100) |
| withdraw | the person who offered | same | `enforce_transfer_rules` |
| record a pass | an admin, from anybody to anybody else, their own meal included; accepted at once, no answer needed | the week is settled; not on a cancelled day | `record_pass` (20261021100100) |
| accept, decline or withdraw on somebody's behalf | an admin, on a pending offer; accept and decline only while the order is placed, so an offer left on a cancelled order is withdrawn | same | `answer_pass` (20261023100100) |
| undo an accepted pass | an admin; the meal goes back on the giver's bill. Refused while the day is still open if the giver has left or was removed (`Tèo has left the office, so the meal cannot go back to them on 24/09`); past the cutoff it is allowed. The recipient leaving undoes it too, on an open day ([Leaving or being removed](#leaving-or-being-removed)) | same | `undo_pass` (20261024100000) |

A pass ends `accepted`, `declined`, `cancelled` (withdrawn) or `undone`.
`undone` means it happened and was reversed later, so the record can tell it
from one that never took effect; `undone_at` and `undone_by` say when and who,
and `decided_at` keeps the acceptance. Only `undo_pass` and the recipient
leaving write it.

**A pending pass ends with its meal.** When its order stops being placed, by
lunch being cancelled, the member cancelling it, an admin removing it or its
owner leaving the office, the pass is withdrawn in the same transaction:
`cancelled`, `decided_by` whoever cancelled the order, and a reason,
`withdrawn: lunch on 24/09 was cancelled`, `withdrawn: the meal was
cancelled`, or `withdrawn: the meal was cancelled when its owner left the
office` (`... was removed from the office`). Nobody is told, as for any withdrawal.
The recipient who answers it anyway is refused. Accepting says why: `lunch on
24/09 was cancelled`, `the lunch on 24/09 offered to you was cancelled, so
there is no meal to accept`, or, once the order is placed again, `the lunch on
24/09 was ordered again after this offer, so the offer no longer stands`.
Declining says `this transfer is already cancelled`. Ordering again does not
revive the pass; the member offers afresh (`orders_withdraw_pass`,
`private.withdraw_pending_pass`, 20261023100100).

The withdrawal skips a pass another transaction is answering at that moment
rather than wait for it; if that answer is an accept, it came first. If it
fails instead, the offer is left waiting on a cancelled order. There nobody can
accept it (`lunch on 24/09 was cancelled`, or `the lunch on 24/09 offered to
you was cancelled, so there is no meal to accept`); the recipient can decline
it, which tells the giver nothing, and the giver can withdraw it. The order
being placed again, by the member or an admin, withdraws it in the same
transaction, so it never reaches the new meal.

**An offer belongs to the placement it was made on.** `orders.placed_at` is
stamped each time an order is placed (its insert, and every move back to
`placed`) and is never changed otherwise, by anybody: a dish change, a note or
an admin's correction of a placed order leave it. Accepting a pass whose order
was placed after the offer is refused, on the table and in `answer_pass`:
`the lunch on 24/09 was ordered again after this offer, so the offer no longer
stands`. Declining and withdrawing it stay allowed. This covers the one case
the withdrawal can miss, an admin answering the offer at the moment the member
orders again (`stamp_order_placement`, `enforce_transfer_rules`, `answer_pass`,
20261023100100). The bot's `/order` lists only offers on placed orders that
were placed before the offer.

**An accepted pass is left alone** when its order is cancelled afterwards: it
happened, the recipient agreed to it, and the cancelled order bills nobody, so
nobody pays for it and nobody is told.

On the table, a browser (and the Telegram bot, which acts as the member) only
offers its own meal, answers an offer made to it, or withdraws its own. An
admin is no exception: their insert of a pass on somebody else's meal, and any
change to somebody else's pass, are refused (`42501`, naming the Orders
screen). The insert is always a pending offer whatever status it carries, its
`created_by` is the caller whatever the row says, and a pending pass moves only
to accepted, declined or cancelled (`enforce_transfer_rules`, 20261022100100).
So an admin passes somebody else's meal only through the three functions
below, which write the audit row and the messages.

One live (pending or accepted) pass per order, no chains, never to yourself
(`transfers_one_live_uk`, `transfers_not_self_ck`). `record_pass` says which
live pass is in the way: an offer to answer or withdraw first, or a pass to
undo first. Each admin pass write is one transaction: it re-bills the week,
writes an `order_corrections` row (`pass`, `pass_declined`, `pass_withdrawn`,
`pass_undone`, naming the pass) and tells both people. Once accepted, the
recipient pays. A pass is never deleted, by anybody; it ends by being declined,
withdrawn or undone (20261020100100). The Board holds admins to the member's window
([Passing a meal](screens.md#passing-a-meal)).

## Leaving or being removed

The owner's rule (2026-10-02): somebody going stops eating from the next day
nobody has told the caterer about, and no sooner.

| Rule | Enforced by |
| --- | --- |
| Leaving (Settings, or `/leave` to the bot), an admin's Remove, and the service role setting a membership inactive all cancel the person's open orders, in the same transaction | `memberships_leaving_cancels`, `private.cancel_leavers_open_orders` (20261024100000) |
| Open means the menu is published and its cutoff ahead, the window in which the person could cancel it themselves. A day past its cutoff (published or locked) and a past day keep the order placed and billed: the caterer may already have the count | `cancel_leavers_open_orders`, as `enforce_order_window` |
| A meal the person passed on, and somebody accepted, stays: it is the recipient's | same |
| A meal passed TO the person and accepted, on an open day, goes back to the giver, as `undo_pass` would leave it: the pass is `undone` (`undone_by` whoever made the person go, the person themselves when the service role did; reason `undone: the person it was passed to left the office`, or `... was removed from the office`, unless the pass carried one), the giver pays again, and the giver is told (`bill_correction`). If the giver has gone too, earlier or in the same statement, the meal is cancelled instead and the pass left `accepted`, billing nobody. Past the cutoff the person keeps it and its bill | `private.leaving_effects`, `private.cancel_leavers_open_orders` (20261025100000) |
| A pending offer TO the person, on a meal still placed, on any day outside a settled week, is declined (`decided_by` as above, reason `declined: the person it was offered to left the office`, or `... was removed from the office`). Nothing moves on the bill; the giver is told (`transfer_decided`). An offer left waiting on a meal already cancelled is neither listed nor declined: nobody can accept it, and the giver can withdraw it | same |
| None of this writes `order_corrections`: like the person's own cancellations, it is the system acting, and the pass row records it | same |
| The cancel is the ordinary one: `status = cancelled`, the dish line kept (the system's one dish included), the pending pass withdrawn, and the week re-billed at once, so a statement left with no lines is deleted and its credit is the person's again. A week nobody has billed gets no period; a settled week is never touched | same, `public.run_billing` |
| `leave_office` checks the membership and the sole-owner rule, then cancels, then refuses if anything is still owed. So a meal leaving takes off the bill does not stop anybody leaving; a meal past its cutoff still unpaid does, and the refusal rolls the cancellation back | `leave_office` (20261024100000) |
| `leave_office` answers on how many open days it took a lunch off the person (their own, or one passed to them), and the bot's reply names that many days, or none | `leave_office`, `renderLeftText` |
| Settings says what would still be owed after leaving, meals given back included, by doing it and rolling it back, for the caller in their own office only, once the Leave dialog opens | `my_balance_after_leaving` |
| An admin's Remove first lists what it would change, from the same rule, read-only and without a lock, for an admin of that office only: each meal cancelled, each meal given back or cancelled with its giver, each offer declined ([People](screens.md#people-admin)) | `removal_preview` (20261025100100) |
| Nothing places an order for somebody who is leaving or gone: their own order (on the Board, the bot or the table), an admin's record of a meal on a day they have none or had cancelled (`Tèo is no longer in this office, so no lunch can be recorded for them on 24/09`), a pass to them (`that person is not a member of this office`), and an undo putting an open day's meal back on them (`Tèo has left the office, so the meal cannot go back to them on 24/09`) are refused, and one in flight when they leave finishes first and is then cancelled with the rest. A meal they kept past its cutoff can still be put right, and a pass of one undone onto them | `private.hold_membership` in `set_my_order`, `correct_meal`, `correct_meal_off_menu`, `record_pass`, `answer_pass`, `undo_pass`; `orders_for_a_member` |
| Coming back (the join code, an invitation, an admin's Add back) revives nothing: cancelled orders, withdrawn and declined offers and undone passes stay as they are | `materialize_standing_orders` writes only into a slot with no row |
| The Board and Orders give a person who has gone a row, marked `(left)`, only for a week in which they still have a placed order, so every portion in a day's total has a name; on Orders that meal can be put right or removed | `fetchBoard` reads every membership ([Board](screens.md#board), [Orders](screens.md#orders-admin)) |

## Deleting an office

The owner's rule (2026-10-05): nothing reaches a caterer, or anybody, for an
office that is gone.

| Rule | Enforced by |
| --- | --- |
| Only an owner deletes an office, which sets `organizations.deleted_at`; every policy then hides it from everybody | `delete_office` (20261025100200), `private.my_org_ids` |
| Deleting cancels every placed order on a day not yet over (today before the office's end of day, and later), before or after the cutoff, published or locked. A day that is over and a settled week keep theirs | `delete_office` |
| Every pending pass in the office is withdrawn first, reason `withdrawn: the office was deleted`, `decided_by` the owner. Nobody is told | same |
| The weeks are re-billed, so every statement is still the sum of its lines and an office restored by hand opens on bills that match its orders | same, `public.run_billing` |
| Every message still waiting for the office is marked `failed` (`the office was deleted`); the outbox drain claims nothing for a deleted office; the hourly tick neither locks its menus, queues its messages nor closes its weeks; materializing orders nothing in it | `delete_office`, `claim_outbox`, `run_hourly_tick`, `materialize_office`, `materialize_open_menus`, `materialize_standing_orders` (20261025100200) |
| A member's order in flight finishes and is then cancelled, or waits and is refused | `delete_office` holds the days' menus `FOR NO KEY UPDATE` |
| Nothing in a deleted office is corrected afterwards: an admin's correction, pass, answer, undo or reprice in flight, even one past its admin check, waits for the deletion and is refused (`this office has been deleted, so nothing in it can be changed`) | `private.correction_period` holds the office row `FOR SHARE` (20261025100200) |
| Its join code and its invitations bring nobody in, refused as a code or a link that does not exist (`That join code is not valid.`, `That invitation link is not valid.`); the bot answers nothing for its chats and redeems no link into it | `private.join_office_with_code`, `accept_invitation` (20261025100200), `linksForChat`, `orgForJoinCode`, `onLinkToken` (`supabase/functions/telegram`) |

## Billing

| Order state | Charged | Enforced by |
| --- | --- | --- |
| placed, priced dish | the dish price copied when chosen, times quantity | `v_order_charges`, `run_billing` |
| placed, dish not priced yet | nothing yet; the week cannot settle | `v_order_charges.unpriced`, `hold_period_open_while_unpriced` |
| placed, no dish chosen | 0, but counted as a meal | `v_order_charges` (no lines sums to 0) |
| cancelled, or on a cancelled day | nothing | `run_billing` takes `placed` only |
| passed and accepted | the recipient | `v_order_charges.payer_profile_id` |

Billing lines are written only by `run_billing`: when the tick closes a week,
when an admin settles one, on every correction, when a pass is accepted,
declined or withdrawn by a person (`trg_transfer_rebills`, 20261023100200), and when lunch
is cancelled (`trg_menu_cancelled`, 20261023100200), and when somebody with an
open order leaves or is removed (20261024100000). A correction, a pass
answer and a cancel each take the office-week key before they look the week's
billing period up, so none misses a period another is creating at the same
moment. A member's own
order change reaches the bill at the next of those, and so does a pass
withdrawn with its meal, which changes nobody's charge. A settled week is never
recomputed, and money already matched to it stays there
(`private.reallocate`, 20261007090000).

Each re-bill recalculates every statement in the week from its lines, and
deletes one left with no lines. So when somebody's last meal of the week goes
(removed, passed on, cancelled, or its price taken away), that week stops
charging them and any credit it held is theirs again (20261020100000). A
waiver goes with its statement: a meal recorded in that week afterwards is
charged on a new statement that is not waived.

A placed order with no dish line bills at 0; a statement whose meals come to 0
is paid, takes none of the person's credit, and gets `paid_at` when it is
settled (kept on a re-bill). The weekly bill goes only to somebody whose
balance is above 0 (20261017200000).

## Notifications

| Message | Sent when | To | Switch |
| --- | --- | --- | --- |
| `menu_published` | first hourly tick after publish, while the cutoff is ahead; once per date | the group chat, and every active member with Telegram linked | `org_notifications`, default on |
| `cutoff_warning` | the first tick within 70 minutes (60 to 1440) of the cutoff | the group and every linked member, ordered or not | default on, 70 |
| `weekly_bill` | billing day, from 09:00 | a group summary; each member whose account is owed | default on, 09:00. Off stops the message, not the billing |
| `bill_correction` | every correction, and every pass an admin records, answers or undoes; a meal coming back to its giver because the recipient left | the order's owner and its payer; for a pass, both people; for a meal coming back, the giver | none |
| `dish_choice` | a one-dish menu gains a dish while open | each person whose system-written line it took back and who is still eating | none |
| `transfer_offer` | a member offers a meal | the recipient | none |
| `transfer_decided` | the recipient accepts or declines, or leaves with the offer waiting | the person who offered | none |
| `payment_ack`, `payment_unmatched` | money is credited; a transfer matches nobody | the payer; the office's admins | default on |

Sources: `run_hourly_tick` (20261009100000), `private.enqueue_correction`
(20261007100200), `trg_transfer_notifies` (20261009100200),
`private.cancel_leavers_open_orders` (20261025100000),
`trg_payment_apply` (20261013100200), `private.settle_undecided`
(20261018100000), `private.enqueue_pass` (20261021100100). Only members who
finished `/start` get a private message. Somebody who has left or been
removed still gets `weekly_bill` while they owe and `bill_correction` for a
meal they own or pay for; any other private message queued for them, and the
`bill_correction` asking them to cancel a meal given back, is marked `failed`
(`the recipient is no longer in the office`) and sent to nobody
(`claim_outbox`, `private.outbox_held_back`, 20261025100200). There is no message for cancelling
lunch, for a member withdrawing their own offer, for an offer withdrawn with
its meal, for anything a leaving or a deleted office cancels, or for a menu
changed after publishing, beyond `dish_choice`.

When somebody leaves, the giver of a meal that comes back reads `Tèo left the
office, so your lunch on 24/09 (Bún bò Huế, 50.000 ₫) is yours again and back
on your bill. Cancel it before 21:00 23/09 if you will not eat it.` and their
balance; the giver of a declined offer reads `Tèo left the office, so your
offer of lunch on 24/09 was declined. It is still yours and still on your
bill.` (`was removed from the office` for a removal; `private.leaver_pass_body`).

A correction's first line depends on the day. For the person who eats it, on a
day not yet over: `Nguyên ordered lunch for you on 02/10.` or `Nguyên
cancelled your lunch on 02/10.` Otherwise, and for every reprice: `Lunch on
02/10 was corrected by Nguyên.` A pass message says what the admin did from
where the reader stands, for example `Nguyên recorded that Dinh had your lunch
on 28/09 (Bún bò Huế, 50.000 ₫), so it is on Dinh's bill rather than yours.`
When an admin answers an offer, `transfer_decided` is not sent as well.

## Observed

Surprises in the code as it stands. None is fixed here.

1. Filling in a missing price on the dish alone leaves existing orders unpriced; nothing re-copies it (`enforce_menu_item_frozen`, 20260928100200; `snapshot_order_item` fires only on `menu_item_id`).
2. Repricing or renaming a dish on a published menu leaves earlier orders on the old price and name, so two people pay differently for one dish on one day, until the Settle week screen prices the week (`snapshot_order_item`; `publish_menu`, `apply_caterer_prices`, 20261017100000).
3. An admin can move the cutoff of a published menu, even after it passed and before the tick locks it, which reopens ordering; nothing guards `order_cutoff_at` (`menus_admin_all`, rls).
4. The order window is the cutoff alone. A cutoff after the office's start of day shows `Cooking` while orders are still accepted, and cancelling is refused from `Cooking` though the cutoff is ahead (`enforce_order_window` vs `private.day_stage`). On such a day a one-dish menu converts only the slots the system creates; `set_my_order` with no dish leaves a member's own slot undecided ([One-dish menus](#one-dish-menus)).
5. Since reopening was removed, `Cooking` enforces nothing that `Closed` does not; it is a label (`refuse_reopen`, 20261006100000).
6. `locked → cancelled` is a legal transition that the stage check always refuses (`enforce_menu_lifecycle`, 20261003100200).
7. An admin can write `source = admin` straight to the table and bypass the clock on any menu not cancelled, with no `order_corrections` row (`orders_admin_all` rls, `guard_order_source`).
8. "Eating, no dish chosen" on a menu of several dishes is billed as a 0 meal and counted in the weekly message's meal count (`v_order_charges`, `run_billing_inner`).
9. A dish chosen by somebody who later cancelled still cannot be removed; cancelling keeps the order's lines (`order_items_menu_item_fk`).
10. The database allows several dishes on one order; the Board and Orders always write one (`order_items_one_per_dish_uk` allows distinct dishes).
11. A member added back with a rule on gets no standing order for a menu already published; the Board still projects `Standing` there (`trg_standing_materialize` fires on rule writes only; `projectStandingDays` ignores menu status).
12. Every guard exempts `private.is_service()`, which is true inside any `SECURITY DEFINER` function owned by `postgres`; the corrections RPCs therefore check the settled week themselves (20261007100200 header).
13. The menu message is written once per date when first enqueued; later dish changes are never announced to the group, only to those a second dish puts back to undecided (`run_hourly_tick`, dedupe key per date).
14. A second dish added before the first hourly tick after publishing queues `dish_choice` to the people it puts back before `menu_published` reaches anybody, so their first message about the day asks them to choose (`private.settle_undecided`, `run_hourly_tick`).
15. A member's own cancel reaches the bill only at the next re-bill, so a week can hold a line for a meal its owner cancelled; `leave_office` reads that stale line as debt and refuses until something re-bills the week (`leave_office`, `orders_update_own`).
16. A member can still offer a meal, on the table, to somebody who has gone; nobody can accept it, and it waits until the giver withdraws it (`transfers_insert_own` checks the giver only).

## One-dish menus

An **undecided slot** is a placed order with no dish line: from a weekday rule,
a planned day (`force`), or a member eating without naming a dish. Only
`standing` and `member` orders count; an `admin` order is the admin's record.

| Rule | Enforced by |
| --- | --- |
| While the day is `open` and the menu has exactly one dish, every undecided slot is an order for that dish, its line marked `auto_assigned` | `private.settle_undecided`, `private.assign_only_dish` (20261018100000) |
| This is checked wherever the answer can change: a publish, a dish added or removed, and a slot created later (a rule turned on, a plan, `set_my_order` with no dish) | `publish_menu`, `trg_menu_items_count_changed`, `materialize_standing_orders`, `set_my_order` |
| When a one-dish menu gains a dish, every marked line on it is deleted and those orders are undecided again. Unmarked lines are untouched; a cancelled order loses its marked line and stays cancelled | `private.settle_undecided` |
| Each person put back who is still eating and has Telegram gets `dish_choice`, once per person per menu each time it happens | `private.settle_undecided` |
| A decision is cancelling, or any write by the member through `set_my_order`, the one dish or a note included: it writes a fresh, unmarked line, so a later second dish leaves it alone. An admin's correction writes an unmarked line too | `set_my_order`, `private.replace_order_line`, `guard_auto_assigned` |
| Offering a meal, or an admin recording a pass, is a decision too: the offer clears the mark, and a slot on offer while undecided gets the one dish unmarked. A second dish never takes back a line under a pending or accepted pass, and a declined or withdrawn pass leaves the line unmarked | `trg_transfer_decides`, `private.assign_only_dish` |
| Only the system writes the mark. A person's own insert or update of a line clears it | `guard_auto_assigned`; no browser UPDATE on the column |
| While the day is open, a dish whose only lines are marked can be removed: the lines go first, and the dishes left decide whether those orders get the new one dish or a `dish_choice` | `trg_menu_items_hold_menu` |
| A slot the system creates gets the one dish, marked, whatever the stage: a new day's standing slots at publish, and a slot made later by a rule turned on or a plan. Slots are created only before the cutoff, so this matters on a day whose cutoff is after the office's start of day | `publish_menu`, `materialize_standing_orders`, `private.assign_new_slots` (20261023100000) |
| Nothing else converts or reverts outside stage `open`, and nothing does on a day in a settled week. A rename or reprice is not a new dish | `private.settle_undecided` |
| A marked line is priced and billed like any other: the dish's price at conversion | `snapshot_order_item`, `v_order_charges` |

The menu message for a one-dish menu adds a line before the cutoff,
`Standing orders are down for <dish>.`, only when the orders bear it out: the
day is today or later, and every placed standing order on it has a dish line
(`private.menu_message`, 20261023100000). A past day has no standing orders.
A menu published with two dishes while `Cooking` and cut to one keeps its
standing slots undecided, so its message leaves the line out. `dish_choice`
is plain text:

```text
The menu for 14/10 now has 2 dishes. Choose yours before 21:00 13/10.
```
