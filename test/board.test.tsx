import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { BoardScreen } from "../src/web/components/BoardScreen.js";
import { cellKey, type Board, type BoardDay, type TransferRow } from "../src/web/api.js";
import * as api from "../src/web/api.js";
import { columnLabel, longDayLabel } from "../src/web/components/boardModel.js";
import { formatMoney } from "../src/shared/money.js";
import {
  addDays,
  formatDay,
  weekNumberOf,
  weekStart,
  zonedTimeToInstant,
} from "../src/shared/dates.js";
import type { Me, Org, Role } from "../src/shared/types.js";
import { fakeClockUser } from "./user.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError`, `cellKey` and the board's own
// rules stay real, because they are most of what these tests are about.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchBoard: vi.fn(),
    fetchTransfers: vi.fn(),
    setOrder: vi.fn(),
    cancelOrder: vi.fn(),
    createTransfer: vi.fn(),
    decideTransfer: vi.fn(),
    setStandingException: vi.fn(),
  };
});

const fetchBoard = vi.mocked(api.fetchBoard);
const fetchTransfers = vi.mocked(api.fetchTransfers);
const setOrder = vi.mocked(api.setOrder);
const cancelOrder = vi.mocked(api.cancelOrder);
const createTransfer = vi.mocked(api.createTransfer);
const decideTransfer = vi.mocked(api.decideTransfer);
const setStandingException = vi.mocked(api.setStandingException);
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
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" }],
};

const DISHES = [
  { id: 5, name: "Cơm gà", priceMinor: 45_000 },
  { id: 6, name: "Bún bò", priceMinor: 50_000 },
  { id: 7, name: "Phở bò", priceMinor: 40_000 },
];

// A fixed Tuesday, not the real one, and `beforeEach` pins the clock to it.
//
// These fixtures all say something about where a day sits relative to today:
// Wednesday is tomorrow, its cutoff is ahead or gone, Thursday is later still.
// Anchored to the real week those sentences changed meaning by the day of the
// week the suite happened to run on, and the suite was green Monday to Thursday
// and red Friday to Sunday. CI caught it at 00:02 local, twelve minutes after
// the same tests passed here.
//
// The cutoffs come off the same pinned clock. Derived from `Date.now()` they
// were "past" and "open" relative to the real moment, which says nothing about
// a clock pinned to another day.
const TODAY = "2026-09-22";
const MONDAY = weekStart(TODAY, 1);
const WED = addDays(MONDAY, 2);
const THU = addDays(MONDAY, 3);
const OPEN_CUTOFF = zonedTimeToInstant(WED, "23:00", TZ).toISOString();
const PAST_CUTOFF = zonedTimeToInstant(TODAY, "07:00", TZ).toISOString();

const MEMBERS = [
  { profileId: "me", name: "Neyu", shortCode: "NEYU", paymentRef: "LUNCHNEYU", isMe: true },
  { profileId: "teo", name: "Tèo", shortCode: "TEO", paymentRef: "LUNCHTEO", isMe: false },
  { profileId: "dinh", name: "Dinh", shortCode: "DINH", paymentRef: "LUNCHDINH", isMe: false },
];

function menuDay(over: Partial<BoardDay> = {}): BoardDay {
  return {
    serviceDate: WED,
    menuId: 5,
    status: "published",
    orderCutoffAt: OPEN_CUTOFF,
    dishes: DISHES,
    ...over,
  };
}

function makeBoard(over: { wed?: BoardDay | null; members?: Board["members"]; cells?: Board["cells"] } = {}): Board {
  const wed = over.wed === undefined ? menuDay() : over.wed;
  const days = Array.from({ length: 7 }, (_, i) => {
    const serviceDate = addDays(MONDAY, i);
    if (serviceDate === WED && wed !== null) return { ...wed, serviceDate: WED };
    return { serviceDate, menuId: null, status: null, orderCutoffAt: null, dishes: [] } as BoardDay;
  });
  return {
    days,
    members: over.members ?? MEMBERS,
    cells: over.cells ?? new Map(),
    projected: new Set<string>(),
    weekdays: new Set<number>(),
    exceptions: new Map(),
  };
}

function noTransfers(): Awaited<ReturnType<typeof api.fetchTransfers>> {
  return { incoming: [], outgoing: [], giveable: [], live: new Map() };
}

/** Makes the fake database answer, and keeps `setOrder` writing back to it. */
function serve(initial: Board) {
  let current = initial;
  fetchBoard.mockImplementation(async () => current);
  fetchTransfers.mockImplementation(async () => noTransfers());
  setOrder.mockImplementation(async (args) => {
    const dish = DISHES.find((d) => d.id === args.itemId);
    const cells = new Map(current.cells);
    cells.set(cellKey(args.profileId, args.serviceDate), {
      orderId: 99,
      status: "placed",
      source: "member",
      itemId: args.itemId,
      dishName: dish?.name ?? null,
      note: args.note?.trim() || null,
      amountMinor: dish?.priceMinor ?? null,
      transferredToName: null,
    });
    current = { ...current, cells };
  });
  cancelOrder.mockImplementation(async () => {
    const cells = new Map(current.cells);
    cells.delete(cellKey("me", WED));
    current = { ...current, cells };
  });
  return {
    get board() {
      return current;
    },
  };
}

function myCell(cellOver: Partial<import("../src/web/api.js").BoardCell> = {}) {
  const cells = new Map<string, import("../src/web/api.js").BoardCell>();
  cells.set(cellKey("me", WED), {
    orderId: 42,
    status: "placed",
    source: "member",
    itemId: 5,
    dishName: "Cơm gà",
    note: null,
    amountMinor: 45_000,
    transferredToName: null,
    ...cellOver,
  });
  return cells;
}

const EMPTY_LABEL = `${formatDay(WED)}: not eating`;

/**
 * The column head that switches the menu panel to that day.
 *
 * `tags` are the words the head carries under the date -- today, and why the
 * day cannot be acted on -- which the label repeats in the order they render.
 */
function headName(serviceDate: string, ...tags: string[]): string {
  const { dow, dom } = columnLabel(serviceDate);
  const all = [...(serviceDate === TODAY ? ["today"] : []), ...tags];
  return `${dow} ${dom}${all.map((t) => `, ${t}`).join("")}: show this day's menu`;
}
// One dish is not a choice, so the cell orders outright. Two or more and the
// `+` opens the chooser while the dice commits to one.
const ORDER_LABEL = `${EMPTY_LABEL}. Order lunch`;
const CHOOSE_LABEL = `${EMPTY_LABEL}. Choose a dish`;
const DICE_LABEL = `${EMPTY_LABEL}. Order a dish at random`;

function renderBoard(role: Role = "member") {
  return render(<BoardScreen me={ME} org={ORG} role={role} />);
}

let user: ReturnType<typeof fakeClockUser>;

beforeEach(() => {
  vi.clearAllMocks();
  createTransfer.mockResolvedValue(undefined);
  decideTransfer.mockResolvedValue(undefined);
  // Pinned, because a day's stage is a function of the time of day. Without
  // this the suite passed every morning and failed every afternoon: at 08:00
  // today is `locked` at most, and after 08:30 it is `Cooking`. 08:00 is the
  // state the older tests were written against without knowing it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(zonedTimeToInstant(TODAY, "08:00", TZ));
  user = fakeClockUser();
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------- tests */

describe("Board, loading and empty", () => {
  it("shows a skeleton shaped like the grid, not the word Loading", async () => {
    fetchBoard.mockReturnValue(new Promise(() => {}));
    fetchTransfers.mockReturnValue(new Promise(() => {}));
    renderBoard();
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("still renders the grid for an office of one", async () => {
    serve(makeBoard({ wed: null, members: [MEMBERS[0]!] }));
    renderBoard();
    // The board still draws: an office of one is not an error state.
    expect(await screen.findByRole("heading", { name: "No menus this week" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/Neyu/)).toBeInTheDocument();
  });

  it("reports a failed read with the database's own words and offers a retry", async () => {
    fetchBoard.mockRejectedValue({ message: "JWT expired" });
    fetchTransfers.mockResolvedValue(noTransfers());
    renderBoard();
    expect(await screen.findByText("JWT expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("Board, ordering", () => {
  it("orders outright when the menu has one dish", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: [DISHES[0]!] }) }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: ORDER_LABEL }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      menuId: 5,
      serviceDate: WED,
      profileId: "me",
      itemId: 5,
    });
    // No dialog: one dish is not a choice, and no dice either.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DICE_LABEL })).not.toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("Ordered Cơm gà");
    expect(within(await screen.findByRole("table")).getByText("Cơm gà")).toBeInTheDocument();
  });

  it("assigns a dish at random from the dice, and names it", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: DICE_LABEL }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    const itemId = setOrder.mock.calls[0]?.[0].itemId;
    expect([5, 6, 7]).toContain(itemId);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const named = DISHES.find((d) => d.id === itemId)!.name;
    expect(success).toHaveBeenCalledWith(`Ordered ${named} · tap to change`);
  });

  // Twelve runs, not twenty-five. Each one is a full board render, so this was
  // the slowest test in the suite: 3.5s alone and over the 5s limit whenever
  // the machine was busy, which made it fail for reasons that had nothing to
  // do with the code. Twelve is still decisive: with three dishes the chance
  // of drawing the same one every time is 3^-11, about one run in 177.000.
  it("spreads the randomised order across the whole menu", { timeout: 15_000 }, async () => {
    const seen = new Set<number | null | undefined>();
    for (let run = 0; run < 12; run++) {
      vi.clearAllMocks();
      serve(makeBoard());
      const view = renderBoard();
      await user.click(await screen.findByRole("button", { name: DICE_LABEL }));
      await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
      seen.add(setOrder.mock.calls[0]?.[0].itemId);
      view.unmount();
    }
    // Not the first dish every time, which is what "at random" buys.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("opens the chooser from the plus, and never orders behind it", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: CHOOSE_LABEL }));

    const dialog = await screen.findByRole("dialog");
    expect(setOrder).not.toHaveBeenCalled();
    // Every dish on that day, priced, which is the whole point of asking.
    for (const dish of DISHES) {
      expect(within(dialog).getByRole("button", { name: new RegExp(dish.name) })).toBeInTheDocument();
    }

    await user.click(within(dialog).getByRole("button", { name: /Bún bò/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 6, existing: null });
    expect(success).toHaveBeenCalledWith("Ordered Bún bò");
  });

  it("puts the cell back and shows the database's sentence when it is refused", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: [DISHES[0]!] }) }));
    setOrder.mockRejectedValue({ message: "ordering for 23/09 closed at 21:00 22/09" });
    renderBoard();

    const cell = await screen.findByRole("button", { name: ORDER_LABEL });
    await user.click(cell);

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("ordering for 23/09 closed at 21:00 22/09"),
    );
    // Reverted: the optimistic fill is gone and the cell is empty again.
    expect(await screen.findByRole("button", { name: ORDER_LABEL })).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Cơm gà")).not.toBeInTheDocument();
  });
});

describe("Board, the dish dialog", () => {
  it("opens on a cell that already holds a dish and swaps it for another", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Bún bò/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Phở bò/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 7, existing: { id: 42 } });
    expect(success).toHaveBeenCalledWith("Ordered Phở bò");
  });

  it("offers Surprise me as a first-class choice, and never repeats the dish you have", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Surprise me" }),
    );

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0].itemId).not.toBe(5);
    expect(success).toHaveBeenCalledWith(expect.stringContaining("· tap to change"));
  });

  it("clears the day from the dialog, in the same words as the button", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Not eating" }),
    );

    await waitFor(() => expect(cancelOrder).toHaveBeenCalledWith(42));
    expect(success).toHaveBeenCalledWith(`Not eating ${formatDay(WED)}`);
  });
});

describe("Board, unavailable cells", () => {
  it("carries the reason on a locked day rather than a bare grey box", async () => {
    serve(makeBoard({ wed: menuDay({ status: "locked" }) }));
    renderBoard();

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    expect(cell).toHaveAttribute("aria-disabled", "true");
    expect(cell).toHaveAccessibleDescription("Orders are closed and have gone to the caterer");

    await user.click(cell);
    expect(setOrder).not.toHaveBeenCalled();
  });

  it("quotes the cutoff once it has passed", async () => {
    serve(makeBoard({ wed: menuDay({ orderCutoffAt: PAST_CUTOFF }) }));
    renderBoard();

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    expect(cell).toHaveAccessibleDescription(/^Ordering closed at \d{2}:\d{2} \d{2}\/\d{2}$/);
  });

  it("says today has no menu instead of leaving the cell mute", async () => {
    serve(makeBoard({ wed: null }));
    renderBoard();

    // Today, because a later day with no menu is one to plan ahead instead.
    const cell = await screen.findByRole("button", { name: `${formatDay(TODAY)}: not eating` });
    expect(cell).toHaveAccessibleDescription(`No menu for ${formatDay(TODAY)} yet`);
  });

  it("holds an admin to the cutoff too, because this board is theirs to eat from", async () => {
    serve(makeBoard({ wed: menuDay({ orderCutoffAt: PAST_CUTOFF, dishes: [DISHES[0]!] }) }));
    renderBoard("admin");

    await screen.findByRole("table");
    const cell = screen.getByRole("button", { name: new RegExp(`^${EMPTY_LABEL}`) });
    expect(cell).toHaveAttribute("aria-disabled", "true");
    await user.click(cell);
    expect(setOrder).not.toHaveBeenCalled();
  });
});

describe("Board, asymmetric rows", () => {
  it("names a colleague's dish too, because somebody has to hand the food out", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` });
    const grid = within(screen.getByRole("table"));
    expect(grid.getByText("Cơm gà")).toBeInTheDocument();
    // It used to be a fill, on the reasoning that a colleague's dish is not
    // your business. It is on the day the boxes arrive and one of them is
    // theirs.
    expect(grid.getByText("Phở bò")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Tèo, ${formatDay(WED)}: eating Phở bò. Hand a meal over`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over` }),
    ).toBeInTheDocument();
  });

  it("counts the headcount per day", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    const total = (await screen.findByText("Total")).closest("tr")!;
    expect(within(total).getAllByText("2")).not.toHaveLength(0);
  });
});

describe("Board, handing a meal over", () => {
  const theirName = (mark: string) => `Tèo, ${formatDay(WED)}: ${mark}. Hand a meal over`;

  it("asks for the whole open billing week, not today onward", async () => {
    serve(makeBoard());
    renderBoard();
    await screen.findByRole("table");
    expect(fetchTransfers).toHaveBeenCalledWith({
      orgId: 7,
      meProfileId: "me",
      openPeriodStart: MONDAY,
    });
  });

  it("gives the meal to the person whose cell you tapped, with no picker at all", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: theirName("not eating") }));
    const dialog = await screen.findByRole("dialog");

    // One direction, named. A member has nothing to choose from.
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Pass on" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Give Tèo my Cơm gà" }));

    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      orderId: 42,
      toProfileId: "teo",
      createdBy: "me",
    });
    expect(success).toHaveBeenCalledWith("Passed on to Tèo");
  });

  it("opens an empty colleague cell too, which is where most handovers start", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    const empty = await screen.findByRole("button", {
      name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over`,
    });
    expect(empty).not.toHaveAttribute("aria-disabled");

    await user.click(empty);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dinh is not down as eating.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Give Dinh my Cơm gà" })).toBeInTheDocument();
  });

  it("says why there is nothing to give when I have not ordered", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: theirName("not eating") }));
    const give = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Give Tèo my lunch",
    });
    expect(give).toHaveAccessibleDescription(`You have nothing ordered on ${formatDay(WED)}`);

    await user.click(give);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  /**
   * The inverse of what this asserted. An admin used to get a
   * `Pass Tèo's Phở bò to someone` form here, with the last recipient picker
   * on the board. This screen is where an admin orders their own lunch and
   * has no admin-only behaviour, so the form is gone; the absence is the rule,
   * which is why the test stayed and turned around.
   */
  it("gives an admin the same one direction, and no recording form", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await user.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("heading", { name: /^Pass Tèo's/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/takes effect immediately/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Pass on" })).not.toBeInTheDocument();

    // What is left moves the admin's own meal, exactly as it would a member's.
    await user.click(within(dialog).getByRole("button", { name: "Give Tèo my Cơm gà" }));
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0]?.[0]).toMatchObject({ orderId: 42, toProfileId: "teo" });
  });

  /**
   * This asserted the recording form's own refusal, `Choose who it goes to`.
   * With the form gone the question worth asking is what an admin gets
   * instead, and the answer is a member's sentence about a member's own meal.
   */
  it("tells an admin with nothing ordered what it tells anybody else", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await user.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    const dialog = await screen.findByRole("dialog");
    const give = within(dialog).getByRole("button", { name: "Give Tèo my lunch" });
    expect(give).toHaveAccessibleDescription(`You have nothing ordered on ${formatDay(WED)}`);
    expect(within(dialog).queryByRole("button", { name: "Pass on" })).not.toBeInTheDocument();

    await user.click(give);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  /**
   * Half of this is unchanged: an offer is legible on the board in words.
   * The withdraw half is inverted. It used to open this sheet as an admin and
   * take back somebody else's offer; an offer belongs to the person who made
   * it, and that person takes it back from their own cell.
   */
  it("keeps a pending offer legible on the board, and leaves it to whoever made it", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    const offer: TransferRow = {
      id: 3,
      orderId: 8,
      serviceDate: WED,
      status: "pending",
      fromProfileId: "teo",
      fromName: "Tèo",
      toProfileId: "dinh",
      toName: "Dinh",
      dishName: "Phở bò",
      amountMinor: 40_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
    };
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      live: new Map([[8, offer]]),
    }));
    renderBoard("admin");

    const cell = await screen.findByRole("button", {
      name: `Tèo, ${formatDay(WED)}: eating Phở bò. Offered to Dinh. Hand a meal over`,
    });
    // Legible on the board itself, in words, which is what gives anybody a
    // reason to open the cell at all.
    expect(within(cell).getByText("to Dinh")).toBeInTheDocument();

    await user.click(cell);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Tèo offered this to Dinh");
    expect(within(dialog).queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
    expect(decideTransfer).not.toHaveBeenCalled();
  });

  it("lets the person who made an offer take it back, from their own cell", async () => {
    const offer: TransferRow = {
      id: 3,
      orderId: 42,
      serviceDate: WED,
      status: "pending",
      fromProfileId: "me",
      fromName: "Neyu",
      toProfileId: "teo",
      toName: "Tèo",
      dishName: "Cơm gà",
      amountMinor: 45_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
    };
    serve(makeBoard({ cells: myCell() }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      outgoing: [offer],
      live: new Map([[42, offer]]),
    }));
    renderBoard();

    await user.click(
      await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà. Offered to Tèo` }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Withdraw" }),
    );

    await waitFor(() => expect(decideTransfer).toHaveBeenCalledWith(3, "cancelled"));
    expect(success).toHaveBeenCalledWith("Withdrawn");
  });

  it("shows an incoming offer on the cell it concerns, with both answers", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    const offer: TransferRow = {
      id: 3,
      orderId: 8,
      serviceDate: WED,
      status: "pending",
      fromProfileId: "teo",
      fromName: "Tèo",
      toProfileId: "me",
      toName: "Neyu",
      dishName: "Phở bò",
      amountMinor: 40_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
    };
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      incoming: [offer],
      live: new Map([[8, offer]]),
    }));
    renderBoard();

    expect(await screen.findByText("Tèo offers you Phở bò")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(decideTransfer).toHaveBeenCalledWith(3, "accepted"));
    expect(success).toHaveBeenCalledWith("Accepted");
  });

  it("starts each colleague's sheet on that colleague, not the last one", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    expect(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Give Tèo my Cơm gà" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(
      await screen.findByRole("button", {
        name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Give Dinh my Cơm gà" })).toBeInTheDocument();
  });
});

describe("Board, once lunch is over", () => {
  const teoOffer: TransferRow = {
    id: 3,
    orderId: 8,
    serviceDate: WED,
    status: "pending",
    fromProfileId: "teo",
    fromName: "Tèo",
    toProfileId: "me",
    toName: "Neyu",
    dishName: "Phở bò",
    amountMinor: 40_000,
    reason: null,
    createdAt: "2026-09-22T09:00:00Z",
  };

  function teoEating() {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    return cells;
  }

  // After the office's end of day, which is where `enforce_transfer_rules`
  // stops a member offering or answering.
  beforeEach(() => {
    vi.setSystemTime(zonedTimeToInstant(WED, "18:00", TZ));
  });

  it("does not offer my meal once the day is over, and says why", async () => {
    serve(makeBoard({ cells: teoEating() }));
    renderBoard();

    await user.click(
      await screen.findByRole("button", { name: `Tèo, ${formatDay(WED)}: eating Phở bò. Hand a meal over` }),
    );
    const give = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Give Tèo my Cơm gà",
    });
    expect(give).toHaveAttribute("aria-disabled", "true");
    expect(give).toHaveAccessibleDescription(
      `Lunch on ${formatDay(WED)} is over, so it can no longer be passed on`,
    );
    await user.click(give);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("keeps an unanswered offer legible, and no longer answerable", async () => {
    serve(makeBoard({ cells: teoEating() }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      incoming: [teoOffer],
      live: new Map([[8, teoOffer]]),
    }));
    renderBoard();

    expect(await screen.findByText("Tèo offers you Phở bò")).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute("aria-disabled", "true");
    await user.click(accept);
    expect(decideTransfer).not.toHaveBeenCalled();
  });
});

describe("Board, a meal somebody gave me", () => {
  const accepted: TransferRow = {
    id: 4,
    orderId: 8,
    serviceDate: WED,
    status: "accepted",
    fromProfileId: "teo",
    fromName: "Tèo",
    toProfileId: "me",
    toName: "Neyu",
    dishName: "Phở bò",
    amountMinor: 40_000,
    reason: null,
    createdAt: "2026-09-22T09:00:00Z",
  };

  function teoGaveMe() {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: "Neyu",
    });
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      live: new Map([[8, accepted]]),
    }));
  }

  it("says the giver's meal went to you, not to your own name", async () => {
    teoGaveMe();
    renderBoard();

    const theirs = await screen.findByRole("button", {
      name: `Tèo, ${formatDay(WED)}: passed on to you. Hand a meal over`,
    });
    expect(within(theirs).getByText("to you")).toBeInTheDocument();
    expect(screen.queryByText("to Neyu")).not.toBeInTheDocument();

    await user.click(theirs);
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Tèo passed this meal to you, so you are billed for it.",
    );
  });

  it("still names a colleague a meal went to", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: "Dinh",
    });
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      live: new Map([[8, { ...accepted, toProfileId: "dinh", toName: "Dinh" }]]),
    }));
    renderBoard();

    const theirs = await screen.findByRole("button", {
      name: `Tèo, ${formatDay(WED)}: passed on to Dinh. Hand a meal over`,
    });
    expect(within(theirs).getByText("to Dinh")).toBeInTheDocument();
  });

  it("shows the meal on my own row and offers no second lunch", async () => {
    teoGaveMe();
    renderBoard();

    const mine = await screen.findByRole("button", { name: `${formatDay(WED)}: Phở bò, from Tèo` });
    expect(mine).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: CHOOSE_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DICE_LABEL })).not.toBeInTheDocument();

    await user.click(mine);
    expect(setOrder).not.toHaveBeenCalled();
  });
});

describe("Board, answers that arrive out of order", () => {
  it("draws the week now shown when the week left behind answers last", async () => {
    let answerFirst: (b: Board) => void = () => {};
    fetchTransfers.mockImplementation(async () => noTransfers());
    fetchBoard.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    const next = makeBoard();
    fetchBoard.mockResolvedValue({
      ...next,
      days: next.days.map((d) => ({ ...d, serviceDate: addDays(d.serviceDate, 7) })),
    });
    renderBoard();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    const nextWed = addDays(WED, 7);
    await waitFor(() =>
      expect(document.querySelector(`th[data-service-date="${nextWed}"]`)).not.toBeNull(),
    );

    await act(async () => answerFirst(makeBoard()));
    expect(document.querySelector(`th[data-service-date="${nextWed}"]`)).not.toBeNull();
    expect(document.querySelector(`th[data-service-date="${WED}"]`)).toBeNull();
  });
});

describe("Board, the note that goes to the caterer", () => {
  it("sends the note with the dish, and shows it under the dish on my row", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: CHOOSE_LABEL }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("ít cơm, không trứng"), "ít cơm");
    await user.click(within(dialog).getByRole("button", { name: /Cơm gà/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 5, note: "ít cơm" });
    expect(within(await screen.findByRole("table")).getByText("ít cơm")).toBeInTheDocument();
  });

  it("saves a note against a dish already chosen, without changing the dish", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByPlaceholderText("ít cơm, không trứng"),
      "không trứng",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({
      itemId: 5,
      note: "không trứng",
      existing: { id: 42 },
    });
    expect(success).toHaveBeenCalledWith("Note saved");
  });

  it("stops at the length the database stops at", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const field = within(await screen.findByRole("dialog")).getByPlaceholderText(
      "ít cơm, không trứng",
    );
    expect(field).toHaveAttribute("maxlength", "120");
  });

  it("has nothing to save until the note changes, and says so", async () => {
    serve(makeBoard({ cells: myCell({ note: "ít cơm" }) }));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà, ít cơm` }));
    const save = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Save note",
    });
    expect(save).toHaveAccessibleDescription("Nothing to save");
  });

  it("shows a colleague's note to the admin who rings the caterer", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: "không trứng",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await user.click(
      await screen.findByRole("button", { name: `Tèo, ${formatDay(WED)}: eating Phở bò. Hand a meal over` }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("không trứng")).toBeInTheDocument();
  });
});

describe("Board, the marks", () => {
  function week() {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: "Dinh",
    });
    return cells;
  }

  it("encodes the headcount as fills, not as five sizes of dot", async () => {
    serve(makeBoard({ cells: week() }));
    renderBoard();

    const spent = await screen.findByRole("button", {
      name: `Tèo, ${formatDay(WED)}: passed on to Dinh. Hand a meal over`,
    });
    const empty = screen.getByRole("button", {
      name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over`,
    });

    // Spent reads as spent, empty reads as empty, and neither is a glyph.
    expect(spent.className).toContain("bg-surface-sunken");
    expect(empty.className).toContain("border-border");
    expect(empty.className).not.toContain("bg-accent-subtle");
    expect(spent.querySelector("svg")).toBeNull();
    expect(empty.querySelector("svg")).toBeNull();
  });

  it("says where a meal went in words, since two arrows cannot mean two things", async () => {
    serve(makeBoard({ cells: week() }));
    renderBoard();

    const spent = await screen.findByRole("button", {
      name: `Tèo, ${formatDay(WED)}: passed on to Dinh. Hand a meal over`,
    });
    expect(within(spent).getByText("to Dinh")).toBeInTheDocument();
  });
});

describe("Board, the menu panel", () => {
  it("shows what is on offer for the next orderable day, without a tap", async () => {
    serve(makeBoard());
    renderBoard();

    const panel = await screen.findByRole("region", { name: `Menu for ${longDayLabel(WED)}` });
    for (const dish of DISHES) {
      expect(within(panel).getByText(dish.name)).toBeInTheDocument();
      // The DOM text arrives with the locale's non-breaking space collapsed.
      expect(
        within(panel).getByText(formatMoney(dish.priceMinor, ORG.currency).replace(/\u00a0/g, " ")),
      ).toBeInTheDocument();
    }
  });

  it("says when the day closes, in the org's zone", async () => {
    serve(makeBoard());
    renderBoard();

    const panel = await screen.findByRole("region", { name: `Menu for ${longDayLabel(WED)}` });
    expect(within(panel).getByText(/^Closes \d{2}:\d{2} \d{2}\/\d{2}$/)).toBeInTheDocument();
  });

  it("quotes the refusal instead of a closing time once the day is shut", async () => {
    serve(makeBoard({ wed: menuDay({ status: "locked" }) }));
    renderBoard();

    // Clicked through the column itself rather than by label: the head's
    // wording is the day's stage, and which stage WED is in depends on what
    // weekday the suite happens to run. The panel is what this test is about.
    await screen.findByRole("table");
    await user.click(
      document.querySelector(`th[data-service-date="${WED}"] button`) as HTMLElement,
    );
    const panel = await screen.findByRole("region", { name: `Menu for ${longDayLabel(WED)}` });
    expect(
      within(panel).getByText("Orders are closed and have gone to the caterer"),
    ).toBeInTheDocument();
  });

  it("switches to the day whose column head you tap, and says when it is bare", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(
      await screen.findByRole("button", { name: headName(MONDAY, "no menu") }),
    );

    const panel = await screen.findByRole("region", { name: `Menu for ${longDayLabel(MONDAY)}` });
    expect(within(panel).getByText(/Nothing on the menu for this day/)).toBeInTheDocument();
  });
});

describe("Board, days you cannot act on", () => {
  // Wednesday of the fixture week is "today" for this block, which is what
  // makes Thursday a day still ahead with its cutoff already gone. Pinned to a
  // weekday inside the week rather than to the real one: run this on a Friday
  // and Thursday is yesterday, whose stage is Served rather than Closed, which
  // is a true statement about a different day and a failing test about this
  // one. It failed in CI at 00:02 local for exactly that reason.
  beforeEach(() => {
    vi.setSystemTime(zonedTimeToInstant(WED, "08:00", TZ));
  });

  // Relative to that pinned clock, not to the real one: a cutoff derived from
  // `Date.now()` at module load is in the future again as soon as the pinned
  // clock moves behind it.
  const GONE = zonedTimeToInstant(WED, "07:00", TZ).toISOString();
  const AHEAD = zonedTimeToInstant(WED, "23:00", TZ).toISOString();

  /** Wednesday inside the window, Thursday past its cutoff. */
  function mixedWeek() {
    const base = makeBoard({ wed: menuDay({ orderCutoffAt: AHEAD }) });
    return {
      ...base,
      days: base.days.map((d) =>
        d.serviceDate === THU
          ? { ...menuDay({ orderCutoffAt: GONE }), serviceDate: THU }
          : d,
      ),
    };
  }

  const head = (serviceDate: string) =>
    document.querySelector(`th[data-service-date="${serviceDate}"]`)!;

  it("lets a closed day recede instead of ruling it", async () => {
    serve(mixedWeek());
    renderBoard();
    await screen.findByRole("button", { name: CHOOSE_LABEL });

    // A word, not a tint. One grey used to cover "no menu", "closed" and
    // "cancelled" alike, so the commonest reading of it -- these are the days
    // with a menu -- was not one of the three things it meant.
    expect(head(THU).textContent).toContain("Closed");
    expect(head(WED).textContent).not.toContain("Closed");
    expect(head(THU).className).not.toContain("bg-surface-sunken");
    const closedCell = screen.getByRole("button", {
      name: `${formatDay(THU)}: not eating`,
    });
    expect(closedCell.closest("td")!.className).not.toContain("bg-surface-sunken");
  });

  it("says Cooking once the kitchen has started, and Served once lunch is over", async () => {
    const base = makeBoard();
    serve({
      ...base,
      days: base.days.map((d) =>
        d.serviceDate === TODAY
          ? { ...menuDay({ orderCutoffAt: PAST_CUTOFF, status: "locked" }), serviceDate: TODAY }
          : d,
      ),
    });

    // Mid-morning: the cutoff is long gone and the kitchen is on.
    vi.setSystemTime(zonedTimeToInstant(TODAY, "09:00", TZ));
    const view = renderBoard();
    await screen.findByRole("table");
    expect(head(TODAY).textContent).toContain("Cooking");
    expect(head(TODAY).textContent).not.toContain("Served");
    view.unmount();

    // After the office has gone home. A member can no longer hand the meal on,
    // which is the rule this word is the face of.
    vi.setSystemTime(zonedTimeToInstant(TODAY, "18:00", TZ));
    renderBoard();
    await screen.findByRole("table");
    expect(head(TODAY).textContent).toContain("Served");
  });

  it("marks today with a word and no rule at all", async () => {
    const base = makeBoard();
    serve({
      ...base,
      days: base.days.map((d) =>
        d.serviceDate === TODAY ? { ...menuDay(), serviceDate: TODAY } : d,
      ),
    });
    renderBoard();
    await screen.findByRole("table");

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(document.querySelectorAll('[class*="border-l-accent"]')).toHaveLength(0);
  });

  it("dims nothing for an admin, who is inside the window on every day", async () => {
    serve(mixedWeek());
    renderBoard("admin");
    await screen.findByRole("button", { name: CHOOSE_LABEL });

    expect(head(THU).className).not.toContain("bg-surface-sunken");
  });
});

describe("Board, week navigation", () => {
  it("offers This week only once you have left it", async () => {
    serve(makeBoard());
    renderBoard();

    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "This week" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    const reset = await screen.findByRole("button", { name: "This week" });

    await user.click(reset);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "This week" })).not.toBeInTheDocument(),
    );
  });

  /**
   * The digits on a billing statement's reference are this number, and this is
   * the only place in the app that spells it out. A payer looking at their own
   * bank history has nothing else to match it against.
   */
  it("names the ISO week under the range, and keeps it in step with the arrows", async () => {
    serve(makeBoard());
    renderBoard();
    await screen.findByRole("table");

    expect(screen.getByText(`Week ${weekNumberOf(MONDAY)}`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText(`Week ${weekNumberOf(addDays(MONDAY, 7))}`)).toBeInTheDocument();
  });

  it("asks the database for the week it moved to", async () => {
    serve(makeBoard());
    renderBoard();
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "Previous week" }));

    await waitFor(() =>
      expect(fetchBoard).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: addDays(MONDAY, -7), to: addDays(MONDAY, -1) }),
      ),
    );
  });
});

describe("Board, a day ahead of its menu", () => {
  // Tuesday is today, so Thursday is ahead and has no menu in `makeBoard`.
  const ISO_THU = 4;
  const STANDING = `${formatDay(THU)}: from your standing order. Skip this day`;
  const SKIPPED = `${formatDay(THU)}: skipped. Take the skip back`;
  const PLAN = `${formatDay(THU)}: not eating. Plan to eat`;
  const PLANNED = `${formatDay(THU)}: planned. Take the plan back`;

  /** The fake database, now holding exceptions too, so a reload tells the truth. */
  function serveRule(weekdays: number[], exceptions: Array<[string, "skip" | "force"]> = []) {
    const base = makeBoard({ wed: null });
    const db = serve({ ...base, weekdays: new Set(weekdays), exceptions: new Map(exceptions) });
    let current = db.board;
    const reproject = (b: Board): Board => ({
      ...b,
      projected: api.projectBoard(b, { meProfileId: "me", today: TODAY }),
    });
    current = reproject(current);
    fetchBoard.mockImplementation(async (args) => {
      if (args.from === MONDAY) return current;
      // Any other week is a week of nothing yet, however far ahead.
      const days = Array.from({ length: 7 }, (_, i): BoardDay => ({
        serviceDate: addDays(args.from, i),
        menuId: null, status: null, orderCutoffAt: null, dishes: [],
      }));
      return reproject({ ...current, days, cells: new Map(), exceptions: new Map(
        [...current.exceptions].filter(([d]) => d >= args.from && d <= args.to),
      ) });
    });
    setStandingException.mockImplementation(async (args) => {
      const exceptions = new Map(current.exceptions);
      if (args.action === null) exceptions.delete(args.serviceDate);
      else exceptions.set(args.serviceDate, args.action);
      current = reproject({ ...current, exceptions });
    });
    return {
      get board() {
        return current;
      },
    };
  }

  /** The Undo on the last success toast. */
  function undoOnLastToast(): () => void {
    const opts = success.mock.calls.at(-1)?.[1] as
      | { action?: { label: string; onClick: () => void } }
      | undefined;
    expect(opts?.action?.label).toBe("Undo");
    return opts!.action!.onClick;
  }

  it("skips a standing day in one tap, and takes the skip back in another", async () => {
    serveRule([ISO_THU]);
    renderBoard();

    await user.click(await screen.findByRole("button", { name: STANDING }));

    // Drawn before the database answers.
    const skipped = await screen.findByRole("button", { name: SKIPPED });
    expect(within(skipped).getByText("Skipped")).toHaveClass("line-through");
    await waitFor(() =>
      expect(setStandingException).toHaveBeenCalledWith({ orgId: 7, serviceDate: THU, action: "skip" }),
    );
    expect(success).toHaveBeenLastCalledWith(`Skipped ${formatDay(THU)}`, expect.anything());

    await user.click(skipped);
    await waitFor(() =>
      expect(setStandingException).toHaveBeenLastCalledWith({
        orgId: 7, serviceDate: THU, action: null,
      }),
    );
    expect(await screen.findByRole("button", { name: STANDING })).toBeInTheDocument();
    expect(success).toHaveBeenLastCalledWith(`Standing again ${formatDay(THU)}`, expect.anything());
  });

  it("plans an empty day, and takes the plan back", async () => {
    serveRule([]);
    renderBoard();

    await user.click(await screen.findByRole("button", { name: PLAN }));
    expect(await screen.findByRole("button", { name: PLANNED })).toHaveTextContent("Planned");
    await waitFor(() =>
      expect(setStandingException).toHaveBeenCalledWith({ orgId: 7, serviceDate: THU, action: "force" }),
    );

    await user.click(screen.getByRole("button", { name: PLANNED }));
    expect(await screen.findByRole("button", { name: PLAN })).toBeInTheDocument();
    await waitFor(() =>
      expect(setStandingException).toHaveBeenLastCalledWith({
        orgId: 7, serviceDate: THU, action: null,
      }),
    );
  });

  it("undoes from the toast, back to what was there before, and offers no second undo", async () => {
    // A plan on a day the rule now covers reads as Standing, and undoing its
    // skip has to put the plan back rather than nothing.
    serveRule([ISO_THU], [[THU, "force"]]);
    renderBoard();

    await user.click(await screen.findByRole("button", { name: STANDING }));
    await waitFor(() => expect(setStandingException).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));

    act(() => undoOnLastToast()());

    expect(await screen.findByRole("button", { name: STANDING })).toBeInTheDocument();
    await waitFor(() =>
      expect(setStandingException).toHaveBeenLastCalledWith({
        orgId: 7, serviceDate: THU, action: "force",
      }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2));
    expect(success.mock.calls[1]).toEqual([`Standing again ${formatDay(THU)}`]);
  });

  it("puts the day back and shows the database's sentence when it is refused", async () => {
    serveRule([ISO_THU]);
    setStandingException.mockRejectedValueOnce({
      message: "the menu for 24/09 is already out, so order or cancel that day instead",
    });
    renderBoard();

    await user.click(await screen.findByRole("button", { name: STANDING }));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        "the menu for 24/09 is already out, so order or cancel that day instead",
      ),
    );
    expect(await screen.findByRole("button", { name: STANDING })).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
  });

  it("keeps today's behaviour on a day whose menu is out", async () => {
    const base = makeBoard({ wed: menuDay({ dishes: [DISHES[0]!] }) });
    serve({ ...base, weekdays: new Set([3]) });
    renderBoard();

    await user.click(await screen.findByRole("button", { name: ORDER_LABEL }));
    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setStandingException).not.toHaveBeenCalled();
  });

  it("is inert today and before, with the reason on tap", async () => {
    serveRule([2]);
    renderBoard();

    const cell = await screen.findByRole("button", { name: `${formatDay(TODAY)}: not eating` });
    expect(cell).toHaveAttribute("aria-disabled", "true");
    await user.click(cell);
    expect(setStandingException).not.toHaveBeenCalled();
  });

  it("is not a skip on a day I already have an order row on, even a cancelled one", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("me", THU), {
      orderId: 51, status: "cancelled", source: "standing", itemId: null,
      dishName: null, note: null, amountMinor: null, transferredToName: null,
    });
    const base = makeBoard({ wed: null, cells });
    serve({ ...base, weekdays: new Set([ISO_THU]) });
    renderBoard();

    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: STANDING })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: PLAN })).not.toBeInTheDocument();
  });

  it("pages to a week years ahead and skips a day in it", { timeout: 30_000 }, async () => {
    serveRule([ISO_THU]);
    renderBoard();
    await screen.findByRole("button", { name: STANDING });

    // A hundred weeks on, with no menus and no orders anywhere near it.
    const next = screen.getByRole("button", { name: "Next week" });
    for (let i = 0; i < 100; i++) fireEvent.click(next);
    const monday = addDays(MONDAY, 700);
    const thursday = addDays(monday, 3);
    await waitFor(() =>
      expect(fetchBoard).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: monday, to: addDays(monday, 6) }),
      ),
    );

    const far = await screen.findByRole("button", {
      name: `${formatDay(thursday)}: from your standing order. Skip this day`,
    });
    await user.click(far);
    await waitFor(() =>
      expect(setStandingException).toHaveBeenCalledWith({
        orgId: 7, serviceDate: thursday, action: "skip",
      }),
    );
    expect(
      await screen.findByRole("button", { name: `${formatDay(thursday)}: skipped. Take the skip back` }),
    ).toBeInTheDocument();
  });

  it("keeps a skipped weekend day on screen so it can be taken back", async () => {
    const SAT = addDays(MONDAY, 5);
    serveRule([6], [[SAT, "skip"]]);
    renderBoard();

    expect(
      await screen.findByRole("button", { name: `${formatDay(SAT)}: skipped. Take the skip back` }),
    ).toBeInTheDocument();
  });

  it("opens on this week when the link names a date it cannot draw", async () => {
    serveRule([ISO_THU]);
    for (const asked of ["9999-12-31", "2026-02-31", "1999-12-31"]) {
      window.location.hash = `#/o/test-office/board?week=${asked}`;
      try {
        const view = renderBoard();
        await screen.findByRole("button", { name: STANDING });
        expect(fetchBoard).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: MONDAY, to: addDays(MONDAY, 6) }),
        );
        view.unmount();
      } finally {
        window.location.hash = "";
      }
    }
  });

  it("says why an Undo cannot land once the day's menu is out", async () => {
    const db = serveRule([ISO_THU]);
    renderBoard();
    await screen.findByRole("button", { name: STANDING });

    // The menu is published while the toast is still up.
    fetchBoard.mockResolvedValue({
      ...db.board,
      days: db.board.days.map((d) =>
        d.serviceDate === THU ? { ...menuDay({ dishes: [DISHES[0]!] }), serviceDate: THU } : d,
      ),
      projected: new Set(),
    });
    await user.click(screen.getByRole("button", { name: STANDING }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: `${formatDay(THU)}: not eating. Order lunch` });

    act(() => undoOnLastToast()());

    expect(failure).toHaveBeenCalledWith(
      `The menu for ${formatDay(THU)} is out, so order or cancel that day instead`,
    );
    expect(setStandingException).toHaveBeenCalledTimes(1);
  });

  it("opens on the week Settings links to", async () => {
    serveRule([ISO_THU]);
    const target = addDays(MONDAY, 7 * 30 + 2);
    window.location.hash = `#/o/test-office/board?week=${target}`;
    try {
      renderBoard();
      await waitFor(() =>
        expect(fetchBoard).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: addDays(MONDAY, 7 * 30) }),
        ),
      );
    } finally {
      window.location.hash = "";
    }
  });

  it("offers none of this on a colleague's row", async () => {
    serveRule([ISO_THU]);
    renderBoard();
    await screen.findByRole("button", { name: STANDING });
    expect(screen.getAllByRole("button", { name: /Skip this day|Plan to eat/ })).toHaveLength(
      // Mon..Fri of my row: Thu standing; Wed and Fri empty and ahead.
      3,
    );
  });
});

describe("Board, long dish names", () => {
  const LONG = "Cơm tấm sườn bì chả trứng ốp la kèm canh chua cá lóc và dưa leo";
  // One word with no break in it, which only `overflow-wrap: anywhere` can wrap.
  const WORD = "Bánhcanhcuaghẹtômthịtchảlụatrứngcútquẩyvàrauthơm";
  const LONG_DISHES = [
    { id: 5, name: LONG, priceMinor: 45_000 },
    { id: 6, name: WORD, priceMinor: 50_000 },
  ];
  const CLIPS = /(^|\s)(truncate|line-clamp-\S+|text-ellipsis|text-clip|whitespace-nowrap|overflow-hidden)(\s|$)/;

  /** The text is there whole, and nothing between it and its container clips it. */
  function expectWhole(el: HTMLElement, name: string, stop: string) {
    expect(el.textContent).toBe(name);
    for (let at: HTMLElement | null = el; at !== null; at = at.parentElement) {
      expect(at.className).not.toMatch(CLIPS);
      if (at.matches(stop)) return;
    }
    throw new Error(`${name} is not inside ${stop}`);
  }

  /** Something between the text and its container lets it break inside a word. */
  function expectWraps(el: HTMLElement, stop: string) {
    for (let at: HTMLElement | null = el; at !== null; at = at.parentElement) {
      if (at.classList.contains("wrap-anywhere")) return;
      if (at.matches(stop)) break;
    }
    throw new Error(`${el.textContent} cannot wrap inside a word`);
  }

  function teoHas(dishName: string, extra: Partial<import("../src/web/api.js").BoardCell> = {}) {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 6,
      dishName,
      note: null,
      amountMinor: 50_000,
      transferredToName: null,
      ...extra,
    });
    return cells;
  }

  function transfer(over: Partial<TransferRow>): TransferRow {
    return {
      id: 3,
      orderId: 8,
      serviceDate: WED,
      status: "pending",
      fromProfileId: "teo",
      fromName: "Tèo",
      toProfileId: "me",
      toName: "Neyu",
      dishName: WORD,
      amountMinor: 50_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
      ...over,
    };
  }

  it("shows a long dish name in full in every cell, the menu panel and the dialog", async () => {
    const cells = myCell({ itemId: 5, dishName: LONG });
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 6,
      dishName: WORD,
      note: null,
      amountMinor: 50_000,
      transferredToName: null,
    });
    serve(makeBoard({ wed: menuDay({ dishes: LONG_DISHES }), cells }));
    renderBoard();

    const mine = await screen.findByRole("button", { name: `${formatDay(WED)}: ${LONG}` });
    expectWhole(within(mine).getByText(LONG), LONG, "td");
    expect(within(mine).getByText(LONG)).toHaveClass("wrap-anywhere");
    const theirs = screen.getByRole("button", {
      name: `Tèo, ${formatDay(WED)}: eating ${WORD}. Hand a meal over`,
    });
    expectWhole(within(theirs).getByText(WORD), WORD, "td");
    expect(within(theirs).getByText(WORD)).toHaveClass("wrap-anywhere");

    const panel = screen.getByRole("region", { name: `Menu for ${longDayLabel(WED)}` });
    expectWhole(within(panel).getByText(LONG), LONG, "li");
    expectWhole(within(panel).getByText(WORD), WORD, "li");

    await user.click(mine);
    const dialog = await screen.findByRole("dialog");
    expectWhole(within(dialog).getByText(WORD), WORD, "[role=dialog]");
    expectWhole(
      within(within(dialog).getByRole("button", { name: new RegExp(LONG) })).getByText(LONG),
      LONG,
      "[role=dialog]",
    );
  });

  it("shows a colleague's long dish in full in the handover sheet", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: LONG_DISHES }), cells: teoHas(WORD) }));
    renderBoard();

    await user.click(
      await screen.findByRole("button", { name: `Tèo, ${formatDay(WED)}: eating ${WORD}. Hand a meal over` }),
    );
    const dialog = await screen.findByRole("dialog");
    const dish = within(dialog).getByText(WORD);
    expectWhole(dish, WORD, "[role=dialog]");
    expectWraps(dish, "[role=dialog]");
  });

  it("shows an offer of a long dish in full, and the meal once it is mine", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: LONG_DISHES }), cells: teoHas(WORD) }));
    const offer = transfer({});
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      incoming: [offer],
      live: new Map([[8, offer]]),
    }));
    const view = renderBoard();

    const said = await screen.findByText(`Tèo offers you ${WORD}`);
    expectWhole(said, `Tèo offers you ${WORD}`, "td");
    expectWraps(said, "td");
    view.unmount();

    serve(makeBoard({ wed: menuDay({ dishes: LONG_DISHES }), cells: teoHas(WORD, { transferredToName: "Neyu" }) }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      live: new Map([[8, transfer({ status: "accepted" })]]),
    }));
    renderBoard();
    const mine = await screen.findByRole("button", { name: `${formatDay(WED)}: ${WORD}, from Tèo` });
    expectWhole(within(mine).getByText(WORD), WORD, "td");
    expect(within(mine).getByText(WORD)).toHaveClass("wrap-anywhere");
  });

  it("shows a long dish in full in the phone's list too", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      serve(makeBoard({ wed: menuDay({ dishes: LONG_DISHES }), cells: teoHas(WORD) }));
      renderBoard();
      const list = await screen.findByRole("region", { name: `Who is eating on ${longDayLabel(WED)}` });
      const theirs = within(list).getByText(WORD);
      expectWhole(theirs, WORD, "li");
      expect(theirs).toHaveClass("wrap-anywhere");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Board, on a phone", () => {
  /**
   * A matchMedia that answers "narrow" until told otherwise. jsdom has none,
   * which is what keeps every other test in this file on the grid.
   */
  let narrow = true;
  const listeners = new Set<() => void>();
  function resize(toNarrow: boolean) {
    narrow = toNarrow;
    act(() => listeners.forEach((l) => l()));
  }
  beforeEach(() => {
    narrow = true;
    listeners.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query.includes("max-width") && narrow;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const listFor = (d: string) => screen.findByRole("region", { name: `Who is eating on ${longDayLabel(d)}` });
  const chip = (d: string) => document.querySelector<HTMLElement>(`[data-strip-date="${d}"]`)!;

  function swipe(el: HTMLElement, dx: number, dy = 0, fingers = 1) {
    const at = (x: number, y: number) => ({ clientX: x, clientY: y });
    fireEvent.touchStart(el, { touches: Array.from({ length: fingers }, () => at(200, 300)) });
    fireEvent.touchEnd(el, { touches: [], changedTouches: [at(200 + dx, 300 + dy)] });
  }

  it("shows one day as a list instead of the grid, opening on the day to order", async () => {
    serve(makeBoard());
    renderBoard();

    const list = await listFor(WED);
    expect(screen.queryByRole("table")).toBeNull();
    for (const m of MEMBERS) expect(within(list).getByText(m.name)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: CHOOSE_LABEL })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: DICE_LABEL })).toBeInTheDocument();
    expect(chip(WED)).toHaveAttribute("aria-pressed", "true");
  });

  it("stands in for the list while loading, not for the grid", async () => {
    fetchBoard.mockReturnValue(new Promise(() => {}));
    fetchTransfers.mockReturnValue(new Promise(() => {}));
    renderBoard();
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reports a failed read and offers a retry, as the grid does", async () => {
    fetchBoard.mockRejectedValue({ message: "JWT expired" });
    fetchTransfers.mockResolvedValue(noTransfers());
    renderBoard();
    expect(await screen.findByText("JWT expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("marks today and the picked day for a screen reader, and says each day's stage", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);

    const group = screen.getByRole("group", { name: "Day" });
    expect(within(group).getAllByRole("button").length).toBe(5);
    const tue = chip(TODAY);
    expect(tue).toHaveAttribute("aria-current", "date");
    expect(tue).toHaveAttribute("aria-pressed", "false");
    const { dow, dom } = columnLabel(TODAY);
    expect(tue).toHaveAccessibleName(`${dow} ${dom}, today, no menu, not eating`);
    expect(tue).toHaveTextContent("Today");
  });

  it("shows the stage word on the picked day only", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);

    // Monday and Tuesday both have no menu; only the picked one says so.
    await user.click(chip(MONDAY));
    expect(within(chip(MONDAY)).getByText("No menu")).toBeInTheDocument();
    expect(within(chip(TODAY)).queryByText("No menu")).toBeNull();
    expect(await listFor(MONDAY)).toBeInTheDocument();
  });

  it("orders from the list in one tap on the dice", async () => {
    const db = serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: DICE_LABEL }));
    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(db.board.cells.get(cellKey("me", WED))?.status).toBe("placed");
    expect(chip(WED)).toHaveAccessibleName(expect.stringContaining("you are eating"));
  });

  it("opens the chooser from the plus, as a target of its own", async () => {
    serve(makeBoard());
    renderBoard();

    await user.click(await screen.findByRole("button", { name: CHOOSE_LABEL }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(setOrder).not.toHaveBeenCalled();
  });

  it("moves the list and the menu to the day picked in the strip, keeping focus on it", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);

    await user.click(chip(THU));
    expect(await listFor(THU)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: `Menu for ${longDayLabel(THU)}` })).toBeInTheDocument();
    expect(chip(THU)).toHaveAttribute("aria-pressed", "true");
    expect(chip(THU)).toHaveFocus();
  });

  it("moves a day on a sideways swipe, and not on a scroll or a pinch", async () => {
    serve(makeBoard());
    renderBoard();
    const list = await listFor(WED);

    // Each is checked on its own, so one guard cannot stand in for another.
    const still = () => expect(list).toHaveAttribute("aria-label", `Who is eating on ${longDayLabel(WED)}`);
    swipe(list, -40, 200); // too short
    still();
    swipe(list, -80, 300); // far enough, but mostly a vertical scroll
    still();
    swipe(list, -120, 0, 2); // a pinch
    still();
    swipe(list, -30);
    still();

    swipe(list, -120, 10);
    expect(await listFor(THU)).toBeInTheDocument();
    swipe(list, 120);
    expect(await listFor(WED)).toBeInTheDocument();
  });

  it("moves focus to the list when a swipe takes away the cell that had it", async () => {
    serve(makeBoard());
    renderBoard();
    const list = await listFor(WED);

    within(list).getByRole("button", { name: DICE_LABEL }).focus();
    swipe(list, -120);
    expect(await listFor(THU)).toHaveFocus();
  });

  it("does not swipe from the strip", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);

    swipe(screen.getByRole("group", { name: "Day" }), -120);
    expect(await listFor(WED)).toBeInTheDocument();
  });

  it("keeps the picked day and an open dialog across the breakpoint, both ways", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);
    await user.click(chip(THU));
    await listFor(THU);

    resize(false);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: `Menu for ${longDayLabel(THU)}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: headName(THU, "no menu") })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: CHOOSE_LABEL }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    resize(true);
    // The open dialog hides the page from the accessibility tree, so by attribute.
    await waitFor(() =>
      expect(document.querySelector("[data-board-list]")).toHaveAttribute(
        "aria-label",
        `Who is eating on ${longDayLabel(THU)}`,
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("stops listening for the breakpoint once it is gone", async () => {
    serve(makeBoard());
    const view = renderBoard();
    await listFor(WED);
    expect(listeners.size).toBeGreaterThan(0);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps a slow order on its own day while the reader moves to another", async () => {
    serve(makeBoard());
    let refuse: (e: unknown) => void = () => {};
    setOrder.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    renderBoard();

    await user.click(await screen.findByRole("button", { name: DICE_LABEL }));
    await user.click(chip(THU));
    const thu = await listFor(THU);
    // Thursday's row of mine is Thursday's, not the Wednesday order in flight.
    expect(within(thu).getByRole("button", { name: `${formatDay(THU)}: not eating. Plan to eat` })).toBeInTheDocument();

    await act(async () => refuse({ message: "ordering for 24/09 closed" }));
    await waitFor(() => expect(failure).toHaveBeenCalledWith("ordering for 24/09 closed"));
    await user.click(chip(WED));
    expect(within(await listFor(WED)).getByRole("button", { name: DICE_LABEL })).toBeInTheDocument();
  });

  it("draws the week now shown when the week left behind answers last", async () => {
    let answerFirst: (b: Board) => void = () => {};
    fetchTransfers.mockImplementation(async () => noTransfers());
    fetchBoard.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    const next = makeBoard();
    fetchBoard.mockResolvedValue({
      ...next,
      days: next.days.map((d) => ({ ...d, serviceDate: addDays(d.serviceDate, 7) })),
    });
    renderBoard();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    const nextWed = addDays(WED, 7);
    expect(await listFor(nextWed)).toBeInTheDocument();

    await act(async () => answerFirst(makeBoard()));
    expect(await listFor(nextWed)).toBeInTheDocument();
    expect(chip(WED)).toBeNull();
  });

  it("opens on the week a link names", async () => {
    serve(makeBoard());
    const target = addDays(MONDAY, 7 * 30 + 2);
    window.location.hash = `#/o/test-office/board?week=${target}`;
    try {
      renderBoard();
      await waitFor(() =>
        expect(fetchBoard).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: addDays(MONDAY, 7 * 30) }),
        ),
      );
    } finally {
      window.location.hash = "";
    }
  });

  it("skips and plans a day ahead from the list", async () => {
    const base = makeBoard({ wed: null });
    let current: Board = { ...base, weekdays: new Set([4]) };
    const reproject = (b: Board): Board => ({
      ...b,
      projected: api.projectBoard(b, { meProfileId: "me", today: TODAY }),
    });
    current = reproject(current);
    fetchBoard.mockImplementation(async () => current);
    fetchTransfers.mockImplementation(async () => noTransfers());
    setStandingException.mockImplementation(async (args) => {
      const exceptions = new Map(current.exceptions);
      if (args.action === null) exceptions.delete(args.serviceDate);
      else exceptions.set(args.serviceDate, args.action);
      current = reproject({ ...current, exceptions });
    });
    renderBoard();
    await listFor(TODAY);

    await user.click(chip(THU));
    const thu = await listFor(THU);
    await user.click(within(thu).getByRole("button", { name: `${formatDay(THU)}: from your standing order. Skip this day` }));
    const skipped = await within(thu).findByRole("button", { name: `${formatDay(THU)}: skipped. Take the skip back` });
    expect(within(skipped).getByText("Skipped")).toHaveClass("line-through");
    expect(chip(THU)).toHaveAccessibleName(expect.stringContaining("skipped"));

    await user.click(chip(addDays(THU, 1)));
    const fri = await listFor(addDays(THU, 1));
    await user.click(within(fri).getByRole("button", { name: `${formatDay(addDays(THU, 1))}: not eating. Plan to eat` }));
    expect(await within(fri).findByRole("button", { name: `${formatDay(addDays(THU, 1))}: planned. Take the plan back` })).toHaveTextContent("Planned");
  });

  it("says a colleague's day in the same words, and hands a meal over from it", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();
    const list = await listFor(WED);

    expect(within(list).getByText("Phở bò")).toBeInTheDocument();
    await user.click(
      within(list).getByRole("button", { name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over` }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Give Dinh my Cơm gà" }),
    );
    await waitFor(() =>
      expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({ orderId: 42, toProfileId: "dinh" })),
    );
  });

  it("answers an incoming offer from the list", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: null,
    });
    const offer: TransferRow = {
      id: 3,
      orderId: 8,
      serviceDate: WED,
      status: "pending",
      fromProfileId: "teo",
      fromName: "Tèo",
      toProfileId: "me",
      toName: "Neyu",
      dishName: "Phở bò",
      amountMinor: 40_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
    };
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({
      ...noTransfers(),
      incoming: [offer],
      live: new Map([[8, offer]]),
    }));
    renderBoard();
    const list = await listFor(WED);

    expect(within(list).getByText("Tèo offers you Phở bò")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(decideTransfer).toHaveBeenCalledWith(3, "declined"));
  });

  it("shows a meal given to me on my row, and \"to you\" on the giver's", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      itemId: 7,
      dishName: "Phở bò",
      note: null,
      amountMinor: 40_000,
      transferredToName: "Neyu",
    });
    const accepted: TransferRow = {
      id: 4,
      orderId: 8,
      serviceDate: WED,
      status: "accepted",
      fromProfileId: "teo",
      fromName: "Tèo",
      toProfileId: "me",
      toName: "Neyu",
      dishName: "Phở bò",
      amountMinor: 40_000,
      reason: null,
      createdAt: "2026-09-22T09:00:00Z",
    };
    serve(makeBoard({ cells }));
    fetchTransfers.mockImplementation(async () => ({ ...noTransfers(), live: new Map([[8, accepted]]) }));
    renderBoard();
    const list = await listFor(WED);

    expect(within(list).getByRole("button", { name: `${formatDay(WED)}: Phở bò, from Tèo` })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const theirs = within(list).getByRole("button", {
      name: `Tèo, ${formatDay(WED)}: passed on to you. Hand a meal over`,
    });
    expect(within(theirs).getByText("to you")).toBeInTheDocument();
    expect(within(list).queryByText("to Neyu")).toBeNull();
    expect(chip(WED)).toHaveAccessibleName(expect.stringContaining("you are eating"));
  });

  it("carries the reason on a day that cannot be ordered, and says a cancelled day is", async () => {
    serve(makeBoard({ wed: menuDay({ status: "cancelled" }) }));
    renderBoard();
    await listFor(TODAY);
    await user.click(chip(WED));
    expect(within(chip(WED)).getByText("Cancelled")).toBeInTheDocument();
    const mine = within(await listFor(WED)).getByRole("button", { name: EMPTY_LABEL });
    expect(mine).toHaveAttribute("aria-disabled", "true");
  });

  it("says a draft is a draft, and a week with no menus says so above the list", async () => {
    serve(makeBoard({ wed: menuDay({ status: "draft" }) }));
    const view = renderBoard();
    await listFor(TODAY);
    await user.click(chip(WED));
    expect(within(chip(WED)).getByText("Draft")).toBeInTheDocument();
    view.unmount();

    serve(makeBoard({ wed: null }));
    renderBoard();
    expect(await screen.findByRole("heading", { name: "No menus this week" })).toBeInTheDocument();
    expect(await listFor(TODAY)).toBeInTheDocument();
  });

  it("says Cooking and Served once the day moves on", async () => {
    serve(makeBoard({ wed: menuDay({ status: "locked", orderCutoffAt: PAST_CUTOFF }) }));
    vi.setSystemTime(zonedTimeToInstant(WED, "18:00", TZ));
    renderBoard();
    await listFor(WED);
    await user.click(chip(WED));
    expect(within(chip(WED)).getByText("Served")).toBeInTheDocument();
    expect(within(await listFor(WED)).getByText(/Served/)).toBeInTheDocument();
  });

  it("pages weeks and keeps the list", async () => {
    serve(makeBoard());
    renderBoard();
    await listFor(WED);
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() =>
      expect(fetchBoard).toHaveBeenLastCalledWith(expect.objectContaining({ from: addDays(MONDAY, 7) })),
    );
    expect(screen.getByRole("button", { name: "This week" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
