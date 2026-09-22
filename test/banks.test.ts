import {
  BANKS,
  bankByBin,
  isAccountNumber,
  normalizeAccountNumber,
  type Bank,
} from "../src/shared/banks.js";
import { vietQrLink } from "../src/shared/telegram.js";

/**
 * The BIN is the only value in this file with consequences: it is what the QR
 * payload encodes, so a wrong one is a code that scans cleanly and pays a
 * different bank. Nothing downstream can catch that, which is why the checks
 * here are about the data and not about the type.
 *
 * The spot checks below are the ten banks a Vietnamese office is most likely to
 * be paid into, pinned to their published NAPAS BINs. They exist so a careless
 * edit to the table fails the build rather than a colleague's transfer.
 */
const PINNED: Record<string, string> = {
  Vietcombank: "970436",
  VietinBank: "970415",
  BIDV: "970418",
  Agribank: "970405",
  Techcombank: "970407",
  MBBank: "970422",
  ACB: "970416",
  VPBank: "970432",
  Sacombank: "970403",
  TPBank: "970423",
};

const byShortName = (name: string): Bank | undefined =>
  BANKS.find((b) => b.shortName === name);

describe("the bank table", () => {
  it("pins the ten banks an office is most likely to use to their published BINs", () => {
    for (const [shortName, bin] of Object.entries(PINNED)) {
      expect(byShortName(shortName), `${shortName} is missing`).toBeDefined();
      expect(byShortName(shortName)?.bin, `${shortName} has the wrong BIN`).toBe(bin);
    }
  });

  it("gives every bank a six-digit BIN", () => {
    for (const b of BANKS) {
      expect(b.bin, `${b.shortName}`).toMatch(/^[0-9]{6}$/);
    }
  });

  it("uses each BIN once, so a picker cannot offer two rows that pay the same place", () => {
    const bins = BANKS.map((b) => b.bin);
    expect(new Set(bins).size).toBe(bins.length);
  });

  it("names every bank once, and names it twice over", () => {
    const names = BANKS.map((b) => b.shortName);
    expect(new Set(names).size).toBe(names.length);
    for (const b of BANKS) {
      expect(b.shortName.trim(), `${b.bin}`).not.toBe("");
      expect(b.fullName.trim(), `${b.bin}`).not.toBe("");
      // The registered name is what settles two lookalike short names, so it
      // may not simply repeat the short one.
      expect(b.fullName).not.toBe(b.shortName);
    }
  });

  it("is alphabetical, because the reader has to be able to predict the order", () => {
    const names = BANKS.map((b) => b.shortName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("keeps the old trading name searchable for a bank that was renamed", () => {
    expect(byShortName("BVBank")?.aka).toContain("VietCapitalBank");
    expect(byShortName("LPBank")?.aka).toContain("LienVietPostBank");
    expect(byShortName("MBV")?.aka).toContain("OceanBank");
  });
});

describe("bankByBin", () => {
  it("finds a bank by the BIN that would be stored in payment_config", () => {
    expect(bankByBin("970436")?.shortName).toBe("Vietcombank");
    expect(bankByBin(" 970436 ")?.shortName).toBe("Vietcombank");
  });

  it("answers null rather than throwing for a BIN it does not know", () => {
    // A config written before a bank left the list still has to render, so the
    // caller shows the bare BIN instead of crashing the bill.
    expect(bankByBin("999999")).toBeNull();
    expect(bankByBin(null)).toBeNull();
    expect(bankByBin(undefined)).toBeNull();
    expect(bankByBin("")).toBeNull();
  });
});

describe("account numbers", () => {
  it("takes out the spaces people read a long number aloud with", () => {
    expect(normalizeAccountNumber(" 1234 5678 90 ")).toBe("1234567890");
  });

  it("accepts what banks actually issue, digits and letters alike", () => {
    expect(isAccountNumber("0123456789")).toBe(true);
    expect(isAccountNumber("0123 4567 89")).toBe(true);
    expect(isAccountNumber("VQRQ0123456")).toBe(true);
  });

  it("refuses what cannot be an account number", () => {
    expect(isAccountNumber("")).toBe(false);
    expect(isAccountNumber("123")).toBe(false);
    expect(isAccountNumber("0123456789012345678901")).toBe(false);
    expect(isAccountNumber("0123-456789")).toBe(false);
  });
});

describe("the BIN reaches the QR unchanged", () => {
  it("builds a VietQR image URL around the stored BIN for every bank listed", () => {
    for (const b of BANKS) {
      const url = vietQrLink(
        { bankBin: b.bin, accountNumber: "0123456789" },
        { amountMinor: 45_000, minorUnits: 0, addInfo: "NEYU" },
      );
      expect(url, `${b.shortName}`).toContain(`/image/${b.bin}-0123456789-`);
    }
  });
});
