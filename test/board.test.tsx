import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { BoardScreen } from "../src/web/components/BoardScreen.js";
import { cellKey, type Board, type BoardDay, type TransferRow } from "../src/web/api.js";
import * as api from "../src/web/api.js";
import { columnLabel, longDayLabel } from "../src/web/components/boardModel.js";
import { formatMoney } from "../src/shared/money.js";
import { addDays, formatDay, todayIn, weekStart, zonedTimeToInstant } from "../src/shared/dates.js";
import type { Me, Org, Role } from "../src/shared/types.js";

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
  };
});

const fetchBoard = vi.mocked(api.fetchBoard);
const fetchTransfers = vi.mocked(api.fetchTransfers);
const setOrder = vi.mocked(api.setOrder);
const cancelOrder = vi.mocked(api.cancelOrder);
const createTransfer = vi.mocked(api.createTransfer);
const decideTransfer = vi.mocked(api.decideTransfer);
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
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" }],
};

const DISHES = [
  { id: 5, name: "Cơm gà", priceMinor: 45_000 },
  { id: 6, name: "Bún bò", priceMinor: 50_000 },
  { id: 7, name: "Phở bò", priceMinor: 40_000 },
];

// Anchored to the real week so the screen's own `todayIn` agrees with the
// fixture. Wednesday is always a weekday, so it always gets a column.
const TODAY = todayIn(TZ);
const MONDAY = weekStart(TODAY, 1);
const WED = addDays(MONDAY, 2);
const THU = addDays(MONDAY, 3);
const OPEN_CUTOFF = new Date(Date.now() + 86_400_000).toISOString();
const PAST_CUTOFF = new Date(Date.now() - 86_400_000).toISOString();

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

    await userEvent.click(await screen.findByRole("button", { name: ORDER_LABEL }));

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

    await userEvent.click(await screen.findByRole("button", { name: DICE_LABEL }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    const itemId = setOrder.mock.calls[0]?.[0].itemId;
    expect([5, 6, 7]).toContain(itemId);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const named = DISHES.find((d) => d.id === itemId)!.name;
    expect(success).toHaveBeenCalledWith(`Ordered ${named} · tap to change`);
  });

  it("spreads the randomised order across the whole menu", async () => {
    const seen = new Set<number | null | undefined>();
    for (let run = 0; run < 25; run++) {
      vi.clearAllMocks();
      serve(makeBoard());
      const view = renderBoard();
      await userEvent.click(await screen.findByRole("button", { name: DICE_LABEL }));
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

    await userEvent.click(await screen.findByRole("button", { name: CHOOSE_LABEL }));

    const dialog = await screen.findByRole("dialog");
    expect(setOrder).not.toHaveBeenCalled();
    // Every dish on that day, priced, which is the whole point of asking.
    for (const dish of DISHES) {
      expect(within(dialog).getByRole("button", { name: new RegExp(dish.name) })).toBeInTheDocument();
    }

    await userEvent.click(within(dialog).getByRole("button", { name: /Bún bò/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 6, existing: null });
    expect(success).toHaveBeenCalledWith("Ordered Bún bò");
  });

  it("puts the cell back and shows the database's sentence when it is refused", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: [DISHES[0]!] }) }));
    setOrder.mockRejectedValue({ message: "ordering for 23/09 closed at 21:00 22/09" });
    renderBoard();

    const cell = await screen.findByRole("button", { name: ORDER_LABEL });
    await userEvent.click(cell);

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

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Bún bò/ })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /Phở bò/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 7, existing: { id: 42 } });
    expect(success).toHaveBeenCalledWith("Ordered Phở bò");
  });

  it("offers Surprise me as a first-class choice, and never repeats the dish you have", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Surprise me" }),
    );

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0].itemId).not.toBe(5);
    expect(success).toHaveBeenCalledWith(expect.stringContaining("· tap to change"));
  });

  it("clears the day from the dialog, in the same words as the button", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    await userEvent.click(
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

    await userEvent.click(cell);
    expect(setOrder).not.toHaveBeenCalled();
  });

  it("quotes the cutoff once it has passed", async () => {
    serve(makeBoard({ wed: menuDay({ orderCutoffAt: PAST_CUTOFF }) }));
    renderBoard();

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    expect(cell).toHaveAccessibleDescription(/^Ordering closed at \d{2}:\d{2} \d{2}\/\d{2}$/);
  });

  it("says a day has no menu instead of leaving the cell mute", async () => {
    serve(makeBoard({ wed: null }));
    renderBoard();

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    expect(cell).toHaveAccessibleDescription(`No menu for ${formatDay(WED)} yet`);
  });

  it("holds an admin to the cutoff too, because this board is theirs to eat from", async () => {
    serve(makeBoard({ wed: menuDay({ orderCutoffAt: PAST_CUTOFF, dishes: [DISHES[0]!] }) }));
    renderBoard("admin");

    await screen.findByRole("table");
    const cell = screen.getByRole("button", { name: new RegExp(`^${EMPTY_LABEL}`) });
    expect(cell).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(cell);
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

    await userEvent.click(await screen.findByRole("button", { name: theirName("not eating") }));
    const dialog = await screen.findByRole("dialog");

    // One direction, named. A member has nothing to choose from.
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Pass on" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Give Tèo my Cơm gà" }));

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

    await userEvent.click(empty);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dinh is not down as eating.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Give Dinh my Cơm gà" })).toBeInTheDocument();
  });

  it("says why there is nothing to give when I have not ordered", async () => {
    serve(makeBoard());
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: theirName("not eating") }));
    const give = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Give Tèo my lunch",
    });
    expect(give).toHaveAccessibleDescription(`You have nothing ordered on ${formatDay(WED)}`);

    await userEvent.click(give);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("adds the recording form for an admin, which is the one picker left", async () => {
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

    await userEvent.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Pass Tèo's Phở bò to someone" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/takes effect immediately/)).toBeInTheDocument();
    // Ordering for somebody else is not on offer here; the handover is.
    expect(within(dialog).queryByRole("button", { name: "Surprise me" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.type(await screen.findByPlaceholderText("Type a name"), "Din");
    await userEvent.click(await screen.findByRole("option", { name: "Dinh" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Pass on" }));

    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0]?.[0]).toMatchObject({ orderId: 8, toProfileId: "dinh" });
  });

  it("refuses to send a meal nowhere, and says so on the control", async () => {
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

    await userEvent.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    const send = within(await screen.findByRole("dialog")).getByRole("button", { name: "Pass on" });
    expect(send).toHaveAccessibleDescription("Choose who it goes to");
  });

  it("keeps a pending offer legible on the board, and reachable to withdraw", async () => {
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

    await userEvent.click(cell);
    await userEvent.click(
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
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

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
    renderBoard("admin");

    await userEvent.click(await screen.findByRole("button", { name: theirName("eating Phở bò") }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Dinh" }));
    await userEvent.keyboard("{Escape}");

    await userEvent.click(
      await screen.findByRole("button", {
        name: `Dinh, ${formatDay(WED)}: not eating. Hand a meal over`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Give Dinh my Cơm gà" })).toBeInTheDocument();
  });
});

describe("Board, the note that goes to the caterer", () => {
  it("sends the note with the dish, and shows it under the dish on my row", async () => {
    serve(makeBoard());
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: CHOOSE_LABEL }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByPlaceholderText("ít cơm, không trứng"), "ít cơm");
    await userEvent.click(within(dialog).getByRole("button", { name: /Cơm gà/ }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({ itemId: 5, note: "ít cơm" });
    expect(within(await screen.findByRole("table")).getByText("ít cơm")).toBeInTheDocument();
  });

  it("saves a note against a dish already chosen, without changing the dish", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByPlaceholderText("ít cơm, không trứng"),
      "không trứng",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save note" }));

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

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const field = within(await screen.findByRole("dialog")).getByPlaceholderText(
      "ít cơm, không trứng",
    );
    expect(field).toHaveAttribute("maxlength", "120");
  });

  it("has nothing to save until the note changes, and says so", async () => {
    serve(makeBoard({ cells: myCell({ note: "ít cơm" }) }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà, ít cơm` }));
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

    await userEvent.click(
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
    await userEvent.click(
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

    await userEvent.click(
      await screen.findByRole("button", { name: headName(MONDAY, "no menu") }),
    );

    const panel = await screen.findByRole("region", { name: `Menu for ${longDayLabel(MONDAY)}` });
    expect(within(panel).getByText(/Nothing on the menu for this day/)).toBeInTheDocument();
  });
});

describe("Board, days you cannot act on", () => {
  /** Wednesday inside the window, Thursday past its cutoff. */
  function mixedWeek() {
    const base = makeBoard();
    return {
      ...base,
      days: base.days.map((d) =>
        d.serviceDate === THU
          ? { ...menuDay({ orderCutoffAt: PAST_CUTOFF }), serviceDate: THU }
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

    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    const reset = await screen.findByRole("button", { name: "This week" });

    await userEvent.click(reset);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "This week" })).not.toBeInTheDocument(),
    );
  });

  it("asks the database for the week it moved to", async () => {
    serve(makeBoard());
    renderBoard();
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "Previous week" }));

    await waitFor(() =>
      expect(fetchBoard).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: addDays(MONDAY, -7), to: addDays(MONDAY, -1) }),
      ),
    );
  });
});
