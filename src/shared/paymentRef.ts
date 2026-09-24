/**
 * The reference a person types into their bank, composed for display only.
 *
 * `TEST LUNCH DINH`: the office, the word, the person. One string per person,
 * the same in every state and for good, so it can be saved as a repeating
 * transfer. A week number was tried here and removed: somebody three weeks
 * behind has no single true week to name, which is exactly the case it was
 * meant to help.
 *
 * `memberships.payment_ref` (`LUNCHDINH`) stays the matchable core and nothing
 * here changes it. `private.payer_from_memo` folds a memo to letters and
 * digits before looking for that core inside it, so `TEST LUNCH DINH` arrives
 * as `TESTLUNCHDINH` and still matches. Composition is therefore a display
 * concern, it lives in this one function, and the database is left alone.
 *
 * Space is the separator. A Vietnamese transfer note carries letters, digits
 * and spaces intact; `_`, `-` and `/` are refused or silently dropped by
 * several banks, and diacritics are mangled. It is also the only separator
 * somebody retyping the memo by hand can reach without a modifier key.
 */
import { foldMemo, REF_PREFIX } from "./sepay.js";

export type ComposedRef = {
  /** `organizations.short_code`, e.g. `TEST`. Empty where an office has none. */
  officeCode: string;
  /** `memberships.short_code`, e.g. `DINH`. `payment_ref` is LUNCH + this. */
  memberCode: string;
};

/** `TEST LUNCH DINH`. */
export function composePaymentRef(ref: ComposedRef): string {
  // Folded rather than validated: a short code that somehow carries a space or
  // a diacritic yields a shorter reference instead of a QR that will not build.
  return [foldMemo(ref.officeCode), REF_PREFIX, foldMemo(ref.memberCode)]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * What to show, with the invariant that makes composing safe enforced rather
 * than assumed: whatever is displayed must still contain the core the database
 * matches on, once folded the way the database folds it.
 *
 * `payment_ref` and `short_code` are two columns kept in step by a trigger, not
 * one derived from the other, so they can in principle disagree. If they ever
 * do, the bare reference is shown. A plainer string is a cost; a reference that
 * reaches nobody is money this app never sees.
 */
export function displayPaymentRef(ref: ComposedRef & { paymentRef: string }): string {
  const core = foldMemo(ref.paymentRef);
  const composed = composePaymentRef(ref);
  return core !== "" && foldMemo(composed).includes(core) ? composed : ref.paymentRef;
}
