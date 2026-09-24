/**
 * Every date in this app is a LOCAL SERVICE DATE in the org's timezone, not an
 * instant. The database stores them as `date` and the server runs in UTC, so
 * anything that reaches for the system date is wrong for part of every day.
 * These helpers are the only sanctioned way to ask "what day is it there".
 *
 * The calendar arithmetic below stays on ISO strings and UTC, because a
 * service date is a label rather than an instant and converting it to a local
 * `Date` is how it picks up a timezone it never had. Anything that genuinely
 * involves a zone goes through `@date-fns/tz`, which knows about the two hours
 * a year that hand-rolled offset arithmetic gets wrong.
 */
import { TZDate } from "@date-fns/tz";

/** YYYY-MM-DD in the given IANA zone. en-CA gives ISO ordering natively. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new TypeError(`not an ISO date: ${isoDate}`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
export function isoWeekday(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new TypeError(`not an ISO date: ${isoDate}`);
  }
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Whole days from `a` to `b`; negative when `b` is the earlier one. */
export function daysApart(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

/** Start of the billing week containing `isoDate`, given the org's week start. */
export function weekStart(isoDate: string, weekStartsOn = 1): string {
  const shift = (isoWeekday(isoDate) - weekStartsOn + 7) % 7;
  return addDays(isoDate, -shift);
}

/**
 * The instant a local wall-clock time occurs in a given zone, as a Date.
 * Used to turn an org's "16:00 cutoff" into a real timestamptz.
 *
 * `TZDate` from `@date-fns/tz` rather than arithmetic of our own. This used to
 * guess the instant as if the wall time were UTC and then correct it by the
 * zone's offset at that guess, in a single pass. One pass is right for every
 * hour of the year except the ones a DST transition moves, where the offset at
 * the guess is not the offset at the answer: an hour that is skipped forward
 * has no instant at all, and an hour that repeats has two. Vietnam has no DST
 * so this office would never have noticed, which is exactly the kind of bug
 * that waits for the first customer somewhere else.
 */
export function zonedTimeToInstant(isoDate: string, hhmm: string, timeZone: string): Date {
  const [h, min] = hhmm.split(":").map(Number);
  if (h === undefined || min === undefined || Number.isNaN(h) || Number.isNaN(min)) {
    throw new TypeError(`not a HH:MM time: ${hhmm}`);
  }
  const [y, mo, d] = isoDate.split("-").map(Number);
  if (y === undefined || mo === undefined || d === undefined) {
    throw new TypeError(`not an ISO date: ${isoDate}`);
  }
  // Constructed IN the zone, so the fields are read as that zone's wall clock
  // and the epoch value comes out of the library's own tz handling.
  return new Date(new TZDate(y, mo - 1, d, h, min, 0, 0, timeZone).getTime());
}

/** Human "Mon 14 Sep" for message bodies and table headers. */
export function formatDay(isoDate: string, locale = "en-GB"): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new TypeError(`not an ISO date: ${isoDate}`);
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "2-digit", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
