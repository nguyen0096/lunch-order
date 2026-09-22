/**
 * The VietQR (NAPAS) transfer payload, assembled here rather than fetched.
 *
 * The obvious shortcut is `img.vietqr.io/image/<bin>-<account>-compact.png`,
 * which renders the same code as an image. It also sends the amount and the
 * member's payment reference to a third party on every single render of the
 * bill, which is a bank memo and a sum of money leaving the office for nobody's
 * benefit. The payload is 150-odd bytes of EMVCo TLV and the arithmetic below
 * is a CRC, so there is nothing here worth paying for in privacy.
 *
 * Format: EMVCo Merchant-Presented QR, as NAPAS profiles it for VietQR. Every
 * field is `ID` (2 digits) + `length` (2 digits) + `value`, and a field whose
 * value is itself a list of fields nests the same shape.
 */

/** NAPAS, the acquirer switch every Vietnamese bank sits behind. */
const NAPAS_GUID = "A000000727";
/** Account-to-account transfer. The other services are card and e-wallet. */
const SERVICE_TRANSFER_TO_ACCOUNT = "QRIBFTTA";
/** ISO 4217 numeric for VND. */
const CURRENCY_VND = "704";
const COUNTRY_VN = "VN";

/** Static: the payer types the amount. Dynamic: the code carries it. */
const POINT_OF_INITIATION_STATIC = "11";
const POINT_OF_INITIATION_DYNAMIC = "12";

export type VietQrRequest = {
  /** NAPAS six-digit bank identification number, e.g. "970415". */
  bankBin: string;
  accountNumber: string;
  /**
   * VND has no sub-unit, so this is whole dong. Omitted or zero produces a
   * static code with no amount, which is what a settled bill wants.
   */
  amountMinor?: number;
  /** The bank memo. This is the string that matches a transfer to a statement. */
  paymentRef: string;
};

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no input or
 * output reflection, no final xor. Check value for "123456789" is 0x29B1.
 *
 * `charCodeAt` is safe here only because every byte of a payload is ASCII --
 * the caller validates that before this runs. A diacritic would be one UTF-16
 * code unit and two bytes on the wire, and the bank would compute a different
 * checksum from the one we sent.
 */
export function crc16CcittFalse(ascii: string): number {
  let crc = 0xffff;
  for (let i = 0; i < ascii.length; i++) {
    crc ^= (ascii.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * The payload a banking app expects to find in the QR, or null when the inputs
 * cannot make a scannable one.
 *
 * Null rather than a throw, for the same reason `parsePaymentConfig` never
 * throws: a bill that fails to render because one office typed its BIN wrong is
 * worse than a bill that shows the amount and the reference with no QR under
 * them. The screen says so in words.
 */
export function vietQrPayload(req: VietQrRequest): string | null {
  const bankBin = req.bankBin.trim();
  const accountNumber = req.accountNumber.trim();
  const paymentRef = req.paymentRef.trim();
  const amountMinor = req.amountMinor ?? 0;

  if (!/^\d{6}$/.test(bankBin)) return null;
  if (!/^[0-9A-Za-z]{1,19}$/.test(accountNumber)) return null;
  // The same shape `billing_statements.payment_ref` is constrained to. A memo
  // outside it would not survive the bank's own transliteration, so a code
  // carrying one would produce a payment nobody can match.
  if (!/^[A-Z0-9]{4,24}$/.test(paymentRef)) return null;
  if (!Number.isInteger(amountMinor) || amountMinor < 0) return null;

  const withAmount = amountMinor > 0;

  const body = concat([
    tlv("00", "01"),
    tlv("01", withAmount ? POINT_OF_INITIATION_DYNAMIC : POINT_OF_INITIATION_STATIC),
    nest("38", [
      tlv("00", NAPAS_GUID),
      nest("01", [tlv("00", bankBin), tlv("01", accountNumber)]),
      tlv("02", SERVICE_TRANSFER_TO_ACCOUNT),
    ]),
    tlv("53", CURRENCY_VND),
    withAmount ? tlv("54", String(amountMinor)) : "",
    tlv("58", COUNTRY_VN),
    nest("62", [tlv("08", paymentRef)]),
  ]);
  if (body === null) return null;

  // The checksum covers its own id and length as well, so "6304" is part of
  // the input and not merely the label of the result.
  const signed = `${body}6304`;
  return signed + crc16CcittFalse(signed).toString(16).toUpperCase().padStart(4, "0");
}

/** One field. Null when the value will not fit the two-digit length. */
function tlv(id: string, value: string): string | null {
  return value.length > 99 ? null : id + String(value.length).padStart(2, "0") + value;
}

function concat(parts: Array<string | null>): string | null {
  let out = "";
  for (const part of parts) {
    if (part === null) return null;
    out += part;
  }
  return out;
}

/** A field whose value is itself a list of fields. */
function nest(id: string, parts: Array<string | null>): string | null {
  const value = concat(parts);
  return value === null ? null : tlv(id, value);
}
