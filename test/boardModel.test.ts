import type { BoardCell, BoardDay } from "../src/web/api.js";
import {
  cellMark,
  cellReason,
  columnLabel,
  cutoffLabel,
  longDayLabel,
  lunchIsOver,
  lunchOverReason,
  nextOrderableDay,
  passOnReason,
  pickDish,
  planMessage,
  planState,
  planToggle,
  visibleDays,
  weekRangeLabel,
} from "../src/web/components/boardModel.js";

const TZ = "Asia/Ho_Chi_Minh";

const DISHES = [
  { id: 5, name: "Cơm gà", priceMinor: 45_000 },
  { id: 6, name: "Bún bò", priceMinor: 50_000 },
  { id: 7, name: "Phở bò", priceMinor: 40_000 },
];

function day(over: Partial<BoardDay> = {}): BoardDay {
  return {
    serviceDate: "2026-09-23",
    menuId: 5,
    status: "published",
    orderCutoffAt: "2026-09-22T14:00:00Z",
    dishes: DISHES,
    ...over,
  };
}

function cell(over: Partial<BoardCell> = {}): BoardCell {
  return {
    orderId: 7,
    status: "placed",
    source: "member",
    itemId: 6,
    dishName: "Phở bò",
    note: null,
    amountMinor: 40_000,
    transferredToName: null,
    ...over,
  };
}

const BEFORE = new Date("2026-09-22T10:00:00Z");
const AFTER = new Date("2026-09-22T15:00:00Z");

describe("visibleDays", () => {
  // Monday 2026-09-21 through Sunday 2026-09-27.
  const week = Array.from({ length: 7 }, (_, i) => day({ serviceDate: `2026-09-${21 + i}` }));

  it("gives a column to the five weekdays", () => {
    expect(visibleDays(week, () => false).map((d) => d.serviceDate)).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
    ]);
  });

  it("adds a weekend day that lunch actually happens on", () => {
    const shown = visibleDays(week, (d) => d === "2026-09-26");
    expect(shown.map((d) => d.serviceDate)).toContain("2026-09-26");
    expect(shown.map((d) => d.serviceDate)).not.toContain("2026-09-27");
  });
});

describe("weekRangeLabel", () => {
  it("names the month once inside one month", () => {
    // en-GB abbreviates September as "Sept", and `formatDay` already does
    // the same everywhere else in the app.
    expect(weekRangeLabel("2026-09-22", "2026-09-26")).toBe("22–26 Sept");
  });

  it("names both months when the week straddles them", () => {
    expect(weekRangeLabel("2026-09-29", "2026-10-03")).toBe("29 Sept – 3 Oct");
  });
});

describe("columnLabel", () => {
  it("splits the weekday from the day number", () => {
    expect(columnLabel("2026-09-22")).toEqual({ dow: "Tue", dom: "22" });
  });

  it("does not pad the day number", () => {
    expect(columnLabel("2026-09-02").dom).toBe("2");
  });
});

describe("cutoffLabel", () => {
  it("spells the cutoff the way the database spells it, in the org's zone", () => {
    expect(cutoffLabel("2026-09-22T14:00:00Z", TZ)).toBe("21:00 22/09");
  });

  it("uses the org's zone, not the reader's", () => {
    expect(cutoffLabel("2026-09-22T14:00:00Z", "UTC")).toBe("14:00 22/09");
  });
});

describe("longDayLabel", () => {
  it("spells the day out, for a panel with the room to say it", () => {
    expect(longDayLabel("2026-09-23")).toBe("Wednesday 23 September");
  });
});

describe("nextOrderableDay", () => {
  // Monday 2026-09-21 through Friday 2026-09-25.
  const week = Array.from({ length: 5 }, (_, i) => day({ serviceDate: `2026-09-${21 + i}` }));
  const date = (d: BoardDay | null) => d?.serviceDate ?? null;

  it("takes the next day still open, not one already gone", () => {
    expect(date(nextOrderableDay(week, () => true, "2026-09-23"))).toBe("2026-09-23");
  });

  it("skips a day inside the window that has already passed", () => {
    const open = (d: BoardDay) => d.serviceDate !== "2026-09-23";
    expect(date(nextOrderableDay(week, open, "2026-09-23"))).toBe("2026-09-24");
  });

  it("falls back to a day already gone rather than showing nothing", () => {
    const open = (d: BoardDay) => d.serviceDate === "2026-09-21";
    expect(date(nextOrderableDay(week, open, "2026-09-23"))).toBe("2026-09-21");
  });

  it("falls back to today when no day can be ordered on at all", () => {
    expect(date(nextOrderableDay(week, () => false, "2026-09-24"))).toBe("2026-09-24");
  });

  it("falls back to a day that at least has dishes on it", () => {
    const bare = week.map((d) =>
      d.serviceDate === "2026-09-22" ? d : { ...d, menuId: null, dishes: [] },
    );
    expect(date(nextOrderableDay(bare, () => false, "2026-10-01"))).toBe("2026-09-22");
  });

  it("has nothing to offer for a week with no days in it", () => {
    expect(nextOrderableDay([], () => true, "2026-09-23")).toBeNull();
  });
});

describe("cellReason", () => {
  const ask = (d: BoardDay, now = BEFORE) => cellReason({ day: d, now, timeZone: TZ });

  it("is null while the menu is published and the cutoff is ahead", () => {
    expect(ask(day())).toBeNull();
  });

  it("names the day when there is no menu, rather than saying tomorrow", () => {
    expect(ask(day({ menuId: null, status: null, orderCutoffAt: null, dishes: [] }))).toBe(
      "No menu for Wed 23 Sept yet",
    );
  });

  it("refuses a cancelled day", () => {
    expect(ask(day({ status: "cancelled" }))).toBe("Lunch is cancelled this day");
  });

  it("refuses a menu with nothing on it", () => {
    expect(ask(day({ dishes: [] }))).toBe("This menu has no dishes on it yet");
  });

  it("refuses a draft for a member", () => {
    expect(ask(day({ status: "draft" }))).toBe("This menu isn't published yet");
  });

  it("refuses a locked day for a member", () => {
    expect(ask(day({ status: "locked" }))).toBe(
      "Orders are closed and have gone to the caterer",
    );
  });

  it("quotes the cutoff once it has passed", () => {
    expect(ask(day(), AFTER)).toBe("Ordering closed at 21:00 22/09");
  });

  it("holds an admin to the window too, because this board is not for correcting", () => {
    // It used to exempt them, which meant an admin could put a meal on a bill
    // for a day already eaten by tapping their own row.
    expect(ask(day({ status: "draft" }), AFTER)).toBe("This menu isn't published yet");
    expect(ask(day({ status: "locked" }), AFTER)).toBe(
      "Orders are closed and have gone to the caterer",
    );
  });

  it("refuses a day with no menu at all", () => {
    expect(ask(day({ menuId: null, dishes: [] }))).toBe("No menu for Wed 23 Sept yet");
  });
});

describe("passOnReason", () => {
  const ask = (over: Partial<Parameters<typeof passOnReason>[0]> = {}) =>
    passOnReason({
      cell: cell(),
      serviceDate: "2026-09-23",
      openWeekStart: "2026-09-21",
      offeredTo: null,
      ...over,
    });

  it("allows a meal inside the open billing week", () => {
    expect(ask()).toBeNull();
  });

  /**
   * The bug the old Transfers screen had: it asked the database for orders
   * from `today`, so Monday's meal became unpassable on Wednesday although
   * the trigger refuses only a meal already on a closed bill.
   */
  it("allows a meal earlier in the week than today", () => {
    expect(ask({ serviceDate: "2026-09-21", openWeekStart: "2026-09-21" })).toBeNull();
  });

  it("refuses a meal from a week whose bill has closed", () => {
    expect(ask({ serviceDate: "2026-09-18" })).toBe("That week's bill is closed");
  });

  it("refuses an empty cell", () => {
    expect(ask({ cell: null })).toBe("There is no meal here to pass on");
  });

  it("refuses a cancelled order", () => {
    expect(ask({ cell: cell({ status: "cancelled" }) })).toBe(
      "There is no meal here to pass on",
    );
  });

  it("refuses an optimistic cell that has no id yet", () => {
    expect(ask({ cell: cell({ orderId: 0 }) })).toBe("Still saving this order");
  });

  it("names who already has it", () => {
    expect(ask({ cell: cell({ transferredToName: "Tèo" }) })).toBe("Already passed to Tèo");
  });

  it("names who it is already offered to", () => {
    expect(ask({ offeredTo: "Dinh" })).toBe("Already offered to Dinh");
  });

  /**
   * This used to answer "Only an admin can pass on somebody else's meal" when
   * a `mayAct` flag was false, for the form an admin had for recording a swap
   * between two other people. The form is gone, so the flag is gone with it:
   * the board only ever asks this about the reader's own meal. Asserted at
   * runtime as well as by the compiler, so a flag reintroduced by name cannot
   * quietly start refusing people again.
   */
  it("has no flag for who is asking, so nothing here refuses a non-admin", () => {
    const stale: object = { mayAct: false };
    expect(ask({ ...stale })).toBeNull();
  });

  it("refuses a meal whose day is over, in the trigger's terms", () => {
    expect(ask({ over: true })).toBe(lunchOverReason("2026-09-23"));
    expect(lunchOverReason("2026-09-23")).toMatch(/is over, so it can no longer be passed on$/);
  });
});

describe("lunchIsOver", () => {
  const ORG = { timezone: TZ, businessDayStartsAt: "08:30", businessDayEndsAt: "17:30" };

  // 17:30 in Ho Chi Minh on the 23rd is 10:30 UTC.
  it("is false through the afternoon, while a member can still pass a meal", () => {
    expect(lunchIsOver({ day: day(), org: ORG, now: new Date("2026-09-23T10:29:00Z") })).toBe(false);
  });

  it("is true from the office's end of day", () => {
    expect(lunchIsOver({ day: day(), org: ORG, now: new Date("2026-09-23T10:30:00Z") })).toBe(true);
  });

  it("is false for a day with no menu, which has nothing to pass on anyway", () => {
    expect(
      lunchIsOver({
        day: day({ menuId: null, status: null }),
        org: ORG,
        now: new Date("2026-09-24T00:00:00Z"),
      }),
    ).toBe(false);
  });
});

describe("cellMark", () => {
  it("fills for an ordered dish", () => {
    expect(cellMark(cell(), false)).toBe("ordered");
  });

  it("outlines for eating with no dish chosen", () => {
    expect(cellMark(cell({ dishName: null }), false)).toBe("eating");
  });

  it("marks a meal that went to somebody else", () => {
    expect(cellMark(cell({ transferredToName: "Tèo" }), false)).toBe("passed");
  });

  it("shows nothing for a cancelled order", () => {
    expect(cellMark(cell({ status: "cancelled" }), false)).toBe("none");
  });

  it("shows a standing order only where no real row exists", () => {
    expect(cellMark(null, true)).toBe("projected");
    expect(cellMark(cell(), true)).toBe("ordered");
  });
});

describe("pickDish", () => {
  it("returns the only dish when there is only one", () => {
    expect(pickDish([DISHES[0]!])?.name).toBe("Cơm gà");
  });

  it("reaches every dish, so the office is not funnelled onto the first", () => {
    expect(pickDish(DISHES, { random: () => 0 })?.id).toBe(5);
    expect(pickDish(DISHES, { random: () => 0.5 })?.id).toBe(6);
    expect(pickDish(DISHES, { random: () => 0.99 })?.id).toBe(7);
  });

  it("never returns out of range on a random() of exactly 1", () => {
    expect(pickDish(DISHES, { random: () => 1 })?.id).toBe(7);
  });

  it("skips the dish already ordered, so Surprise me surprises", () => {
    for (const roll of [0, 0.5, 0.99]) {
      expect(pickDish(DISHES, { excludeId: 6, random: () => roll })?.id).not.toBe(6);
    }
  });

  it("re-offers the only dish rather than going blank", () => {
    expect(pickDish([DISHES[0]!], { excludeId: 5 })?.id).toBe(5);
  });

  it("has nothing to pick from an empty menu", () => {
    expect(pickDish([])).toBeNull();
  });
});

describe("planState, a day ahead of its menu", () => {
  // 2026-09-24 is a Thursday.
  const THU = "2026-09-24";
  const TODAY = "2026-09-22";
  const noMenu = day({ serviceDate: THU, menuId: null, status: null, orderCutoffAt: null, dishes: [] });
  const base = { day: noMenu, today: TODAY, hasOrderRow: false, weekdays: new Set([4]), exception: null };

  it("reads the rule, then the exception over it", () => {
    expect(planState(base)).toBe("standing");
    expect(planState({ ...base, exception: "skip" })).toBe("skipped");
    expect(planState({ ...base, exception: "force" })).toBe("standing");
    expect(planState({ ...base, weekdays: new Set() })).toBe("empty");
    expect(planState({ ...base, weekdays: new Set(), exception: "force" })).toBe("planned");
    expect(planState({ ...base, weekdays: new Set(), exception: "skip" })).toBe("empty");
  });

  it("counts a draft as not out yet", () => {
    expect(planState({ ...base, day: day({ serviceDate: THU, status: "draft" }) })).toBe("standing");
  });

  it("leaves a published, locked or cancelled day to ordering", () => {
    for (const status of ["published", "locked", "cancelled"] as const) {
      expect(planState({ ...base, day: day({ serviceDate: THU, status }) })).toBeNull();
    }
  });

  it("is nothing today, before, or on a day with an order row", () => {
    expect(planState({ ...base, day: { ...noMenu, serviceDate: TODAY } })).toBeNull();
    expect(planState({ ...base, day: { ...noMenu, serviceDate: "2026-09-21" } })).toBeNull();
    expect(planState({ ...base, hasOrderRow: true })).toBeNull();
  });

  it("has no horizon", () => {
    expect(planState({ ...base, day: { ...noMenu, serviceDate: "2031-09-25" } })).toBe("standing");
  });

  it("toggles each state to the other side of the rule", () => {
    expect(planToggle("standing")).toBe("skip");
    expect(planToggle("skipped")).toBeNull();
    expect(planToggle("empty")).toBe("force");
    expect(planToggle("planned")).toBeNull();
  });

  it("names the day in the toast", () => {
    expect(planMessage("skipped", THU)).toMatch(/^Skipped Thu 24 Sept?$/);
  });
});
