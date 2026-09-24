import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Action, Button, useAction } from "@/ui";
import { vietQrPayload } from "../../../shared/vietqr.js";
import { bankByBin } from "../../../shared/banks.js";
import type { PaymentConfig } from "../../../shared/payment.js";

/**
 * Put money on the account before there is anything to pay.
 *
 * Nothing here is new machinery. A transfer is credited by the reference in
 * its memo, resolved to a person and not to a week, so money that arrives
 * against no bill simply takes the balance below zero and comes off the next
 * lunches. Proven against production with a simulated bank payment: a memo
 * carrying only the reference moved an account from -500.000 to -800.000 with
 * no statement involved.
 *
 * What was missing was the means. Somebody who owes nothing was shown no code
 * at all, so paying ahead meant asking an admin to record it by hand.
 *
 * The code carries no amount, deliberately. A dynamic VietQR fixes the sum at
 * scan time, and the whole point of paying ahead is that the payer picks it.
 *
 * Folded away by default: this is an option, not the thing the screen is for,
 * and somebody who owes nothing has come here to confirm that and leave.
 */
export function PayAhead({
  paymentRef,
  payment,
}: {
  paymentRef: string;
  payment: PaymentConfig;
}) {
  const [open, setOpen] = useState(false);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const copy = useAction(
    async (text: string) => {
      await clipboard?.writeText(text);
    },
    { success: "Copied" },
  );

  const account = payment.vietqr;
  // No `amountMinor`, so this is a static code: the payer types the sum.
  const payload = account
    ? vietQrPayload({
        bankBin: account.bankBin,
        accountNumber: account.accountNumber,
        paymentRef,
      })
    : null;

  if (!open) {
    return (
      <div>
        <Button variant="link" onClick={() => setOpen(true)}>
          Pay ahead
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-muted">Pay ahead</h3>
        <Button variant="link" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>

      <p className="max-w-prose text-sm text-muted">
        Send any amount with your reference in the message. It sits on your account and comes
        off your next lunches, and nobody has to record it by hand.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <p className="tabular text-xl font-semibold tracking-wider text-text">{paymentRef}</p>
        <Action
          variant="outline"
          size="sm"
          reason={
            clipboard
              ? null
              : "Your browser will not let the page copy. Select the reference and copy it by hand."
          }
          pending={copy.pending}
          onClick={() => void copy.run(paymentRef)}
        >
          Copy
        </Action>
      </div>

      {payload === null ? (
        <p className="max-w-prose text-sm text-muted">
          This office has not set up bank transfer yet, so there is no code to scan. Ask an
          admin how they would like to be paid.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Dark modules on a light field in both themes, as on the bill
              above: an inverted code is one a banking app may refuse. */}
          <div className="w-fit rounded-lg bg-accent-subtle p-3 text-accent-subtle-fg dark:bg-accent dark:text-accent-fg">
            <QRCodeSVG
              value={payload}
              marginSize={4}
              level="M"
              size={136}
              bgColor="transparent"
              fgColor="currentColor"
              title={`VietQR code to ${
                account?.accountName || account?.accountNumber
              }, reference ${paymentRef}, amount up to you`}
              className="h-auto max-w-full"
            />
          </div>
          <p className="text-sm text-muted">
            {`The code fills in ${
              bankByBin(account!.bankBin)?.shortName ?? account!.bankBin
            } and your reference. You type the amount.`}
          </p>
        </div>
      )}
    </div>
  );
}
