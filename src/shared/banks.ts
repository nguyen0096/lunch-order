/**
 * The banks an admin can point the office's QR code at.
 *
 * `bin` is the NAPAS six-digit bank identification number, and it is the one
 * field here with consequences: it is what a VietQR payload encodes, so a wrong
 * digit produces a code that scans cleanly and pays a different bank. Nothing
 * downstream can catch that -- the payer sees an account name resolved by the
 * bank they were sent to, not by us.
 *
 * Embedded rather than fetched. A picker that cannot open until a third party
 * answers is a picker that is sometimes empty, and the one thing worse than an
 * out-of-date bank list is a bank list that is not there when the admin is.
 *
 * Every row below appears, with this BIN, in BOTH the VietQR registry
 * (https://api.vietqr.io/v2/banks) and SePay's (https://qr.sepay.vn/banks.json),
 * which are independently maintained; the two disagree about some short names
 * and about nothing else. VietQR's is the registry that matters twice over,
 * because `vietQrLink` in shared/telegram.ts builds img.vietqr.io URLs from
 * whatever BIN is stored here.
 *
 * Trimmed on purpose. Entries only one registry knows about are left out, as
 * are e-wallets and a bank's separate "digital bank" row -- two rows that look
 * like the same bank is exactly how the wrong one gets picked.
 */

export type Bank = {
  /** NAPAS six-digit BIN. This is what the QR encodes. */
  bin: string;
  /** What people call it, and what the picker shows: "Vietcombank". */
  shortName: string;
  /** The registered name, which settles it when two short names look alike. */
  fullName: string;
  /**
   * Names this bank used to trade under. Search only: an admin who still calls
   * it LienVietPostBank has to be able to find LPBank.
   */
  aka?: string[];
};

/**
 * Alphabetical by short name. The picker filters as you type, so ordering is
 * something a reader can predict rather than a guess at which banks an office
 * is most likely to use.
 */
export const BANKS: readonly Bank[] = [
  { bin: "970425", shortName: "ABBANK", fullName: "Ngân hàng TMCP An Bình" },
  { bin: "970416", shortName: "ACB", fullName: "Ngân hàng TMCP Á Châu" },
  {
    bin: "970405",
    shortName: "Agribank",
    fullName: "Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam",
  },
  { bin: "970409", shortName: "BacABank", fullName: "Ngân hàng TMCP Bắc Á" },
  { bin: "970438", shortName: "BaoVietBank", fullName: "Ngân hàng TMCP Bảo Việt" },
  {
    bin: "970418",
    shortName: "BIDV",
    fullName: "Ngân hàng TMCP Đầu tư và Phát triển Việt Nam",
  },
  {
    // Rebranded from Viet Capital Bank in 2024; both registries still print the
    // old trading name against this BIN.
    bin: "970454",
    shortName: "BVBank",
    fullName: "Ngân hàng TMCP Bản Việt",
    aka: ["VietCapitalBank", "Viet Capital Bank", "Bản Việt"],
  },
  { bin: "422589", shortName: "CIMB", fullName: "Ngân hàng TNHH MTV CIMB Việt Nam" },
  { bin: "970446", shortName: "COOPBANK", fullName: "Ngân hàng Hợp tác xã Việt Nam" },
  {
    bin: "970431",
    shortName: "Eximbank",
    fullName: "Ngân hàng TMCP Xuất Nhập khẩu Việt Nam",
  },
  {
    bin: "970437",
    shortName: "HDBank",
    fullName: "Ngân hàng TMCP Phát triển Thành phố Hồ Chí Minh",
  },
  { bin: "970452", shortName: "KienLongBank", fullName: "Ngân hàng TMCP Kiên Long" },
  {
    bin: "970449",
    shortName: "LPBank",
    fullName: "Ngân hàng TMCP Lộc Phát Việt Nam",
    aka: ["LienVietPostBank", "Liên Việt"],
  },
  { bin: "970422", shortName: "MBBank", fullName: "Ngân hàng TMCP Quân đội" },
  {
    // Formerly OceanBank, transferred to MB and renamed at the end of 2024.
    bin: "970414",
    shortName: "MBV",
    fullName: "Ngân hàng TNHH MTV Việt Nam Hiện Đại",
    aka: ["OceanBank", "Đại Dương"],
  },
  { bin: "970426", shortName: "MSB", fullName: "Ngân hàng TMCP Hàng Hải Việt Nam" },
  { bin: "970428", shortName: "NamABank", fullName: "Ngân hàng TMCP Nam Á" },
  { bin: "970419", shortName: "NCB", fullName: "Ngân hàng TMCP Quốc Dân" },
  { bin: "970448", shortName: "OCB", fullName: "Ngân hàng TMCP Phương Đông" },
  {
    bin: "970430",
    shortName: "PGBank",
    fullName: "Ngân hàng TMCP Thịnh vượng và Phát triển",
  },
  { bin: "970412", shortName: "PVcomBank", fullName: "Ngân hàng TMCP Đại Chúng Việt Nam" },
  { bin: "970403", shortName: "Sacombank", fullName: "Ngân hàng TMCP Sài Gòn Thương Tín" },
  { bin: "970400", shortName: "SaigonBank", fullName: "Ngân hàng TMCP Sài Gòn Công Thương" },
  { bin: "970429", shortName: "SCB", fullName: "Ngân hàng TMCP Sài Gòn" },
  { bin: "970440", shortName: "SeABank", fullName: "Ngân hàng TMCP Đông Nam Á" },
  { bin: "970443", shortName: "SHB", fullName: "Ngân hàng TMCP Sài Gòn - Hà Nội" },
  { bin: "970424", shortName: "ShinhanBank", fullName: "Ngân hàng TNHH MTV Shinhan Việt Nam" },
  { bin: "970407", shortName: "Techcombank", fullName: "Ngân hàng TMCP Kỹ thương Việt Nam" },
  { bin: "970423", shortName: "TPBank", fullName: "Ngân hàng TMCP Tiên Phong" },
  { bin: "970441", shortName: "VIB", fullName: "Ngân hàng TMCP Quốc tế Việt Nam" },
  { bin: "970427", shortName: "VietABank", fullName: "Ngân hàng TMCP Việt Á" },
  { bin: "970433", shortName: "VietBank", fullName: "Ngân hàng TMCP Việt Nam Thương Tín" },
  { bin: "970436", shortName: "Vietcombank", fullName: "Ngân hàng TMCP Ngoại Thương Việt Nam" },
  { bin: "970415", shortName: "VietinBank", fullName: "Ngân hàng TMCP Công thương Việt Nam" },
  { bin: "970432", shortName: "VPBank", fullName: "Ngân hàng TMCP Việt Nam Thịnh Vượng" },
  { bin: "970457", shortName: "Woori", fullName: "Ngân hàng TNHH MTV Woori Việt Nam" },
];

const BY_BIN = new Map(BANKS.map((b) => [b.bin, b]));

/**
 * The bank a stored BIN names, or null.
 *
 * Null is a real answer, not a bug: a config written before a bank left this
 * list still has to render, so callers show the bare BIN rather than nothing.
 */
export function bankByBin(bin: string | null | undefined): Bank | null {
  if (typeof bin !== "string") return null;
  return BY_BIN.get(bin.trim()) ?? null;
}

/**
 * What an account number may contain, after spaces are taken out.
 *
 * Deliberately loose. Most Vietnamese account numbers are digits, but some
 * banks issue alphanumeric ones, and a form that refuses a real account number
 * is worse than one that lets a typo through -- the typo is visible on the
 * confirmation line, the refusal is a dead end.
 */
const ACCOUNT_RE = /^[0-9A-Za-z]{4,19}$/;

/** Spaces are how people read a long number aloud; the bank does not want them. */
export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function isAccountNumber(raw: string): boolean {
  return ACCOUNT_RE.test(normalizeAccountNumber(raw));
}
