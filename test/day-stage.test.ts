import { describe, expect, it } from "vitest";
import { dayStage, stageWord } from "../src/shared/gating.js";
import type { Org } from "../src/shared/types.js";

const ORG = {
  timezone: "Asia/Ho_Chi_Minh",
  businessDayStartsAt: "08:30",
  businessDayEndsAt: "17:30",
} satisfies Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;

/** An instant expressed as the office reads it, which is the only reading that counts. */
function at(local: string): Date {
  return new Date(`${local}+07:00`);
}

describe("The five stages of a day", () => {
  const day = "2026-09-24";
  const cutoff = "2026-09-23T14:00:00Z"; // 21:00 the evening before, in Saigon
  const stage = (status: string | null, now: Date) =>
    dayStage({ serviceDate: day, status, orderCutoffAt: cutoff, org: ORG, now });

  it("is open while the menu is published and the cutoff is ahead", () => {
    expect(stage("published", at("2026-09-23T18:00"))).toBe("open");
  });

  it("locks on the cutoff, whatever the stored status still says", () => {
    // The hourly tick has not run yet, so the row still reads `published`.
    expect(stage("published", at("2026-09-23T21:00"))).toBe("locked");
    expect(stage("locked", at("2026-09-23T21:00"))).toBe("locked");
  });

  it("stays locked right up to the office's start of day", () => {
    expect(stage("locked", at("2026-09-24T08:29"))).toBe("locked");
    expect(stage("locked", at("2026-09-24T08:30"))).toBe("closed");
  });

  it("is done from the end of the day, not from midnight", () => {
    expect(stage("locked", at("2026-09-24T17:29"))).toBe("closed");
    expect(stage("locked", at("2026-09-24T17:30"))).toBe("done");
    expect(stage("locked", at("2026-09-25T09:00"))).toBe("done");
  });

  it("reads a day with no menu apart from a day whose menu was called off", () => {
    expect(stage(null, at("2026-09-24T12:00"))).toBe("no_menu");
    expect(stage("cancelled", at("2026-09-24T12:00"))).toBe("cancelled");
  });

  it("says nothing on an open day and something on every other", () => {
    expect(stageWord("open")).toBeNull();
    for (const s of ["no_menu", "locked", "closed", "done", "cancelled"] as const) {
      expect(stageWord(s)).not.toBeNull();
    }
  });

  it("agrees with the office's clock rather than the reader's", () => {
    // 08:40 in Saigon is 01:40 UTC. A reader in London must still be told the
    // kitchen has started.
    expect(stage("locked", new Date("2026-09-24T01:40:00Z"))).toBe("closed");
  });
});
