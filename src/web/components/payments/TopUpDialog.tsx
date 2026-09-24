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
import type { PaymentsPerson } from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { CANNOT_UNDO, accountState, landsOn } from "./labels.js";
import { RecordFields, draftProblem, readAmount, type RecordDraft } from "./RecordFields.js";

/**
 * Money from somebody who is not behind.
 *
 * It has no statement to attach to, and until `money_belongs_to_a_person` it
 * had nowhere to go at all: paying before you had eaten meant paying a week
 * that did not exist yet, and paying more than a week asked for destroyed the
 * excess. A credit is now just a negative balance, so this writes exactly the
 * same row the bank's own money arrives as, and next week's meals eat into it.
 *
 * Separate from the row's own dialog because the person is the question here.
 * Somebody who ate nothing this week has no row to start from, and they are
 * precisely the person who pays ahead.
 */
export function TopUpDialog({
  open,
  people,
  currency,
  pending,
  onOpenChange,
  onRecord,
}: {
  open: boolean;
  people: PaymentsPerson[];
  currency: Currency;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onRecord: (person: PaymentsPerson, draft: RecordDraft) => void;
}) {
  const pickerId = useId();
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setChosenId(null);
    setAmount("");
    setMemo("");
  }, [open]);

  if (!open) return null;

  // Somebody deactivated is not paying ahead for lunches they will not eat.
  const choices = people.filter((p) => p.active);
  const chosen = choices.find((p) => p.profileId === chosenId) ?? null;
  const options: ComboboxOption[] = choices.map((p) => ({
    value: p.profileId,
    label: `${p.name} · ${accountState(p.account, currency)}`,
    keywords: [p.shortCode, p.paymentRef],
  }));

  const amountMinor = readAmount(amount) ?? 0;
  const reason =
    choices.length === 0
      ? "Nobody has joined this office yet."
      : chosen === null
        ? "Choose whose money this is first."
        : draftProblem(amount, memo);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record a top-up</DialogTitle>
          <DialogDescription>
            Money from somebody who owes nothing yet. It sits on their account and comes off their
            next lunches.
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={pickerId} className="text-sm font-medium">
                  Whose money is it?
                </label>
                <Combobox
                  id={pickerId}
                  options={options}
                  value={chosenId}
                  onChange={(value) => {
                    setChosenId(value);
                    // The reference is what the database matches on, so it is
                    // filled in for them the moment the person is known.
                    setMemo(choices.find((p) => p.profileId === value)?.paymentRef ?? "");
                  }}
                  disabled={choices.length === 0}
                  placeholder="Choose a person"
                  searchPlaceholder="Name, short code or reference"
                  emptyMessage="Nobody in this office matches that."
                />
                <p className="text-sm text-muted">
                  Anybody can be topped up, including somebody who is already in credit.
                </p>
              </div>

              <RecordFields
                amount={amount}
                memo={memo}
                currency={currency}
                memoHint={
                  chosen === null
                    ? "The reference decides who is credited. Choose a person and it is filled in."
                    : `The reference decides who is credited. ${chosen.name}'s is ${chosen.paymentRef}.`
                }
                onAmount={setAmount}
                onMemo={setMemo}
              />

              <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
                {CANNOT_UNDO}
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Action reason={reason} onClick={() => setStep("confirm")}>
                Review
              </Action>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && chosen !== null && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">
                {`Credit ${formatMoney(amountMinor, currency)} to ${chosen.name}, with the memo ${memo.trim()}.`}
              </p>
              <p className="text-muted">{landsOn(chosen.name, chosen.account, amountMinor, currency)}</p>
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
                onClick={() => onRecord(chosen, { amountMinor, memo: memo.trim() })}
              >
                {pending ? "Recording…" : "Record the top-up"}
              </Action>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
