import { describe, expect, it } from "vitest";
import {
  cutoffPassed,
  defaultSelectedDay,
  formatCutoff,
  minutesToCutoff,
  notices,
  orderDisabledReason,
  publishDisabledReason,
} from "../src/shared/gating.js";
import type { Menu, MyOrder } from "../src/shared/types.js";

const CUTOFF = "2026-09-22T09:00:00.000Z";
const BEFORE = new Date("2026-09-22T08:30:00.000Z");
const AFTER = new Date("2026-09-22T09:30:00.000Z");
// 09:00 UTC is 16:00 in ICT, so every rendered time below is exact rather than
// dependent on the CI runner's zone.
const TZ = "Asia/Ho_Chi_Minh";

function menu(over: Partial<Menu> = {}): Menu {
  return {
    id: 1,
    orgId: 7,
    serviceDate: "2026-09-23",
    status: "published",
    orderCutoffAt: CUTOFF,
    items: [],
    ...over,
  };
}

function order(over: Partial<MyOrder> = {}): MyOrder {
  return {
    id: 10,
    status: "placed",
    source: "member",
    itemId: 3,
    itemName: "Cơm gà",
    unitPriceMinor: 45_000,
    ...over,
  };
}

describe("orderDisabledReason", () => {
  it("reports a missing menu", () => {
    expect(orderDisabledReason(null, BEFORE, TZ)).toBe("Tomorrow's menu isn't up yet");
  });

  it("binds an admin to the same window as everybody else", () => {
    // The board is where an admin orders their own lunch. Correcting a
    // finished day is a different job on a different screen, and the trigger
    // now asks for it by name: only `source = 'admin'` steps outside.
    expect(orderDisabledReason(menu({ status: "locked" }), BEFORE, TZ)).toBe(
      "Orders are closed and have gone to the caterer",
    );
    expect(orderDisabledReason(menu(), AFTER, TZ)).toBe("Ordering closed at 16:00");
  });

  it("reports a cancelled day", () => {
    expect(orderDisabledReason(menu({ status: "cancelled" }), BEFORE, TZ)).toBe(
      "Lunch is cancelled for this day",
    );
  });

  it("reports a locked menu to a member", () => {
    expect(orderDisabledReason(menu({ status: "locked" }), BEFORE, TZ)).toBe(
      "Orders are closed and have gone to the caterer",
    );
  });

  it("reports a passed cutoff with the cutoff time", () => {
    expect(orderDisabledReason(menu(), AFTER, TZ)).toBe("Ordering closed at 16:00");
  });

  it("allows ordering before the cutoff on a published menu", () => {
    expect(orderDisabledReason(menu(), BEFORE, TZ)).toBeNull();
  });

  it("exempts nobody from locked or the cutoff", () => {
    // It used to exempt admins. That made the board a place where an admin
    // could put a meal on a bill for a day already eaten, by tapping their own
    // row, which is not a power anybody asked for.
    expect(orderDisabledReason(menu({ status: "locked" }), AFTER, TZ)).not.toBeNull();
    expect(orderDisabledReason(menu(), AFTER, TZ)).not.toBeNull();
  });
});

describe("cutoffPassed", () => {
  it("is false before the cutoff", () => {
    expect(cutoffPassed(menu(), BEFORE)).toBe(false);
  });

  it("is true at the cutoff instant", () => {
    expect(cutoffPassed(menu(), new Date(CUTOFF))).toBe(true);
  });

  it("is true after the cutoff", () => {
    expect(cutoffPassed(menu(), AFTER)).toBe(true);
  });
});

describe("minutesToCutoff", () => {
  const cases: Array<[string, number]> = [
    ["2026-09-22T08:30:00.000Z", 30],
    ["2026-09-22T09:00:00.000Z", 0],
    ["2026-09-22T08:58:30.000Z", 1],
    ["2026-09-22T09:00:30.000Z", -1],
    ["2026-09-22T10:00:00.000Z", -60],
  ];

  it.each(cases)("at %s it is %d", (nowIso, expected) => {
    expect(minutesToCutoff(menu(), new Date(nowIso))).toBe(expected);
  });
});

describe("formatCutoff", () => {
  it("renders the org's wall clock, not the reader's", () => {
    expect(formatCutoff(menu(), TZ)).toBe("16:00");
    expect(formatCutoff(menu(), "UTC")).toBe("09:00");
    expect(formatCutoff(menu(), "America/New_York")).toBe("05:00");
  });
});

describe("notices", () => {
  it("returns nothing without a menu", () => {
    expect(notices(null, order(), BEFORE)).toEqual([]);
  });

  it("warns when a published menu closes within the hour", () => {
    expect(notices(menu(), null, BEFORE)).toEqual([
      { level: "warn", text: "Orders close in 30 min" },
    ]);
  });

  it("does not warn at exactly 61 minutes out, but does at 60", () => {
    expect(notices(menu(), null, new Date("2026-09-22T07:59:00.000Z"))).toEqual([]);
    expect(notices(menu(), null, new Date("2026-09-22T08:00:00.000Z"))).toEqual([
      { level: "warn", text: "Orders close in 60 min" },
    ]);
  });

  it("stops warning once the cutoff has passed", () => {
    expect(notices(menu(), null, new Date(CUTOFF))).toEqual([]);
  });

  it("does not warn about a countdown on a cancelled menu", () => {
    expect(notices(menu({ status: "cancelled" }), null, BEFORE)).toEqual([]);
  });

  it("warns about a placed order with no dish chosen", () => {
    expect(notices(menu(), order({ itemId: null, itemName: null }), AFTER)).toEqual([
      { level: "warn", text: "You're down as eating but haven't picked a dish yet" },
    ]);
  });

  it("says nothing about a cancelled order with no dish", () => {
    expect(notices(menu(), order({ status: "cancelled", itemId: null }), AFTER)).toEqual([]);
  });

  it("explains a standing-order origin", () => {
    expect(notices(menu(), order({ source: "standing" }), AFTER)).toEqual([
      { level: "info", text: "This was added automatically by your weekday preference" },
    ]);
  });

  it("says the headcount is gone once locked", () => {
    expect(notices(menu({ status: "locked" }), null, BEFORE)).toEqual([
      { level: "info", text: "The headcount has gone to the caterer" },
    ]);
  });

  it("stacks every applicable notice in a fixed order", () => {
    expect(notices(menu(), order({ source: "standing", itemId: null }), BEFORE)).toEqual([
      { level: "warn", text: "Orders close in 30 min" },
      { level: "warn", text: "You're down as eating but haven't picked a dish yet" },
      { level: "info", text: "This was added automatically by your weekday preference" },
    ]);
  });
});

describe("publishDisabledReason", () => {
  const items = [{ name: "Cơm gà", priceMinor: 45_000 }];

  it("requires a service date", () => {
    expect(publishDisabledReason(items, null)).toBe("Pick the service date first");
  });

  it("requires at least one dish", () => {
    expect(publishDisabledReason([], "2026-09-23")).toBe("Add at least one dish");
  });

  it("requires every dish to have a name", () => {
    expect(publishDisabledReason([...items, { name: "  ", priceMinor: 1 }], "2026-09-23")).toBe(
      "Every dish needs a name",
    );
  });

  it("requires integer, non-negative prices", () => {
    const reason = "A price must be a whole number of dong, or left for the caterer";
    expect(publishDisabledReason([{ name: "A", priceMinor: 45_000.5 }], "2026-09-23")).toBe(reason);
    expect(publishDisabledReason([{ name: "A", priceMinor: -1 }], "2026-09-23")).toBe(reason);
    // Typed, and not money. Distinct from "nobody has priced it", below.
    expect(publishDisabledReason([{ name: "A", priceMinor: Number.NaN }], "2026-09-23")).toBe(reason);
  });

  it("publishes a dish the caterer has not priced yet", () => {
    // The caterer prices at the weekend. Demanding a number here forced admins
    // to invent one, and 0 reads on a bill as a free meal.
    expect(publishDisabledReason([{ name: "A", priceMinor: null }], "2026-09-23")).toBeNull();
  });

  it("allows a free dish", () => {
    expect(publishDisabledReason([{ name: "A", priceMinor: 0 }], "2026-09-23")).toBeNull();
  });
});

describe("defaultSelectedDay", () => {
  const week = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
  const days = (withMenu: string[]) =>
    week.map((serviceDate) => ({
      serviceDate,
      menuId: withMenu.includes(serviceDate) ? 1 : null,
      status: withMenu.includes(serviceDate) ? "published" : null,
    }));

  it("picks the soonest upcoming day still open", () => {
    expect(
      defaultSelectedDay({
        days: days(["2026-09-21", "2026-09-22", "2026-09-23"]),
        today: "2026-09-22",
        isOpen: (d) => d >= "2026-09-23",
      }),
    ).toBe("2026-09-23");
  });

  it("falls back to the soonest upcoming day with a menu when none is open", () => {
    expect(
      defaultSelectedDay({
        days: days(["2026-09-21", "2026-09-22", "2026-09-24"]),
        today: "2026-09-22",
        isOpen: () => false,
      }),
    ).toBe("2026-09-22");
  });

  it("falls back to today when the week ahead has no menu", () => {
    expect(
      defaultSelectedDay({ days: days([]), today: "2026-09-22", isOpen: () => true }),
    ).toBe("2026-09-22");
  });

  it("falls back to the first day on screen when today is not in view", () => {
    expect(
      defaultSelectedDay({ days: days([]), today: "2026-10-05", isOpen: () => true }),
    ).toBe("2026-09-21");
  });

  it("falls back to today when there are no days at all", () => {
    expect(defaultSelectedDay({ days: [], today: "2026-09-22", isOpen: () => true })).toBe(
      "2026-09-22",
    );
  });
});
