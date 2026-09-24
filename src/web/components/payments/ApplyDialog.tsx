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
import type { PaymentsPerson, UnmatchedPayment } from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { CANNOT_UNDO, accountState, arrivedLabel, landsOn } from "./labels.js";

/**
 * Whose money was it.
 *
 * A person, not a week. Money that arrived belongs to somebody, and what it
 * does to their weeks is the database's arithmetic rather than a choice an
 * admin makes: it pays off their oldest week first and whatever is left over
 * stays on their account. That also means a person who owes nothing can be
 * chosen, which used to be refused and is now simply a top-up that came in by
 * bank transfer with a memo nobody could read.
 *
 * Applying is not a correction to the payment that arrived: the trigger
 * credits on INSERT and on nothing else, so the only thing that moves an
 * account is a new payment carrying that person's reference. This dialog
 * therefore says plainly that it is about to write a second row, because an
 * admin who thinks they are re-filing one row will not expect to find two.
 */
export function ApplyDialog({
  payment,
  people,
  currency,
  timeZone,
  pending,
  onOpenChange,
  onApply,
}: {
  /** Null closes the dialog. */
  payment: UnmatchedPayment | null;
  people: PaymentsPerson[];
  currency: Currency;
  timeZone: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (person: PaymentsPerson) => void;
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

  // Everybody, including people who have left: money can arrive from somebody
  // whose membership was deactivated while they still owed for a week.
  const options: ComboboxOption[] = people.map((p) => ({
    value: p.profileId,
    label: `${p.name} · ${accountState(p.account, currency)}`,
    keywords: [p.shortCode, p.paymentRef],
  }));

  const chosen = people.find((p) => p.profileId === chosenId) ?? null;

  const pickReason =
    people.length === 0
      ? "Nobody has joined this office yet, so there is nobody to credit."
      : chosen === null
        ? "Choose whose money this is first."
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
                disabled={people.length === 0}
                placeholder="Choose a person"
                searchPlaceholder="Name, short code or reference"
                emptyMessage="Nobody in this office matches that."
              />
              <p className="text-sm text-muted">
                Where it goes is worked out from what they owe, oldest week first. Somebody who
                owes nothing can still be chosen: the money waits on their account.
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
                {`Credit ${formatMoney(payment.amountMinor, currency)} to ${chosen.name}, with the memo ${chosen.paymentRef}.`}
              </p>

              <p className="text-muted">
                {/* Said out loud because the row count is surprising and an
                    admin who expected one row would read two as a bug. */}
                {`This records a new payment carrying ${chosen.paymentRef}, because an account is only ever credited by a payment coming in. The one that arrived is marked as having been dealt with, so it leaves this list, and the money is counted once.`}
              </p>

              <p className="text-muted">
                {landsOn(chosen.name, chosen.account, payment.amountMinor, currency)}
              </p>

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
