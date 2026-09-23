/**
 * The words this screen uses for dates, counts and menu status.
 *
 * Kept apart from the JSX so the confirmation, the day strip and the notices
 * cannot drift into saying the same thing three ways. Dates are formatted in
 * UTC because a service date is a calendar day, not an instant; only the cutoff
 * is a real timestamp, and it is rendered in the ORG's zone, which is the zone
 * the caterer works to.
 */
import type { MenuStatus } from "../../../shared/types.js";

/** `Wednesday 24 September`, for the places with room to spell it. */
export function longDay(serviceDate: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${serviceDate}T00:00:00Z`));
}

/** `Wednesday`, for "everyone with a standing Wednesday". */
export function weekdayName(serviceDate: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${serviceDate}T00:00:00Z`),
  );
}

/** `Mon 22`, for the day strip. */
export function shortDay(serviceDate: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${serviceDate}T00:00:00Z`));
}

/**
 * `21:00 23/09`, spelled the way the order-cutoff trigger spells it, so the
 * screen and the database's refusal read as one voice.
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

export function people(n: number): string {
  return n === 1 ? "1 person" : `${n} people`;
}

/** `One person has` / `4 people have`, so a sentence about a count can agree. */
export function peopleHave(n: number): string {
  return n === 1 ? "One person has" : `${n} people have`;
}

/**
 * `One order already exists` / `4 orders already exist`.
 *
 * Counted as orders rather than as people on purpose: it is the noun the
 * trigger's own refusal uses -- "orders already exist for this menu" -- so the
 * sentence the button carries and the sentence the database sends back when the
 * count moved underneath read as one voice rather than two.
 */
export function ordersExist(n: number): string {
  return n === 1 ? "One order already exists" : `${n} orders already exist`;
}

export function dishes(n: number): string {
  return n === 1 ? "1 dish" : `${n} dishes`;
}

/** `One dish has` / `3 dishes have`, so a sentence about a count can agree. */
export function dishesHave(n: number): string {
  return n === 1 ? "One dish has" : `${n} dishes have`;
}

/**
 * Null when the menu can be edited, otherwise why not.
 *
 * Only two statuses close the screen, and both are the database's rule, not a
 * policy invented here: `enforce_menu_item_frozen` refuses to touch a dish on a
 * locked or cancelled menu.
 */
export function readOnlyReason(status: MenuStatus | null): string | null {
  if (status === "locked") return "Orders are closed and have gone to the caterer";
  if (status === "cancelled") return "Lunch is cancelled for this day";
  return null;
}

export function statusWord(status: MenuStatus): string {
  return status === "draft"
    ? "Draft"
    : status === "published"
      ? "Published"
      : status === "locked"
        ? "Locked"
        : "Cancelled";
}

/**
 * The whole sentence a frozen menu's notice carries.
 *
 * Not `readOnlyReason` with a full stop after it: what a frozen day can still
 * become differs by status, and that is the half the old copy got wrong. A
 * locked day is exactly the day reopening exists for; a cancelled one has no
 * transition out of it at all.
 */
export function frozenNotice(status: MenuStatus): string | null {
  if (status === "locked") {
    return "Orders are closed and have gone to the caterer. Reopen ordering to change dishes or prices again.";
  }
  if (status === "cancelled") {
    return "Lunch is cancelled for this day. Dishes and prices can no longer be changed, and a cancelled day cannot be reopened.";
  }
  return null;
}
