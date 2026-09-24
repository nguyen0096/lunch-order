/**
 * The corrections screen's rules and its words, kept away from the JSX.
 *
 * Everything here is arithmetic about money that has not moved yet. It is a
 * preview and it says so: the database is what writes, and the balance it
 * hands back afterwards is the only figure this screen may state as fact.
 */
import type { CorrectionEntry, CorrectionsPeriod, RecordedMeal } from "../../api.js";
import { addDays, isoWeekday, zonedTimeToInstant } from "../../../shared/dates.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import type { Org } from "../../../shared/types.js";
import { arrivedLabel, weekLabel } from "../payments/labels.js";

/**
 * Where the screen opens: the most recent working day that is over.
 *
 * Not today. The job is finalising a day the office has already eaten, and on
 * a Wednesday morning that day is Tuesday. Today counts only once the office's
 * day has ended, and weekends are stepped over the way every other screen
 * steps over them; a Saturday that was worked is still reachable through the
 * week strip.
 */
export function lastFinishedDay(args: {
  today: string;
  now: Date;
  org: Pick<Org, "timezone" | "businessDayEndsAt">;
}): string {
  const { today, now, org } = args;
  const over = (day: string) =>
    zonedTimeToInstant(day, org.businessDayEndsAt, org.timezone).getTime() <= now.getTime();

  let day = over(today) ? today : addDays(today, -1);
  while (isoWeekday(day) > 5) day = addDays(day, -1);
  return day;
}

/**
 * What an unavailable control says, since the notice above it carries the rest.
 *
 * The full sentence names the week and the day it closed, which is worth
 * reading once and is noise repeated on seven controls.
 */
export const SETTLED_REASON = "That week has been settled";

/**
 * Why this week takes no corrections, or null while it still does.
 *
 * A settled week is billed and paid against, so the answer is the week's name
 * and the day it closed rather than a disabled control with nothing behind it.
 */
export function settledNotice(
  period: CorrectionsPeriod | null,
  timeZone: string,
): string | null {
  if (period === null || period.status !== "closed") return null;
  const week = weekLabel(period.periodStart, period.periodEnd);
  const when =
    period.closedAt === null
      ? "has been settled"
      : `was settled on ${arrivedLabel(period.closedAt, timeZone)}`;
  return `${week} ${when}. A settled week is already billed and paid against, so nothing on it can be corrected here.`;
}

/** Where somebody's account stands, in the Bill screen's own vocabulary. */
export function balanceNow(balanceMinor: number, c: Currency): string {
  if (balanceMinor > 0) return `owes ${formatMoney(balanceMinor, c)}`;
  if (balanceMinor < 0) return `has ${formatMoney(-balanceMinor, c)} in credit`;
  return "owes nothing";
}

function balanceWouldBe(balanceMinor: number, c: Currency): string {
  if (balanceMinor > 0) return `would owe ${formatMoney(balanceMinor, c)}`;
  if (balanceMinor < 0) return `would be ${formatMoney(-balanceMinor, c)} in credit`;
  return "would owe nothing";
}

/** `Tèo owes 135.000 ₫ now, and would owe 185.000 ₫.` */
function accountLine(name: string, balanceMinor: number, deltaMinor: number, c: Currency): string {
  return `${name} ${balanceNow(balanceMinor, c)} now, and ${balanceWouldBe(
    balanceMinor + deltaMinor,
    c,
  )}.`;
}

/**
 * What saving this would do to one person's money, in figures.
 *
 * Written as "would" throughout, because none of it has happened. What the
 * person is charged is decided by the database, and the balance it returns
 * afterwards is what the screen then reports.
 */
export function mealPreview(a: {
  name: string;
  /** What the recorded meal bills now. Null when it has no price yet. */
  beforeMinor: number | null;
  /** False when there is nothing recorded for this person on this day. */
  hadMeal: boolean;
  /** What the chosen dish would bill. Null when it carries no price yet. */
  afterMinor: number | null;
  balanceMinor: number;
  currency: Currency;
}): string {
  const { name, beforeMinor, hadMeal, afterMinor, balanceMinor, currency: c } = a;

  if (afterMinor === null) {
    return `That dish has no price yet, so this records the meal and puts nothing on ${name}'s bill until a price arrives. ${name} ${balanceNow(
      balanceMinor,
      c,
    )}.`;
  }

  const before = hadMeal ? beforeMinor : 0;
  if (before === null) {
    return `The meal recorded now has no price, so all ${formatMoney(
      afterMinor,
      c,
    )} of this is new on ${name}'s bill. ${accountLine(name, balanceMinor, afterMinor, c)}`;
  }

  const delta = afterMinor - before;
  if (delta === 0) {
    return `This changes what the day records and moves no money: both come to ${formatMoney(
      afterMinor,
      c,
    )}. ${name} ${balanceNow(balanceMinor, c)}.`;
  }

  const direction =
    delta > 0
      ? `put ${formatMoney(delta, c)} on ${name}'s bill`
      : `take ${formatMoney(-delta, c)} off ${name}'s bill`;
  const fromTo = hadMeal
    ? `, from ${formatMoney(before, c)} to ${formatMoney(afterMinor, c)}`
    : "";
  return `This would ${direction}${fromTo}. ${accountLine(name, balanceMinor, delta, c)}`;
}

/** What taking this meal off the record would do to that person's money. */
export function removalPreview(a: {
  name: string;
  meal: RecordedMeal;
  balanceMinor: number;
  currency: Currency;
}): string {
  const { name, meal, balanceMinor, currency: c } = a;
  if (meal.amountMinor === null || meal.amountMinor === 0) {
    return `This meal bills nothing, so taking it off the record moves no money. ${name} ${balanceNow(
      balanceMinor,
      c,
    )}.`;
  }
  return `This would take ${formatMoney(
    meal.amountMinor,
    c,
  )} off ${name}'s bill. ${accountLine(name, balanceMinor, -meal.amountMinor, c)}`;
}

/**
 * Everybody a price change on one dish would reach, and the money in both
 * directions.
 *
 * Both directions, separately, because the portions on a dish are not all
 * priced alike: some were snapshotted before a price arrived, some at a price
 * that has since changed, and one person may have had two. A single net figure
 * would hide a week where half the office is charged more and half less.
 */
export type RepriceImpact = {
  people: number;
  portions: number;
  /** Portions carrying no price at all, which take the whole of the new one. */
  waitingPortions: number;
  /** Total going onto bills, as a positive figure. */
  ontoMinor: number;
  /** Total coming off bills, as a positive figure. */
  offMinor: number;
};

export function repriceImpact(args: {
  meals: RecordedMeal[];
  menuItemId: number;
  priceMinor: number;
}): RepriceImpact {
  const affected = args.meals.filter((m) => m.menuItemId === args.menuItemId);
  let portions = 0;
  let waitingPortions = 0;
  let ontoMinor = 0;
  let offMinor = 0;

  for (const meal of affected) {
    portions += meal.quantity;
    // A portion with no price is not a portion priced at zero anywhere else in
    // this app. In a delta it genuinely is nothing yet, so it takes the whole
    // new price -- and it is counted so the confirmation can say so.
    if (meal.unitPriceMinor === null) waitingPortions += meal.quantity;
    const before = (meal.unitPriceMinor ?? 0) * meal.quantity;
    const after = args.priceMinor * meal.quantity;
    if (after > before) ontoMinor += after - before;
    else offMinor += before - after;
  }

  return { people: affected.length, portions, waitingPortions, ontoMinor, offMinor };
}

/** The word a history entry carries, so a reprice is not read as a person's meal. */
export function kindWord(kind: CorrectionEntry["kind"]): string {
  switch (kind) {
    case "meal":
      return "Meal";
    case "off_menu":
      return "Off the menu";
    case "removal":
      return "Removed";
    case "reprice":
      return "Price";
  }
}

export function portions(n: number): string {
  return `${n} ${n === 1 ? "portion" : "portions"}`;
}

export function peopleWord(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}
