import { useEffect, useId, useState } from "react";
import {
  Action,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type ComboboxOption,
} from "@/ui";
import {
  isSettled,
  outstandingMinor,
  type PaymentsPeriod,
  type PaymentsStatement,
  type UnmatchedPayment,
} from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { CANNOT_UNDO, arrivedLabel, weekLabel } from "./labels.js";

/**
 * Whose money was it.
 *
 * Applying is not a correction to the payment that arrived: the trigger
 * credits on INSERT and on nothing else, so the only thing that moves a
 * statement is a new payment carrying that person's reference. This dialog
 * therefore says plainly that it is about to write a second row, because an
 * admin who thinks they are re-filing one row will not expect to find two.
 */
export function ApplyDialog({
  payment,
  statements,
  periods,
  currency,
  timeZone,
  pending,
  onOpenChange,
  onApply,
}: {
  /** Null closes the dialog. */
  payment: UnmatchedPayment | null;
  statements: PaymentsStatement[];
  periods: PaymentsPeriod[];
  currency: Currency;
  timeZone: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (statement: PaymentsStatement) => void;
}) {
  const pickerId = useId();
  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [chosenId, setChosenId] = useState<string | null>(null);

  const paymentId = payment?.id ?? null;
  useEffect(() => {
    setStep("pick");
    setChosenId(null);
  }, [paymentId]);

  if (payment === null) return null;

  const periodOf = new Map(periods.map((p) => [p.periodId, p]));

  // Only weeks somebody is still being asked to pay. Money that arrived
  // belongs to a debt, and offering a settled week first is how an admin
  // credits the wrong one and creates a second problem out of the first.
  const owed = statements
    .filter((s) => !isSettled(s))
    .sort(
      (a, b) => b.periodId - a.periodId || a.name.localeCompare(b.name, "vi"),
    );

  const options: ComboboxOption[] = owed.map((s) => {
    const period = periodOf.get(s.periodId);
    const week = period ? weekLabel(period.periodStart, period.periodEnd) : "an earlier week";
    return {
      value: String(s.id),
      label: `${s.name} · ${week} · ${formatMoney(outstandingMinor(s), currency)} still to pay`,
      keywords: [s.shortCode, s.paymentRef],
    };
  });

  const chosen = owed.find((s) => String(s.id) === chosenId) ?? null;
  const chosenPeriod = chosen === null ? null : periodOf.get(chosen.periodId) ?? null;
  const chosenWeek =
    chosenPeriod === null ? "" : weekLabel(chosenPeriod.periodStart, chosenPeriod.periodEnd);

  const pickReason =
    owed.length === 0
      ? "Nobody is being asked to pay anything, so there is no week to credit."
      : chosen === null
        ? "Choose whose week this money belongs to first."
        : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Apply ${formatMoney(payment.amountMinor, currency)} to a person`}</DialogTitle>
          <DialogDescription>
            {`Arrived ${arrivedLabel(payment.receivedAt, timeZone)} via ${payment.provider}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Memo, as the bank sent it</span>
          <p className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm break-words text-text">
            {payment.memo === null || payment.memo.trim() === ""
              ? "No memo at all, which is why nothing could match it."
              : payment.memo}
          </p>
        </div>

        {step === "pick" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={pickerId} className="text-sm font-medium">
                Whose money is it?
              </label>
              <Combobox
                id={pickerId}
                options={options}
                value={chosenId}
                onChange={setChosenId}
                disabled={owed.length === 0}
                placeholder="Choose a person and week"
                searchPlaceholder="Name, short code or reference"
                emptyMessage="No outstanding week matches that."
              />
              <p className="text-sm text-muted">
                Only weeks somebody still owes are listed. Search by name, short code or
                reference.
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Action reason={pickReason} onClick={() => setStep("confirm")}>
                Review
              </Action>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && chosen !== null && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">
                {`Credit ${formatMoney(payment.amountMinor, currency)} to ${chosen.name} for ${chosenWeek}, with the memo ${chosen.paymentRef}.`}
              </p>

              <p className="text-muted">
                {/* Said out loud because the row count is surprising and an
                    admin who expected one row would read two as a bug. */}
                {`This records a new payment carrying ${chosen.paymentRef}, because a statement is only ever credited by a payment coming in. The one that arrived is then marked as ${chosen.name}'s, so it leaves this list, and the money is counted once.`}
              </p>

              {payment.amountMinor > outstandingMinor(chosen) && (
                <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
                  {`That is more than the ${formatMoney(
                    outstandingMinor(chosen),
                    currency,
                  )} ${chosen.name} still owes for that week. The extra stays on it and is not credited to any other.`}
                </p>
              )}

              <p className="text-muted">{CANNOT_UNDO}</p>
              <p className="text-muted">Nothing has been written yet. This is the write.</p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Action reason={null} pending={pending} onClick={() => onApply(chosen)}>
                {pending ? "Recording…" : "Record"}
              </Action>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
