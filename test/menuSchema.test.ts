import { describe, expect, it } from "vitest";
import { MENU_TOOL_SCHEMA, validateAssist } from "../src/shared/menuSchema.js";

const ok = {
  service_date: "2026-09-23",
  items: [
    { name: "Cơm gà xối mỡ", price: 45_000, note: "limited" },
    { name: "Bún bò Huế", price: 40_000, note: null },
  ],
  notes: ["Thực đơn thứ 4"],
};

describe("validateAssist", () => {
  it("accepts a well-formed result", () => {
    expect(validateAssist(ok)).toEqual({
      serviceDate: "2026-09-23",
      items: [
        { name: "Cơm gà xối mỡ", price: 45_000, note: "limited" },
        { name: "Bún bò Huế", price: 40_000, note: null },
      ],
      notes: ["Thực đơn thứ 4"],
    });
  });

  it("fails loudly on a float price", () => {
    expect(() => validateAssist({ ...ok, items: [{ name: "Cơm gà", price: 45_000.5 }] })).toThrow(
      /item 0 \("Cơm gà"\) has an unusable price/,
    );
  });

  it("fails loudly on a blank name", () => {
    expect(() => validateAssist({ ...ok, items: [{ name: "   ", price: 45_000 }] })).toThrow(
      /item 0 has no name/,
    );
  });

  it("fails loudly on 60+ items", () => {
    const item = { name: "Cơm", price: 45_000 };
    expect(() => validateAssist({ ...ok, items: Array(61).fill(item) })).toThrow(
      /model returned 61 items/,
    );
    expect(validateAssist({ ...ok, items: Array(60).fill(item) }).items).toHaveLength(60);
  });

  it("rejects anything that is not an object", () => {
    for (const raw of [null, "{}", 42, undefined]) {
      expect(() => validateAssist(raw)).toThrow(/model returned no object/);
    }
  });

  it("requires an items array", () => {
    expect(() => validateAssist({ notes: [] })).toThrow(/model returned no items array/);
    expect(() => validateAssist({ items: {} })).toThrow(/model returned no items array/);
  });

  it("rejects an item that is not an object", () => {
    expect(() => validateAssist({ items: ["Cơm gà 45k"] })).toThrow(
      /item 0 is not an object/,
    );
  });

  it("rejects an implausibly long name", () => {
    expect(() => validateAssist({ items: [{ name: "a".repeat(201), price: 45_000 }] })).toThrow(
      /name is implausibly long/,
    );
  });

  it("accepts a quoted integer price but not a quoted float", () => {
    expect(validateAssist({ items: [{ name: "Cơm", price: " 45000 " }] }).items[0]?.price).toBe(
      45_000,
    );
    expect(() => validateAssist({ items: [{ name: "Cơm", price: "45.000" }] })).toThrow(
      /unusable price/,
    );
  });

  it("rejects a price outside the plausible band", () => {
    expect(() => validateAssist({ items: [{ name: "Cơm", price: -1 }] })).toThrow(
      /unusable price/,
    );
    expect(() => validateAssist({ items: [{ name: "Cơm", price: 100_000_001 }] })).toThrow(
      /unusable price/,
    );
    expect(validateAssist({ items: [{ name: "Cơm", price: 0 }] }).items[0]?.price).toBe(0);
  });

  it("drops a service date it cannot trust", () => {
    for (const sd of ["23/09/2026", "2026-9-3", "tomorrow", 20260923, null, undefined]) {
      expect(validateAssist({ ...ok, service_date: sd }).serviceDate).toBeNull();
    }
  });

  // Date.parse accepts a day that overflows its month, so the shape check is
  // all that stands between a caterer's typo and the admin's date picker.
  it("passes through a well-shaped but impossible calendar date", () => {
    expect(validateAssist({ ...ok, service_date: "2026-02-30" }).serviceDate).toBe("2026-02-30");
  });

  it("keeps only string notes, capped at 40", () => {
    expect(validateAssist({ items: [], notes: ["a", 1, null, "b"] }).notes).toEqual(["a", "b"]);
    expect(validateAssist({ items: [], notes: Array(50).fill("n") }).notes).toHaveLength(40);
    expect(validateAssist({ items: [] }).notes).toEqual([]);
  });

  it("nulls a non-string note on an item", () => {
    expect(validateAssist({ items: [{ name: "Cơm", price: 45_000, note: 7 }] }).items).toEqual([
      { name: "Cơm", price: 45_000, note: null },
    ]);
  });
});

describe("MENU_TOOL_SCHEMA", () => {
  it("requires items and notes and forbids extra keys", () => {
    expect(MENU_TOOL_SCHEMA.required).toEqual(["items", "notes"]);
    expect(MENU_TOOL_SCHEMA.additionalProperties).toBe(false);
    expect(MENU_TOOL_SCHEMA.properties.items.items.properties.price.type).toBe("integer");
  });
});
