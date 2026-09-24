/**
 * The words and the date formatting the payments screen shares.
 *
 * Two kinds of date live on this screen and they are not interchangeable. A
 * service date and a period boundary are local calendar days, so they are
 * formatted in UTC; parsing "2026-09-22" in the reader's zone and printing it
 * back is how a week silently becomes 21-27 for anybody west of Greenwich.
 * `received_at` and `paid_at` are instants, so they are read in the office's
 * zone rather than the reader's.
 */

import { creditMinor, owedMinor, type Account } from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";

/** Said wherever a payment is about to be written, in the same words. */
export const CANNOT_UNDO =
  "A recorded payment cannot be taken back from this screen. Nothing subtracts it, so check the amount and the person before you record it.";

/**
 * Where somebody's account stands, as a phrase that fits inside a sentence.
 *
 * Credit is named rather than shown as a zero: somebody who has paid ahead is
 * not the same as somebody who is square, and an admin chasing money needs to
 * see the difference at a glance.
 */
export function accountState(account: Account, currency: Currency): string {
  const owed = owedMinor(account);
  if (owed > 0) return `owes ${formatMoney(owed, currency)}`;
  const credit = creditMinor(account);
  if (credit > 0) return `${formatMoney(credit, currency)} in credit`;
  return "nothing outstanding";
}

/**
 * What this money does to that account, said before the write.
 *
 * Money above what somebody owes is no longer destroyed: it stays on the
 * account and next week's meals eat into it, which is the whole of
 * `money_belongs_to_a_person`. So this is information, not a warning.
 */
export function landsOn(
  name: string,
  account: Account,
  amountMinor: number,
  currency: Currency,
): string {
  const after = account.balanceMinor - amountMinor;
  if (after > 0) return `${name} would still owe ${formatMoney(after, currency)}.`;
  if (after === 0) return `That settles ${name}'s account exactly.`;
  if (owedMinor(account) === 0) {
    return `${name} owes nothing, so all of it sits as credit and comes off their next lunches.`;
  }
  return `That settles ${name}'s account, and the last ${formatMoney(
    -after,
    currency,
  )} sits as credit against their next lunches.`;
}

function utcDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** "14–20 September", or "28 September – 4 October" across a month boundary. */
export function weekLabel(periodStart: string, periodEnd: string): string {
  const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const start = utcDate(periodStart);
  const end = utcDate(periodEnd);
  return periodStart.slice(0, 7) === periodEnd.slice(0, 7)
    ? `${dayOnly.format(start)}–${dayMonth.format(end)}`
    : `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
}

/** An instant, in the office's zone: "22 Sep, 09:30". */
export function arrivedLabel(instant: string, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(instant));
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(instant));
  return `${date}, ${time}`;
}

export function meals(n: number): string {
  return `${n} ${n === 1 ? "meal" : "meals"}`;
}

export function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/**
 * What `trg_payment_apply` will see when it looks for a reference in a memo.
 *
 * A warning only. The trigger uses `unaccent_fallback` and remains the
 * authority on what matches; this exists so an admin who mistypes a reference
 * hears about it before the write rather than finding an unmatched payment
 * afterwards. It errs toward saying nothing is wrong: `đ` is the one letter
 * with no canonical decomposition, so it is mapped by hand the way the
 * database's own short-code helper maps it.
 */
export function foldMemo(memo: string): string {
  return memo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/** True when the trigger would find this reference inside this memo. */
export function memoCarriesRef(memo: string, paymentRef: string): boolean {
  return foldMemo(memo).includes(foldMemo(paymentRef));
}
