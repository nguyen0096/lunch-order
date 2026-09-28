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
  type PersonPayment,
} from "../../api.js";
import type { PersonRow } from "./PeopleRows.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import {
  CANNOT_UNDO,
  arrivedLabel,
  landsOn,
  meals,
  memoCarriesRef,
  weekLabel,
} from "./labels.js";
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
 * Recording is a write nobody edits afterwards -- an admin holds no UPDATE or
 * DELETE on payments, and a mistake is voided, on the record, rather than
 * erased -- so the amount and the person are read back in a sentence before
 * the write rather than reported in a toast afterwards.
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
  payments,
  timeZone,
  onMove,
  onVoid,
}: {
  /** Null closes the dialog. The person is the whole subject of it. */
  row: PersonRow | null;
  period: PaymentsPeriod | null;
  currency: Currency;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onRecord: (draft: RecordDraft) => void;
  onWaive: () => void;
  /** What is on their account, newest first. Null while it loads. */
  payments: PersonPayment[] | null;
  timeZone: string;
  onMove: (payment: PersonPayment) => void;
  onVoid: (payment: PersonPayment, reason: string) => void;
}) {
  const [step, setStep] = useState<"form" | "record" | "waive" | "void">("form");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [voiding, setVoiding] = useState<PersonPayment | null>(null);
  const [voidReason, setVoidReason] = useState("");

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

            <PersonPayments
              name={person.name}
              payments={payments}
              currency={currency}
              timeZone={timeZone}
              busy={pending}
              onMove={onMove}
              onVoid={(payment) => {
                setVoiding(payment);
                setVoidReason("");
                setStep("void");
              }}
            />
          </>
        )}

        {step === "void" && voiding !== null && (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-base">
                {`Void ${formatMoney(voiding.amountMinor, currency)} recorded by hand ${arrivedLabel(voiding.receivedAt, timeZone)}.`}
              </p>
              <p className="text-muted">
                {`It stops counting towards ${person.name}'s account and their weeks are redrawn without it. The payment stays on the record, marked void, with your name and the reason.`}
              </p>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium">Why</span>
                <input
                  value={voidReason}
                  maxLength={200}
                  placeholder="Recorded twice"
                  className="h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text placeholder:text-subtle"
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </label>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Action
                reason={voidReason.trim() === "" ? "Say why it is being voided." : null}
                pending={pending}
                variant="danger"
                onClick={() => {
                  onVoid(voiding, voidReason.trim());
                  setStep("form");
                }}
              >
                {pending ? "Voiding…" : "Void"}
              </Action>
            </DialogFooter>
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

/**
 * The money already on this person's account, where a mistake is put right.
 *
 * Move is for money that is somebody else's; void is for a payment an admin
 * recorded by hand that never happened, so it is offered on manual rows only.
 */
function PersonPayments({
  name,
  payments,
  currency,
  timeZone,
  busy,
  onMove,
  onVoid,
}: {
  name: string;
  payments: PersonPayment[] | null;
  currency: Currency;
  timeZone: string;
  busy: boolean;
  onMove: (payment: PersonPayment) => void;
  onVoid: (payment: PersonPayment) => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-sm font-medium">{`Payments on ${name}'s account`}</h3>
      {payments === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : payments.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ul aria-label={`Payments on ${name}'s account`} className="flex flex-col gap-2">
          {payments.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="tabular text-sm font-medium">
                  {formatMoney(p.amountMinor, currency)}
                </span>
                <span className="text-xs text-muted">
                  {`${arrivedLabel(p.receivedAt, timeZone)} via ${p.provider}`}
                </span>
              </div>
              <div className="flex gap-2">
                <Action reason={null} pending={busy} variant="outline" onClick={() => onMove(p)}>
                  Move
                </Action>
                {p.voidable && (
                  <Action reason={null} pending={busy} variant="outline" onClick={() => onVoid(p)}>
                    Void
                  </Action>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
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
