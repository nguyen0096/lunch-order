/**
 * The Orders screen's rules and its words, kept away from the JSX.
 *
 * Much of this is arithmetic about money that has not moved yet. It is a
 * preview and it says so: the database is what writes, and the balance it
 * hands back afterwards is the only figure the screen states as fact.
 */
import type {
  BoardDay,
  CorrectionEntry,
  OrdersPeriod,
  PassRecord,
  RecordedMeal,
} from "../../api.js";
import { addDays, isoWeekday, zonedTimeToInstant } from "../../../shared/dates.js";
import { dayStage, type DayStage } from "../../../shared/gating.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import type { Org } from "../../../shared/types.js";
import { cutoffLabel } from "../boardModel.js";

type Clock = Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;

/** `Thu 1 Oct`, the way the design writes a day inside a sentence. */
export function dayWords(serviceDate: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${serviceDate}T00:00:00Z`));
}

/** `30/09 14:05`, an instant in the office's zone. */
export function instantWords(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * The most recent working day that is over: where the panel opens, because
 * that is usually the day being checked. Today counts once the office's day
 * has ended; weekends are stepped over.
 */
export function lastFinishedDay(args: { today: string; now: Date; org: Clock }): string {
  const { today, now, org } = args;
  const over = (day: string) =>
    zonedTimeToInstant(day, org.businessDayEndsAt, org.timezone).getTime() <= now.getTime();

  let day = over(today) ? today : addDays(today, -1);
  while (isoWeekday(day) > 5) day = addDays(day, -1);
  return day;
}

/** The day's stage, as the Board and the database derive it. */
export function stageOf(day: BoardDay, org: Clock, now: Date): DayStage {
  return dayStage({
    serviceDate: day.serviceDate,
    status: day.status,
    orderCutoffAt: day.orderCutoffAt,
    org,
    now,
  });
}

/**
 * What an admin may do with a day's cells.
 *
 * `write` days carry the cutoff warning when the caterer may already have the
 * count. `inert` days give the reason on tap; `toMenu` says the fix is on the
 * Menu screen. `read` is a settled week, whose cells only open to be read.
 */
export type DayAccess =
  | { mode: "write"; warning: { heading: string } | null }
  | { mode: "inert"; reason: string; toMenu: boolean }
  | { mode: "read" };

export function dayAccess(args: {
  day: BoardDay;
  org: Clock;
  now: Date;
  settled: boolean;
}): DayAccess {
  const { day, org, now, settled } = args;
  const stage = stageOf(day, org, now);
  if (stage === "no_menu") {
    return {
      mode: "inert",
      reason: `No menu for ${dayWords(day.serviceDate)}. Add the day on the Menu screen to record a lunch on it.`,
      toMenu: true,
    };
  }
  if (stage === "cancelled") {
    return { mode: "inert", reason: `Lunch was cancelled on ${dayWords(day.serviceDate)}`, toMenu: false };
  }
  if (settled) return { mode: "read" };
  if ((stage === "locked" || stage === "closed") && day.orderCutoffAt !== null) {
    return {
      mode: "write",
      warning: {
        heading: `Ordering for ${dayWords(day.serviceDate)} closed at ${cutoffLabel(day.orderCutoffAt, org.timezone)}.`,
      },
    };
  }
  return { mode: "write", warning: null };
}

/** The panel's sentence about where the day stands. */
export function stageSentence(day: BoardDay, org: Clock, now: Date, settled: boolean): string {
  const stage = stageOf(day, org, now);
  switch (stage) {
    case "no_menu":
      return "No menu";
    case "cancelled":
      return "Lunch was cancelled";
    case "done":
      return settled ? "Served" : "Served. Open to record until the week is settled";
    case "open":
      return day.orderCutoffAt === null ? "Open" : `Closes ${cutoffLabel(day.orderCutoffAt, org.timezone)}`;
    default:
      return day.orderCutoffAt === null
        ? "Closed"
        : `Closed at ${cutoffLabel(day.orderCutoffAt, org.timezone)}`;
  }
}

/** The dialog's day line: `open until 21:00 Thu 1 Oct`, `Served`, `Cooking`. */
export function stagePhrase(day: BoardDay, org: Clock, now: Date): string {
  const stage = stageOf(day, org, now);
  if (stage === "open" && day.orderCutoffAt !== null) {
    const at = new Date(day.orderCutoffAt);
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: org.timezone,
    }).format(at);
    const date = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: org.timezone,
    })
      .format(at)
      .split("/")
      .reverse()
      .join("-");
    return `open until ${time} ${dayWords(date)}`;
  }
  switch (stage) {
    case "locked":
      return "Closed";
    case "closed":
      return "Cooking";
    case "done":
      return "Served";
    default:
      return "open";
  }
}

/** The ahead-or-over split the design words differently: Remove's record line. */
export function isOver(day: BoardDay, org: Clock, now: Date): boolean {
  return stageOf(day, org, now) === "done";
}

/**
 * Why this week takes no changes, or null while it still does. Said once, in
 * the notice, rather than on every control.
 */
export function settledNotice(period: OrdersPeriod | null, timeZone: string): string | null {
  if (period === null || period.status !== "closed") return null;
  const start = new Date(`${period.periodStart}T00:00:00Z`);
  const end = new Date(`${period.periodEnd}T00:00:00Z`);
  const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const range =
    period.periodStart.slice(0, 7) === period.periodEnd.slice(0, 7)
      ? `${dayOnly.format(start)} to ${dayMonth.format(end)}`
      : `${dayMonth.format(start)} to ${dayMonth.format(end)}`;
  let when = "has been settled";
  if (period.closedAt !== null) {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(period.closedAt));
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(period.closedAt));
    when = `was settled on ${dayWords(localDate)} at ${time}`;
  }
  return `The week of ${range} ${when}. A settled week is already billed and paid against, so nothing on it can change. Cells open to show what was recorded.`;
}

/** What an unavailable control says in a settled week. */
export const SETTLED_REASON = "That week has been settled";

/* ------------------------------------------------------------- provenance */

/**
 * The word a cell carries under the dish. No word means the member, or their
 * standing days, made it; `recorded` means an admin did; `corrected` means the
 * member did and an admin changed it since.
 */
export function provenanceWord(meal: RecordedMeal, entries: CorrectionEntry[]): string | null {
  if (meal.source === "admin") return "recorded";
  if (entries.some((e) => e.orderId === meal.orderId && (e.kind === "meal" || e.kind === "off_menu"))) {
    return "corrected";
  }
  return null;
}

/** The same thing as a sentence, for the dialog. */
export function provenanceSentence(args: {
  meal: RecordedMeal;
  entries: CorrectionEntry[];
  nameOf: (profileId: string) => string;
  timeZone: string;
}): string {
  const { meal, entries, nameOf, timeZone } = args;
  const owner = nameOf(meal.profileId);
  const changed = entries
    .filter((e) => e.orderId === meal.orderId && (e.kind === "meal" || e.kind === "off_menu"))
    .sort((a, b) => b.madeAt.localeCompare(a.madeAt))[0];
  if (meal.source === "admin") {
    const by = nameOf(meal.createdBy);
    return meal.createdAt === ""
      ? `Recorded by ${by}.`
      : `Recorded by ${by} on ${instantWords(meal.createdAt, timeZone)}.`;
  }
  const origin = meal.source === "standing" ? `From ${owner}'s standing days.` : `${owner} ordered this.`;
  if (changed === undefined) return origin;
  return `${origin.slice(0, -1)}, and ${nameOf(changed.madeBy)} changed it on ${instantWords(changed.madeAt, timeZone)}.`;
}

/* ----------------------------------------------------------------- money */

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
  return `${name} ${balanceNow(balanceMinor, c)} now, and ${balanceWouldBe(balanceMinor + deltaMinor, c)}.`;
}

/** What saving this would do to one person's money, in figures. */
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
    return `That dish has no price yet, so this records the meal and puts nothing on ${name}'s bill until a price arrives. ${name} ${balanceNow(balanceMinor, c)}.`;
  }

  const before = hadMeal ? beforeMinor : 0;
  if (before === null) {
    return `The meal recorded now has no price, so all ${formatMoney(afterMinor, c)} of this is new on ${name}'s bill. ${accountLine(name, balanceMinor, afterMinor, c)}`;
  }

  const delta = afterMinor - before;
  if (delta === 0) {
    return `This changes what the day records and moves no money: both come to ${formatMoney(afterMinor, c)}. ${name} ${balanceNow(balanceMinor, c)}.`;
  }

  const direction =
    delta > 0
      ? `put ${formatMoney(delta, c)} on ${name}'s bill`
      : `take ${formatMoney(-delta, c)} off ${name}'s bill`;
  const fromTo = hadMeal ? `, from ${formatMoney(before, c)} to ${formatMoney(afterMinor, c)}` : "";
  return `This would ${direction}${fromTo}. ${accountLine(name, balanceMinor, delta, c)}`;
}

/** What taking this meal off the record would do to whoever pays for it. */
export function removalPreview(a: {
  name: string;
  meal: RecordedMeal;
  balanceMinor: number;
  currency: Currency;
}): string {
  const { name, meal, balanceMinor, currency: c } = a;
  if (meal.amountMinor === null || meal.amountMinor === 0) {
    return `This meal bills nothing, so taking it off the record moves no money. ${name} ${balanceNow(balanceMinor, c)}.`;
  }
  return `This would take ${formatMoney(meal.amountMinor, c)} off ${name}'s bill. ${accountLine(name, balanceMinor, -meal.amountMinor, c)}`;
}

/**
 * Moving one meal from one bill to another, naming both people. `verb` is
 * the sentence's opening: "This would move" or "Undoing it would move".
 */
export function moveMealPreview(a: {
  opening: string;
  amountMinor: number | null;
  from: { name: string; balanceMinor: number };
  to: { name: string; balanceMinor: number };
  /** "'s" for the recipient's bill; " back to X's" reads better on undo. */
  back?: boolean;
  currency: Currency;
}): string {
  const { opening, amountMinor, from, to, back = false, currency: c } = a;
  if (amountMinor === null) {
    return `That meal has no price yet, so this moves nothing until a price arrives. It will then be on ${to.name}'s bill.`;
  }
  if (amountMinor === 0) {
    return `This meal bills nothing, so it moves no money. ${to.name} ${balanceNow(to.balanceMinor, c)}.`;
  }
  return `${opening} ${formatMoney(amountMinor, c)} from ${from.name}'s bill${back ? " back" : ""} to ${to.name}'s. ${accountLine(
    from.name,
    from.balanceMinor,
    -amountMinor,
    c,
  )} ${accountLine(to.name, to.balanceMinor, amountMinor, c)}`;
}

/**
 * Everybody a price change on one dish would reach, and the money in both
 * directions, separately: a single net figure would hide a day where half the
 * office is charged more and half less.
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
    if (meal.unitPriceMinor === null) waitingPortions += meal.quantity;
    const before = (meal.unitPriceMinor ?? 0) * meal.quantity;
    const after = args.priceMinor * meal.quantity;
    if (after > before) ontoMinor += after - before;
    else offMinor += before - after;
  }

  return { people: affected.length, portions, waitingPortions, ontoMinor, offMinor };
}

/* ----------------------------------------------------------------- words */

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
    case "pass":
      return "Passed";
    case "pass_declined":
      return "Declined";
    case "pass_withdrawn":
      return "Withdrawn";
    case "pass_undone":
      return "Pass undone";
  }
}

export function portions(n: number): string {
  return `${n} ${n === 1 ? "portion" : "portions"}`;
}

export function peopleWord(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** `Bún chả Hà Nội × 2`, or the words for eating with no dish. */
export function mealWords(meal: RecordedMeal): string {
  if (meal.dishName === null) return "eating, no dish chosen";
  return meal.quantity > 1 ? `${meal.dishName} × ${meal.quantity}` : meal.dishName;
}

/** The sentence a pass reads as, in the dialog. */
export function passSentence(args: {
  pass: PassRecord;
  nameOf: (profileId: string) => string;
  timeZone: string;
}): string {
  const { pass, nameOf, timeZone } = args;
  const from = nameOf(pass.fromProfileId);
  const to = nameOf(pass.toProfileId);
  if (pass.status === "pending") return `${from} offered this to ${to}, who has not answered.`;
  const when = pass.decidedAt === null ? "" : instantWords(pass.decidedAt, timeZone).split(" ");
  const at = when === "" ? "" : ` on ${when[0]} at ${when[1]}`;
  // Who accepted it decides the sentence, not who created it: an admin's
  // record_pass creates and decides it, and an admin answering a member's
  // offer decides one the member created.
  const decider = pass.decidedBy ?? pass.createdBy;
  if (decider !== pass.toProfileId) {
    if (decider === pass.createdBy) {
      return `${nameOf(decider)} recorded that ${from}'s meal went to ${to}${at}. ${to} pays for it.`;
    }
    return `${from} passed this meal to ${to}, and ${nameOf(decider)} accepted it for ${to}${at}. ${to} pays for it.`;
  }
  return `${from} passed this meal to ${to}, and ${to} accepted it${at}. ${to} pays for it.`;
}

/**
 * Which day the panel opens on: the last finished day when it is in the week
 * on screen, else the next day that can still be ordered for, else the first
 * day with a menu, else the first day.
 */
export function openingDay(args: {
  days: BoardDay[];
  lastFinished: string;
  today: string;
  org: Clock;
  now: Date;
}): string | null {
  const { days, lastFinished, today, org, now } = args;
  if (days.some((d) => d.serviceDate === lastFinished)) return lastFinished;
  const ahead = days.find((d) => d.serviceDate >= today && stageOf(d, org, now) === "open");
  if (ahead) return ahead.serviceDate;
  const past = [...days].reverse().find((d) => d.serviceDate < today && d.menuId !== null);
  if (past && days[0] && days[0].serviceDate < today) return past.serviceDate;
  return days.find((d) => d.menuId !== null)?.serviceDate ?? days[0]?.serviceDate ?? null;
}
