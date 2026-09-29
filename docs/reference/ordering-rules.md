# Ordering rules

How lunch ordering behaves today, as the database enforces it. Each rule names
the function, trigger or policy that holds it; the migration is the newest one
that defines it, under `supabase/migrations/`. What the screens show is in
[Screens](screens.md); why each rule exists is in [Decisions](../decisions.md).

Every date and clock time is in the office's own zone, `organizations.timezone`
(`Asia/Ho_Chi_Minh` by default). "Admin" means admin or owner throughout.

| Term | Means here |
| --- | --- |
| menu status | what an admin sets: `draft`, `published`, `locked`, `cancelled` |
| day stage | what the clock derives from the status: see [Day stages](#day-stages) |
| cutoff | `menus.order_cutoff_at`, one instant per menu. The Menu screen defaults it to the evening before at the office's default time, 21:00 |
| slot | one person on one menu. There is at most one order row per slot, cancelled included |
| standing rule | a member's weekdays (`standing_orders`); an exception (`skip` or `force`) overrides it for one date |
| settled week | a billing week whose period is `closed`. Nothing on it changes any more |

## Day stages

`private.day_stage` (20261001100000) derives the stage on every read; the Board
mirrors it in `dayStage` (`src/shared/gating.ts`). The word in brackets is what
the screens show.

| Stage | When | A member can | An admin can | Enforced by |
| --- | --- | --- | --- | --- |
| no menu (`No menu`) | no menu row for the date | skip or plan a date after today | create a menu for any date, a past one included | `set_standing_exception`, `enforce_menu_not_in_past` (20260930100000) |
| draft (`Draft`) | saved, not published; members cannot see it | skip or plan a date after today | edit dishes, publish, cancel | `menus_select` policy (rls) |
| open | published, before the cutoff | order, change, cancel, pass a meal | the same on the Board; edit dishes; cancel lunch | `enforce_order_window` (20261003100100) |
| locked (`Closed`) | the cutoff passed | offer, accept, decline, withdraw a pass | correct the record; fill in a missing price | `enforce_order_window`, `enforce_menu_item_frozen` (20260928100200) |
| closed (`Cooking`) | the office's start of day, `business_day_starts_at` (08:30) | the same as locked | the same as locked | `private.day_stage` |
| done (`Served`) | the office's end of day, `business_day_ends_at` (17:30) | nothing | correct the record; record a pass | `enforce_transfer_rules` (20261001100000) |
| cancelled (`Cancelled`) | lunch was called off | nothing | nothing, in principle (see [Observed](#observed)) | `enforce_order_window`, `enforce_menu_lifecycle` |

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
| draft → published | at least one available dish | standing slots become orders, if the date is today or later and the cutoff is ahead; the menu message on the next hourly tick | `enforce_menu_lifecycle` (20261003100200), `trg_menu_published_materialize` (20260930100000), `run_hourly_tick` (20261009100000) |
| published → locked | the first hourly tick after the cutoff | nothing else | `run_hourly_tick` |
| draft or published → cancelled | stage is draft or open | every placed order on the menu is cancelled | `enforce_menu_lifecycle`, `trg_menu_cancelled` (20261003100200) |
| published → draft | no order row exists | nothing; no screen offers it | `enforce_menu_lifecycle` |
| locked → published | never | | `refuse_reopen` (20261006100000) |
| locked → cancelled | never in practice: the stage check refuses it | | `enforce_menu_lifecycle` |
| cancelled → anything | never | | `enforce_menu_lifecycle` |

- **Republishing** a published menu is an edit in place. It changes no status,
  so it materializes nothing and sends no new message (`publishMenu`,
  `src/web/api/menu.ts`).
- **The service date** changes only on a draft, and never into the past
  (`enforce_menu_lifecycle`, `enforce_menu_not_in_past`).
- **A past day** can be created and published by an admin. Publishing it
  materializes no standing orders: the admin records who ate
  (`trg_menu_published_materialize`, 20260930100000).
- **Cancelling lunch** cancels the orders, which takes them out of billing.
  Exceptions stay. Nothing is sent to Telegram, and a menu message already
  sent is not withdrawn.

## Menu contents

| Change | draft, published | locked | cancelled | Enforced by |
| --- | --- | --- | --- | --- |
| add a dish | yes | no; an off-menu dish only through Corrections | no | `enforce_menu_item_frozen` (20260928100200), `correct_meal_off_menu` |
| rename or reprice | yes. Orders already placed keep the name and price they took | fill in a missing price only; other repricing through Corrections | no | `enforce_menu_item_frozen`, `snapshot_order_item` (orders), `reprice_dish` |
| leave the price empty | yes; orders for it are held out of billing until priced | | | `v_order_charges.unpriced` (20260928100000) |
| make unavailable | yes. No new order can pick it; orders that have it keep it | no | no | `snapshot_order_item` checks availability on insert only |
| remove | only if no order line names it, in any order status | no | no | `order_items_menu_item_fk` ON DELETE RESTRICT (orders) |

Dish names are unique per menu, ignoring case and outer spaces
(`menu_items_name_uk`). No database rule depends on how many dishes a menu has,
beyond needing one available dish to publish. The Board does: with one dish,
`+` orders it outright; with several, `+` opens the chooser and the dice picks
one ([Ordering](screens.md#ordering)).

## Standing days

| Rule | Enforced by |
| --- | --- |
| A member sets their own weekdays, on or off (`is_enabled`); an admin can set anybody's | `standing_orders_own`, `standing_orders_admin` policies (rls) |
| A member skips a rule day or plans (`force`) a day off the rule, only for a date after today, whose menu is absent or a draft, on which they have no order row. Only their own. Undoing removes the exception | `set_standing_exception` (20261016100000) |
| Nobody writes exceptions directly, admins included | revoke in 20261016100000 |
| Exceptions survive changes to the weekday rule | `set_standing_exception` never deletes them |
| At publish, each active member whose rule covers the weekday and has no skip, plus each active member with a force, gets an order: `source = standing`, no dish | `materialize_standing_orders` (20260911100500) |
| Turning a weekday on, or writing an exception, re-runs that for every published menu still before its cutoff | `trg_standing_materialize` |
| Nothing is materialized after the cutoff, for a past date, or into a slot that already has a row. A slot the member cancelled stays cancelled | `materialize_standing_orders`, `orders_menu_profile_uk` |
| Turning a weekday off cancels nothing already created | no trigger on turning off |
| A member who left or was removed keeps their rule but gets no new standing orders; orders already created stay | `m.status = 'active'` in `materialize_standing_orders` |

On the Board, a day after today with no order row of mine shows `Standing` or
`Planned` when the rule and exceptions predict an order, and bare `+` or
`Skipped` otherwise (`projectStandingDays`, `src/shared/projection.ts`). It is
tappable only while the menu is absent or a draft
([Skipping and planning](screens.md#skipping-and-planning-a-day-ahead)).

## Orders

| Action | Who, when | Result | Enforced by |
| --- | --- | --- | --- |
| order | a member for themselves, on a published menu before the cutoff | `source = member`. The Board writes `member` for admins too | `orders_insert_own` (rls), `enforce_order_window` |
| choose or change the dish | same window | the Board deletes the order's dish lines and writes one; name and price are copied from the dish then | `setOrder` (`src/web/api/board.ts`), `snapshot_order_item` |
| quantity | same window | 1 to 20 per dish; the Board always writes 1 | `order_items.quantity` check |
| note | same window | 1 to 120 characters, on the dish line, so an order with no dish has none | 20260926100000 |
| eating, no dish chosen | from a standing slot or an admin | an order with no dish line. The Board never creates one | `materialize_standing_orders` |
| cancel (not eating) | same window, own order | `status = cancelled`; the row keeps the slot. Ordering again revives it. No member delete | `orders_update_own` (rls), `enforce_order_window` |
| after the cutoff | nobody on the Board, admins included | refused with the cutoff in the sentence | `enforce_order_window` |
| correct a day | an admin, on any day with a menu, until the week is settled | set a person's dish, quantity and note (creating an `admin` order if there was none), add an off-menu dish, remove a meal (cancel), or reprice a dish for everybody. Re-bills the week, writes `order_corrections`, tells the member | `correct_meal`, `correct_meal_off_menu`, `remove_meal`, `reprice_dish` (20261007100200) |
| `source = admin` | only an admin may write it; it is exempt from the clock, not from a cancelled menu or a settled week | | `guard_order_source`, `enforce_order_window` (20261003100100) |

### Passing a meal

| Step | Who | Until | Enforced by |
| --- | --- | --- | --- |
| offer | the person whose placed order it is | a member: the day is done. An admin: the week is settled | `enforce_transfer_rules` (20261001100000) |
| accept or decline | the recipient | same | `enforce_transfer_rules` |
| withdraw | the person who offered | same | `enforce_transfer_rules` |
| record a pass between two others | an admin; it is accepted at once | the week is settled | `enforce_transfer_rules` |

One live (pending or accepted) pass per order, no chains, never to yourself
(`transfers_one_live_uk`, `transfers_not_self_ck`). Once accepted, the
recipient pays. The Board holds admins to the member's window
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
when an admin settles one, on every correction, and when a pass is accepted,
declined or withdrawn (`trg_transfer_rebills`, 20261004100000). A member's own
order change reaches the bill at the next of those. A settled week is never
recomputed, and money already matched to it stays there
(`private.reallocate`, 20261007090000).

## Notifications

| Message | Sent when | To | Switch |
| --- | --- | --- | --- |
| `menu_published` | first hourly tick after publish, while the cutoff is ahead; once per date | the group chat, and every active member with Telegram linked | `org_notifications`, default on |
| `cutoff_warning` | the first tick within 70 minutes (60 to 1440) of the cutoff | the group and every linked member, ordered or not | default on, 70 |
| `weekly_bill` | billing day, from 09:00 | a group summary; each member whose account is owed | default on, 09:00. Off stops the message, not the billing |
| `bill_correction` | every correction | the order's owner and its payer | none |
| `transfer_offer` | a member offers a meal | the recipient | none |
| `transfer_decided` | the recipient accepts or declines | the person who offered | none |
| `payment_ack`, `payment_unmatched` | money is credited; a transfer matches nobody | the payer; the office's admins | default on |

Sources: `run_hourly_tick` (20261009100000), `private.enqueue_correction`
(20261007100200), `trg_transfer_notifies` (20261009100200),
`trg_payment_apply` (20261013100200). Only members who finished `/start` get a
private message. There is no message for cancelling lunch, for a withdrawn
pass, for a pass an admin recorded, or for a menu changed after publishing.

## Observed

Surprises in the code as it stands. None is fixed here.

1. The Settle week screen's price step re-copies prices onto order lines as an admin browser, which `enforce_order_window` refuses on a locked menu for `member` and `standing` orders; only `reprice_dish` reaches them (`applyCatererPrices`, `src/web/api/billing.ts:1233`).
2. Filling in a missing price on the dish alone leaves existing orders unpriced; nothing re-copies it (`enforce_menu_item_frozen`, 20260928100200; `snapshot_order_item` fires only on `menu_item_id`).
3. Repricing or renaming a dish on a published menu leaves earlier orders on the old price and name, so two people pay differently for one dish on one day (`snapshot_order_item`; `reconcileDishes`, `src/web/api/menu.ts:112`).
4. An admin can move the cutoff of a published menu, even after it passed and before the tick locks it, which reopens ordering; nothing guards `order_cutoff_at` (`menus_admin_all`, rls).
5. The order window is the cutoff alone. A cutoff after the office's start of day shows `Cooking` while orders are still accepted, and cancelling is refused from `Cooking` though the cutoff is ahead (`enforce_order_window` vs `private.day_stage`).
6. Since reopening was removed, `Cooking` enforces nothing that `Closed` does not; it is a label (`refuse_reopen`, 20261006100000).
7. `locked → cancelled` is a legal transition that the stage check always refuses (`enforce_menu_lifecycle`, 20261003100200).
8. `published → draft` is still accepted by the database when no order exists, although decisions.md says un-publishing was removed (`enforce_menu_lifecycle`).
9. Corrections check only the week, not the day's stage or status: an admin can correct an open or future day, and `correct_meal` on a cancelled day revives the order and bills it, so a cancelled menu's orders do leave `cancelled` (`private.replace_order_line`, `private.correction_period`).
10. An admin can write `source = admin` straight to the table and bypass the clock on any non-cancelled menu, draft included, with no `order_corrections` row (`orders_admin_all` rls, `guard_order_source`).
11. "Eating, no dish chosen" is billed as a 0 meal and counted in the weekly message's meal count (`v_order_charges`, `run_billing_inner`).
12. A dish chosen by somebody who later cancelled still cannot be removed; cancelling keeps the order's lines (`order_items_menu_item_fk`).
13. Making a dish unavailable does not touch the orders that already have it (`snapshot_order_item`, insert only).
14. The database allows several dishes on one order; the Board and Corrections always write one (`order_items_one_per_dish_uk` allows distinct dishes).
15. A member can cancel an order while a pass on it is pending or accepted; the recipient is not told and pays nothing (`enforce_transfer_rules` checks order status on offer only).
16. Leaving or being removed keeps already-created future orders placed and billed (`leave_office`, 20261002100000; no trigger on memberships).
17. A member added back with a rule on gets no standing order for a menu already published; the Board still projects `Standing` there (`trg_standing_materialize` fires on rule writes only; `projectStandingDays` ignores menu status).
18. Every guard exempts `private.is_service()`, which is true inside any `SECURITY DEFINER` function owned by `postgres`; the corrections RPCs therefore check the settled week themselves (20261007100200 header).
19. The menu message is written once per date when first enqueued; later dish changes are never announced (`run_hourly_tick`, dedupe key per date).

## Proposed: one-dish menus (not built)

**The owner's rule, as proposed:**

- A standing slot the member has not decided on is **undecided**. When the menu
  has exactly one available dish, every undecided standing slot (from the
  weekday rule or a force exception) becomes an order for that dish, marked
  **auto-assigned**.
- Conversion happens at publish with one dish, and when the menu drops from
  several dishes to one (a dish can only be removed if nobody ordered it).
- When a one-dish menu gains dishes, every auto-assigned order goes back to
  undecided, so everybody chooses again. Decided orders are untouched.
- A **decision** is cancelling (not eating), or any member write to their own
  order: choosing a dish, the single dish explicitly included, or a note. Only
  the system sets the auto-assigned mark.
- Only while the day is open for ordering. After the cutoff nothing converts or
  reverts automatically.
- The Telegram menu message for a one-dish menu says standing members are down
  for it. There is no "menu updated" message today.

**How it meets the rules above:**

| Rule today | Interaction |
| --- | --- |
| Materialization at publish and on rule changes | Both become conversion points: a slot created while the menu has one dish is created with it |
| Dish count has no database meaning | It gains one: the count of available dishes drives conversion and reversion |
| Unavailable and removed dishes | Removal only happens with no orders, so it cannot strand an auto-assigned order; unavailability can (Observed 13) |
| Price copied at choice | An auto-assigned order copies the price at conversion; a later price change follows Observed 2 and 3 |
| Cancelled slots hold their row | A cancelled slot is a decision and never converts |
| Stages | Conversion and reversion only at stage `open`; locked onward, as today |
| Billing | Fewer 0 meals (Observed 11): converted slots are billed at the dish price |
| Notifications | The menu message gains a line; any reversion message is a new kind |

**Open questions, with a recommendation each:**

1. Is explicitly confirming the single dish a decision? Recommend yes, as the rule says: it is a member write, and it keeps that member's order when dishes are added.
2. What tells auto-assigned members to choose again after a dish is added? Recommend a new per-person kind, sent only to those reverted, not switchable, like `bill_correction`.
3. Does making a dish unavailable count toward "down to one dish"? Recommend yes: count available dishes; orders already on the unavailable dish keep it.
4. Convert and revert only at stage `open`? Recommend yes; after the cutoff the count has gone to the caterer.
5. Do `member` orders with no dish convert too? Recommend yes: they are equally undecided, though the Board never makes one today.
6. Does a slot materialized after publish on a one-dish menu (a rule turned on later) convert? Recommend yes, so the outcome does not depend on timing.
7. Removing a dish somebody ordered needs an admin screen that moves or cancels those orders first. Recommend a backlog entry; out of scope here.
