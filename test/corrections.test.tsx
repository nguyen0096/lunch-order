import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fakeClockUser } from "./user.js";
import { toast } from "sonner";
import { CorrectionsScreen } from "../src/web/components/CorrectionsScreen.js";
import * as api from "../src/web/api.js";
import {
  cellKey,
  type CorrectionEntry,
  type CorrectionsWeek,
  type RecordedMeal,
} from "../src/web/api.js";
import { formatMoney } from "../src/shared/money.js";
import { addDays, zonedTimeToInstant } from "../src/shared/dates.js";
import type { BoardDay } from "../src/web/api.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError`, `cellKey` and every rule about
// what a correction would do to somebody's money stay real, because the
// arithmetic the screen shows before the write is most of what is under test.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchCorrectionsWeek: vi.fn(),
    correctMeal: vi.fn(),
    correctMealOffMenu: vi.fn(),
    removeMeal: vi.fn(),
    repriceDish: vi.fn(),
  };
});

const fetchCorrectionsWeek = vi.mocked(api.fetchCorrectionsWeek);
const correctMeal = vi.mocked(api.correctMeal);
const correctMealOffMenu = vi.mocked(api.correctMealOffMenu);
const removeMeal = vi.mocked(api.removeMeal);
const repriceDish = vi.mocked(api.repriceDish);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

/* ------------------------------------------------------------------ fixture */

const TZ = "Asia/Ho_Chi_Minh";

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: TZ,
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
  businessDayStartsAt: "08:30",
  businessDayEndsAt: "17:30",
};

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  mayFoundOffice: true,
  orgs: [
    { org: ORG, role: "admin", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" },
  ],
};

// A fixed Wednesday, so the day the screen opens on is the same whichever day
// the suite is run: the office's day ends at 17:30 and the clock below says
// 18:00, which makes today the most recent working day that is over.
const MONDAY = "2026-09-21";
const WED = "2026-09-23";
const SUNDAY = "2026-09-27";

const COM_GA = 101;
const BUN_BO = 102;

const money = (minor: number) => formatMoney(minor, ORG.currency).replace(/\u00a0/g, " ");
/** The same figure unnormalised, for accessible names and toast strings. */
const rawMoney = (minor: number) => formatMoney(minor, ORG.currency);

function days(): BoardDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const serviceDate = `2026-09-${21 + i}`;
    if (serviceDate !== WED) {
      return { serviceDate, menuId: null, status: null, orderCutoffAt: null, dishes: [] };
    }
    return {
      serviceDate,
      menuId: 5,
      status: "locked" as const,
      orderCutoffAt: "2026-09-22T14:00:00Z",
      dishes: [
        { id: COM_GA, name: "Cơm gà", priceMinor: 45_000 },
        { id: BUN_BO, name: "Bún bò", priceMinor: 50_000 },
      ],
    };
  });
}

function meal(over: Partial<RecordedMeal> & Pick<RecordedMeal, "orderId" | "profileId">): RecordedMeal {
  const quantity = over.quantity ?? 1;
  const unitPriceMinor = over.unitPriceMinor === undefined ? 45_000 : over.unitPriceMinor;
  return {
    serviceDate: WED,
    menuItemId: COM_GA,
    dishName: "Cơm gà",
    note: null,
    transferredToName: null,
    amountMinor: unitPriceMinor === null ? null : unitPriceMinor * quantity,
    ...over,
    quantity,
    unitPriceMinor,
  };
}

/**
 * Four people, one day. Dinh has nothing recorded, which is the case this
 * screen exists to answer; Quy had two portions at a price nobody else paid,
 * which is what makes a reprice move money in both directions at once.
 */
function week(over: Partial<CorrectionsWeek> = {}): CorrectionsWeek {
  const meals = new Map<string, RecordedMeal>([
    [
      cellKey("me", WED),
      meal({
        orderId: 901,
        profileId: "me",
        menuItemId: BUN_BO,
        dishName: "Bún bò",
        unitPriceMinor: 50_000,
      }),
    ],
    [cellKey("quy", WED), meal({ orderId: 902, profileId: "quy", quantity: 2, unitPriceMinor: 55_000 })],
    [cellKey("teo", WED), meal({ orderId: 900, profileId: "teo", note: "ít cơm" })],
  ]);

  return {
    days: days(),
    members: [
      { profileId: "dinh", name: "Dinh", balanceMinor: 0 },
      { profileId: "me", name: "Neyu", balanceMinor: 0 },
      { profileId: "quy", name: "Quy", balanceMinor: 55_000 },
      { profileId: "teo", name: "Tèo", balanceMinor: 135_000 },
    ],
    meals,
    period: {
      periodId: 3,
      periodStart: MONDAY,
      periodEnd: SUNDAY,
      status: "open",
      closedAt: null,
    },
    entries: [],
    ...over,
  };
}

const ENTRIES: CorrectionEntry[] = [
  {
    id: 3,
    serviceDate: WED,
    kind: "reprice",
    orderId: null,
    menuItemId: COM_GA,
    profileId: null,
    summary: "Cơm gà repriced for this day",
    reason: null,
    madeBy: "me",
    madeAt: "2026-09-26T03:00:00Z",
  },
  {
    id: 2,
    serviceDate: WED,
    kind: "removal",
    orderId: 903,
    menuItemId: null,
    profileId: "dinh",
    summary: "Dinh had nothing on this day",
    reason: null,
    madeBy: "me",
    madeAt: "2026-09-26T02:30:00Z",
  },
  {
    id: 1,
    serviceDate: WED,
    kind: "meal",
    orderId: 900,
    menuItemId: COM_GA,
    profileId: "teo",
    summary: "Tèo had Cơm gà, 1 portion",
    reason: "caterer delivered 1 extra, verbal order from Tèo",
    madeBy: "me",
    madeAt: "2026-09-26T02:00:00Z",
  },
];

function serve(data: CorrectionsWeek = week()) {
  fetchCorrectionsWeek.mockResolvedValue(data);
}

function renderScreen() {
  return render(<CorrectionsScreen me={ME} org={ORG} role="admin" />);
}

/** Waits for the day to land, whatever it landed on. */
async function ready() {
  await screen.findByRole("heading", { name: "Wednesday 23 September" });
}

async function openDialog(user: ReturnType<typeof fakeClockUser>, name: string) {
  await user.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog");
}

/** Picks an option out of the day's dish list, which opens in a portal. */
async function pick(user: ReturnType<typeof fakeClockUser>, dialog: HTMLElement, label: string) {
  await user.click(within(dialog).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // 18:00 on the fixture's Wednesday: past the office's 17:30, so Wednesday is
  // the most recent working day that is over and the screen opens on it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(zonedTimeToInstant(WED, "18:00", TZ));
  correctMeal.mockResolvedValue({ orderId: 950, balanceMinor: 45_000 });
  correctMealOffMenu.mockResolvedValue({
    orderId: 951,
    menuItemId: 103,
    balanceMinor: 60_000,
  });
  removeMeal.mockResolvedValue({ balanceMinor: 90_000 });
  repriceDish.mockResolvedValue({ lines: 3, people: 2 });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ----------------------------------------------------------- what it shows */

describe("Corrections, reading the day", () => {
  it("opens on the most recent working day that is over, named with its week", async () => {
    serve();
    renderScreen();
    await ready();

    expect(screen.getByText("In the week of 21–27 September.")).toBeInTheDocument();
    expect(fetchCorrectionsWeek).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 7, from: MONDAY, to: SUNDAY }),
    );
  });

  it("lists the people with nothing recorded beside the ones who ate", async () => {
    serve();
    renderScreen();
    await ready();

    expect(screen.getByText("Nothing recorded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a meal for Dinh" })).toBeInTheDocument();
    expect(screen.getByText("Cơm gà × 2")).toBeInTheDocument();
    expect(screen.getByText("ít cơm")).toBeInTheDocument();
    expect(screen.getByText(money(205_000))).toBeInTheDocument();
  });

  it("keeps a way back to the screen it is reached from", async () => {
    serve();
    renderScreen();
    await ready();

    expect(screen.getByRole("link", { name: "Back to Payments" })).toHaveAttribute(
      "href",
      "#/o/test-office/payments",
    );
  });

  it("renders the database's own sentence when the day does not load, and retries", async () => {
    const user = fakeClockUser();
    fetchCorrectionsWeek.mockRejectedValueOnce(new Error("network is down"));
    renderScreen();

    expect(await screen.findByRole("heading", { name: "The day did not load" })).toBeInTheDocument();
    expect(screen.getByText("network is down")).toBeInTheDocument();

    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });
});

/* ---------------------------------------------------------- a settled week */

describe("A week that has been settled", () => {
  function settled(): CorrectionsWeek {
    return week({
      period: {
        periodId: 3,
        periodStart: MONDAY,
        periodEnd: SUNDAY,
        status: "closed",
        closedAt: "2026-09-28T03:00:00Z",
      },
    });
  }

  it("says which week it was and when it was settled", async () => {
    serve(settled());
    renderScreen();
    await ready();

    expect(
      screen.getByText(
        "21–27 September was settled on 28 Sept, 10:00. A settled week is already billed and paid against, so nothing on it can be corrected here.",
      ),
    ).toBeInTheDocument();
  });

  it("offers nothing, and says why rather than greying the controls in silence", async () => {
    const user = fakeClockUser();
    serve(settled());
    renderScreen();
    await ready();

    const change = screen.getByRole("button", { name: "Change what Tèo had" });
    expect(change).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Reprice Cơm gà" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await user.click(change);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(correctMeal).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------- correcting a meal */

describe("Recording a meal the app missed", () => {
  it("says what it would do to that person's money before it is saved", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);

    expect(
      within(dialog).getByText(
        `This would put ${money(45_000)} on Dinh's bill. Dinh owes nothing now, and would owe ${money(45_000)}.`,
      ),
    ).toBeInTheDocument();
    expect(correctMeal).not.toHaveBeenCalled();
  });

  it("sends the dish, the portions and the person, and reports the balance the database returns", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);
    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));

    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith({
        orgId: 7,
        serviceDate: WED,
        profileId: "dinh",
        menuItemId: COM_GA,
        quantity: 1,
        note: null,
        reason: null,
      }),
    );
    expect(success).toHaveBeenCalledWith(
      `Dinh now has Cơm gà. Dinh owes ${rawMoney(45_000)}.`,
    );
  });

  it("changes the dish somebody had and names the difference, not the whole meal", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Change what Tèo had");
    await pick(user, dialog, `Bún bò · ${rawMoney(50_000)}`);

    expect(
      within(dialog).getByText(
        `This would put ${money(5_000)} on Tèo's bill, from ${money(45_000)} to ${money(50_000)}. Tèo owes ${money(135_000)} now, and would owe ${money(140_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));
    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "teo", menuItemId: BUN_BO, quantity: 1 }),
      ),
    );
  });

  it("takes a meal that did not happen off the record, saying whose bill loses what", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Change what Tèo had");
    await user.click(within(dialog).getByRole("button", { name: "This meal did not happen" }));

    expect(
      within(dialog).getByText(
        `This would take ${money(45_000)} off Tèo's bill. Tèo owes ${money(135_000)} now, and would owe ${money(90_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remove the meal" }));
    await waitFor(() =>
      expect(removeMeal).toHaveBeenCalledWith({ orderId: 900, reason: null }),
    );
    expect(success).toHaveBeenCalledWith(`Meal removed. Tèo owes ${rawMoney(90_000)}.`);
  });

  it("records a dish that was never on the menu from the same picker, with its own price", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, "A dish that was not on the menu");

    await user.type(within(dialog).getByLabelText("Dish"), "Cơm sườn");
    await user.type(within(dialog).getByLabelText("What it cost"), "60k");

    expect(
      within(dialog).getByText(
        `This would put ${money(60_000)} on Dinh's bill. Dinh owes nothing now, and would owe ${money(60_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));
    await waitFor(() =>
      expect(correctMealOffMenu).toHaveBeenCalledWith({
        orgId: 7,
        serviceDate: WED,
        profileId: "dinh",
        dishName: "Cơm sườn",
        priceMinor: 60_000,
        quantity: 1,
        note: null,
        reason: null,
      }),
    );
  });

  it("will not save an off-menu dish with no price, and says so", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, "A dish that was not on the menu");
    await user.type(within(dialog).getByLabelText("Dish"), "Cơm sườn");

    const save = within(dialog).getByRole("button", { name: "Save the correction" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getAllByText("Say what the dish cost").length).toBeGreaterThan(0);

    await user.click(save);
    expect(correctMealOffMenu).not.toHaveBeenCalled();
  });

  it("will not send a meal with no portions on it", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);
    await user.clear(within(dialog).getByLabelText("Portions"));

    const save = within(dialog).getByRole("button", { name: "Save the correction" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getAllByText("A meal is between 1 and 20 portions").length).toBeGreaterThan(
      0,
    );

    await user.click(save);
    expect(correctMeal).not.toHaveBeenCalled();
  });

  it("sends the portions somebody typed", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Change what Tèo had");
    await user.clear(within(dialog).getByLabelText("Portions"));
    await user.type(within(dialog).getByLabelText("Portions"), "2");

    expect(
      within(dialog).getByText(
        `This would put ${money(45_000)} on Tèo's bill, from ${money(45_000)} to ${money(90_000)}. Tèo owes ${money(135_000)} now, and would owe ${money(180_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));
    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 })),
    );
  });

  it("cannot be fired twice by a second click while the first is still going", async () => {
    const user = fakeClockUser();
    serve();
    correctMeal.mockReturnValue(new Promise(() => {}));
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);

    const save = within(dialog).getByRole("button", { name: /Sav/ });
    await user.click(save);
    await user.click(within(dialog).getByRole("button", { name: /Sav/ }));

    expect(correctMeal).toHaveBeenCalledTimes(1);
  });

  it("shows the database's refusal in the database's own words, and stays open", async () => {
    const user = fakeClockUser();
    serve();
    correctMeal.mockRejectedValue(
      new Error("ordering for 2026-09-23 is closed: that week was settled on 28/09"),
    );
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);
    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));

    expect(
      await within(dialog).findByText(
        "ordering for 2026-09-23 is closed: that week was settled on 28/09",
      ),
    ).toBeInTheDocument();
    expect(failure).toHaveBeenCalledWith(
      "ordering for 2026-09-23 is closed: that week was settled on 28/09",
    );
  });
});

/* ------------------------------------------------------------ the reason */

describe("Why a correction was made", () => {
  it("sends the reason somebody typed", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);
    await user.type(
      within(dialog).getByLabelText("Why (optional)"),
      "caterer delivered 1 extra, verbal order from Teo",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));

    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "caterer delivered 1 extra, verbal order from Teo",
        }),
      ),
    );
  });

  it("sends nothing rather than an empty reason when the box is left alone", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Change what Tèo had");
    await user.click(within(dialog).getByRole("button", { name: "This meal did not happen" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove the meal" }));

    await waitFor(() => expect(removeMeal).toHaveBeenCalledWith({ orderId: 900, reason: null }));
  });

  it("never blocks the save on it", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Add a meal for Dinh");
    await pick(user, dialog, `Cơm gà · ${rawMoney(45_000)}`);

    expect(within(dialog).getByRole("button", { name: "Save the correction" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

/* -------------------------------------------------------------- repricing */

describe("Repricing a dish for one day", () => {
  it("names the people and the money moving in both directions before it writes", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Reprice Cơm gà");
    fireEvent.change(within(dialog).getByLabelText("What the caterer charged"), {
      target: { value: "50k" },
    });

    expect(within(dialog).getByText("2 people had it, 3 portions in all.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `${money(5_000)} goes onto bills and ${money(10_000)} comes off them.`,
      ),
    ).toBeInTheDocument();
    expect(repriceDish).not.toHaveBeenCalled();
  });

  it("writes one price for the day and reports what the database touched", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Reprice Cơm gà");
    fireEvent.change(within(dialog).getByLabelText("What the caterer charged"), {
      target: { value: "50k" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Reprice for this day" }));

    await waitFor(() =>
      expect(repriceDish).toHaveBeenCalledWith({
        menuItemId: COM_GA,
        priceMinor: 50_000,
        reason: null,
      }),
    );
    expect(success).toHaveBeenCalledWith("Cơm gà repriced on 3 meals, across 2 people.");
  });

  it("refuses a price the dish already carries, and says which", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await openDialog(user, "Reprice Cơm gà");
    fireEvent.change(within(dialog).getByLabelText("What the caterer charged"), {
      target: { value: "45000" },
    });

    expect(within(dialog).getByRole("button", { name: "Reprice for this day" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      within(dialog).getAllByText("That is the price it already carries").length,
    ).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- history */

describe("What has already been corrected", () => {
  it("says so plainly when nothing on the day has been", async () => {
    serve();
    renderScreen();
    await ready();

    expect(screen.getByText("Nothing on this day has been corrected.")).toBeInTheDocument();
  });

  it("shows each correction with who made it, and the reason only where one was given", async () => {
    serve(week({ entries: ENTRIES }));
    renderScreen();
    await ready();

    expect(screen.getByText("Tèo had Cơm gà, 1 portion")).toBeInTheDocument();
    expect(
      screen.getByText("Why: caterer delivered 1 extra, verbal order from Tèo"),
    ).toBeInTheDocument();

    expect(screen.getByText("Dinh had nothing on this day")).toBeInTheDocument();
    expect(screen.getAllByText(/^Why: /)).toHaveLength(1);
    expect(screen.getAllByText("Neyu · 26 Sept, 09:00").length).toBeGreaterThan(0);
  });

  it("renders a price change as a dish's entry, with nobody on it", async () => {
    serve(week({ entries: ENTRIES }));
    renderScreen();
    await ready();

    const entry = screen.getByText("Cơm gà repriced for this day").closest("li");
    expect(entry).not.toBeNull();
    expect(within(entry as HTMLElement).getByText("Price")).toBeInTheDocument();
    expect(within(entry as HTMLElement).queryByText(/^Why: /)).not.toBeInTheDocument();
  });

  it("marks the row of somebody whose meal was corrected", async () => {
    serve(week({ entries: ENTRIES }));
    renderScreen();
    await ready();

    const row = screen.getByText("ít cơm").closest("tr");
    expect(within(row as HTMLElement).getByText("Corrected")).toBeInTheDocument();
    expect(screen.getAllByText("Corrected")).toHaveLength(1);
  });
});

/* ------------------------------------------------ answers out of order */

describe("Corrections, answers that arrive out of order", () => {
  it("draws the week now shown when the week left behind answers last", async () => {
    const user = fakeClockUser();
    const LAST_WED = "2026-09-16";
    const lastWeek = week({
      days: days().map((d) => ({ ...d, serviceDate: addDays(d.serviceDate, -7) })),
      meals: new Map([
        [
          cellKey("quy", LAST_WED),
          meal({ orderId: 802, profileId: "quy", serviceDate: LAST_WED, quantity: 2 }),
        ],
      ]),
    });

    let answerFirst: (w: CorrectionsWeek) => void = () => {};
    fetchCorrectionsWeek.mockImplementationOnce(
      () => new Promise((resolve) => (answerFirst = resolve)),
    );
    fetchCorrectionsWeek.mockResolvedValue(lastWeek);
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await screen.findByRole("heading", { name: "Wednesday 16 September" });
    expect(await screen.findByText("Cơm gà × 2")).toBeInTheDocument();

    await act(async () => answerFirst(week()));
    expect(screen.getByText("Cơm gà × 2")).toBeInTheDocument();
    expect(screen.queryByText("ít cơm")).not.toBeInTheDocument();
  });
});
