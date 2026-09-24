import { describe, expect, it } from "vitest";
import { catererMessage, type CatererOrder } from "../src/shared/catererOrder.js";

function order(over: Partial<CatererOrder> = {}): CatererOrder {
  return {
    serviceDate: "2026-09-24",
    lines: [
      { itemId: 1, name: "Cơm gà", count: 3, notes: [] },
      { itemId: 2, name: "Bún bò", count: 2, notes: [] },
    ],
    unchosen: 0,
    ...over,
  };
}

describe("the message an admin sends the caterer", () => {
  it("names the day, each dish, its portions and the total", () => {
    expect(catererMessage(order())).toBe(
      ["Đặt cơm 24/09", "- Cơm gà: 3 phần", "- Bún bò: 2 phần", "Tổng: 5 phần"].join("\n"),
    );
  });

  it("puts a note under its dish with whose it is", () => {
    // A caterer hands boxes to people. "ít cơm" against nobody is an
    // instruction they cannot carry out.
    const msg = catererMessage(
      order({
        lines: [
          {
            itemId: 1,
            name: "Cơm gà",
            count: 2,
            notes: [
              { text: "ít cơm", who: "Tèo" },
              { text: "không trứng", who: "Quy" },
            ],
          },
        ],
      }),
    );
    expect(msg).toBe(
      [
        "Đặt cơm 24/09",
        "- Cơm gà: 2 phần",
        "  + Tèo: ít cơm",
        "  + Quy: không trứng",
        "Tổng: 2 phần",
      ].join("\n"),
    );
  });

  it("leaves out a dish nobody ordered rather than sending a zero", () => {
    const msg = catererMessage(
      order({
        lines: [
          { itemId: 1, name: "Cơm gà", count: 2, notes: [] },
          { itemId: 2, name: "Phở bò", count: 0, notes: [] },
        ],
      }),
    );
    expect(msg).not.toContain("Phở bò");
    expect(msg).toContain("Tổng: 2 phần");
  });

  it("says out loud that somebody is eating without a dish", () => {
    // They are a real head and no caterer can cook them. Dropping them
    // silently is how a person turns up to no lunch.
    const msg = catererMessage(order({ unchosen: 2 }));
    expect(msg).toContain("Tổng: 5 phần");
    expect(msg).toContain("Còn 2 người đã đăng ký nhưng chưa chọn món");
  });

  it("says nobody has ordered rather than sending a total of zero", () => {
    expect(catererMessage(order({ lines: [], unchosen: 0 }))).toBe(
      "Đặt cơm 24/09\nChưa có ai đặt.",
    );
  });

  it("still sends a message when the only heads have no dish", () => {
    const msg = catererMessage(order({ lines: [], unchosen: 3 }));
    expect(msg).toContain("Tổng: 0 phần");
    expect(msg).toContain("Còn 3 người");
  });

  it("writes the date the way a Vietnamese chat writes it", () => {
    expect(catererMessage(order({ serviceDate: "2026-01-05" }))).toContain("Đặt cơm 05/01");
  });
});
