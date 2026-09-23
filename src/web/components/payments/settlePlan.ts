/**
 * Turn a reconciled message into the exact writes it would make.
 *
 * Pure, and separate from the screen, because this is the sentence the
 * confirmation has to be able to say: how many dishes, how many menu rows, how
 * many portions already eaten, and what the week would then bill. A
 * confirmation that says "apply prices?" and nothing else is not a
 * confirmation.
 */

import type { PriceApplication, SettlementDish, SettlementWeek } from "../../api.js";
import type { Reconciliation } from "../../../shared/settlement.js";

/** A price the caterer names that the board has already settled differently. */
export type Contradiction = {
  name: string;
  /** What the caterer's message says. */
  theirMinor: number;
  /** What the board already charges, and will go on charging. */
  boardMinor: number[];
  /** Portions of this dish that are still waiting and can take the new price. */
  waitingCount: number;
};

export type SettlePlan = {
  /** Exactly what `applyCatererPrices` will be handed. */
  prices: PriceApplication[];
  /** Menu rows the prices are written to. */
  menuItems: number;
  /** Portions still waiting on a price that these writes reach. */
  portions: number;
  /** What the week bills for food once these prices land. */
  totalMinor: number;
  /**
   * Dishes the caterer prices differently from the board.
   *
   * The late-price exemption covers a price going from NULL to a value and
   * nothing more, so a dish already carrying a price cannot be re-priced on a
   * locked menu. That is not a technicality to swallow: the caterer quoting
   * 50.000 for something the office already agreed at 45.000 is a
   * disagreement about money, and it has to be said rather than silently
   * skipped or silently attempted.
   */
  contradicted: Contradiction[];
  /** Dishes the caterer named that were on no menu this week. */
  unknown: string[];
  /** Dishes already carrying exactly this price, so the write would change nothing. */
  unchanged: string[];
  /** Dishes whose week includes a cancelled day, which takes no price at all. */
  cancelled: string[];
};

export function planApply(reconciled: Reconciliation, week: SettlementWeek): SettlePlan {
  const byKey = new Map<string, SettlementDish>(week.dishes.map((d) => [d.key, d]));

  const prices: PriceApplication[] = [];
  const contradicted: Contradiction[] = [];
  const unknown: string[] = [];
  const unchanged: string[] = [];
  const cancelled: string[] = [];
  let menuItems = 0;
  let portions = 0;

  // Everything the week already bills, mentioned in the message or not. These
  // are snapshots on the orders themselves and nothing here moves them.
  let totalMinor = week.dishes.reduce((n, d) => n + d.pricedTotalMinor, 0);

  for (const dish of reconciled.dishes) {
    if (dish.priceMinor === null) continue;

    const served = byKey.get(dish.key);
    if (served === undefined) {
      unknown.push(dish.name);
      continue;
    }

    if (dish.contradictsMinor.length > 0) {
      contradicted.push({
        name: served.name,
        theirMinor: dish.priceMinor,
        boardMinor: dish.contradictsMinor,
        waitingCount: served.waitingCount,
      });
    }
    if (served.cancelledDays.length > 0) cancelled.push(served.name);

    if (served.unpricedMenuItemIds.length === 0) {
      // Nothing to write: either every row already carries this exact price,
      // or every row carries a different one. The second case is already in
      // `contradicted`, so it is reported rather than lost.
      if (dish.contradictsMinor.length === 0) unchanged.push(served.name);
      continue;
    }

    // Our count, not theirs: their count is what the admin checks, and what
    // the office is billed for is what the board recorded. And only the
    // portions still waiting -- the rest are snapshotted and stay as they are.
    totalMinor += dish.priceMinor * served.waitingCount;

    prices.push({
      name: served.name,
      priceMinor: dish.priceMinor,
      menuItemIds: served.unpricedMenuItemIds,
    });
    menuItems += served.unpricedMenuItemIds.length;
    portions += served.waitingCount;
  }

  return { prices, menuItems, portions, totalMinor, contradicted, unknown, unchanged, cancelled };
}
