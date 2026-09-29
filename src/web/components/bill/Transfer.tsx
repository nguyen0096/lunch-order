// The one dependency this screen adds, chosen over `qrcode`, `uqr` and
// `qr-code-styling` on three counts: it ships no runtime dependencies of its
// own, it draws SVG rather than canvas (so the code scales, prints, survives a
// screenshot and needs no canvas shim under jsdom), and its colours are plain
// paint strings, which lets the code be drawn in `currentColor` from the design
// tokens instead of a hardcoded black. It encodes; the payload is ours.
import { QRCodeSVG } from "qrcode.react";
import { CopyIcon } from "lucide-react";
import { Action, useAction } from "@/ui";
import { vietQrAccepts, vietQrPayload } from "../../../shared/vietqr.js";
import { bankByBin } from "../../../shared/banks.js";
import { formatMoney, plainAmount, type Currency } from "../../../shared/money.js";
import type { PaymentConfig } from "../../../shared/payment.js";
import { phonePlatform } from "../../phone.js";
import { OpenBankApp, SaveQr } from "./PayFromPhone.js";

/**
 * One transfer, in one block, in every state.
 *
 * The code first, then the four fields it encodes, each one copyable. The list
 * is not a fallback bolted under the code: it is the readout of what the code
 * says, which is also what somebody types when their bank will not scan. There
 * were two components here, one for a bill and one for a top-up, drawing the
 * same payload in two layouts with the amount printed twice.
 *
 * The amount is shown, not edited. A field to pre-set it was built and removed:
 * the payer's own banking app asks for or shows the amount at the moment of
 * paying, so a control here is machinery for a decision made one step later
 * anyway. The code still carries the figure when something is owed, because
 * scan-and-confirm is the common case; it carries none when nothing is, and
 * the bank then asks.
 *
 * It says which of the two it is. The same code under a balance of zero reads
 * as a demand for money nobody owes, and somebody in credit is the likeliest
 * person of all to top up again: the heading is the difference between a bill
 * to settle and an account to put money on.
 */
export function Transfer({
  paymentRef,
  owedMinor,
  currency,
  payment,
}: {
  paymentRef: string;
  /** What is still to pay. Zero when settled or in credit. */
  owedMinor: number;
  currency: Currency;
  payment: PaymentConfig;
}) {
  const account = payment.vietqr;
  const inDong = vietQrAccepts(currency);
  const payload = account && inDong
    ? vietQrPayload({
        bankBin: account.bankBin,
        accountNumber: account.accountNumber,
        // Zero makes a static code, which is what an account with nothing
        // owing wants: the payer's own bank asks them for the sum.
        amountMinor: owedMinor,
        paymentRef,
      })
    : null;

  const owing = owedMinor > 0;
  const platform = phonePlatform();
  const payee = account ? account.accountName || account.accountNumber : "";
  const bank = account ? bankName(account.bankBin) : "";
  const caption = owing
    ? [formatMoney(owedMinor, currency), paymentRef, `${payee}, ${bank}`]
    : [paymentRef, `${payee}, ${bank}`];
  const summary = account
    ? `${owing ? `Pay ${formatMoney(owedMinor, currency)}` : "Transfer"} to ${payee}, ${bank} ${
        account.accountNumber
      }. Reference: ${paymentRef}`
    : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-text">{owing ? "Pay by transfer" : "Top up"}</h3>
        {!owing && (
          <p className="max-w-prose text-sm text-muted">
            What you send sits on your account and comes off your next lunches.
          </p>
        )}
      </div>

      {platform !== null && account !== null && payload !== null && (
        <OpenBankApp
          platform={platform}
          owedMinor={owedMinor}
          currency={currency}
          paymentRef={paymentRef}
        />
      )}

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
        {account === null ? null : !inDong ? (
          <p className="max-w-prose text-sm text-muted sm:w-52 sm:shrink-0">
            {`A VietQR code can only ask for dong, and this office bills in ${currency.code}, so there is no code. Use the details here.`}
          </p>
        ) : payload === null ? (
          <p className="max-w-prose text-sm text-muted sm:w-52 sm:shrink-0">
            The bank details saved for this office are not a valid account, so the code
            cannot be built. Ask an admin to check them.
          </p>
        ) : (
          /* The plate keeps dark modules on a light field in BOTH themes, which
             is the polarity every scanner assumes. Inheriting `surface` would
             invert the code after dark, and an inverted QR is one a banking app
             may simply refuse to read. */
          <div className="flex w-fit shrink-0 flex-col items-start gap-3">
            <div className="w-fit shrink-0 rounded-lg bg-accent-subtle p-3 text-accent-subtle-fg dark:bg-accent dark:text-accent-fg">
              <QRCodeSVG
                value={payload}
                // The specification's four-module quiet zone. The library defaults
                // to none, which produces a code that reads on a phone held still
                // and fails on one held at an angle.
                marginSize={4}
                // M survives a fingerprint on the screen; H would push the code to
                // a denser version for no benefit at this size.
                level="M"
                size={168}
                bgColor="transparent"
                fgColor="currentColor"
                title={
                  owedMinor > 0
                    ? `VietQR code for ${formatMoney(owedMinor, currency)} to ${
                        account.accountName || account.accountNumber
                      }, reference ${paymentRef}`
                    : `VietQR code to ${
                        account.accountName || account.accountNumber
                      }, reference ${paymentRef}, amount up to you`
                }
                // `size` is the intrinsic geometry of the drawing, not a layout
                // choice; the class is what keeps it inside a 390px screen.
                className="h-auto max-w-full"
              />
            </div>
            <SaveQr payload={payload} paymentRef={paymentRef} caption={caption} summary={summary} />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {/* Only when there is a figure. A row reading "Any amount" with a
              caption explaining that your bank will ask for it restated the
              headline directly above it, which already says there is nothing to
              pay. The list drops to three rows and says nothing false. */}
          {account !== null && owedMinor > 0 && (
            <Row label="Amount">
              <div className="flex flex-wrap items-center gap-3">
                <p className="tabular text-text">{formatMoney(owedMinor, currency)}</p>
                <CopyButton
                  thing="amount"
                  // Digits only. A grouping dot in a bank's amount field is
                  // read as a decimal point by some of them, and on VND that
                  // turns 180.000 into a hundred and eighty dong.
                  value={plainAmount(owedMinor, currency)}
                  success="Amount copied"
                />
              </div>
              <p className="max-w-prose text-sm text-muted">
                Send more if you like; anything above this stays on your account.
              </p>
            </Row>
          )}

          <Row label="Reference">
            <div className="flex flex-wrap items-center gap-3">
              <p className="tabular font-semibold tracking-wide text-text">{paymentRef}</p>
              <CopyButton thing="reference" value={paymentRef} success="Reference copied" />
            </div>
            {/* The failure moved. With a code filling the memo in, the common
                mistake is no longer forgetting to type the reference, it is
                typing over it. SePay syncs only memos carrying LUNCH, so a
                transfer without it is not money an admin can chase: it is money
                nobody here can see. */}
            <p className="max-w-prose text-sm text-muted">
              Keep this in the transfer message. Without it the payment never reaches your
              account here.
            </p>
          </Row>

          {account === null ? (
            <p className="max-w-prose text-sm text-muted">
              This office has not set up bank transfer yet. Ask an admin how they would like
              to be paid.
            </p>
          ) : (
            <>
              <Row label="Account">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="tabular text-text">{account.accountNumber}</p>
                  <CopyButton
                    thing="account number"
                    value={account.accountNumber}
                    success="Account number copied"
                  />
                </div>
                {/* Not a row and not copyable: the name is not in the payload at
                    all, NAPAS resolves it at the bank. It is here to catch a
                    mistyped BIN, which otherwise produces a code that scans
                    perfectly and pays a stranger. */}
                {account.accountName !== "" && (
                  <p className="text-sm text-muted">{account.accountName}</p>
                )}
              </Row>

              <Row label="Bank">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-text">{bankName(account.bankBin)}</p>
                  <CopyButton
                    thing="bank"
                    value={bankName(account.bankBin)}
                    success="Bank copied"
                  />
                </div>
              </Row>
            </>
          )}

          {payment.note !== null && (
            <p className="max-w-prose text-sm text-muted">{payment.note}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- parts */

/**
 * One field of the payload: its name, then what it says.
 *
 * The label sits above the value on a phone and beside it on a desktop, where
 * there is room for a column of names to be read down.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
      <p className="text-sm text-muted sm:pt-0.5">{label}</p>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function CopyButton({
  thing,
  value,
  success,
}: {
  /** Names the control and the sentence it falls back to, e.g. "reference". */
  thing: string;
  value: string;
  success: string;
}) {
  // Read at render: a page served over plain http, or an older browser, has no
  // clipboard at all, and a Copy button that does nothing is worse than one
  // that says why it cannot.
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const copy = useAction(
    async (text: string) => {
      await clipboard?.writeText(text);
    },
    { success },
  );

  return (
    <Action
      variant="outline"
      size="icon-sm"
      reason={
        clipboard
          ? null
          : `Your browser will not let the page copy. Select the ${thing} and copy it by hand.`
      }
      pending={copy.pending}
      // The label is the only thing naming this control now, so it has to say
      // which of four it is rather than "Copy".
      aria-label={`Copy the ${thing}`}
      title={`Copy the ${thing}`}
      onClick={() => void copy.run(value)}
    >
      <CopyIcon />
    </Action>
  );
}

/** A BIN is not something anybody can type into a banking app. */
function bankName(bin: string): string {
  return bankByBin(bin)?.shortName ?? bin;
}
