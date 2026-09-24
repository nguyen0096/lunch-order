/**
 * Every date in this app is a LOCAL SERVICE DATE in the org's timezone, not an
 * instant. The database stores them as `date` and the server runs in UTC, so
 * anything that reaches for the system date is wrong for part of every day.
 * These helpers are the only sanctioned way to ask "what day is it there".
 */

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
 * Built by probing rather than by arithmetic on a fixed offset: zones change
 * their offset, and Vietnam having no DST is not a property other customers share.
 */
export function zonedTimeToInstant(isoDate: string, hhmm: string, timeZone: string): Date {
  const [h, min] = hhmm.split(":").map(Number);
  if (h === undefined || min === undefined) {
    throw new TypeError(`not a HH:MM time: ${hhmm}`);
  }
  const [y, mo, d] = isoDate.split("-").map(Number);
  if (y === undefined || mo === undefined || d === undefined) {
    throw new TypeError(`not an ISO date: ${isoDate}`);
  }
  // First guess treats the wall time as UTC, then correct by the zone's offset
  // at that instant. One correction pass is enough for every real zone.
  const guess = Date.UTC(y, mo - 1, d, h, min);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") % 24, get("minute"), get("second"),
  );
  return asUTC - at.getTime();
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
