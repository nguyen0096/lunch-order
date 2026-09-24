/**
 * Pure derivations the UI uses to decide what is enabled and why.
 *
 * These mirror the rules enforced by database triggers. Keeping them pure and
 * separate means the UI can grey out a control *and explain it* without a round
 * trip, while the database remains the thing that actually refuses the write.
 * If these two ever disagree, the database wins and the user sees its message.
 */
import type { Menu, MyOrder, Org } from "./types.js";
import { zonedTimeToInstant } from "./dates.js";

export type Notice = { level: "info" | "warn" | "error"; text: string };

/**
 * The five stages a day goes through, plus the three it can sit outside.
 *
 * Mirrors `private.day_stage`. The database is what actually refuses a write;
 * this is what lets a screen say which stage a day is in without asking.
 */
export type DayStage =
  | "no_menu"
  | "draft"
  | "open"
  | "locked"
  | "closed"
  | "done"
  | "cancelled";

/**
 * Which stage a day is in.
 *
 * `locked` is the cutoff, after which nobody orders. `closed` is the office's
 * start of day, when the kitchen begins. `done` is its end of day, after which
 * a member cannot record a meal passed to somebody else.
 *
 * The last two are derived from the clock rather than stored, so they are
 * right to the second rather than right to the last hourly tick -- which
 * matters, because an hour is long enough to hand on a meal already eaten.
 */
export function dayStage(args: {
  serviceDate: string;
  status: string | null;
  orderCutoffAt: string | null;
  org: Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;
  now: Date;
}): DayStage {
  const { serviceDate, status, orderCutoffAt, org, now } = args;
  if (status === null) return "no_menu";
  if (status === "cancelled") return "cancelled";
  if (status === "draft") return "draft";

  const at = (hhmm: string) =>
    zonedTimeToInstant(serviceDate, hhmm, org.timezone).getTime();
  if (now.getTime() >= at(org.businessDayEndsAt)) return "done";
  if (now.getTime() >= at(org.businessDayStartsAt)) return "closed";
  if (status === "locked") return "locked";
  if (orderCutoffAt !== null && now.getTime() >= Date.parse(orderCutoffAt)) return "locked";
  return "open";
}

/** The word a day's stage puts on a column head or a day card. */
export function stageWord(stage: DayStage): string | null {
  switch (stage) {
    case "no_menu":
      return "No menu";
    case "draft":
      return "Draft";
    case "open":
      return null;
    case "locked":
      return "Closed";
    case "closed":
      return "Cooking";
    case "done":
      return "Served";
    case "cancelled":
      return "Cancelled";
  }
}

/** Null when ordering is allowed; otherwise the reason to show the member. */
export function orderDisabledReason(
  menu: Menu | null,
  now: Date,
  timeZone: string,
): string | null {
  if (menu === null) return "Tomorrow's menu isn't up yet";
  if (menu.status === "cancelled") return "Lunch is cancelled for this day";
  // No admin exemption, deliberately. See `cellReason`.
  if (menu.status === "draft") return "Tomorrow's menu isn't published yet";
  if (menu.status === "locked") return "Orders are closed and have gone to the caterer";
  if (cutoffPassed(menu, now)) return `Ordering closed at ${formatCutoff(menu, timeZone)}`;
  return null;
}

export function cutoffPassed(menu: Menu, now: Date): boolean {
  return now.getTime() >= Date.parse(menu.orderCutoffAt);
}

// Instants are stored and compared in UTC; only the rendering is local, and
// local means the ORG's zone, not the reader's. A member travelling must still
// be told the cutoff the office and the caterer are working to.
export function formatCutoff(menu: Menu, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
  }).format(new Date(menu.orderCutoffAt));
}

/** Whole minutes until the cutoff; negative once it has passed. */
export function minutesToCutoff(menu: Menu, now: Date): number {
  return Math.floor((Date.parse(menu.orderCutoffAt) - now.getTime()) / 60_000);
}

export function notices(menu: Menu | null, order: MyOrder | null, now: Date): Notice[] {
  const out: Notice[] = [];
  if (menu === null) return out;

  const mins = minutesToCutoff(menu, now);
  if (menu.status === "published" && mins > 0 && mins <= 60) {
    out.push({ level: "warn", text: `Orders close in ${mins} min` });
  }
  if (order?.status === "placed" && order.itemId === null) {
    out.push({
      level: "warn",
      text: "You're down as eating but haven't picked a dish yet",
    });
  }
  if (order?.source === "standing") {
    out.push({
      level: "info",
      text: "This was added automatically by your weekday preference",
    });
  }
  if (menu.status === "locked") {
    out.push({ level: "info", text: "The headcount has gone to the caterer" });
  }
  return out;
}

/**
 * Null when the admin can publish; otherwise why not.
 *
 * A missing price is not a reason. The caterer often prices the week at the
 * weekend, so demanding a number here forced admins to invent one, and `0` is a
 * real price that reads on a bill as a free meal. An unpriced dish publishes,
 * people order it, and it is held out of billing until the price arrives.
 *
 * A price that is present and nonsense is still refused: `null` means "not
 * said yet", and that is the only absence this accepts.
 */
export function publishDisabledReason(
  items: Array<{ name: string; priceMinor: number | null }>,
  serviceDate: string | null,
): string | null {
  if (serviceDate === null) return "Pick the service date first";
  if (items.length === 0) return "Add at least one dish";
  if (items.some((i) => i.name.trim() === "")) return "Every dish needs a name";
  if (
    items.some(
      (i) => i.priceMinor !== null && (!Number.isInteger(i.priceMinor) || i.priceMinor < 0),
    )
  ) {
    return "A price must be a whole number of dong, or left for the caterer";
  }
  return null;
}

/**
 * Which day the board should open on.
 *
 * Deliberately NOT "the first day that isn't locked". Admins are exempt from
 * the cutoff so they can resolve dishes after it passes, which means a past day
 * is still editable for them -- and using editability to choose the default
 * landed the board on the earliest day of the week that happened to have a
 * menu, in the past.
 *
 * What the reader wants is the soonest day that still matters: today or later,
 * with a menu they can see. Falling back to today keeps the board anchored
 * somewhere sensible when the week ahead is empty.
 */
export function defaultSelectedDay(args: {
  days: Array<{ serviceDate: string; menuId: number | null; status: string | null }>;
  today: string;
  /** Days whose cutoff has not passed, by service date. */
  isOpen: (serviceDate: string) => boolean;
}): string {
  const upcoming = args.days.filter((d) => d.serviceDate >= args.today);

  // Best: the soonest upcoming day still open for ordering.
  const open = upcoming.find((d) => d.menuId !== null && args.isOpen(d.serviceDate));
  if (open) return open.serviceDate;

  // Next best: the soonest upcoming day with a menu at all, even if closed --
  // seeing today's locked menu beats being shown last Wednesday.
  const withMenu = upcoming.find((d) => d.menuId !== null);
  if (withMenu) return withMenu.serviceDate;

  // Then today, if it is in view. Browsing a past or future week has no
  // "today", so fall back to the start of whatever is on screen.
  if (args.days.some((d) => d.serviceDate === args.today)) return args.today;
  return args.days[0]?.serviceDate ?? args.today;
}
