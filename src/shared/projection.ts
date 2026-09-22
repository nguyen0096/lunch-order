/**
 * Which future days a member's weekday preference *will* cover, computed
 * rather than stored.
 *
 * The alternative is creating order rows for dates that have no menu yet,
 * which would invent a commitment with no price attached and make the
 * headcount query lie. So the board shows a dashed tick for these, and a real
 * row only appears when a menu is published -- at which point the database's
 * materializer creates it.
 *
 * This mirrors the `union` in materialize_standing_orders: the rule's weekdays
 * minus skips, plus explicit forces. Kept pure and beside its own tests so the
 * two definitions cannot quietly drift apart.
 */
export function projectStandingDays(args: {
  days: string[];
  /** Local service date for the org; nothing on or before this is projected. */
  today: string;
  weekdays: Set<number>;
  skips: Set<string>;
  forces: Set<string>;
  hasOrder: (serviceDate: string) => boolean;
}): Set<string> {
  const out = new Set<string>();
  for (const d of args.days) {
    if (d <= args.today) continue;      // the past is whatever the rows say
    if (args.hasOrder(d)) continue;     // a real row always wins
    const byRule = args.weekdays.has(isoWeekday(d)) && !args.skips.has(d);
    if (byRule || args.forces.has(d)) out.add(d);
  }
  return out;
}

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
