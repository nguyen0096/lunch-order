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
import { accountState, arrivedLabel, landsOn } from "./labels.js";

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
 * The same dialog moves a payment that landed on the wrong colleague. Either
 * way it is the one row that moves, through `move_payment`, which redraws both
 * people's weeks and writes the change to `payment_corrections`.
 */
export function ApplyDialog({
  payment,
  from,
  people,
  currency,
  timeZone,
  pending,
  onOpenChange,
  onApply,
}: {
  /** Null closes the dialog. */
  payment: UnmatchedPayment | null;
  /** Whose account it is on now. Null for money that matched nobody. */
  from: PaymentsPerson | null;
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
  const options: ComboboxOption[] = people
    .filter((p) => p.profileId !== from?.profileId)
    .map((p) => ({
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
          <DialogTitle>
            {from === null
              ? `Apply ${formatMoney(payment.amountMinor, currency)} to a person`
              : `Move ${formatMoney(payment.amountMinor, currency)} off ${from.name}`}
          </DialogTitle>
          <DialogDescription>
            {`Arrived ${arrivedLabel(payment.receivedAt, timeZone)} via ${payment.provider}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Memo, as the bank sent it</span>
          <p className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm break-words text-text">
            {payment.memo === null || payment.memo.trim() === ""
              ? from === null
                ? "No memo at all, which is why nothing could match it."
                : "No memo at all."
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
                {from === null
                  ? `Put ${formatMoney(payment.amountMinor, currency)} on ${chosen.name}'s account.`
                  : `Move ${formatMoney(payment.amountMinor, currency)} from ${from.name} to ${chosen.name}.`}
              </p>

              <p className="text-muted">
                {from === null
                  ? "The payment that arrived is the one that moves, so the money is counted once and leaves this list."
                  : `${from.name}'s weeks are redrawn without it.`}
                {" The change is kept on the record with your name on it."}
              </p>

              <p className="text-muted">
                {landsOn(chosen.name, chosen.account, payment.amountMinor, currency)}
              </p>

              <p className="text-muted">Nothing has been written yet. This is the write.</p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Action reason={null} pending={pending} onClick={() => onApply(chosen)}>
                {pending ? "Moving…" : from === null ? "Apply" : "Move"}
              </Action>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
