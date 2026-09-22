/**
 * The board's rules, kept pure and away from the JSX so they can be read and
 * tested on their own.
 *
 * These mirror what the database triggers enforce. The database still decides:
 * when the two disagree it wins, and its sentence is what the person sees.
 * What lives here is only the part the UI needs in order to say *why* a cell
 * is inert before anybody taps it.
 */
import type { BoardCell, BoardDay } from "../api.js";
import { formatDay, isoWeekday } from "../../shared/dates.js";

export type Dish = { id: number; name: string; priceMinor: number };

/**
 * Which days get a column.
 *
 * Every weekday, plus a weekend day only when lunch actually happens on it. A
 * Sunday column that is empty in every office every week is width spent on
 * nothing, but an office that does order on Saturday has to see Saturday.
 */
export function visibleDays(
  days: BoardDay[],
  hasActivity: (serviceDate: string) => boolean,
): BoardDay[] {
  return days.filter((d) => isoWeekday(d.serviceDate) <= 5 || hasActivity(d.serviceDate));
}

/** `22–26 Sep`, or `29 Sep – 3 Oct` when the week straddles two months. */
export function weekRangeLabel(from: string, to: string, locale = "en-GB"): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  const day = (d: Date) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: "UTC" }).format(d);
  const dayMonth = (d: Date) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  const sameMonth =
    f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear();
  return sameMonth ? `${day(f)}–${dayMonth(t)}` : `${dayMonth(f)} – ${dayMonth(t)}`;
}

/** `Mon` / `22`, for a two-line column head. */
export function columnLabel(serviceDate: string, locale = "en-GB"): { dow: string; dom: string } {
  const at = new Date(`${serviceDate}T00:00:00Z`);
  return {
    dow: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(at),
    dom: String(Number(serviceDate.slice(8))),
  };
}

/**
 * The cutoff in the org's zone, spelled the way the database spells it, so the
 * greyed-out reason and the refusal that follows it read as one voice:
 * `Ordering closed at 21:00 22/09` here, `ordering for 2026-09-23 closed at
 * 21:00 22/09` from the trigger.
 */
export function cutoffLabel(orderCutoffAt: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(orderCutoffAt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("day")}/${get("month")}`;
}

/**
 * Null when this day's order can be changed right now, otherwise the sentence
 * saying why not.
 *
 * Deliberately not `gating.orderDisabledReason`: that one is written for a
 * single day in view and says "Tomorrow's menu isn't up yet", which is wrong
 * on five of the six cells of a week. Same rules, day-accurate wording.
 */
export function cellReason(args: {
  day: BoardDay;
  isAdminHere: boolean;
  now: Date;
  timeZone: string;
}): string | null {
  const { day, isAdminHere, now, timeZone } = args;
  if (day.menuId === null) return `No menu for ${formatDay(day.serviceDate)} yet`;
  if (day.status === "cancelled") return "Lunch is cancelled this day";
  if (day.dishes.length === 0) return "This menu has no dishes on it yet";
  // Admins are exempt from the window by the same trigger that enforces it:
  // after the cutoff they are the ones on the phone to the caterer.
  if (isAdminHere) return null;
  if (day.status === "draft") return "This menu isn't published yet";
  if (day.status === "locked") return "Orders are closed and have gone to the caterer";
  if (day.orderCutoffAt !== null && now.getTime() >= Date.parse(day.orderCutoffAt)) {
    return `Ordering closed at ${cutoffLabel(day.orderCutoffAt, timeZone)}`;
  }
  return null;
}

/**
 * Null when this meal can still be handed to somebody else, otherwise why not.
 *
 * The window is the **open billing week**, not today onward. The old screen
 * asked the database for orders from `today`, so a Tuesday meal could not be
 * handed over on Thursday although the trigger permits it: it refuses only a
 * meal already on a *closed* bill. People remember on Thursday that Tuesday's
 * lunch went to somebody else, and the alternative to letting them say so is a
 * bill that is quietly wrong.
 */
export function passOnReason(args: {
  cell: BoardCell | null;
  serviceDate: string;
  /** Start of the billing week containing today, in the org's zone. */
  openWeekStart: string;
  /** A live offer already sitting on this meal. */
  offeredTo: string | null;
  mayAct: boolean;
}): string | null {
  const { cell, serviceDate, openWeekStart, offeredTo, mayAct } = args;
  if (!mayAct) return "Only an admin can pass on somebody else's meal";
  if (cell === null || cell.status !== "placed") return "There is no meal here to pass on";
  // An optimistic cell has no server id yet, so there is nothing to offer.
  if (cell.orderId <= 0) return "Still saving this order";
  if (cell.transferredToName !== null) return `Already passed to ${cell.transferredToName}`;
  if (offeredTo !== null) return `Already offered to ${offeredTo}`;
  if (serviceDate < openWeekStart) return "That week's bill is closed";
  return null;
}

export type Mark = "ordered" | "eating" | "passed" | "projected" | "none";

/** What a colleague's cell shows. You need whether, not what. */
export function cellMark(cell: BoardCell | null | undefined, projected: boolean): Mark {
  if (cell && cell.status === "placed") {
    if (cell.transferredToName !== null) return "passed";
    return cell.dishName !== null ? "ordered" : "eating";
  }
  return projected ? "projected" : "none";
}

/**
 * The dish a first tap orders.
 *
 * Random rather than first-listed, and that is the default rather than a
 * fallback: on most days nobody minds which of three similar dishes arrives,
 * and picking the first would quietly funnel the whole office onto one dish
 * and skew what the caterer is asked to cook. Anyone who does mind gets the
 * dialog on the next tap.
 */
export function pickDish(
  dishes: Dish[],
  options: { excludeId?: number | null; random?: () => number } = {},
): Dish | null {
  const without = dishes.filter((d) => d.id !== options.excludeId);
  // Falling back to the full list matters when the menu has one dish and it is
  // the one already ordered: "Surprise me" should re-offer it, not go blank.
  const pool = without.length > 0 ? without : dishes;
  if (pool.length === 0) return null;
  const roll = (options.random ?? Math.random)();
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[index] ?? null;
}
