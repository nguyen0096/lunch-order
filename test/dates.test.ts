import { describe, expect, it } from "vitest";
import {
  addDays,
  daysApart,
  formatDay,
  isoWeek,
  isoWeekday,
  todayIn,
  weekNumberOf,
  weekStart,
  zonedTimeToInstant,
} from "../src/shared/dates.js";

const HCM = "Asia/Ho_Chi_Minh";

describe("todayIn", () => {
  it("uses the zone's local day, not the UTC one", () => {
    expect(todayIn(HCM, new Date("2026-09-22T17:30:00Z"))).toBe("2026-09-23");
    expect(todayIn("UTC", new Date("2026-09-22T17:30:00Z"))).toBe("2026-09-22");
  });

  it("stays on the same day just before the zone rolls over", () => {
    expect(todayIn(HCM, new Date("2026-09-22T16:59:59Z"))).toBe("2026-09-22");
  });

  it("pads month and day", () => {
    expect(todayIn("UTC", new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });
});

describe("addDays", () => {
  const cases: Array<[string, number, string]> = [
    ["2026-09-22", 1, "2026-09-23"],
    ["2026-09-22", 0, "2026-09-22"],
    ["2026-09-22", -1, "2026-09-21"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2026-09-22", 7, "2026-09-29"],
  ];

  it.each(cases)("%s + %d days", (iso, days, expected) => {
    expect(addDays(iso, days)).toBe(expected);
  });

  it("rejects a non-ISO date", () => {
    expect(() => addDays("22/09/2026", 1)).toThrow(TypeError);
  });
});

describe("isoWeekday", () => {
  const cases: Array<[string, number]> = [
    ["2026-09-21", 1],
    ["2026-09-22", 2],
    ["2026-09-23", 3],
    ["2026-09-24", 4],
    ["2026-09-25", 5],
    ["2026-09-26", 6],
    ["2026-09-27", 7],
  ];

  it.each(cases)("%s is weekday %d", (iso, expected) => {
    expect(isoWeekday(iso)).toBe(expected);
  });

  it("rejects a non-ISO date", () => {
    expect(() => isoWeekday("nope")).toThrow(TypeError);
  });
});

describe("isoWeek", () => {
  const cases: Array<[string, number]> = [
    ["2026-01-01", 1],
    ["2026-09-21", 39],
    ["2026-09-23", 39],
    ["2026-09-27", 39],
    ["2026-09-28", 40],
  ];

  it.each(cases)("%s is week %d", (iso, week) => {
    expect(isoWeek(iso)).toBe(week);
  });

  /**
   * The whole reason this is not `ceil(dayOfYear / 7)`. A week belongs to the
   * year holding its Thursday, so the last days of December can be week 1 and
   * the first days of January can be week 52 or 53. 2026 is a 53-week year,
   * which the commoner off-by-one implementations get wrong here specifically.
   */
  const boundary: Array<[string, number]> = [
    ["2026-12-27", 52],
    ["2026-12-28", 53],
    ["2026-12-31", 53],
    ["2027-01-01", 53],
    ["2027-01-03", 53],
    ["2027-01-04", 1],
    ["2025-12-29", 1],
    ["2024-12-30", 1],
    ["2021-01-01", 53],
    ["2023-01-01", 52],
  ];

  it.each(boundary)("%s is week %d, by the Thursday rule", (iso, week) => {
    expect(isoWeek(iso)).toBe(week);
  });

  it("counts every day of a 53-week year, end to end", () => {
    // Intl has no ISO week, so the oracle is the definition: week 1 is the one
    // holding 4 January, and each week after it is seven days on. ISO 2026
    // therefore runs Mon 29/12/2025 to Sun 03/01/2027, 371 days.
    const firstMonday = weekStart("2026-01-04");
    let seen = 0;
    for (let d = firstMonday; d <= "2027-01-03"; d = addDays(d, 1)) {
      expect(isoWeek(d)).toBe(Math.floor(daysApart(firstMonday, d) / 7) + 1);
      seen += 1;
    }
    expect(seen).toBe(53 * 7);
  });
});

describe("weekNumberOf", () => {
  it("names the week its weekdays are in, whatever day the office starts on", () => {
    expect(weekNumberOf("2026-09-21")).toBe(39);
    // An office whose billing week starts on Sunday: 20/09 is the tail of week
    // 38, but the lunches it shows are week 39's.
    expect(weekNumberOf("2026-09-20")).toBe(39);
  });

  it("carries the boundary week with it", () => {
    expect(weekNumberOf("2026-12-28")).toBe(53);
    expect(weekNumberOf("2027-01-04")).toBe(1);
  });
});

describe("weekStart", () => {
  it("defaults to Monday", () => {
    expect(weekStart("2026-09-24")).toBe("2026-09-21");
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
  });

  it("honours a Sunday week start", () => {
    expect(weekStart("2026-09-24", 7)).toBe("2026-09-20");
    expect(weekStart("2026-09-20", 7)).toBe("2026-09-20");
  });
});

describe("zonedTimeToInstant", () => {
  it("turns an org's local cutoff into the right instant", () => {
    expect(zonedTimeToInstant("2026-09-22", "16:00", HCM).toISOString()).toBe(
      "2026-09-22T09:00:00.000Z",
    );
  });

  it("follows a zone across its DST change", () => {
    expect(zonedTimeToInstant("2026-01-15", "09:30", "America/New_York").toISOString()).toBe(
      "2026-01-15T14:30:00.000Z",
    );
    expect(zonedTimeToInstant("2026-07-01", "09:30", "America/New_York").toISOString()).toBe(
      "2026-07-01T13:30:00.000Z",
    );
  });

  it("rejects malformed inputs", () => {
    expect(() => zonedTimeToInstant("2026-09-22", "16h", HCM)).toThrow(TypeError);
    expect(() => zonedTimeToInstant("22-09", "16:00", HCM)).toThrow(TypeError);
  });
});

describe("formatDay", () => {
  it("renders weekday, padded day and short month", () => {
    expect(formatDay("2026-03-02")).toBe("Mon 02 Mar");
    expect(formatDay("2026-01-05")).toBe("Mon 05 Jan");
  });

  it("reads the date as UTC, so the runner's zone cannot shift it", () => {
    expect(formatDay("2026-06-15")).toBe("Mon 15 Jun");
  });

  it("rejects a non-ISO date", () => {
    expect(() => formatDay("")).toThrow(TypeError);
  });
});

describe("zonedTimeToInstant across a DST seam", () => {
  /**
   * The hour that does not exist, and the hour that happens twice.
   *
   * America/New_York springs forward at 02:00 on 8 March 2026 and falls back
   * at 02:00 on 1 November 2026. These are the two mornings a year where
   * guessing the instant and correcting it once by the offset at the guess
   * lands on the wrong side. Vietnam has no DST, so nothing in this office
   * would ever have shown it.
   */
  it("resolves a wall time inside the skipped hour to a real instant", () => {
    // 02:30 on the spring-forward morning never happens. There is no correct
    // answer, only a defensible one, and what matters is that it is a real
    // instant on that morning rather than one an hour outside it.
    const at = zonedTimeToInstant("2026-03-08", "02:30", "America/New_York");
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.toISOString().slice(0, 10)).toBe("2026-03-08");
  });

  it("puts each side of the repeated hour on its own offset", () => {
    // 01:30 happens twice on the fall-back morning: once at UTC-4, once at
    // UTC-5. Either is a defensible answer; an instant on the wrong DAY is not.
    const at = zonedTimeToInstant("2026-11-01", "01:30", "America/New_York");
    expect(at.toISOString().slice(0, 10)).toBe("2026-11-01");
    // An hour either side of the seam has to keep its own offset.
    expect(zonedTimeToInstant("2026-11-01", "00:30", "America/New_York").toISOString())
      .toBe("2026-11-01T04:30:00.000Z");
    expect(zonedTimeToInstant("2026-11-01", "03:30", "America/New_York").toISOString())
      .toBe("2026-11-01T08:30:00.000Z");
  });

  it("is exact on either side of the spring-forward seam", () => {
    expect(zonedTimeToInstant("2026-03-08", "01:30", "America/New_York").toISOString())
      .toBe("2026-03-08T06:30:00.000Z");
    expect(zonedTimeToInstant("2026-03-08", "03:30", "America/New_York").toISOString())
      .toBe("2026-03-08T07:30:00.000Z");
  });
});
