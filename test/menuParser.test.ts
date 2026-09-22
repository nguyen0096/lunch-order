import { describe, expect, it } from "vitest";
import { parseMenu, type ItemWarning } from "../src/shared/menuParser.js";

const TODAY = "2026-09-22"; // Tuesday

const parse = (text: string, opts: Partial<{ minPrice: number; maxPrice: number }> = {}) =>
  parseMenu(text, { today: TODAY, ...opts });

const one = (line: string) => {
  const parsed = parse(line);
  expect(parsed.items).toHaveLength(1);
  return parsed.items[0]!;
};

describe("price notations", () => {
  const cases: Array<[string, number, ItemWarning[]]> = [
    ["Cơm gà 45k", 45_000, []],
    ["Cơm gà 45K", 45_000, []],
    ["Cơm gà 40.000d", 40_000, []],
    ["Cơm gà 40.000đ", 40_000, []],
    ["Cơm gà 40.000 VNĐ", 40_000, []],
    ["Cơm gà 40,000", 40_000, []],
    ["Cơm gà 40 000", 40_000, []],
    ["Cơm gà 45 nghìn", 45_000, []],
    ["Cơm gà 45 nghin", 45_000, []],
    ["Cơm gà 45 ngàn", 45_000, []],
    ["Cơm gà 45", 45_000, ["price_inferred_thousands"]],
    ["Cơm gà 45,5k", 45_500, ["price_ambiguous_decimal"]],
    ["Cơm gà - 45k", 45_000, []],
    ["Cơm gà : 45k", 45_000, []],
    ["Cơm gà 5.000đ", 5_000, ["price_out_of_range"]],
    ["Cơm gà 600.000đ", 600_000, ["price_out_of_range"]],
  ];

  it.each(cases)("reads %s", (line, priceMinor, warnings) => {
    const item = one(line);
    expect(item.name).toBe("Cơm gà");
    expect(item.priceMinor).toBe(priceMinor);
    expect(item.warnings).toEqual(warnings);
  });
});

describe("list markers", () => {
  const cases: Array<[string, string]> = [
    ["1. Cơm gà 45k", "numbered with a dot"],
    ["2) Cơm gà 45k", "numbered with a bracket"],
    ["(3) Cơm gà 45k", "numbered in brackets"],
    ["10. Cơm gà 45k", "two-digit numbered"],
    ["11 - Cơm gà 45k", "numbered with a dash"],
    ["- Cơm gà 45k", "dashed"],
    ["* Cơm gà 45k", "starred"],
    ["• Cơm gà 45k", "bulleted"],
    ["+ Cơm gà 45k", "plus"],
    ["> Cơm gà 45k", "quoted"],
    ["🍜 Cơm gà 45k", "emoji-prefixed"],
    ["   Cơm gà 45k", "indented"],
  ];

  it.each(cases)("strips the leader from a %s line", (line) => {
    const item = one(line);
    expect(item.name).toBe("Cơm gà");
    expect(item.priceMinor).toBe(45_000);
    expect(item.raw).toBe(line.trim());
  });
});

describe("lines that are not dishes", () => {
  it("keeps headers as notes", () => {
    const parsed = parse("THỰC ĐƠN\nmenu tuần này\nCơm gà 45k");
    expect(parsed.notes).toEqual(["THỰC ĐƠN", "menu tuần này"]);
    expect(parsed.items).toHaveLength(1);
  });

  it("keeps a note with a number in it as a note, not a dish", () => {
    const parsed = parse("Đặt trước 9h sáng\nlưu ý: hết sớm\nghi chú 123");
    expect(parsed.items).toEqual([]);
    expect(parsed.notes).toHaveLength(3);
  });

  it("keeps a leader-only line as a note", () => {
    expect(parse("---").notes).toEqual(["---"]);
  });

  it("ignores blank and whitespace-only lines", () => {
    const parsed = parse("\n   \nCơm gà 45k\n\n");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.notes).toEqual([]);
    expect(parsed.unparsed).toEqual([]);
  });

  const junk: string[] = [
    "xin chào cả nhà",
    "không có gì",
    "35k",
    "45.000đ",
    // The price has to end the line, so trailing punctuation is not recoverable.
    "Cơm gà 45k.",
    "Cơm gà 45k ...",
  ];

  it.each(junk)("rejects %s rather than inventing a dish", (line) => {
    const parsed = parse(line);
    expect(parsed.items).toEqual([]);
    expect(parsed.unparsed).toEqual([{ line: 0, raw: line }]);
  });
});

describe("duplicates", () => {
  it("keeps the first price and flags it", () => {
    const parsed = parse("Cơm gà 45k\nCơm gà 47k");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.priceMinor).toBe(45_000);
    expect(parsed.items[0]?.warnings).toEqual(["duplicate_name"]);
  });

  it("flags only once however many repeats there are", () => {
    const parsed = parse("Cơm gà 45k\nCơm gà 47k\ncơm GÀ 49k");
    expect(parsed.items[0]?.warnings).toEqual(["duplicate_name"]);
  });

  it("matches decomposed Vietnamese against its composed form", () => {
    const decomposed = "Cơm gà 47k";
    const parsed = parse(`Cơm gà 45k\n${decomposed}`);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.warnings).toEqual(["duplicate_name"]);
  });
});

describe("serviceDateGuess", () => {
  it("reads a d/m date from the opening lines", () => {
    expect(parse("Thực đơn 23/09\nCơm gà 45k").serviceDateGuess).toBe(
      "2026-09-23",
    );
  });

  it("accepts an explicit year", () => {
    expect(parse("Thực đơn 23.09.27").serviceDateGuess).toBe("2027-09-23");
  });

  it("rolls a January date over into next year", () => {
    expect(parseMenu("Thực đơn 05/01", { today: "2026-12-28" }).serviceDateGuess).toBe(
      "2027-01-05",
    );
  });

  it("resolves a weekday word to its next occurrence, never today", () => {
    expect(parse("Thực đơn thứ 4").serviceDateGuess).toBe("2026-09-23");
    expect(parse("Thực đơn thứ 3").serviceDateGuess).toBe("2026-09-29");
    expect(parse("Thực đơn CN").serviceDateGuess).toBe("2026-09-27");
  });

  it("is null when nothing date-like is in the opening lines", () => {
    expect(parse("Cơm gà 45k").serviceDateGuess).toBeNull();
    expect(parse("a\nb\nc\nThực đơn 23/09").serviceDateGuess).toBeNull();
  });

  it("ignores an impossible date", () => {
    expect(parse("Thực đơn 45/99").serviceDateGuess).toBeNull();
  });
});

describe("price band", () => {
  it("honours a caller's band", () => {
    const parsed = parse("Cơm gà 45k", { minPrice: 46_000 });
    expect(parsed.items[0]?.warnings).toEqual(["price_out_of_range"]);
    expect(parse("Cơm gà 45k", { maxPrice: 44_000 }).items[0]?.warnings).toEqual([
      "price_out_of_range",
    ]);
  });

  it("stacks warnings rather than choosing one", () => {
    expect(one("Cơm gà 9").warnings).toEqual([
      "price_inferred_thousands",
      "price_out_of_range",
    ]);
  });
});

describe("a real caterer message", () => {
  const message = [
    "THỰC ĐƠN thứ 4 ngày 23/09",
    "",
    "1. Cơm gà xối mỡ 45k",
    "2) Bún bò Huế - 40.000đ",
    "- Phở bò 50 nghìn",
    "• Cơm tấm sườn 45",
    "🍜 Mì quảng 42.000",
    "",
    "Đặt trước 9h sáng nhé",
    "Liên hệ 0909 123 456",
    "cảm ơn mọi người",
  ].join("\n");

  it("parses end to end", () => {
    const parsed = parse(message);

    expect(parsed.serviceDateGuess).toBe("2026-09-23");
    expect(parsed.items.map((i) => [i.name, i.priceMinor])).toEqual([
      ["Cơm gà xối mỡ", 45_000],
      ["Bún bò Huế", 40_000],
      ["Phở bò", 50_000],
      ["Cơm tấm sườn", 45_000],
      ["Mì quảng", 42_000],
    ]);
    expect(parsed.items.flatMap((i) => i.warnings)).toEqual(["price_inferred_thousands"]);
    expect(parsed.notes).toEqual([
      "THỰC ĐƠN thứ 4 ngày 23/09",
      "Đặt trước 9h sáng nhé",
      "Liên hệ 0909 123 456",
    ]);
    expect(parsed.unparsed).toEqual([{ line: 10, raw: "cảm ơn mọi người" }]);
  });

  it("ties every item back to its source line", () => {
    const parsed = parse(message);
    expect(parsed.items.map((i) => i.sourceLine)).toEqual([2, 3, 4, 5, 6]);
    expect(parsed.items.map((i) => i.id)).toEqual(["l2", "l3", "l4", "l5", "l6"]);
    expect(parsed.items[0]?.raw).toBe("1. Cơm gà xối mỡ 45k");
  });
});
