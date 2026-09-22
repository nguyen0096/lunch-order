import { describe, expect, it } from "vitest";
import {
  VND,
  assertMinor,
  formatAmount,
  formatMoney,
  parseMoneyInput,
  parseVietnamesePrice,
  type Currency,
} from "../src/shared/money.js";

const USD: Currency = { code: "USD", minorUnits: 2, locale: "en-US" };

describe("formatMoney", () => {
  const cases: Array<[number, Currency, string]> = [
    [45_000, VND, "45.000 ₫"],
    [0, VND, "0 ₫"],
    [1_234_567_890, VND, "1.234.567.890 ₫"],
    [1_999, USD, "$19.99"],
    [1, USD, "$0.01"],
    [-500, USD, "-$5.00"],
  ];

  it.each(cases)("formats %d in %o", (minor, currency, expected) => {
    expect(formatMoney(minor, currency)).toBe(expected);
  });

  it("rejects a non-integer minor amount", () => {
    expect(() => formatMoney(45_000.5, VND)).toThrow(TypeError);
  });
});

describe("formatAmount", () => {
  const cases: Array<[number, Currency, string]> = [
    [45_000, VND, "45.000"],
    [1_000_000_007, VND, "1.000.000.007"],
    [1_999, USD, "19.99"],
    [1, USD, "0.01"],
  ];

  it.each(cases)("formats %d in %o without a symbol", (minor, currency, expected) => {
    expect(formatAmount(minor, currency)).toBe(expected);
  });

  it("keeps a large 2-minor-unit amount exact", () => {
    expect(formatAmount(123_456_789_012, USD)).toBe("1,234,567,890.12");
  });

  it("rejects a non-integer minor amount", () => {
    expect(() => formatAmount(0.1 + 0.2, VND)).toThrow(TypeError);
  });
});

describe("assertMinor", () => {
  it("accepts integers including zero and negatives", () => {
    expect(() => assertMinor(0)).not.toThrow();
    expect(() => assertMinor(-45_000)).not.toThrow();
  });

  it("names the offending value", () => {
    expect(() => assertMinor(45_000.5)).toThrow(/got 45000.5/);
  });
});

describe("parseVietnamesePrice", () => {
  const cases: Array<[string, number, boolean, boolean]> = [
    ["45k", 45_000, false, false],
    ["45K", 45_000, false, false],
    ["45 nghìn", 45_000, false, false],
    ["45nghin", 45_000, false, false],
    ["45 ngàn", 45_000, false, false],
    ["45 ngan", 45_000, false, false],
    ["40.000d", 40_000, false, false],
    ["40.000đ", 40_000, false, false],
    ["40,000 vnd", 40_000, false, false],
    ["40 000", 40_000, false, false],
    ["1.234.567", 1_234_567, false, false],
    ["45", 45_000, true, false],
    ["999", 999_000, true, false],
    ["1000", 1_000, false, false],
    ["45 vnd", 45, false, false],
    ["45₫", 45, false, false],
    ["45,5k", 45_500, false, true],
    ["45,05k", 45_050, false, true],
    ["Cơm gà 45k", 45_000, false, false],
  ];

  it.each(cases)(
    "reads %s as %d",
    (raw, minor, inferredThousands, ambiguousDecimal) => {
      expect(parseVietnamesePrice(raw)).toEqual({ minor, inferredThousands, ambiguousDecimal });
    },
  );

  it.each([["abc"], [""], ["0"], ["45k m\u1ed7i su\u1ea5t"], ["giá liên hệ"]])(
    "returns null for %s",
    (raw) => {
      expect(parseVietnamesePrice(raw)).toBeNull();
    },
  );

  it("always returns an integer minor amount", () => {
    for (const raw of ["45,5k", "45,05k", "45,01k", "0,5k"]) {
      const reading = parseVietnamesePrice(raw);
      expect(reading).not.toBeNull();
      expect(Number.isInteger(reading!.minor)).toBe(true);
    }
  });
});

describe("parseMoneyInput", () => {
  it("accepts the caterer's shorthand with surrounding whitespace", () => {
    expect(parseMoneyInput("  45k  ")).toBe(45_000);
  });

  it("returns null when there is no number", () => {
    expect(parseMoneyInput("không có")).toBeNull();
  });

  // Current behaviour: the currency argument does not change the reading, so a
  // 2-minor-unit currency still gets the Vietnamese thousands inference.
  it("ignores the currency's minor units", () => {
    expect(parseMoneyInput("20", USD)).toBe(20_000);
    expect(parseMoneyInput("1999", USD)).toBe(1_999);
  });
});
