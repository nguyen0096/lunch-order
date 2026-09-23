// The one dependency this screen adds, chosen over `qrcode`, `uqr` and
// `qr-code-styling` on three counts: it ships no runtime dependencies of its
// own, it draws SVG rather than canvas (so the code scales, prints, survives a
// screenshot and needs no canvas shim under jsdom), and its colours are plain
// paint strings, which lets the code be drawn in `currentColor` from the design
// tokens instead of a hardcoded black. It encodes; the payload is ours.
import { QRCodeSVG } from "qrcode.react";
import { Action, Badge, useAction } from "@/ui";
import { vietQrPayload } from "../../../shared/vietqr.js";
import { bankByBin } from "../../../shared/banks.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import type { PaymentConfig } from "../../../shared/payment.js";

/**
 * How to pay: the reference first, the code under it.
 *
 * The reference leads because it is the part that goes wrong, and getting it
 * wrong is not something anybody can put right afterwards. SePay syncs only
 * transactions whose memo carries LUNCH, because the office account is often
 * also somebody's own, so a transfer without the reference never reaches this
 * app at all: it is not unmatched money waiting on the Payments screen, it is
 * money nobody here can see.
 */
export function PaymentDetails({
  paymentRef,
  amountMinor,
  currency,
  payment,
}: {
  paymentRef: string;
  /** What is still outstanding. The code carries it so nobody re-types it. */
  amountMinor: number;
  currency: Currency;
  payment: PaymentConfig;
}) {
  // Read at render: a page served over plain http, or an older browser, has no
  // clipboard at all, and a Copy button that does nothing is worse than one
  // that says why it cannot.
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;

  const copy = useAction(
    async (text: string) => {
      await clipboard?.writeText(text);
    },
    { success: "Copied" },
  );

  const account = payment.vietqr;
  const payload = account
    ? vietQrPayload({
        bankBin: account.bankBin,
        accountNumber: account.accountNumber,
        amountMinor,
        paymentRef,
      })
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-muted">Payment reference</h3>
          <Badge variant="accent">Required</Badge>
        </div>
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
        <p className="max-w-prose text-sm text-muted">
          Put this in the transfer message. Only transfers carrying it reach this app, so
          one sent without it leaves your bill unpaid with nothing for an admin to find.
        </p>
      </div>

      {account === null ? (
        <p className="max-w-prose text-sm text-muted">
          This office has not set up bank transfer yet, so there is no code to scan. Ask
          an admin how they would like to be paid.
        </p>
      ) : payload === null ? (
        <p className="max-w-prose text-sm text-muted">
          The bank details saved for this office are not a valid account, so the code
          cannot be built. Ask an admin to check them.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* The plate keeps dark modules on a light field in BOTH themes, which
              is the polarity every scanner assumes. Inheriting `surface` would
              invert the code after dark, and an inverted QR is one a banking
              app may simply refuse to read. */}
          <div className="w-fit rounded-lg bg-accent-subtle p-3 text-accent-subtle-fg dark:bg-accent dark:text-accent-fg">
            <QRCodeSVG
              value={payload}
              // The specification's four-module quiet zone. The library
              // defaults to none, which produces a code that reads on a phone
              // held still and fails on one held at an angle.
              marginSize={4}
              // M survives a fingerprint on the screen; H would push the code
              // to a denser version for no benefit at this size.
              level="M"
              size={168}
              bgColor="transparent"
              fgColor="currentColor"
              title={`VietQR code for ${formatMoney(amountMinor, currency)} to ${
                account.accountName || account.accountNumber
              }, reference ${paymentRef}`}
              // `size` is the intrinsic geometry of the drawing, not a layout
              // choice; the class is what keeps it inside a 390px screen.
              className="h-auto max-w-full"
            />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Bank</dt>
            {/* Named as well as encoded: when a phone will not scan, this is
                the panel somebody re-types the transfer from, and a bare BIN
                is not something a person can type into a banking app. */}
            <dd className="text-text">
              {bankByBin(account.bankBin)?.shortName ?? account.bankBin}
            </dd>
            {account.accountName !== "" && (
              <>
                <dt className="text-muted">Account name</dt>
                <dd className="text-text">{account.accountName}</dd>
              </>
            )}
            <dt className="text-muted">Account number</dt>
            <dd className="tabular text-text">{account.accountNumber}</dd>
            <dt className="text-muted">Amount</dt>
            <dd className="tabular text-text">{formatMoney(amountMinor, currency)}</dd>
          </dl>
        </div>
      )}

      {payment.note !== null && (
        <p className="max-w-prose text-sm text-muted">{payment.note}</p>
      )}
    </div>
  );
}
