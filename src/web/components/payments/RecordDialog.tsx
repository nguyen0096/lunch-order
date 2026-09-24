import { useEffect, useState } from "react";
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
import {
  creditMinor,
  owedMinor,
  type PaymentsPeriod,
  type PaymentsPerson,
} from "../../api.js";
import type { PersonRow } from "./PeopleRows.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { CANNOT_UNDO, landsOn, meals, memoCarriesRef, weekLabel } from "./labels.js";
import { RecordFields, draftProblem, readAmount, type RecordDraft } from "./RecordFields.js";

/**
 * Money from one person, and the one thing that is not money.
 *
 * The subject is the person, not the week. What they owe is their account, so
 * that is what the amount is pre-filled with and what the confirmation reads
 * back; a week is no longer a debt in its own right and asking for one week
 * from somebody three weeks behind is how the old screen left money on the
 * table.
 *
 * Recording is a write nothing can reverse -- `payments_apply_on_insert` is an
 * AFTER INSERT trigger, so no update or delete gives the money back, and
 * `amount_minor > 0` forbids a corrective row -- so the amount and the person
 * are read back in a sentence before the write rather than reported in a toast
 * afterwards.
 *
 * Waiving stays here, and stays a week: it says nobody is being asked for that
 * week's meals. It must never be mistaken for the other answer. It is not
 * money.
 */
export function RecordDialog({
  row,
  period,
  currency,
  pending,
  onOpenChange,
  onRecord,
  onWaive,
}: {
  /** Null closes the dialog. The person is the whole subject of it. */
  row: PersonRow | null;
  period: PaymentsPeriod | null;
  currency: Currency;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onRecord: (draft: RecordDraft) => void;
  onWaive: () => void;
}) {
  const [step, setStep] = useState<"form" | "record" | "waive">("form");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  // Keyed on the person rather than the object: a refetch hands down a fresh
  // row for the same person, and re-seeding on that would wipe what the admin
  // is halfway through typing.
  const profileId = row?.person.profileId ?? null;
  useEffect(() => {
    if (row === null) return;
    setStep("form");
    const outstanding = owedMinor(row.person.account);
    setAmount(outstanding > 0 ? String(outstanding) : "");
    setMemo(row.person.paymentRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [profileId]);

  if (row === null) return null;

  const { person, statement } = row;
  const reason = draftProblem(amount, memo);
  const amountMinor = readAmount(amount) ?? 0;
  const week = period === null ? "" : weekLabel(period.periodStart, period.periodEnd);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{person.name}</DialogTitle>
          <DialogDescription>{accountSentence(person, currency)}</DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <>
            <div className="flex flex-col gap-4">
              <RecordFields
                amount={amount}
                memo={memo}
                currency={currency}
                // The memo is not decoration: it is what the database matches
                // on, and what makes it redraw this person's weeks.
                memoHint={`The reference decides who is credited. ${person.name}'s is ${person.paymentRef}.`}
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
              <Action reason={reason} onClick={() => setStep("record")}>
                Review
              </Action>
            </DialogFooter>

            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">Not asking for this week?</h3>
              <p className="text-sm text-muted">
                {statement === null
                  ? `Nothing was billed to ${person.name} for ${week}.`
                  : `Waiving records that ${person.name} is not being asked to pay for ${week}: ${meals(
                      statement.mealCount,
                    )}, ${formatMoney(statement.mealsMinor, currency)}. It credits nothing, so it is never the way to record money that arrived.`}
              </p>
              <Action
                reason={waiveReason(row, week)}
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
                {`Credit ${formatMoney(amountMinor, currency)} to ${person.name}, with the memo ${memo.trim()}.`}
              </p>

              {!memoCarriesRef(memo, person.paymentRef) && (
                <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
                  {`This memo does not contain ${person.paymentRef}. The money is recorded as ${person.name}'s either way, but the database matches on the memo, so one carrying somebody else's reference moves it to them.`}
                </p>
              )}

              <p className="text-muted">{landsOn(person.name, person.account, amountMinor, currency)}</p>

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

        {step === "waive" && statement !== null && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">{`Stop asking ${person.name} for ${week}.`}</p>
              <p className="text-muted">
                {`No money is recorded and nothing is credited: ${formatMoney(
                  statement.mealsMinor,
                  currency,
                )} simply stops being charged, so it leaves what ${person.name} owes and they see the week as waived rather than paid.`}
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

/** What the person owes, which is their account and never one week. */
function accountSentence(person: PaymentsPerson, currency: Currency): string {
  const owed = owedMinor(person.account);
  if (owed > 0) {
    return `Owes ${formatMoney(owed, currency)}. That is every week they have eaten, not only this one.`;
  }
  const credit = creditMinor(person.account);
  if (credit > 0) {
    return `Nothing outstanding, and ${formatMoney(credit, currency)} already in credit. More is a top-up.`;
  }
  return "Nothing outstanding. Anything recorded here is a top-up against their next lunches.";
}

/** Why this week cannot be waived. A week nobody was billed for is not one. */
function waiveReason(row: PersonRow, week: string): string | null {
  if (row.statement === null) {
    return `There is no statement for ${week}, so there is nothing to stop asking for.`;
  }
  if (row.statement.status === "waived") return "This week is already waived.";
  return null;
}
