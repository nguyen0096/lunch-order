import { describe, expect, it } from "vitest";
import { projectStandingDays } from "../src/shared/projection.js";

// Mon 2026-09-21 .. Fri 2026-09-25.
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];

function project(over: Partial<Parameters<typeof projectStandingDays>[0]> = {}) {
  return projectStandingDays({
    days: WEEK,
    today: "2026-09-22",
    weekdays: new Set([1, 2, 3, 4, 5]),
    skips: new Set<string>(),
    forces: new Set<string>(),
    hasOrder: () => false,
    ...over,
  });
}

describe("projectStandingDays", () => {
  it("projects only days strictly after today", () => {
    expect([...project()]).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
  });

  it("projects nothing when the rule covers no weekday in view", () => {
    expect([...project({ weekdays: new Set([6, 7]) })]).toEqual([]);
  });

  it("follows the rule's weekdays", () => {
    expect([...project({ weekdays: new Set([4]) })]).toEqual(["2026-09-24"]);
  });

  it("drops a skipped day", () => {
    expect([...project({ skips: new Set(["2026-09-24"]) })]).toEqual([
      "2026-09-23",
      "2026-09-25",
    ]);
  });

  it("adds a forced day the rule does not cover", () => {
    expect([...project({ weekdays: new Set<number>(), forces: new Set(["2026-09-25"]) })]).toEqual([
      "2026-09-25",
    ]);
  });

  it("lets a force win over a skip", () => {
    expect([
      ...project({
        weekdays: new Set([4]),
        skips: new Set(["2026-09-24"]),
        forces: new Set(["2026-09-24"]),
      }),
    ]).toEqual(["2026-09-24"]);
  });

  it("yields to a real order row, even a forced one", () => {
    expect([
      ...project({ forces: new Set(["2026-09-25"]), hasOrder: (d) => d === "2026-09-25" }),
    ]).toEqual(["2026-09-23", "2026-09-24"]);
  });

  it("never projects the past, whatever the rule says", () => {
    expect([
      ...project({ today: "2026-09-25", forces: new Set(["2026-09-21", "2026-09-25"]) }),
    ]).toEqual([]);
  });
});
