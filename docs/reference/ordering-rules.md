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
| A member who left or was removed keeps their rule but gets no new standing orders; orders already created stay | `m.status = 'active'` in `materialize_standing_orders` |

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
| undo an accepted pass | an admin; the meal goes back on the giver's bill | same | `undo_pass` |

A pass ends `accepted`, `declined`, `cancelled` (withdrawn) or `undone`.
`undone` means it happened and was reversed later, so the record can tell it
from one that never took effect; `undone_at` and `undone_by` say when and who,
and `decided_at` keeps the acceptance. Only `undo_pass` writes it.

**A pending pass ends with its meal.** When its order stops being placed, by
lunch being cancelled, the member cancelling it or an admin removing it, the
pass is withdrawn in the same transaction: `cancelled`, `decided_by` whoever
cancelled the order, and a reason, `withdrawn: lunch on 24/09 was cancelled`
or `withdrawn: the meal was cancelled`. Nobody is told, as for any withdrawal.
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
is cancelled (`trg_menu_cancelled`, 20261023100200). A correction, a pass
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
| `bill_correction` | every correction, and every pass an admin records, answers or undoes | the order's owner and its payer; for a pass, both people | none |
| `dish_choice` | a one-dish menu gains a dish while open | each person whose system-written line it took back and who is still eating | none |
| `transfer_offer` | a member offers a meal | the recipient | none |
| `transfer_decided` | the recipient accepts or declines | the person who offered | none |
| `payment_ack`, `payment_unmatched` | money is credited; a transfer matches nobody | the payer; the office's admins | default on |

Sources: `run_hourly_tick` (20261009100000), `private.enqueue_correction`
(20261007100200), `trg_transfer_notifies` (20261009100200),
`trg_payment_apply` (20261013100200), `private.settle_undecided`
(20261018100000), `private.enqueue_pass` (20261021100100). Only members who
finished `/start` get a private message. There is no message for cancelling
lunch, for a member withdrawing their own offer, for an offer withdrawn with
its meal, or for a menu changed after publishing, beyond `dish_choice`.

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
11. Leaving or being removed keeps already-created future orders placed and billed (`leave_office`, 20261002100000; no trigger on memberships).
12. A member added back with a rule on gets no standing order for a menu already published; the Board still projects `Standing` there (`trg_standing_materialize` fires on rule writes only; `projectStandingDays` ignores menu status).
13. Every guard exempts `private.is_service()`, which is true inside any `SECURITY DEFINER` function owned by `postgres`; the corrections RPCs therefore check the settled week themselves (20261007100200 header).
14. The menu message is written once per date when first enqueued; later dish changes are never announced to the group, only to those a second dish puts back to undecided (`run_hourly_tick`, dedupe key per date).
15. A second dish added before the first hourly tick after publishing queues `dish_choice` to the people it puts back before `menu_published` reaches anybody, so their first message about the day asks them to choose (`private.settle_undecided`, `run_hourly_tick`).

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
