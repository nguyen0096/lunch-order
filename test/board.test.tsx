import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { BoardScreen } from "../src/web/components/BoardScreen.js";
import { cellKey, type Board, type BoardDay, type TransferRow } from "../src/web/api.js";
import * as api from "../src/web/api.js";
import { addDays, formatDay, todayIn, weekStart } from "../src/shared/dates.js";
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
};

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", displayName: "Neyu" }],
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
const OPEN_CUTOFF = new Date(Date.now() + 86_400_000).toISOString();
const PAST_CUTOFF = new Date(Date.now() - 86_400_000).toISOString();

const MEMBERS = [
  { profileId: "me", name: "Neyu", shortCode: "NEYU", isMe: true },
  { profileId: "teo", name: "Tèo", shortCode: "TEO", isMe: false },
  { profileId: "dinh", name: "Dinh", shortCode: "DINH", isMe: false },
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
      dishName: dish?.name ?? null,
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
    dishName: "Cơm gà",
    amountMinor: 45_000,
    transferredToName: null,
    ...cellOver,
  });
  return cells;
}

const EMPTY_LABEL = `${formatDay(WED)}: not eating`;

function renderBoard(role: Role = "member") {
  return render(<BoardScreen me={ME} org={ORG} role={role} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  createTransfer.mockResolvedValue(undefined);
  decideTransfer.mockResolvedValue(undefined);
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

    await userEvent.click(await screen.findByRole("button", { name: EMPTY_LABEL }));

    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
    expect(setOrder.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      menuId: 5,
      serviceDate: WED,
      profileId: "me",
      itemId: 5,
    });
    // No dialog: one dish is not a choice.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("Ordered Cơm gà");
    expect(await screen.findByText("Cơm gà")).toBeInTheDocument();
  });

  it("assigns a dish at random when the menu has several, and names it", async () => {
    serve(makeBoard());
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: EMPTY_LABEL }));

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
      await userEvent.click(await screen.findByRole("button", { name: EMPTY_LABEL }));
      await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
      seen.add(setOrder.mock.calls[0]?.[0].itemId);
      view.unmount();
    }
    // Not the first dish every time, which is what "at random" buys.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("puts the cell back and shows the database's sentence when it is refused", async () => {
    serve(makeBoard({ wed: menuDay({ dishes: [DISHES[0]!] }) }));
    setOrder.mockRejectedValue({ message: "ordering for 23/09 closed at 21:00 22/09" });
    renderBoard();

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    await userEvent.click(cell);

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("ordering for 23/09 closed at 21:00 22/09"),
    );
    // Reverted: the optimistic fill is gone and the cell is empty again.
    expect(await screen.findByRole("button", { name: EMPTY_LABEL })).toBeInTheDocument();
    expect(screen.queryByText("Cơm gà")).not.toBeInTheDocument();
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

  it("lets an admin past the cutoff, as the trigger does", async () => {
    serve(makeBoard({ wed: menuDay({ orderCutoffAt: PAST_CUTOFF, dishes: [DISHES[0]!] }) }));
    renderBoard("admin");

    const cell = await screen.findByRole("button", { name: EMPTY_LABEL });
    expect(cell).not.toHaveAttribute("aria-disabled");
    await userEvent.click(cell);
    await waitFor(() => expect(setOrder).toHaveBeenCalledTimes(1));
  });
});

describe("Board, asymmetric rows", () => {
  it("names your dish but only marks a colleague's", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    expect(await screen.findByText("Cơm gà")).toBeInTheDocument();
    // Tèo is eating, but which dish is not this reader's business.
    expect(screen.queryByText("Phở bò")).not.toBeInTheDocument();
    expect(screen.getByText(`Tèo, ${formatDay(WED)}: ordered`)).toBeInTheDocument();
    expect(screen.getByText(`Dinh, ${formatDay(WED)}: not eating`)).toBeInTheDocument();
  });

  it("counts the headcount per day", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    const total = (await screen.findByText("Total")).closest("tr")!;
    expect(within(total).getAllByText("2")).not.toHaveLength(0);
  });
});

describe("Board, passing a meal on", () => {
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

  it("hands the meal over from the cell, through a combobox you type into", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.type(await screen.findByPlaceholderText("Type a name"), "Tè");
    await userEvent.click(await screen.findByRole("option", { name: "Tèo" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Pass on" }));

    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(createTransfer.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      orderId: 42,
      toProfileId: "teo",
      createdBy: "me",
    });
    expect(success).toHaveBeenCalledWith("Passed on to Tèo");
  });

  it("refuses to send a meal nowhere, and says so on the control", async () => {
    serve(makeBoard({ cells: myCell() }));
    renderBoard();

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    const send = within(await screen.findByRole("dialog")).getByRole("button", { name: "Pass on" });
    expect(send).toHaveAccessibleDescription("Choose who it goes to");
  });

  it("shows an incoming offer on the cell it concerns, with both answers", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
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

  it("does not offer a member somebody else's cell at all", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard();

    await screen.findByRole("table");
    expect(
      screen.queryByRole("button", { name: new RegExp(`Tèo, ${formatDay(WED)}`) }),
    ).not.toBeInTheDocument();
  });

  it("addresses the colleague rather than the reader on somebody else's cell", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await userEvent.click(
      await screen.findByRole("button", { name: `Tèo, ${formatDay(WED)}: ordered. Pass it on` }),
    );
    expect(await screen.findByText("Tèo has Phở bò.")).toBeInTheDocument();
  });

  it("starts the form empty on each cell, so a name cannot follow you to the next meal", async () => {
    const cells = myCell();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await userEvent.click(await screen.findByRole("button", { name: `${formatDay(WED)}: Cơm gà` }));
    await userEvent.type(
      within(await screen.findByRole("dialog")).getByPlaceholderText("out at a client meeting"),
      "dentist",
    );
    await userEvent.keyboard("{Escape}");

    await userEvent.click(
      await screen.findByRole("button", { name: `Tèo, ${formatDay(WED)}: ordered. Pass it on` }),
    );
    expect(
      within(await screen.findByRole("dialog")).getByPlaceholderText("out at a client meeting"),
    ).toHaveValue("");
  });

  it("lets an admin record a swap on a colleague's cell", async () => {
    const cells = new Map<string, import("../src/web/api.js").BoardCell>();
    cells.set(cellKey("teo", WED), {
      orderId: 8,
      status: "placed",
      source: "member",
      dishName: "Phở bò",
      amountMinor: 40_000,
      transferredToName: null,
    });
    serve(makeBoard({ cells }));
    renderBoard("admin");

    await userEvent.click(
      await screen.findByRole("button", {
        name: `Tèo, ${formatDay(WED)}: ordered. Pass it on`,
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/takes effect immediately/)).toBeInTheDocument();
    // Ordering for somebody else is not on offer here; the swap is.
    expect(within(dialog).queryByRole("button", { name: "Surprise me" })).not.toBeInTheDocument();
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
