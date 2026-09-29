/**
 * The board's rules, kept pure and away from the JSX so they can be read and
 * tested on their own.
 *
 * These mirror what the database triggers enforce. The database still decides:
 * when the two disagree it wins, and its sentence is what the person sees.
 * What lives here is only the part the UI needs in order to say *why* a cell
 * is inert before anybody taps it.
 */
import type { BoardCell, BoardDay, StandingException } from "../api.js";
import { addDays, formatDay, isoWeekday, weekStart } from "../../shared/dates.js";
import { dayStage, stageWord } from "../../shared/gating.js";
import type { Org } from "../../shared/types.js";

export type Dish = { id: number; name: string; priceMinor: number | null };

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

/** `Wednesday 23 September`, for the menu panel, which has the room to spell it. */
export function longDayLabel(serviceDate: string, locale = "en-GB"): string {
  const at = new Date(`${serviceDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(at);
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
  now: Date;
  timeZone: string;
}): string | null {
  const { day, now, timeZone } = args;
  if (day.menuId === null) return `No menu for ${formatDay(day.serviceDate)} yet`;
  if (day.status === "cancelled") return "Lunch is cancelled this day";
  if (day.dishes.length === 0) return "This menu has no dishes on it yet";
  // No admin exemption. This board is where an admin orders their own lunch,
  // like everybody else, and the clock binds everybody on it. Correcting a
  // finished day is a different job, and `enforce_order_window` now asks for
  // it by name: only an order whose `source` is 'admin' steps outside the
  // window, and nothing on this screen writes that.
  if (day.status === "draft") return "This menu isn't published yet";
  if (day.status === "locked") return "Orders are closed and have gone to the caterer";
  if (day.orderCutoffAt !== null && now.getTime() >= Date.parse(day.orderCutoffAt)) {
    return `Ordering closed at ${cutoffLabel(day.orderCutoffAt, timeZone)}`;
  }
  return null;
}

/**
 * The one or two words a column head carries under its date.
 *
 * This used to be a tint. A recessed column said "you cannot act here", but
 * the same grey covered a day with no menu, a day past its cutoff and a day
 * lunch was cancelled on, so one shade stood for three different pieces of
 * news and the commonest reading of it -- "these are the days with a menu" --
 * was not one of them. A word says which.
 *
 * Returns null when the reader can act on the day, so an ordinary open day
 * stays quiet. `Today` is added by the caller: it is a different axis and the
 * two coexist, since today is usually also closed by the afternoon.
 */
export function columnTag(args: {
  day: BoardDay;
  org: Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;
  now: Date;
}): string | null {
  const { day, org, now } = args;
  if (day.dishes.length > 0 && day.status !== null && day.status !== "cancelled") {
    const stage = dayStage({
      serviceDate: day.serviceDate,
      status: day.status,
      orderCutoffAt: day.orderCutoffAt,
      org,
      now,
    });
    return stageWord(stage);
  }
  if (day.menuId === null) return "No menu";
  if (day.status === "cancelled") return "Cancelled";
  return "No dishes";
}

/**
 * The day the menu panel opens on, and the column the grid scrolls to.
 *
 * The next one still orderable, so the panel answers "what is on offer that I
 * can still act on" without a tap. Past days are skipped even for an admin,
 * who can order on them but is not usually looking at them. The fallbacks run
 * down to *some* day, because a panel that renders nothing teaches nothing.
 */
export function nextOrderableDay(
  days: BoardDay[],
  canOrder: (day: BoardDay) => boolean,
  today: string,
): BoardDay | null {
  return (
    days.find((d) => d.serviceDate >= today && canOrder(d)) ??
    days.find(canOrder) ??
    days.find((d) => d.serviceDate === today) ??
    days.find((d) => d.dishes.length > 0) ??
    days[0] ??
    null
  );
}

/**
 * Null when this meal can still be handed to somebody else, otherwise why not.
 *
 * Always asked about the reader's own meal. Giving your own lunch away is the
 * only handover the board offers anybody, admin or not; moving a meal between
 * two other people is a correction, and it has no screen.
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
  /** The day has reached `done`: see `lunchIsOver`. */
  over?: boolean;
}): string | null {
  const { cell, serviceDate, openWeekStart, offeredTo, over = false } = args;
  if (cell === null || cell.status !== "placed") return "There is no meal here to pass on";
  // An optimistic cell has no server id yet, so there is nothing to offer.
  if (cell.orderId <= 0) return "Still saving this order";
  if (cell.transferredToName !== null) return `Already passed to ${cell.transferredToName}`;
  if (offeredTo !== null) return `Already offered to ${offeredTo}`;
  if (serviceDate < openWeekStart) return "That week's bill is closed";
  if (over) return lunchOverReason(serviceDate);
  return null;
}

/**
 * True once the office's day has ended, which is when `enforce_transfer_rules`
 * stops a member offering, accepting or declining a meal on it. The board is
 * the same for everybody, so an admin is held to it here too.
 */
export function lunchIsOver(args: {
  day: BoardDay;
  org: Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;
  now: Date;
}): boolean {
  const { day, org, now } = args;
  return (
    dayStage({
      serviceDate: day.serviceDate,
      status: day.status,
      orderCutoffAt: day.orderCutoffAt,
      org,
      now,
    }) === "done"
  );
}

/** The trigger's refusal, said before anybody taps. */
export function lunchOverReason(serviceDate: string): string {
  return `Lunch on ${formatDay(serviceDate)} is over, so it can no longer be passed on`;
}

/**
 * What my own cell says about a day whose menu is not out yet, or null when
 * the day is not one to plan ahead: today or earlier, a menu already
 * published, locked or cancelled, or an order row of mine on it in any
 * status. The same three conditions `set_standing_exception` checks.
 *
 * A draft counts as not out. Publishing is when standing orders are made, so
 * until then an exception still decides what publishing does.
 */
export type PlanState = "standing" | "skipped" | "planned" | "empty";

export function planState(args: {
  day: BoardDay;
  today: string;
  /** Any order row of mine on this day, cancelled included. */
  hasOrderRow: boolean;
  weekdays: Set<number>;
  exception: StandingException | null;
}): PlanState | null {
  const { day, today, hasOrderRow, weekdays, exception } = args;
  if (day.serviceDate <= today || hasOrderRow) return null;
  if (day.menuId !== null && day.status !== "draft") return null;
  const byRule = weekdays.has(isoWeekday(day.serviceDate));
  if (byRule) return exception === "skip" ? "skipped" : "standing";
  return exception === "force" ? "planned" : "empty";
}

/**
 * The exception a tap writes. It takes the day to the other side of the rule:
 * a standing day is skipped, a skip is taken back, an empty day is planned
 * and a plan is taken back.
 */
export function planToggle(state: PlanState): StandingException | null {
  switch (state) {
    case "standing":
      return "skip";
    case "empty":
      return "force";
    case "skipped":
    case "planned":
      return null;
  }
}

/**
 * The week a `?week=` link asks for, or null when it names no real date.
 *
 * A date must survive a round trip, so 2026-02-31 is refused rather than read
 * as 3 March. The year stops at 9998 because the week arrows add seven days,
 * and past 9999 an ISO string gains a sign and six digits, which the Board
 * cannot draw.
 */
export function weekFromParam(asked: string | null, weekStartsOn: number): string | null {
  if (asked === null || !/^\d{4}-\d{2}-\d{2}$/.test(asked)) return null;
  const year = Number(asked.slice(0, 4));
  if (year < 2000 || year > 9998 || addDays(asked, 0) !== asked) return null;
  return weekStart(asked, weekStartsOn);
}

/**
 * Why a day is no longer one to plan ahead, in the words
 * `set_standing_exception` would use. For the case the database never hears
 * about: an Undo on a day `planState` has already turned down.
 */
export function planRefusal(args: {
  serviceDate: string;
  today: string;
  hasOrderRow: boolean;
}): string {
  const day = formatDay(args.serviceDate);
  if (args.serviceDate <= args.today) {
    return `${day} is today or already past, so it can no longer be planned ahead`;
  }
  if (args.hasOrderRow) return `You already have an order on ${day}, so change that instead`;
  return `The menu for ${day} is out, so order or cancel that day instead`;
}

/** The toast for a day that has just become `state`. */
export function planMessage(state: PlanState, serviceDate: string): string {
  const day = formatDay(serviceDate);
  switch (state) {
    case "skipped":
      return `Skipped ${day}`;
    case "planned":
      return `Planned ${day}`;
    case "standing":
      return `Standing again ${day}`;
    case "empty":
      return `Nothing planned ${day}`;
  }
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
