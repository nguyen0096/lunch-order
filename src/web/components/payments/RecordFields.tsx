import { useId } from "react";
import { formatMoney, parseMoneyInput, type Currency } from "../../../shared/money.js";

export type RecordDraft = { amountMinor: number; memo: string };

/**
 * The amount and the memo, wherever money is recorded by hand.
 *
 * Shared rather than repeated because the two boxes are one rule: the amount
 * is read by the caterer's own shorthand and the memo is what the database
 * matches on. Two copies of that would eventually disagree about what `180k`
 * means, and the disagreement would be about money.
 */
export function RecordFields({
  amount,
  memo,
  currency,
  memoHint,
  onAmount,
  onMemo,
}: {
  amount: string;
  memo: string;
  currency: Currency;
  /** What this memo decides, in the words of whoever is recording. */
  memoHint: string;
  onAmount: (value: string) => void;
  onMemo: (value: string) => void;
}) {
  const amountId = useId();
  const memoId = useId();
  const parsed = readAmount(amount);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={amountId} className="text-sm font-medium">
          Amount received
        </label>
        <input
          id={amountId}
          value={amount}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => onAmount(e.target.value)}
          className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 tabular text-text"
        />
        <p className="text-sm text-muted">
          {parsed === null
            ? "Whole dong, or the shorthand the caterer uses: 180k is 180.000 ₫."
            : `That is ${formatMoney(parsed, currency)}.`}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={memoId} className="text-sm font-medium">
          Memo
        </label>
        <input
          id={memoId}
          value={memo}
          autoComplete="off"
          onChange={(e) => onMemo(e.target.value)}
          className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-text"
        />
        <p className="text-sm text-muted">{memoHint}</p>
      </div>
    </>
  );
}

/** Null when there is no number in there at all. Never formats money by hand. */
export function readAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return parseMoneyInput(trimmed);
  } catch {
    return null;
  }
}

/** Why this pair cannot be recorded yet, or null. Mirrors the table's checks. */
export function draftProblem(amount: string, memo: string): string | null {
  const parsed = readAmount(amount);
  // `payments_amount_minor_check` is `> 0`, and saying so before the round
  // trip is cheaper than a failed write nobody can undo.
  if (parsed === null) return "Type the amount that arrived first.";
  if (parsed <= 0) return "A payment has to be more than nothing.";
  if (!Number.isInteger(parsed)) return "The amount has to be a whole number of dong.";
  if (memo.trim() === "") {
    return "A payment with no memo matches nobody, so nothing would redraw their weeks.";
  }
  return null;
}
