import { useEffect, useId, useState } from "react";
import {
  Action,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui";
import { outstandingMinor, type PaymentsPeriod, type PaymentsStatement } from "../../api.js";
import { formatMoney, parseMoneyInput, type Currency } from "../../../shared/money.js";
import { CANNOT_UNDO, meals, memoCarriesRef, weekLabel } from "./labels.js";

export type RecordDraft = { amountMinor: number; memo: string };

/**
 * The two ways one person's week stops being owed, behind one confirmation.
 *
 * Recording is a write nothing can reverse -- `payments_apply_on_insert` is an
 * AFTER INSERT trigger, so no update or delete gives the money back, and
 * `amount_minor > 0` forbids a corrective row -- so the amount and the person
 * are read back in a sentence before the write rather than reported in a toast
 * afterwards. Publishing a menu earns a confirmation for the same reason: it
 * is the other action that cannot be walked back.
 *
 * Waiving sits in here rather than on the row because it answers the same
 * question and must never be mistaken for the other answer. It is not money.
 */
export function RecordDialog({
  statement,
  period,
  currency,
  pending,
  onOpenChange,
  onRecord,
  onWaive,
}: {
  /** Null closes the dialog. The statement is the whole subject of it. */
  statement: PaymentsStatement | null;
  period: PaymentsPeriod | null;
  currency: Currency;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onRecord: (draft: RecordDraft) => void;
  onWaive: () => void;
}) {
  const amountId = useId();
  const memoId = useId();
  const [step, setStep] = useState<"form" | "record" | "waive">("form");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const outstanding = statement === null ? 0 : outstandingMinor(statement);

  // Keyed on the id rather than the object: a refetch hands down a fresh
  // statement for the same person, and re-seeding on that would wipe what the
  // admin is halfway through typing.
  const statementId = statement?.id ?? null;
  useEffect(() => {
    if (statement === null) return;
    setStep("form");
    setAmount(outstandingMinor(statement) > 0 ? String(outstandingMinor(statement)) : "");
    setMemo(statement.paymentRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [statementId]);

  if (statement === null || period === null) return null;

  const parsed = readAmount(amount);
  const reason = amountProblem(parsed) ?? memoProblem(memo);
  const amountMinor = parsed ?? 0;
  const week = weekLabel(period.periodStart, period.periodEnd);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`${statement.name} · ${week}`}</DialogTitle>
          <DialogDescription>
            {outstanding > 0
              ? `${meals(statement.mealCount)}, ${formatMoney(outstanding, currency)} still to pay.`
              : `${meals(statement.mealCount)}, nothing still to pay.`}
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={amountId} className="text-sm font-medium">
                  Amount received
                </label>
                <input
                  id={amountId}
                  value={amount}
                  inputMode="numeric"
                  autoComplete="off"
                  onChange={(e) => setAmount(e.target.value)}
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
                  onChange={(e) => setMemo(e.target.value)}
                  className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-text"
                />
                <p className="text-sm text-muted">
                  {/* The memo is not decoration: it is the whole matching rule.
                      The trigger credits the statement whose reference appears
                      inside it, so a mistyped one credits somebody else. */}
                  {`The reference decides who is credited. ${statement.name}'s is ${statement.paymentRef}.`}
                </p>
              </div>

              <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
                {CANNOT_UNDO}
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Action reason={reason} onClick={() => setStep("record")}>
                Review
              </Action>
            </DialogFooter>

            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">Not asking for this week?</h3>
              <p className="text-sm text-muted">
                Waiving records that {statement.name} is not being asked to pay. It credits
                nothing, so it is never the way to record money that arrived.
              </p>
              <Action
                reason={
                  statement.status === "waived"
                    ? "This week is already waived."
                    : null
                }
                variant="outline"
                className="self-start"
                onClick={() => setStep("waive")}
              >
                Waive this week
              </Action>
            </div>
          </>
        )}

        {step === "record" && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">
                {`Credit ${formatMoney(amountMinor, currency)} to ${statement.name} for ${week}, with the memo ${memo.trim()}.`}
              </p>

              {!memoCarriesRef(memo, statement.paymentRef) && (
                <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
                  {`This memo does not contain ${statement.paymentRef}, so it will not land on this week. It will credit whoever else's reference it does contain, or nobody.`}
                </p>
              )}

              {amountMinor > outstanding && (
                <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
                  {outstanding > 0
                    ? `That is more than the ${formatMoney(outstanding, currency)} still to pay. The extra stays on this week and is not credited to any other.`
                    : "Nothing is still to pay on this week, so all of this is an overpayment and is not credited to any other week."}
                </p>
              )}

              <p className="text-muted">{CANNOT_UNDO}</p>
              <p className="text-muted">Nothing has been written yet. This is the write.</p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Action
                reason={null}
                pending={pending}
                onClick={() => onRecord({ amountMinor, memo: memo.trim() })}
              >
                {pending ? "Recording…" : "Record"}
              </Action>
            </DialogFooter>
          </>
        )}

        {step === "waive" && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">
                {`Stop asking ${statement.name} for ${week}.`}
              </p>
              <p className="text-muted">
                {`No money is recorded and nothing is credited: ${formatMoney(
                  statement.paidMinor,
                  currency,
                )} received stays as it is. The week simply stops being owed, and ${statement.name} sees it as waived rather than paid.`}
              </p>
              <p className="text-muted">
                This screen cannot put it back. Undoing a waiver means changing the statement in
                the database by hand.
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Action reason={null} pending={pending} variant="danger" onClick={onWaive}>
                {pending ? "Waiving…" : "Waive"}
              </Action>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Null when there is no number in there at all. Never formats money by hand. */
function readAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return parseMoneyInput(trimmed);
  } catch {
    return null;
  }
}

/** Mirrors `payments_amount_minor_check`, which is `> 0`, before the round trip. */
function amountProblem(parsed: number | null): string | null {
  if (parsed === null) return "Type the amount that arrived first.";
  if (parsed <= 0) return "A payment has to be more than nothing.";
  if (!Number.isInteger(parsed)) return "The amount has to be a whole number of dong.";
  return null;
}

function memoProblem(memo: string): string | null {
  if (memo.trim() === "") {
    return "A payment with no memo matches nobody, so it would credit no week at all.";
  }
  return null;
}
