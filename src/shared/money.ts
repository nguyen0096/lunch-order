/**
 * Money is always an integer in the currency's minor unit, never a float.
 * VND has no sub-unit, so `currencyMinorUnits` is 0 and the integer is dong.
 * USD would be 2 and the integer is cents.
 */
export type Currency = { code: string; minorUnits: number; locale: string };

export const VND: Currency = { code: "VND", minorUnits: 0, locale: "vi-VN" };

/** 45000 -> "45.000 ₫" for vi-VN. */
export function formatMoney(minor: number, c: Currency): string {
  assertMinor(minor);
  return new Intl.NumberFormat(c.locale, {
    style: "currency",
    currency: c.code,
    minimumFractionDigits: c.minorUnits,
    maximumFractionDigits: c.minorUnits,
  }).format(minor / 10 ** c.minorUnits);
}

/** 45000 -> "45.000" for vi-VN. No symbol, for table columns. */
export function formatAmount(minor: number, c: Currency): string {
  assertMinor(minor);
  return new Intl.NumberFormat(c.locale, {
    minimumFractionDigits: c.minorUnits,
    maximumFractionDigits: c.minorUnits,
  }).format(minor / 10 ** c.minorUnits);
}

export function assertMinor(n: number): asserts n is number {
  if (!Number.isInteger(n)) {
    throw new TypeError(`money must be an integer minor amount, got ${n}`);
  }
}

/**
 * Parse what an admin types into a price box. Accepts the same shorthand the
 * caterer uses, so they can copy a value across without converting it.
 * Returns null when there is no number at all; throws on nothing.
 */
export function parseMoneyInput(input: string, c: Currency = VND): number | null {
  const parsed = parseVietnamesePrice(input.trim());
  if (parsed === null) return null;
  return c.minorUnits === 0 ? parsed.minor : parsed.minor;
}

export type PriceReading = {
  minor: number;
  /** Set when a bare number below 1000 was read as thousands. */
  inferredThousands: boolean;
  /** Set when a comma was read as a decimal point rather than a separator. */
  ambiguousDecimal: boolean;
};

const THOUSAND_WORDS = ["k", "nghìn", "ngàn", "nghin", "ngan"];
const CURRENCY_WORDS = ["đ", "d", "vnd", "vnđ", "₫"];

/**
 * The fiddly part. Vietnamese price notation uses `.` and `,` interchangeably
 * as thousand separators, and `k`/`nghìn` to mean thousands. VND has no
 * sub-unit, so any separator can be stripped -- except that "45,5k" genuinely
 * means 45500, which is the one case where a comma is a decimal point.
 */
export function parseVietnamesePrice(raw: string): PriceReading | null {
  const s = raw.toLowerCase().trim();
  const m = s.match(
    /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(k|nghìn|ngàn|nghin|ngan|đ|d|vnd|vnđ|₫)?\s*$/u,
  );
  if (!m) return null;

  const digits = m[1];
  const suffix = m[2] ?? "";
  if (digits === undefined) return null;

  const isThousandSuffix = THOUSAND_WORDS.includes(suffix);
  let ambiguousDecimal = false;
  let n: number;

  // A comma (or dot) followed by 1-2 digits, with a thousands suffix, is a
  // decimal: "45,5k" is 45500. Three trailing digits is a separator group.
  const decimal = digits.match(/^(\d+)[.,](\d{1,2})$/);
  if (decimal && isThousandSuffix) {
    n = Number(`${decimal[1]}.${decimal[2]}`);
    ambiguousDecimal = true;
  } else {
    n = Number(digits.replace(/[.,\s]/g, ""));
  }
  if (!Number.isFinite(n) || n <= 0) return null;

  let minor = isThousandSuffix ? n * 1000 : n;

  // Caterers write "45" meaning 45k. Nobody sells a 45-dong lunch.
  let inferredThousands = false;
  if (minor < 1000 && !CURRENCY_WORDS.includes(suffix)) {
    minor *= 1000;
    inferredThousands = true;
  }

  return { minor: Math.round(minor), inferredThousands, ambiguousDecimal };
}
