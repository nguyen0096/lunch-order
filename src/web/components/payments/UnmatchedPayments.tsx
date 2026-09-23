import { useId } from "react";
import { Action, Badge, EmptyState } from "@/ui";
import type { UnmatchedPayment } from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { arrivedLabel } from "./labels.js";

/**
 * Money that arrived and landed on nobody.
 *
 * This is the job. A list of who has paid can be read off the statements, but
 * a payment whose memo matched no reference changes nothing anywhere and
 * announces itself nowhere, so it sits at the top of the screen until somebody
 * works out whose it was. Everything an admin needs for that is on the card:
 * what arrived, when, and the memo exactly as the bank sent it, because the
 * clue is usually a name or a typo inside it.
 */
export function UnmatchedPayments({
  payments,
  currency,
  timeZone,
  busy,
  onApply,
}: {
  payments: UnmatchedPayment[];
  currency: Currency;
  timeZone: string;
  busy: boolean;
  onApply: (payment: UnmatchedPayment) => void;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          Money that matched nobody
        </h2>
        {payments.length > 0 && <Badge variant="warn">{payments.length}</Badge>}
      </div>

      {payments.length === 0 ? (
        <EmptyState heading="Every payment found its person">
          A payment whose memo carries nobody's reference lands here, with what the bank sent, so
          you can work out whose it was.
        </EmptyState>
      ) : (
        <ul aria-label="Unmatched payments" className="flex flex-col gap-3">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="tabular text-lg font-semibold">
                  {formatMoney(payment.amountMinor, currency)}
                </p>
                <p className="text-sm text-muted">
                  {`Arrived ${arrivedLabel(payment.receivedAt, timeZone)} via ${payment.provider}.`}
                </p>
                {/* Verbatim, and monospaced. The memo is evidence, so it is
                    shown as received rather than tidied up: the reference
                    somebody mistyped is the thing an admin is reading for. */}
                <p className="mt-1 rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm break-words text-text">
                  {payment.memo === null || payment.memo.trim() === ""
                    ? "No memo at all, which is why nothing could match it."
                    : payment.memo}
                </p>
              </div>

              <Action
                reason={null}
                pending={busy}
                variant="outline"
                className="self-start"
                onClick={() => onApply(payment)}
              >
                Apply to a person
              </Action>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
