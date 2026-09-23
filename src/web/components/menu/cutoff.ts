/**
 * When ordering closes, as the admin edits it: a calendar day and a wall-clock
 * time in the ORG's zone, which is the pair `menus.order_cutoff_at` is built
 * from and the pair the caterer works to.
 *
 * Kept apart from the screen because every question here is arithmetic on a
 * zone -- what a stored instant is locally, what a typed pair means as an
 * instant, and whether the pair says something the database will happily accept
 * but nobody wants.
 */
import { addDays, todayIn, zonedTimeToInstant } from "../../../shared/dates.js";
import { longDay } from "./labels.js";

export type LocalCutoff = { date: string; time: string };

/** A stored `order_cutoff_at` as the two boxes the admin edits. */
export function localCutoff(orderCutoffAt: string, timeZone: string): LocalCutoff {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // h23, not `hour12: false`, which renders midnight as hour 24 on some ICU
    // builds and would put "24:00" into a time input that refuses it.
    hourCycle: "h23",
  }).formatToParts(new Date(orderCutoffAt));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** The pair as the instant that goes to `menus.order_cutoff_at`. */
export function cutoffInstant(cutoff: LocalCutoff, timeZone: string): string {
  return zonedTimeToInstant(cutoff.date, cutoff.time, timeZone).toISOString();
}

/**
 * Null when the cutoff makes sense, otherwise the sentence saying why not.
 *
 * Neither case is refused by the database -- `order_cutoff_at` takes any
 * instant, on a published menu, after people have ordered -- so this screen is
 * the only place either can be said at all.
 */
export function cutoffProblem(a: {
  cutoff: LocalCutoff;
  serviceDate: string;
  /** What the menu already stores; null for a day with no menu yet. */
  storedAt: string | null;
  timeZone: string;
  now: Date;
}): string | null {
  if (a.cutoff.date > a.serviceDate) {
    return `Orders would close after lunch on ${longDay(a.serviceDate)}. Move the cutoff earlier`;
  }

  // An elapsed cutoff the admin has not moved is history, not a mistake.
  // Correcting a price on a published menu after ordering closed is a supported
  // flow and goes through this same Publish, so refusing it here would leave no
  // way to do it at all. Compared as the two boxes rather than as instants,
  // because a stored timestamptz carries seconds the boxes cannot hold.
  if (a.storedAt !== null) {
    const stored = localCutoff(a.storedAt, a.timeZone);
    if (stored.date === a.cutoff.date && stored.time === a.cutoff.time) return null;
  }

  // A day that is already over is a record, not an invitation to order, so its
  // cutoff being in the past is the point rather than a mistake. Warning here
  // would make every recorded day unpublishable -- the cutoff derives to the
  // evening before, which for a past day is always past.
  if (a.serviceDate < todayIn(a.timeZone, a.now)) return null;

  if (Date.parse(cutoffInstant(a.cutoff, a.timeZone)) <= a.now.getTime()) {
    // Not "nobody could order": admins are exempt from the cutoff, and the
    // only person reading this sentence is an admin. Saying "nobody" to the
    // one person it does not apply to is how this reads as a refusal.
    return "That cutoff has already passed, so only an admin could still order. Move it later";
  }
  return null;
}

/**
 * The cutoff to offer for a day nobody has set one for.
 *
 * The evening before, at the office's own time -- except that for a menu being
 * written on the day itself, the evening before has already gone. Offering it
 * anyway hands the admin a value that is dead on arrival and then refuses to
 * publish it, which is the shape of the bug this exists to stop: the screen
 * created the problem and then blamed the person for it.
 *
 * So when the derived cutoff has already passed and the day has not, the offer
 * moves to the next whole hour. That is always at least a minute away, reads as
 * a decision ("closes at 16:00") rather than as an accident, and is still a
 * suggestion -- the admin can move it, and pinning still wins.
 *
 * A day that is already over keeps the evening before. It is a record of when
 * ordering closed, not an invitation, and nothing about it should look live.
 */
export function defaultCutoff(a: {
  serviceDate: string;
  /** `HH:MM`, the office's own default. */
  defaultTime: string;
  timeZone: string;
  now: Date;
}): LocalCutoff {
  const evening: LocalCutoff = { date: addDays(a.serviceDate, -1), time: a.defaultTime };
  if (a.serviceDate < todayIn(a.timeZone, a.now)) return evening;
  if (Date.parse(cutoffInstant(evening, a.timeZone)) > a.now.getTime()) return evening;

  const nextHour = localCutoff(new Date(a.now.getTime() + 3_600_000).toISOString(), a.timeZone);
  return { date: nextHour.date, time: `${nextHour.time.slice(0, 2)}:00` };
}
