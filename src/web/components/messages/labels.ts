/**
 * What each message is, in the words an admin would use, and the sentences the
 * screen says a send with.
 *
 * Kept away from the JSX because these are the whole product here: the screen
 * is four controls and a great many sentences, and a count that reads wrongly
 * in the singular is the defect people actually notice.
 */

import type { Audience, AnnouncementResult, NotificationKind } from "../../api.js";
import { peopleWord } from "../corrections/model.js";

/** What a kind takes a timing in, if anything. */
export type Timing = "minutes" | "hour" | "none";

export type KindCopy = {
  /** The message named as the thing that happens, not as a database kind. */
  title: string;
  what: string;
  /** The message as a noun, for a control that has to name it mid-sentence. */
  noun: string;
  /** What the toggle turns on, so it is never a button called "On". */
  toggle: string;
  timing: Timing;
};

export const KIND_COPY: Record<NotificationKind, KindCopy> = {
  menu_published: {
    title: "A new menu is published",
    what: "The day's dishes, their prices, and the time ordering closes.",
    noun: "the menu announcement",
    toggle: "Announce a new menu",
    timing: "none",
  },
  cutoff_warning: {
    title: "Ordering closes",
    what: "A last call, so somebody who has not ordered yet still can.",
    noun: "the last call",
    toggle: "Send a last call",
    timing: "minutes",
  },
  weekly_bill: {
    title: "The weekly bill",
    what: "What everybody owes for the week just finished, on the day the week turns over.",
    noun: "the weekly bill",
    toggle: "Send the weekly bill",
    timing: "hour",
  },
  payment_ack: {
    title: "Money arrives",
    what: "Tells whoever paid how much arrived and where their account now stands.",
    noun: "the payment receipt",
    toggle: "Tell people their money arrived",
    timing: "none",
  },
  payment_unmatched: {
    title: "A transfer matches nobody",
    what: "Tells the office's admins and owners about a bank transfer whose message names nobody, so one of them assigns it under Payments.",
    noun: "the unmatched transfer alert",
    toggle: "Tell admins about unmatched transfers",
    timing: "none",
  },
};

/** `09:00`. The column holds an hour, so the minutes are always zero. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Every hour of the day, for the one control that picks between them. */
export const HOURS: ReadonlyArray<number> = Array.from({ length: 24 }, (_, i) => i);

/** What the office now does about this kind, said as the thing that happens. */
export function savedSentence(setting: {
  kind: NotificationKind;
  enabled: boolean;
  minutesBefore: number | null;
  atLocalHour: number | null;
}): string {
  switch (setting.kind) {
    case "menu_published":
      return setting.enabled
        ? "A new menu is announced as soon as you publish it."
        : "Nobody is told when a new menu is published.";
    case "cutoff_warning":
      return setting.enabled
        ? `The last call goes out ${setting.minutesBefore ?? 0} minutes before ordering closes.`
        : "No last call goes out.";
    case "weekly_bill":
      return setting.enabled
        ? `The weekly bill goes out at ${hourLabel(setting.atLocalHour ?? 0)}.`
        : "The weekly bill is not sent.";
    case "payment_ack":
      return setting.enabled
        ? "Whoever pays is told as soon as their money arrives."
        : "Nobody is told when their money arrives.";
    case "payment_unmatched":
      return setting.enabled
        ? "Admins and owners are told when a transfer matches nobody."
        : "Nobody is told when a transfer matches nobody.";
  }
}

/**
 * The same sentence, marked as not yet true.
 *
 * A row shows what the office does now; the moment somebody moves the switch or
 * the number it shows what saving would do instead, and says which it is. The
 * sentences above all open on a word that lowercases cleanly.
 */
export function pendingSentence(setting: {
  kind: NotificationKind;
  enabled: boolean;
  minutesBefore: number | null;
  atLocalHour: number | null;
}): string {
  const said = savedSentence(setting);
  return `Once saved: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
}

/* ------------------------------------------------------------ announcements */

export const AUDIENCES: ReadonlyArray<{ value: Audience; label: string }> = [
  { value: "office", label: "Everybody in the office" },
  { value: "person", label: "One person" },
  { value: "unpaid", label: "Everybody who owes money" },
];

/** The confirmation's question, which has to name who is about to hear this. */
export function audienceQuestion(audience: Audience, name: string | null): string {
  switch (audience) {
    case "office":
      return "Send this to everybody in the office?";
    case "person":
      return name === null ? "Send this?" : `Send this to ${name}?`;
    case "unpaid":
      return "Send this to everybody who owes money?";
  }
}

function hasHave(n: number): string {
  return n === 1 ? "has" : "have";
}

/**
 * How many people this would reach, before anything is sent.
 *
 * Worked out from who has connected Telegram rather than from the audience
 * size, because the two differ in every office and the difference is the part
 * an admin cannot see from anywhere else.
 */
export function reachSentence(
  chosen: ReadonlyArray<{ name: string; connected: boolean }>,
): string {
  const total = chosen.length;
  if (total === 0) return "Nobody is in this audience, so there is nobody to send to.";

  const first = chosen[0];
  if (total === 1 && first !== undefined) {
    return first.connected
      ? `This reaches ${first.name}.`
      : `${first.name} has not connected Telegram, so this would reach nobody.`;
  }

  const reach = chosen.filter((p) => p.connected).length;
  if (reach === 0) {
    return `None of these ${peopleWord(total)} has connected Telegram, so this would reach nobody.`;
  }
  if (reach === total) return `This reaches ${peopleWord(total)}.`;
  return `This reaches ${reach} of ${peopleWord(total)}. ${peopleWord(total - reach)} ${hasHave(
    total - reach,
  )} not connected Telegram.`;
}

/** Both numbers the database hands back, because one of them is the surprise. */
export function sentSentence(r: AnnouncementResult): string {
  if (r.queued === 0 && r.unreachable === 0) return "Nothing went out. There was nobody to send to.";
  if (r.queued === 0) {
    return `Nothing went out. ${peopleWord(r.unreachable)} ${hasHave(
      r.unreachable,
    )} not connected Telegram.`;
  }
  if (r.unreachable === 0) return `Sent to ${peopleWord(r.queued)}.`;
  return `Sent to ${peopleWord(r.queued)}. ${peopleWord(r.unreachable)} ${hasHave(
    r.unreachable,
  )} not connected Telegram.`;
}

/** What a test of one message reports, which is only ever about you. */
export function testSentence(queued: number): string {
  return queued === 0
    ? "Nothing was sent. Connect Telegram in your own settings first."
    : "A test is on its way to your Telegram.";
}
