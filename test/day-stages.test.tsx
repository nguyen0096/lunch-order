import { render, screen, within } from "@testing-library/react";
import { DayStages } from "../src/web/components/DayStages.js";
import { zonedTimeToInstant } from "../src/shared/dates.js";

const TZ = "Asia/Ho_Chi_Minh";
const ORG = { timezone: TZ, businessDayStartsAt: "08:30", businessDayEndsAt: "17:30" };
const DAY = "2026-09-24";
/** 21:00 the evening before, in the office's zone. */
const CUTOFF = zonedTimeToInstant("2026-09-23", "21:00", TZ).toISOString();

function show(status: string | null, local: [string, string]) {
  render(
    <DayStages
      serviceDate={DAY}
      status={status}
      orderCutoffAt={CUTOFF}
      org={ORG}
      now={zonedTimeToInstant(local[0], local[1], TZ)}
    />,
  );
}

/** The point the line says the day has reached. */
function current(): string {
  const list = screen.getByRole("list", { name: "What has happened to this day" });
  const here = within(list)
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("aria-current") === "step");
  return here?.textContent ?? "";
}

describe("the line a day moves along", () => {
  it("is on Ordering while the menu is published and the cutoff is ahead", () => {
    show("published", ["2026-09-23", "18:00"]);
    expect(current()).toBe("Ordering");
  });

  it("moves to Cooking at the cutoff, before the hourly check has locked it", () => {
    show("published", ["2026-09-23", "21:30"]);
    expect(current()).toBe("Cooking");
  });

  it("stays on Cooking through the morning", () => {
    show("locked", ["2026-09-24", "09:00"]);
    expect(current()).toBe("Cooking");
  });

  it("reaches Served after the office's end of day", () => {
    show("locked", ["2026-09-24", "18:00"]);
    expect(current()).toBe("Served");
  });

  it("says a day with no menu has not started, rather than drawing an empty line", () => {
    show(null, ["2026-09-23", "18:00"]);
    expect(screen.getByText("No menu for this day yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("says lunch is off, because cancelled is not a step along the line", () => {
    show("cancelled", ["2026-09-23", "18:00"]);
    expect(screen.getByText(/Lunch is cancelled for this day/)).toBeInTheDocument();
    expect(screen.getByText(/Every order for it was cancelled too/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("names every point, so the ones still ahead are readable", () => {
    show("published", ["2026-09-23", "18:00"]);
    const list = screen.getByRole("list", { name: "What has happened to this day" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Ordering",
      "Cooking",
      "Served",
    ]);
  });
});
