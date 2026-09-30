import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATERER_TEMPLATE,
  catererMessage,
  catererTemplateProblem,
  nobodyOrdered,
  type CatererOrder,
} from "../src/shared/catererOrder.js";

function order(over: Partial<CatererOrder> = {}): CatererOrder {
  return {
    serviceDate: "2026-09-24",
    lines: [
      { itemId: 1, name: "Cơm gà", count: 3, notes: [{ text: "ít cơm", who: "Tèo" }] },
      { itemId: 2, name: "Bún bò", count: 2, notes: [] },
    ],
    unchosen: 0,
    ...over,
  };
}

const office = { companyName: "Nexus" };

describe("the message an admin sends the caterer", () => {
  it("reads, by default, as the day, each dish with its portions, and the total", () => {
    expect(catererMessage(order(), office)).toBe(
      ["Đặt cơm 24/09", "- Cơm gà: 3", "- Bún bò: 2", "Tổng: 5 phần"].join("\n"),
    );
  });

  it("fills every placeholder of an office's own template", () => {
    const template =
      "Chào chị, {companyName} đặt cơm {servingDate}:\n{dishes}\nTổng {total}, {unchosen} chưa chọn";
    expect(catererMessage(order({ unchosen: 2 }), { ...office, template })).toBe(
      "Chào chị, Nexus đặt cơm 24/09:\n- Cơm gà: 3\n- Bún bò: 2\nTổng 5, 2 chưa chọn",
    );
  });

  it("uses the default when the office has saved none", () => {
    expect(catererMessage(order(), { ...office, template: null })).toBe(
      catererMessage(order(), { ...office, template: DEFAULT_CATERER_TEMPLATE }),
    );
  });

  it("leaves the notes out, for the admin to word", () => {
    expect(catererMessage(order(), office)).not.toContain("ít cơm");
  });

  it("gives {unchosen} as a bare number, zero included", () => {
    const template = "{dishes}\n[{unchosen}]";
    expect(catererMessage(order(), { ...office, template })).toContain("[0]");
    expect(catererMessage(order({ unchosen: 3 }), { ...office, template })).toContain("[3]");
  });

  it("leaves out a dish nobody ordered rather than sending a zero", () => {
    const msg = catererMessage(
      order({
        lines: [
          { itemId: 1, name: "Cơm gà", count: 2, notes: [] },
          { itemId: 2, name: "Phở bò", count: 0, notes: [] },
        ],
      }),
      office,
    );
    expect(msg).not.toContain("Phở bò");
    expect(msg).toContain("Tổng: 2 phần");
  });

  it("does not expand braces that arrive inside a dish name", () => {
    const msg = catererMessage(
      order({ lines: [{ itemId: 1, name: "Cơm {total}", count: 1, notes: [] }] }),
      office,
    );
    expect(msg).toContain("- Cơm {total}: 1");
  });

  it("writes the date the way a Vietnamese chat writes it", () => {
    expect(catererMessage(order({ serviceDate: "2026-01-05" }), office)).toContain(
      "Đặt cơm 05/01",
    );
  });
});

describe("a day with nothing to send", () => {
  it("is a day with no dish and nobody waiting for one", () => {
    expect(nobodyOrdered(order({ lines: [], unchosen: 0 }))).toBe(true);
  });

  it("is not a day when somebody is eating with no dish yet", () => {
    expect(nobodyOrdered(order({ lines: [], unchosen: 1 }))).toBe(false);
  });
});

describe("a template an office can save", () => {
  it("accepts the default and every placeholder", () => {
    expect(catererTemplateProblem(DEFAULT_CATERER_TEMPLATE)).toBeNull();
    expect(
      catererTemplateProblem("{companyName} {servingDate} {dishes} {total} {unchosen}"),
    ).toBeNull();
  });

  it("needs {dishes}, or the caterer is not told what to cook", () => {
    expect(catererTemplateProblem("Đặt cơm {servingDate}")).toMatch(/\{dishes\}/);
  });

  it("refuses a placeholder it does not know, naming it", () => {
    expect(catererTemplateProblem("{dishes} {dish}")).toMatch(/\{dish\} is not a placeholder/);
  });

  it("refuses a placeholder hidden around a known one, as the database does", () => {
    expect(catererTemplateProblem("{dishes} {a{total}b}")).toMatch(/\{ab\} is not a placeholder/);
  });

  it("lets braces that are not a placeholder through", () => {
    expect(catererTemplateProblem("{dishes} :-{ }")).toBeNull();
  });

  it("refuses a template over 2000 characters", () => {
    expect(catererTemplateProblem(`{dishes}${"a".repeat(2000)}`)).toMatch(/2000/);
  });
});
