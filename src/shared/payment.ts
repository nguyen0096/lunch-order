/**
 * The shape of `organizations.payment_config`.
 *
 * The column is `jsonb` with no database-side shape, so this module is the only
 * place that decides what is in it: the admin form writes this, the bill reads
 * it, and a config written by an older version of either is parsed rather than
 * trusted.
 */

/** A NAPAS-addressable account, which is what a VietQR code encodes. */
export type VietQrAccount = {
  /** NAPAS six-digit bank identification number, e.g. "970415" for VietinBank. */
  bankBin: string;
  accountNumber: string;
  /** Shown to the payer before they confirm, so a wrong account is caught. */
  accountName: string;
};

export type PaymentConfig = {
  vietqr: VietQrAccount | null;
  /** Free text shown under the QR: "pay Chi in cash if you prefer". */
  note: string | null;
};

export const EMPTY_PAYMENT_CONFIG: PaymentConfig = { vietqr: null, note: null };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Total, never throwing: a bill that cannot render because one field is the
 * wrong type is worse than a bill with no QR on it.
 */
export function parsePaymentConfig(raw: unknown): PaymentConfig {
  if (typeof raw !== "object" || raw === null) return EMPTY_PAYMENT_CONFIG;
  const o = raw as Record<string, unknown>;
  const q = typeof o["vietqr"] === "object" && o["vietqr"] !== null
    ? (o["vietqr"] as Record<string, unknown>)
    : null;

  const bankBin = q && str(q["bankBin"]);
  const accountNumber = q && str(q["accountNumber"]);

  return {
    // An account missing either half cannot produce a scannable code, so it is
    // no account at all rather than a half-rendered one.
    vietqr: bankBin && accountNumber
      ? { bankBin, accountNumber, accountName: (q && str(q["accountName"])) ?? "" }
      : null,
    note: str(o["note"]),
  };
}
