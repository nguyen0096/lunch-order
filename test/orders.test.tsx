import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fakeClockUser } from "./user.js";
import { toast } from "sonner";
import { OrdersScreen } from "../src/web/components/OrdersScreen.js";
import * as api from "../src/web/api.js";
import {
  cellKey,
  type BoardDay,
  type CorrectionEntry,
  type OrdersWeek,
  type PassRecord,
  type RecordedMeal,
} from "../src/web/api.js";
import { formatMoney } from "../src/shared/money.js";
import { zonedTimeToInstant } from "../src/shared/dates.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. Every rule about what a save would do to
// somebody's money, and every word the screen says, stays real.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchOrdersWeek: vi.fn(),
    correctMeal: vi.fn(),
    correctMealOffMenu: vi.fn(),
    removeMeal: vi.fn(),
    repriceDish: vi.fn(),
    recordPass: vi.fn(),
    answerPass: vi.fn(),
    undoPass: vi.fn(),
  };
});

const fetchOrdersWeek = vi.mocked(api.fetchOrdersWeek);
const correctMeal = vi.mocked(api.correctMeal);
const correctMealOffMenu = vi.mocked(api.correctMealOffMenu);
const removeMeal = vi.mocked(api.removeMeal);
const repriceDish = vi.mocked(api.repriceDish);
const recordPass = vi.mocked(api.recordPass);
const answerPass = vi.mocked(api.answerPass);
const undoPass = vi.mocked(api.undoPass);
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
  orgs: [{ org: ORG, role: "admin", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" }],
};

// Thursday 1 October at 10:00: Monday to Wednesday are served, today is
// cooking past its cutoff, Friday is open until 21:00 tonight.
const MON = "2026-09-28";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const THU = "2026-10-01";
const FRI = "2026-10-02";
const SUN = "2026-10-04";

const money = (minor: number) => formatMoney(minor, ORG.currency).replace(/ /g, " ");
const rawMoney = (minor: number) => formatMoney(minor, ORG.currency);

const cutoffBefore = (date: string) => zonedTimeToInstant(date, "21:00", TZ).toISOString();

function days(over: Partial<Record<string, Partial<BoardDay>>> = {}): BoardDay[] {
  const base: Record<string, BoardDay> = {
    [MON]: {
      serviceDate: MON, menuId: 1, status: "locked", orderCutoffAt: cutoffBefore("2026-09-27"),
      dishes: [{ id: 11, name: "Cơm gà", priceMinor: 45_000 }, { id: 12, name: "Bún bò", priceMinor: 50_000 }],
    },
    [TUE]: {
      serviceDate: TUE, menuId: 2, status: "locked", orderCutoffAt: cutoffBefore(MON),
      dishes: [{ id: 21, name: "Cơm tấm sườn", priceMinor: 45_000 }],
    },
    [WED]: {
      serviceDate: WED, menuId: 3, status: "locked", orderCutoffAt: cutoffBefore(TUE),
      dishes: [{ id: 31, name: "Bún chả Hà Nội", priceMinor: 50_000 }, { id: 32, name: "Mì Quảng", priceMinor: null }],
    },
    [THU]: {
      serviceDate: THU, menuId: 4, status: "published", orderCutoffAt: cutoffBefore(WED),
      dishes: [{ id: 41, name: "Phở gà", priceMinor: 40_000 }, { id: 42, name: "Bánh canh cua", priceMinor: 55_000 }],
    },
    [FRI]: {
      serviceDate: FRI, menuId: 5, status: "published", orderCutoffAt: cutoffBefore(THU),
      dishes: [{ id: 51, name: "Cơm chiên", priceMinor: 40_000 }, { id: 52, name: "Bún riêu", priceMinor: 45_000 }],
    },
  };
  return Array.from({ length: 7 }, (_, i) => {
    const serviceDate = `2026-${i < 3 ? "09" : "10"}-${String(i < 3 ? 28 + i : i - 2).padStart(2, "0")}`;
    const d = base[serviceDate] ?? { serviceDate, menuId: null, status: null, orderCutoffAt: null, dishes: [] };
    return { ...d, ...(over[serviceDate] ?? {}) };
  });
}

function meal(over: Partial<RecordedMeal> & Pick<RecordedMeal, "orderId" | "profileId" | "serviceDate">): RecordedMeal {
  const quantity = over.quantity ?? 1;
  const unitPriceMinor = over.unitPriceMinor === undefined ? 45_000 : over.unitPriceMinor;
  return {
    source: "member",
    createdBy: over.profileId,
    createdAt: "2026-09-27T02:00:00Z",
    menuItemId: 11,
    dishName: "Cơm gà",
    note: null,
    amountMinor: unitPriceMinor === null ? null : unitPriceMinor * quantity,
    ...over,
    quantity,
    unitPriceMinor,
  };
}

const PASSED: PassRecord = {
  id: 51, orderId: 201, status: "accepted", fromProfileId: "teo", toProfileId: "dinh",
  createdBy: "teo", createdAt: "2026-09-29T03:00:00Z",
  decidedAt: "2026-09-29T04:20:00Z", decidedBy: "dinh",
};
const OFFER: PassRecord = {
  id: 52, orderId: 401, status: "pending", fromProfileId: "teo", toProfileId: "vy",
  createdBy: "teo", createdAt: "2026-09-30T13:00:00Z", decidedAt: null, decidedBy: null,
};

const CORRECTED: CorrectionEntry = {
  id: 9, serviceDate: WED, kind: "meal", orderId: 303, menuItemId: null, transferId: null,
  profileId: "quy", summary: "Quy: Bún chả Hà Nội, 50.000 ₫ on 30/09", reason: "Quy nhắn qua Zalo",
  madeBy: "me", madeAt: "2026-09-30T08:00:00Z",
};

function week(over: Partial<OrdersWeek> = {}): OrdersWeek {
  const list: RecordedMeal[] = [
    meal({ orderId: 101, profileId: "vy", serviceDate: MON, menuItemId: 12, dishName: "Bún bò", unitPriceMinor: 50_000 }),
    meal({ orderId: 102, profileId: "teo", serviceDate: MON }),
    meal({ orderId: 201, profileId: "teo", serviceDate: TUE, menuItemId: 21, dishName: "Cơm tấm sườn" }),
    meal({
      orderId: 301, profileId: "teo", serviceDate: WED, menuItemId: 31, dishName: "Bún chả Hà Nội",
      unitPriceMinor: 50_000, quantity: 2, source: "admin", createdBy: "me", createdAt: "2026-09-30T07:05:00Z",
    }),
    meal({ orderId: 302, profileId: "dinh", serviceDate: WED, menuItemId: 32, dishName: "Mì Quảng", unitPriceMinor: null }),
    meal({ orderId: 303, profileId: "quy", serviceDate: WED, menuItemId: 31, dishName: "Bún chả Hà Nội", unitPriceMinor: 50_000 }),
    meal({ orderId: 401, profileId: "teo", serviceDate: THU, menuItemId: 41, dishName: "Phở gà", unitPriceMinor: 40_000 }),
    meal({ orderId: 402, profileId: "dinh", serviceDate: THU, menuItemId: 41, dishName: "Phở gà", unitPriceMinor: 40_000, note: "ít bánh" }),
    meal({ orderId: 501, profileId: "dinh", serviceDate: FRI, menuItemId: 51, dishName: "Cơm chiên", unitPriceMinor: 40_000 }),
  ];
  return {
    days: days(),
    members: [
      { profileId: "me", name: "Neyu", isMe: true, balanceMinor: 0 },
      { profileId: "dinh", name: "Dinh", isMe: false, balanceMinor: 140_000 },
      { profileId: "quy", name: "Quy", isMe: false, balanceMinor: -20_000 },
      { profileId: "vy", name: "Thảo Vy", isMe: false, balanceMinor: 95_000 },
      { profileId: "teo", name: "Tèo", isMe: false, balanceMinor: 185_000 },
    ],
    meals: new Map(list.map((m) => [cellKey(m.profileId, m.serviceDate), m])),
    passes: new Map([[201, PASSED], [401, OFFER]]),
    period: { periodId: 3, periodStart: MON, periodEnd: SUN, status: "open", closedAt: null },
    entries: [CORRECTED],
    ...over,
  };
}

function serve(data: OrdersWeek = week()) {
  fetchOrdersWeek.mockResolvedValue(data);
}

function renderScreen() {
  return render(<OrdersScreen me={ME} org={ORG} role="admin" />);
}

async function ready() {
  await screen.findByRole("region", { name: /^Prices for / });
}

const cell = (name: RegExp | string) => screen.getByRole("button", { name });

async function open(user: ReturnType<typeof fakeClockUser>, name: RegExp | string) {
  await user.click(cell(name));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(zonedTimeToInstant(THU, "10:00", TZ));
  correctMeal.mockResolvedValue({ orderId: 950, balanceMinor: 185_000 });
  correctMealOffMenu.mockResolvedValue({ orderId: 951, menuItemId: 99, balanceMinor: 200_000 });
  removeMeal.mockResolvedValue({ balanceMinor: 85_000 });
  repriceDish.mockResolvedValue({ lines: 3, people: 2 });
  recordPass.mockResolvedValue({ transferId: 60, fromBalanceMinor: 45_000, toBalanceMinor: 190_000 });
  answerPass.mockResolvedValue({ transferId: 52, fromBalanceMinor: 145_000, toBalanceMinor: 135_000 });
  undoPass.mockResolvedValue({ transferId: 51, fromBalanceMinor: 230_000, toBalanceMinor: 95_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------ the frame */

describe("Orders, the week", () => {
  it("opens on the week, with the panel on the last finished day", async () => {
    serve();
    renderScreen();
    await ready();

    expect(fetchOrdersWeek).toHaveBeenCalledWith(expect.objectContaining({ orgId: 7, from: MON, to: SUN }));
    expect(screen.getByRole("region", { name: "Prices for Wednesday 30 September" })).toBeInTheDocument();
    expect(screen.getByText("Served. Open to record until the week is settled")).toBeInTheDocument();
    expect(
      screen.getByText(/Each save goes on that person.s bill at once, and they get a message saying what changed\./),
    ).toBeInTheDocument();
  });

  it("puts each person's balance under their name", async () => {
    serve();
    renderScreen();
    await ready();

    expect(screen.getByText(`owes ${money(185_000)}`)).toBeInTheDocument();
    expect(screen.getByText(`has ${money(20_000)} in credit`)).toBeInTheDocument();
  });

  it("counts the day's dishes by people and portions in the panel", async () => {
    serve();
    renderScreen();
    await ready();

    const panel = screen.getByRole("region", { name: "Prices for Wednesday 30 September" });
    expect(within(panel).getByText("2 people, 3 portions")).toBeInTheDocument();
    expect(within(panel).getByText("Price to come")).toBeInTheDocument();
  });

  it("totals portions and money under each day", async () => {
    serve();
    renderScreen();
    await ready();

    const footer = screen.getAllByRole("rowgroup").at(-1)!;
    // Wednesday: 2 + 1 + 1 portions; Mì Quảng has no price, so 100k + 50k.
    expect(within(footer).getByText("4")).toBeInTheDocument();
    expect(within(footer).getByText(money(150_000))).toBeInTheDocument();
  });

  it("moves the panel when a column head is pressed", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("button", { name: /^Fri 2.*show this day's prices$/ }));
    expect(screen.getByRole("region", { name: "Prices for Friday 2 October" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Fri 2/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the week's failure with a retry", async () => {
    const user = fakeClockUser();
    fetchOrdersWeek.mockRejectedValueOnce(new Error("network is down"));
    renderScreen();

    expect(await screen.findByRole("heading", { name: "The week did not load" })).toBeInTheDocument();
    expect(screen.getByText("network is down")).toBeInTheDocument();
    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });

  it("says a week with no menus has none, and still lists who is in the office", async () => {
    serve(week({ days: days(Object.fromEntries([MON, TUE, WED, THU, FRI].map((d) => [d, { menuId: null, status: null, dishes: [] }]))), meals: new Map(), passes: new Map(), entries: [] }));
    renderScreen();
    await ready();

    expect(screen.getByRole("heading", { name: "No menus this week" })).toBeInTheDocument();
    expect(screen.getByText("Thảo Vy")).toBeInTheDocument();
  });

  it("follows a ?week= changed while the screen is open", async () => {
    window.history.replaceState(null, "", "/#/o/test-office/orders");
    serve();
    renderScreen();
    await ready();
    expect(fetchOrdersWeek).toHaveBeenLastCalledWith(expect.objectContaining({ from: MON }));

    await act(async () => {
      window.history.replaceState(null, "", "/#/o/test-office/orders?week=2026-09-23");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(fetchOrdersWeek).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-09-21", to: "2026-09-27" })),
    );
    window.history.replaceState(null, "", "/");
  });

  it("draws only the newest week when an older answer arrives last", async () => {
    const user = fakeClockUser();
    let answerFirst: (w: OrdersWeek) => void = () => {};
    fetchOrdersWeek.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    fetchOrdersWeek.mockResolvedValue(week({ meals: new Map(), passes: new Map(), entries: [] }));
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await ready();
    await act(async () => answerFirst(week()));
    expect(screen.queryByText("ít bánh")).not.toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------- cells */

describe("Orders, what a cell says", () => {
  it("names where a meal came from in words, and nothing for the member's own", async () => {
    serve();
    renderScreen();
    await ready();

    expect(cell(/^Tèo, Wed 30: Bún chả Hà Nội, 2 portions, recorded by an admin\. Change$/)).toHaveTextContent(
      /Bún chả Hà Nội × 2\s*recorded/,
    );
    expect(cell(/^Quy, Wed 30: Bún chả Hà Nội, corrected by an admin\. Change$/)).toHaveTextContent("corrected");
    expect(cell(/^Thảo Vy, Mon 28: Bún bò\. Change$/)).not.toHaveTextContent(/recorded|corrected/);
  });

  it("marks a dish with no price, a pass, a received meal and an offer", async () => {
    serve();
    renderScreen();
    await ready();

    expect(cell(/^Dinh, Wed 30: Mì Quảng, price to come/)).toHaveTextContent("Price to come");
    const given = cell(/^Tèo, Tue 29: Cơm tấm sườn, passed to Dinh, who pays\. Open$/);
    expect(given).toHaveTextContent("to Dinh");
    expect(within(given).getByText("Cơm tấm sườn")).toHaveClass("line-through");
    expect(cell(/^Dinh, Tue 29: nothing recorded, also has Tèo's meal\. Add a meal$/)).toHaveTextContent(
      "+ 1 from Tèo",
    );
    expect(cell(/^Tèo, Thu 1: Phở gà, offered to Thảo Vy, not answered\. Change$/)).toHaveTextContent(
      "offered to Thảo Vy",
    );
  });

  it("shows the portions a received meal brought", async () => {
    const base = week();
    const meals = new Map(base.meals);
    const given = meals.get(cellKey("teo", TUE))!;
    meals.set(cellKey("teo", TUE), { ...given, quantity: 2, amountMinor: 90_000 });
    serve({ ...base, meals });
    renderScreen();
    await ready();

    expect(cell(/^Dinh, Tue 29: nothing recorded, also has Tèo's meal\. Add a meal$/)).toHaveTextContent("+ 2 from Tèo");
  });

  it("speaks the note whole, and draws the admin's own row like everybody else's", async () => {
    serve();
    renderScreen();
    await ready();

    expect(cell(/^Dinh, Thu 1: Phở gà, ít bánh\. Change$/)).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /^Neyu, / })) {
      expect(b.className).not.toMatch(/bg-accent/);
    }
    expect(cell(/^Neyu, Thu 1: nothing recorded\. Add a meal$/)).not.toHaveAttribute("aria-disabled");
  });

  it("keeps a day that cannot be recorded on inert, with its reason, and sends a missing menu to Menu", async () => {
    const user = fakeClockUser();
    serve(
      week({
        days: days({
          [MON]: { status: "cancelled" },
          [TUE]: { menuId: null, status: null, orderCutoffAt: null, dishes: [] },
          [FRI]: { status: "draft" },
        }),
        meals: new Map(),
        passes: new Map(),
        entries: [],
      }),
    );
    renderScreen();
    await ready();

    expect(cell(/^Dinh, Mon 28: nothing recorded\.?$/)).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Lunch was cancelled on Mon 28 Sept").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("No menu for Tue 29 Sept. Add the day on the Menu screen to record a lunch on it.").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("The menu for Fri 2 Oct isn't published yet").length).toBeGreaterThan(0);

    await user.click(cell(/^Dinh, Fri 2: nothing recorded\.?$/));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Tue 29.*show this day's prices$/ }));
    expect(screen.getByRole("link", { name: "Open the Menu screen" })).toHaveAttribute(
      "href",
      `#/o/test-office/menu?date=${TUE}`,
    );
  });
});

/* ----------------------------------------------------------- ordering */

describe("Orders, adding and changing a meal", () => {
  it("says which day and stage, and what saving would do, before anything is written", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    expect(within(dialog).getByRole("heading", { name: "Add a meal for Tèo" })).toHaveFocus();
    expect(
      within(dialog).getByText("Friday 2 October · open until 21:00 Thu 1 Oct. Tèo has nothing recorded."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: /^Bún\ riêu(,|$)/ }));
    expect(
      within(dialog).getByText(
        `This would put ${money(45_000)} on Tèo's bill. Tèo owes ${money(185_000)} now, and would owe ${money(230_000)}.`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Tèo gets a message saying what you saved.")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Close" })[0]!).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(correctMeal).not.toHaveBeenCalled();
  });

  it("saves the dish, the portions and the note, and reports the balance the database returns", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: /^Bún\ riêu(,|$)/ }));
    await user.click(within(dialog).getByRole("button", { name: "One portion more" }));
    expect(
      within(dialog).getByText(
        `This would put ${money(90_000)} on Tèo's bill. Tèo owes ${money(185_000)} now, and would owe ${money(275_000)}.`,
      ),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Note for the caterer"), "không huyết{Enter}");
    // Enter in a field saves nothing.
    expect(correctMeal).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Why (optional)"), "Tèo nhắn qua Telegram");
    await user.click(within(dialog).getByRole("button", { name: "Save Tèo's meal" }));

    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith({
        orgId: 7,
        serviceDate: FRI,
        profileId: "teo",
        menuItemId: 52,
        quantity: 2,
        note: "không huyết",
        reason: "Tèo nhắn qua Telegram",
      }),
    );
    expect(success).toHaveBeenCalledWith(`Saved Tèo's meal. Tèo owes ${rawMoney(185_000)}.`);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("holds the portions between 1 and 20", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    expect(within(dialog).getByRole("button", { name: "One portion fewer" })).toBeDisabled();
    for (let i = 0; i < 25; i += 1) {
      fireEvent.click(within(dialog).getByRole("button", { name: "One portion more" }));
    }
    expect(within(dialog).getByRole("status")).toHaveTextContent("20");
    expect(within(dialog).getByRole("button", { name: "One portion more" })).toBeDisabled();
  });

  it("names the difference when the dish changes, and who made the meal", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Quy, Wed 30:/);
    expect(within(dialog).getByRole("heading", { name: "Change Quy's meal" })).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Quy ordered this, and Neyu changed it on 30\/09 15:00\./),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: /^Mì\ Quảng(,|$)/ }));
    expect(
      within(dialog).getByText(/That dish has no price yet, so this records the meal and puts nothing on Quy's bill/),
    ).toBeInTheDocument();
  });

  it("says an admin recorded a meal, and when", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Wed 30:/);
    expect(within(dialog).getByText(/Recorded by Neyu on 30\/09 14:05\./)).toBeInTheDocument();
  });

  it("records a dish that was never on the menu, echoing the price it read", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Dinh, Mon 28: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: "A dish not on the menu" }));
    const save = within(dialog).getByRole("button", { name: "Save Dinh's meal" });
    await user.type(within(dialog).getByLabelText("Dish"), "Cơm sườn");
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.type(within(dialog).getByLabelText("What it cost"), "60k");
    expect(within(dialog).getByText(money(60_000))).toBeInTheDocument();

    await user.click(save);
    await waitFor(() =>
      expect(correctMealOffMenu).toHaveBeenCalledWith({
        orgId: 7, serviceDate: MON, profileId: "dinh", dishName: "Cơm sườn", priceMinor: 60_000,
        quantity: 1, note: null, reason: null,
      }),
    );
  });

  it("saves a typed name that matches a priced dish as that dish, at its price, and says so", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Dinh, Mon 28: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: "A dish not on the menu" }));
    await user.type(within(dialog).getByLabelText("Dish"), "  bún   BÒ ");
    await user.type(within(dialog).getByLabelText("What it cost"), "30k");

    expect(
      within(dialog).getByText(
        `Bún bò is already on this day's menu at ${money(50_000)}. Saving records that dish at that price, whatever is typed here.`,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `This would put ${money(50_000)} on Dinh's bill. Dinh owes ${money(140_000)} now, and would owe ${money(190_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save Dinh's meal" }));
    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith(expect.objectContaining({ profileId: "dinh", menuItemId: 12 })),
    );
    expect(correctMealOffMenu).not.toHaveBeenCalled();
  });

  it("will not record a typed name that matches a dish with no price yet, and says to reprice it", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Neyu, Wed 30: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: "A dish not on the menu" }));
    await user.type(within(dialog).getByLabelText("Dish"), "mì quảng");
    await user.type(within(dialog).getByLabelText("What it cost"), "60k");

    const sentence =
      '"Mì Quảng" is already on the menu with no price yet. Set its price with Reprice, then record this meal';
    expect(within(dialog).getByText(`${sentence}.`)).toBeInTheDocument();
    const save = within(dialog).getByRole("button", { name: "Save Neyu's meal" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getAllByText(sentence).length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/^This would put/)).not.toBeInTheDocument();

    await user.click(save);
    expect(correctMealOffMenu).not.toHaveBeenCalled();
    expect(correctMeal).not.toHaveBeenCalled();
  });

  it("keeps the database's refusal in the dialog, and the dialog open", async () => {
    const user = fakeClockUser();
    serve();
    correctMeal.mockRejectedValue(new Error("the menu for 02/10 isn't published yet"));
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: /^Cơm\ chiên(,|$)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save Tèo's meal" }));

    expect(await within(dialog).findByText("the menu for 02/10 isn't published yet")).toBeInTheDocument();
    expect(failure).toHaveBeenCalledWith("the menu for 02/10 isn't published yet");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reads the week again after a refusal, keeping the refusal on screen", async () => {
    const user = fakeClockUser();
    serve();
    correctMeal.mockRejectedValue(new Error("the week of 02/10 has been settled, so it can no longer be corrected"));
    renderScreen();
    await ready();
    const loads = fetchOrdersWeek.mock.calls.length;

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: /^Cơm chiên(,|$)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save Tèo's meal" }));

    await waitFor(() => expect(fetchOrdersWeek.mock.calls.length).toBe(loads + 1));
    expect(
      within(screen.getByRole("dialog")).getByText("the week of 02/10 has been settled, so it can no longer be corrected"),
    ).toBeInTheDocument();
  });

  it("cannot be sent twice by a second press while the first is going", async () => {
    const user = fakeClockUser();
    serve();
    correctMeal.mockReturnValue(new Promise(() => {}));
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: /^Cơm\ chiên(,|$)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save Tèo's meal" }));
    await user.click(within(dialog).getByRole("button", { name: "Saving…" }));
    expect(correctMeal).toHaveBeenCalledTimes(1);
  });

  it("opens the next cell on its own dish, never the last cell's", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    let dialog = await open(user, /^Tèo, Fri 2: nothing recorded\. Add a meal$/);
    await user.click(within(dialog).getByRole("radio", { name: /^Bún\ riêu(,|$)/ }));
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    dialog = await open(user, /^Dinh, Fri 2:/);
    expect(within(dialog).getByRole("radio", { name: /^Cơm\ chiên(,|$)/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /^Bún\ riêu(,|$)/ })).not.toBeChecked();
  });
});

/* ----------------------------------------------------- after the cutoff */

describe("Orders, after the cutoff", () => {
  it("warns that the caterer may be cooking, on a day closed or cooking only", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    let dialog = await open(user, /^Dinh, Thu 1:/);
    const note = within(dialog).getByRole("note");
    expect(note).toHaveTextContent("Ordering for Thu 1 Oct closed at 21:00 30/09.");
    expect(note).toHaveTextContent("If this adds a portion, tell them yourself: the app will not.");
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);

    dialog = await open(user, /^Quy, Wed 30:/);
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
  });

  it("lets an admin record their own lunch after the cutoff here", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Neyu, Thu 1: nothing recorded\. Add a meal$/);
    expect(within(dialog).getByRole("note")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /^Phở\ gà(,|$)/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save Neyu's meal" }));
    await waitFor(() =>
      expect(correctMeal).toHaveBeenCalledWith(expect.objectContaining({ profileId: "me", serviceDate: THU })),
    );
  });
});

/* --------------------------------------------------------------- remove */

describe("Orders, removing a meal", () => {
  it("is a second step, worded for a day that is over, with the money on a warning", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Quy, Wed 30:/);
    await user.click(within(dialog).getByRole("button", { name: "Remove this meal" }));
    expect(within(dialog).getByRole("heading", { name: "Remove Quy's meal" })).toBeInTheDocument();
    expect(within(dialog).getByText("The record says Quy had Bún chả Hà Nội.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `This would take ${money(50_000)} off Quy's bill. Quy has ${money(20_000)} in credit now, and would be ${money(70_000)} in credit.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByRole("heading", { name: "Change Quy's meal" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove this meal" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove Quy's meal" }));

    await waitFor(() => expect(removeMeal).toHaveBeenCalledWith({ orderId: 303, reason: null }));
    expect(success).toHaveBeenCalledWith(`Removed Quy's meal. Quy owes ${rawMoney(85_000)}.`);
  });

  it("speaks of a day ahead as a plan", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Dinh, Fri 2:/);
    await user.click(within(dialog).getByRole("button", { name: "Remove this meal" }));
    expect(within(dialog).getByText("Dinh is down for Cơm chiên.")).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------- pass */

describe("Orders, passing a meal", () => {
  it("names both people's money before it is recorded, and who has lunch already", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Thảo Vy, Mon 28: Bún bò\. Change$/);
    await user.click(within(dialog).getByRole("button", { name: "Pass this meal to someone" }));

    expect(within(dialog).getByRole("heading", { name: "Pass Thảo Vy's Bún bò" })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Monday 28 September · Served. Whoever you pick pays for it instead of Thảo Vy."),
    ).toBeInTheDocument();
    const tèo = within(dialog).getByRole("radio", { name: /^Tèo(,|$)/ }).closest("label")!;
    expect(tèo).toHaveTextContent("has lunch that day");
    const dinh = within(dialog).getByRole("radio", { name: /^Dinh(,|$)/ }).closest("label")!;
    expect(dinh).toHaveTextContent("nothing that day");
    expect(within(dialog).queryByRole("radio", { name: /^Thảo Vy(,|$)/ })).not.toBeInTheDocument();

    const button = within(dialog).getByRole("button", { name: "Pass" });
    expect(button).toHaveAttribute("aria-disabled", "true");

    await user.click(within(dialog).getByRole("radio", { name: /^Dinh(,|$)/ }));
    expect(
      within(dialog).getByText(
        `This would move ${money(50_000)} from Thảo Vy's bill to Dinh's. Thảo Vy owes ${money(95_000)} now, and would owe ${money(45_000)}. Dinh owes ${money(140_000)} now, and would owe ${money(190_000)}.`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Both of them get a message saying what you recorded.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Pass to Dinh" }));
    await waitFor(() => expect(recordPass).toHaveBeenCalledWith({ orderId: 101, toProfileId: "dinh", reason: null }));
    expect(success).toHaveBeenCalledWith("Passed Thảo Vy's Bún bò to Dinh.");
  });

  it("shows an accepted pass with who pays, and undoes it with the figures first", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Tue 29:/);
    expect(within(dialog).getByRole("heading", { name: "Tèo's Cơm tấm sườn" })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Tèo passed this meal to Dinh, and Dinh accepted it on 29/09 at 11:20. Dinh pays for it."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `Undoing it would move ${money(45_000)} from Dinh's bill back to Tèo's. Dinh owes ${money(140_000)} now, and would owe ${money(95_000)}. Tèo owes ${money(185_000)} now, and would owe ${money(230_000)}.`,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Undo the pass" }));
    await waitFor(() => expect(undoPass).toHaveBeenCalledWith({ transferId: 51, reason: null }));
    expect(success).toHaveBeenCalledWith("Undid the pass. Tèo pays for Cơm tấm sườn again.");
  });

  it("says an admin recorded a pass, or accepted it for the recipient, rather than the recipient", async () => {
    const user = fakeClockUser();
    serve(week({ passes: new Map([[201, { ...PASSED, createdBy: "me", decidedBy: "me" }], [401, OFFER]]) }));
    const { unmount } = renderScreen();
    await ready();
    let dialog = await open(user, /^Tèo, Tue 29:/);
    expect(
      within(dialog).getByText("Neyu recorded that Tèo's meal went to Dinh on 29/09 at 11:20. Dinh pays for it."),
    ).toBeInTheDocument();
    unmount();

    serve(week({ passes: new Map([[201, { ...PASSED, decidedBy: "me" }], [401, OFFER]]) }));
    renderScreen();
    await ready();
    dialog = await open(user, /^Tèo, Tue 29:/);
    expect(
      within(dialog).getByText(
        "Tèo passed this meal to Dinh, and Neyu accepted it for Dinh on 29/09 at 11:20. Dinh pays for it.",
      ),
    ).toBeInTheDocument();
  });

  it("changes a passed meal on the payer's money", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Tue 29:/);
    await user.click(within(dialog).getByRole("button", { name: "Change this meal" }));
    expect(within(dialog).getByText("Dinh pays for this meal now.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Pass this meal to someone" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove this meal" }));
    expect(
      within(dialog).getByText(
        `This would take ${money(45_000)} off Dinh's bill. Dinh owes ${money(140_000)} now, and would owe ${money(95_000)}.`,
      ),
    ).toBeInTheDocument();
  });

  it("answers a waiting offer on the recipient's behalf, or withdraws it, one step on", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Thu 1:/);
    expect(within(dialog).getByText("Tèo offered this to Thảo Vy, who has not answered.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Pass this meal to someone" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getAllByText("Answer or withdraw the offer first").length).toBeGreaterThan(0);

    await user.click(within(dialog).getByRole("button", { name: "Accept for Thảo Vy" }));
    expect(within(dialog).getByRole("heading", { name: "Accept Tèo's offer for Thảo Vy" })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `This would move ${money(40_000)} from Tèo's bill to Thảo Vy's. Tèo owes ${money(185_000)} now, and would owe ${money(145_000)}. Thảo Vy owes ${money(95_000)} now, and would owe ${money(135_000)}.`,
      ),
    ).toBeInTheDocument();
    expect(answerPass).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Accept for Thảo Vy" }));
    await waitFor(() => expect(answerPass).toHaveBeenCalledWith({ transferId: 52, answer: "accept", reason: null }));
    expect(success).toHaveBeenCalledWith("Accepted Tèo's offer for Thảo Vy.");
  });

  it("withdraws a waiting offer, moving no money", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const dialog = await open(user, /^Tèo, Thu 1:/);
    await user.click(within(dialog).getByRole("button", { name: "Withdraw Tèo's offer" }));
    expect(within(dialog).getByText(/^No money moves: Tèo keeps the meal and pays for it\./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Withdraw Tèo's offer" }));
    await waitFor(() => expect(answerPass).toHaveBeenCalledWith({ transferId: 52, answer: "withdraw", reason: null }));
    expect(success).toHaveBeenCalledWith("Withdrew Tèo's offer.");
  });
});

/* --------------------------------------------------------------- settled */

describe("Orders, a settled week", () => {
  const settled = () =>
    week({ period: { periodId: 3, periodStart: MON, periodEnd: SUN, status: "closed", closedAt: "2026-10-05T02:00:00Z" } });

  it("says so once, at the top, and offers no write anywhere", async () => {
    const user = fakeClockUser();
    serve(settled());
    renderScreen();
    await ready();

    expect(
      screen.getByText(
        "The week of 28 September to 4 October was settled on Mon 5 Oct at 09:00. A settled week is already billed and paid against, so nothing on it can change. Cells open to show what was recorded.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reprice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a meal$/ })).not.toBeInTheDocument();

    const dialog = await open(user, /^Quy, Wed 30:.*Open$/);
    expect(within(dialog).getByRole("heading", { name: "Quy's Bún chả Hà Nội" })).toBeInTheDocument();
    expect(within(dialog).getByText("Why: Quy nhắn qua Zalo")).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Save|Remove|Pass|Undo/ })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- reprice */

describe("Orders, repricing a dish", () => {
  it("counts people and portions and the money both ways, then writes once", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("button", { name: "Reprice Bún chả Hà Nội" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What the caterer charged"), { target: { value: "55k" } });
    expect(within(dialog).getByText("2 people had it, 3 portions in all.")).toBeInTheDocument();
    expect(within(dialog).getByText(`${money(15_000)} goes onto their bills.`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reprice for this day" }));
    await waitFor(() => expect(repriceDish).toHaveBeenCalledWith({ menuItemId: 31, priceMinor: 55_000, reason: null }));
  });

  it("asks for a new price on a day ahead, not what the caterer charged", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("button", { name: /^Fri 2.*show this day's prices$/ }));
    await user.click(screen.getByRole("button", { name: "Reprice Cơm chiên" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("New price")).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- history */

describe("Orders, the day's history", () => {
  it("lists what admins changed on the day, with who, when and why", async () => {
    serve();
    renderScreen();
    await ready();

    const history = screen.getByRole("region", { name: "Changed by an admin on Wed 30 Sept" });
    expect(within(history).getByText("Meal")).toBeInTheDocument();
    expect(within(history).getByText("Quy: Bún chả Hà Nội, 50.000 ₫ on 30/09")).toBeInTheDocument();
    expect(within(history).getByText("Why: Quy nhắn qua Zalo")).toBeInTheDocument();
  });

  it("says when nothing on the day has been changed", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    await user.click(screen.getByRole("button", { name: /^Mon 28.*show this day's prices$/ }));
    expect(screen.getByText("Nothing on this day has been changed by an admin.")).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------- phone */

describe("Orders, on a phone", () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    // @ts-expect-error jsdom has none; the grid tests rely on that.
    delete window.matchMedia;
  });

  it("shows a strip of days with portions, and the picked day's list", async () => {
    const user = fakeClockUser();
    serve();
    renderScreen();
    await ready();

    const strip = screen.getByRole("group", { name: "Day" });
    expect(within(strip).getByRole("button", { name: /^Wed 30, served, 4 portions$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const list = screen.getByRole("region", { name: "Everyone on Wednesday 30 September" });
    expect(within(list).getByText("4 portions")).toBeInTheDocument();

    await user.click(within(strip).getByRole("button", { name: /^Fri 2/ }));
    expect(screen.getByRole("region", { name: "Everyone on Friday 2 October" })).toBeInTheDocument();
  });
});
