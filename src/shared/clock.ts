/**
 * The single source of "now" for the UI.
 *
 * Everything that asks the time goes through here so that manual testing can
 * move it. In a dev build, `?now=2026-09-16T10:00:00+07:00` (or a bare
 * `?now=2026-09-16`) shifts the clock; in a production build the override is
 * compiled out and ignored entirely.
 *
 * IMPORTANT LIMIT, and not a bug: this moves only the browser. The database
 * enforces the order cutoff with its own now(), so a shifted clock changes what
 * the UI *shows* -- which week, the countdown, whether a day looks locked --
 * but a write the real cutoff forbids is still refused by the trigger, with its
 * own message. To test behaviour on a past or future day, move the data
 * instead: see supabase/tests/mock_week.sql.
 */
let offsetMs = 0;

export function initClock(search: string): string | null {
  // Reset first. Returning early on a missing override would leave a stale
  // offset behind, which bites on a second call (hot reload, or a test suite)
  // and makes the clock silently wrong rather than obviously off.
  offsetMs = 0;

  // Guarded at build time, so no override code ships to production.
  if (!import.meta.env.DEV) return null;
  const raw = new URLSearchParams(search).get("now");
  if (!raw) return null;
  const parsed = Date.parse(raw.length === 10 ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(parsed)) return null;
  offsetMs = parsed - Date.now();
  return new Date(parsed).toISOString();
}

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/** Non-zero only when a dev override is active. */
export function clockOffsetMs(): number {
  return offsetMs;
}
