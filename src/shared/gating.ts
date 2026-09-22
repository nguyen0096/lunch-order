/**
 * Pure derivations the UI uses to decide what is enabled and why.
 *
 * These mirror the rules enforced by database triggers. Keeping them pure and
 * separate means the UI can grey out a control *and explain it* without a round
 * trip, while the database remains the thing that actually refuses the write.
 * If these two ever disagree, the database wins and the user sees its message.
 */
import type { Menu, MyOrder } from "./types.js";

export type Notice = { level: "info" | "warn" | "error"; text: string };

/** Null when ordering is allowed; otherwise the reason to show the member. */
export function orderDisabledReason(
  menu: Menu | null,
  isAdminHere: boolean,
  now: Date,
  timeZone: string,
): string | null {
  if (menu === null) return "Tomorrow's menu isn't up yet";
  if (menu.status === "cancelled") return "Lunch is cancelled for this day";
  if (isAdminHere) return null;
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

/** Null when the admin can publish; otherwise why not. */
export function publishDisabledReason(
  items: Array<{ name: string; priceMinor: number }>,
  serviceDate: string | null,
): string | null {
  if (serviceDate === null) return "Pick the service date first";
  if (items.length === 0) return "Add at least one dish";
  if (items.some((i) => i.name.trim() === "")) return "Every dish needs a name";
  if (items.some((i) => !Number.isInteger(i.priceMinor) || i.priceMinor < 0)) {
    return "Every dish needs a valid price";
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
