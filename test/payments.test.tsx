import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { PaymentsScreen } from "../src/web/components/PaymentsScreen.js";
import * as api from "../src/web/api.js";
import type {
  CatererSummary,
  PaymentsData,
  PaymentsPeriod,
  PaymentsStatement,
  SettlementDish,
  SettlementWeek,
  UnmatchedPayment,
} from "../src/web/api.js";
import { formatMoney } from "../src/shared/money.js";
import { formatDay } from "../src/shared/dates.js";
import { dishKey } from "../src/shared/settlement.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

/**
 * The network edge, one layer lower than the other screen tests go.
 *
 * `board.test.tsx` fakes the api module and leaves the real one alone, which
 * is right when the question is what a screen does with data. Half the
 * questions here are about the row that reaches `payments` -- a provider that
 * is not the bank's, a transaction id that will not collide, `received_at` and
 * `raw` supplied because both are NOT NULL with no default -- and none of that
 * is visible above the api layer. So the client itself is stubbed, and the
 * calls it was handed are the assertion.
 */
const db = vi.hoisted(() => {
  type Call = {
    table: string;
    op: "select" | "insert" | "update";
    payload: Record<string, unknown> | null;
    filters: Array<[string, unknown]>;
  };
  const calls: Call[] = [];
  const results: Array<{ data: unknown; error: unknown }> = [];
  /** `settle_period` is an RPC, so it never reaches `from`. */
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  function from(table: string): Record<string, unknown> {
    const call: Call = { table, op: "select", payload: null, filters: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const step =
      (record: (...args: never[]) => void) =>
      (...args: unknown[]) => {
        (record as (...a: unknown[]) => void)(...args);
        return builder;
      };
    Object.assign(builder, {
      insert: step(((row: Record<string, unknown>) => {
        call.op = "insert";
        call.payload = row;
      }) as never),
      update: step(((patch: Record<string, unknown>) => {
        call.op = "update";
        call.payload = patch;
      }) as never),
      select: step((() => {}) as never),
      eq: step(((column: string, value: unknown) => call.filters.push([column, value])) as never),
      is: step(((column: string, value: unknown) => call.filters.push([column, value])) as never),
      in: step(((column: string, value: unknown) => call.filters.push([column, value])) as never),
      neq: step((() => {}) as never),
      order: step((() => {}) as never),
      limit: step((() => {}) as never),
      single: step((() => {}) as never),
      maybeSingle: step((() => {}) as never),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(results.shift() ?? { data: null, error: null }).then(resolve, reject),
    });
    return builder;
  }

  function rpc(fn: string, args: unknown) {
    rpcCalls.push({ fn, args });
    return Promise.resolve(results.shift() ?? { data: null, error: null });
  }

  return { calls, results, from, rpc, rpcCalls };
});

vi.mock("../src/web/supabase.js", () => ({
  configError: null,
  supabase: {
    from: (table: string) => db.from(table),
    rpc: (fn: string, args: unknown) => db.rpc(fn, args),
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// The screen's own tests fake the api module, as every other screen test does.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchPayments: vi.fn(),
    fetchCatererSummary: vi.fn(),
    fetchSettlementWeek: vi.fn(),
    applyCatererPrices: vi.fn(),
    settlePeriod: vi.fn(),
    recordPayment: vi.fn(),
    waiveStatement: vi.fn(),
  };
});

const fetchPayments = vi.mocked(api.fetchPayments);
const fetchCatererSummary = vi.mocked(api.fetchCatererSummary);
const fetchSettlementWeek = vi.mocked(api.fetchSettlementWeek);
const applyCatererPrices = vi.mocked(api.applyCatererPrices);
const settlePeriod = vi.mocked(api.settlePeriod);
const recordPayment = vi.mocked(api.recordPayment);
const waiveStatement = vi.mocked(api.waiveStatement);
const success = vi.mocked(toast.success);

/** The real module, running against the stubbed client above. */
function realApi() {
  return vi.importActual<typeof import("../src/web/api.js")>("../src/web/api.js");
}

/* ------------------------------------------------------------------ fixture */

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: "Asia/Ho_Chi_Minh",
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
};

const ME: Me = {
  profileId: "admin",
  fullName: "Chi",
  email: "chi@example.com",
  orgs: [{ org: ORG, role: "admin", shortCode: "CHI", displayName: "Chi" }],
};

// Testing Library collapses whitespace before matching and `formatMoney` puts a
// non-breaking space before the ₫, so the expectations stay written in the
// currency the screen actually prints.
const money = (minor: number) => formatMoney(minor, ORG.currency).replace(/\u00a0/g, " ");

/**
 * The same figure, unnormalised. `getByRole`'s `name` option compares the
 * computed accessible name with no whitespace normalisation at all, and a
 * toast is compared as a plain string, so both need the non-breaking space
 * `formatMoney` actually emits.
 */
const rawMoney = (minor: number) => formatMoney(minor, ORG.currency);

const WEEK_14: PaymentsPeriod = {
  periodId: 11,
  periodStart: "2026-09-14",
  periodEnd: "2026-09-20",
  periodStatus: "closed",
  lineCount: 5,
  totalMinor: 230_000,
};

const WEEK_21: PaymentsPeriod = {
  periodId: 12,
  periodStart: "2026-09-21",
  periodEnd: "2026-09-27",
  periodStatus: "open",
  lineCount: 0,
  totalMinor: 0,
};

function statement(over: Partial<PaymentsStatement> = {}): PaymentsStatement {
  return {
    id: 1,
    periodId: 11,
    profileId: "teo",
    name: "Tèo",
    shortCode: "TEO",
    mealCount: 3,
    mealsMinor: 130_000,
    carriedInMinor: 0,
    totalDueMinor: 130_000,
    paidMinor: 0,
    paymentRef: "LUNCH14TEO",
    status: "unpaid",
    paidAt: null,
    ...over,
  };
}

const DINH = statement({
  id: 2,
  profileId: "dinh",
  name: "Dinh",
  shortCode: "DINH",
  mealCount: 2,
  mealsMinor: 100_000,
  totalDueMinor: 100_000,
  paidMinor: 40_000,
  paymentRef: "LUNCH14DINH",
  status: "partial",
});

const STRAY: UnmatchedPayment = {
  id: 91,
  amountMinor: 100_000,
  memo: "CT DEN TK 113366668888 LUNCH14TE0 CHUYEN TIEN",
  receivedAt: "2026-09-22T03:30:00Z",
  provider: "sepay",
};

const CATERER: CatererSummary = {
  days: [
    {
      serviceDate: "2026-09-14",
      dishes: [
        { description: "Cơm gà", count: 2, amountMinor: 90_000 },
        { description: "Phở bò", count: 1, amountMinor: 40_000 },
      ],
      count: 3,
      subtotalMinor: 130_000,
    },
    {
      serviceDate: "2026-09-15",
      dishes: [{ description: "Bún bò", count: 2, amountMinor: 100_000 }],
      count: 2,
      subtotalMinor: 100_000,
    },
  ],
  count: 5,
  totalMinor: 230_000,
  periodTotalMinor: 230_000,
};

/* ------------------------------------------------------ settling the week */

/**
 * A dish on a week's menus, waiting on a price. That is the ordinary state at
 * settlement time and the menu it sits on is `locked` by then, which the
 * late-price exemption covers: the fixture carries no menu status because the
 * screen no longer needs one, only whether the row still holds NULL.
 */
function dish(over: Partial<SettlementDish> = {}): SettlementDish {
  const name = over.name ?? "Cơm tấm";
  return {
    name,
    // The real fetch folds the name the way the database folds it, and
    // reconciliation matches on that. A fixture inventing its own key would
    // pass tests the screen would fail.
    key: dishKey(name),
    ourCount: 4,
    waitingCount: 4,
    pricedTotalMinor: 0,
    menuItemIds: [101],
    unpricedMenuItemIds: [101],
    existingPricesMinor: [],
    days: ["2026-09-14"],
    cancelledDays: [],
    unpriced: true,
    ...over,
  };
}

/** A dish the board already priced, so the exemption does not reach it. */
function pricedDish(name: string, minor: number, over: Partial<SettlementDish> = {}) {
  return dish({
    name,
    waitingCount: 0,
    pricedTotalMinor: minor * (over.ourCount ?? 4),
    unpricedMenuItemIds: [],
    existingPricesMinor: [minor],
    unpriced: false,
    ...over,
  });
}

function settlementWeek(over: Partial<SettlementWeek> = {}): SettlementWeek {
  return {
    periodId: 11,
    periodStart: "2026-09-14",
    periodEnd: "2026-09-20",
    dishes: [
      dish(),
      dish({
        name: "Bún bò",
        ourCount: 3,
        waitingCount: 3,
        menuItemIds: [102],
        unpricedMenuItemIds: [102],
      }),
    ],
    unpricedOrders: 7,
    ordersWithoutDish: 0,
    ...over,
  };
}

function serve(over: Partial<PaymentsData> = {}, caterer: CatererSummary = CATERER): PaymentsData {
  const data: PaymentsData = {
    periods: [WEEK_14],
    statements: [statement(), DINH],
    unmatched: [],
    ...over,
  };
  fetchPayments.mockResolvedValue(data);
  fetchCatererSummary.mockResolvedValue(caterer);
  return data;
}

function renderPayments() {
  return render(<PaymentsScreen me={ME} org={ORG} role="admin" />);
}

/** The label and the figure are one paragraph, so the label locates the figure. */
function headline(label: string): HTMLElement {
  const node = screen.getByText(label).closest("p");
  if (node === null) throw new Error(`no headline paragraph for "${label}"`);
  return node;
}

/** The row for one person in the statements table. */
async function rowFor(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "Statements for this week" });
  const row = within(table)
    .getAllByRole("row")
    .find((r) => within(r).queryByText(name) !== null);
  if (row === undefined) throw new Error(`no statement row for ${name}`);
  return row;
}

async function openSettle(name: string): Promise<HTMLElement> {
  const row = await rowFor(name);
  await userEvent.click(within(row).getByRole("button", { name: "Record" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  db.calls.length = 0;
  db.results.length = 0;
  db.rpcCalls.length = 0;
  recordPayment.mockResolvedValue({ id: 500, amountMinor: 130_000, matchedStatementId: 1 });
  waiveStatement.mockResolvedValue(undefined);
  fetchSettlementWeek.mockResolvedValue(settlementWeek());
  applyCatererPrices.mockResolvedValue({ dishes: 0, menuItems: 0, orderItems: 0 });
  settlePeriod.mockResolvedValue({ lines: 0, statements: 0, totalMinor: 0 });
});

/* ---------------------------------------------------------- what gets written */

describe("Recording a payment, the row that reaches the database", () => {
  it("names a provider that is not the bank's, and supplies the two NOT NULL columns", async () => {
    db.results.push(
      { data: { id: 91, amount_minor: 180_000 }, error: null },
      { data: { matched_statement_id: 5 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const recorded = await record({
      orgId: 7,
      amountMinor: 180_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    });
    expect(recorded).toEqual({ id: 91, amountMinor: 180_000, matchedStatementId: 5 });

    const insert = db.calls.find((c) => c.op === "insert");
    expect(insert?.table).toBe("payments");
    const row = insert?.payload ?? {};
    // `provider` defaults to 'sepay', so an admin's own record has to overwrite
    // it or the audit trail claims the bank reported money it never saw.
    expect(row["provider"]).toBe("manual");
    expect(row["provider"]).not.toBe("sepay");
    // Both NOT NULL with no default: an insert that leaves either out fails.
    expect(row["received_at"]).toBe("2026-09-22T03:00:00.000Z");
    expect(row["raw"]).toEqual({ source: "admin", recorded_by: "admin" });
    expect(row["org_id"]).toBe(7);
    expect(row["amount_minor"]).toBe(180_000);
    expect(row["memo"]).toBe("LUNCH14TEO");
    expect(String(row["provider_txn_id"])).not.toBe("");
  });

  it("gives two cash payments on the same instant different transaction ids", async () => {
    db.results.push(
      { data: { id: 1, amount_minor: 50_000 }, error: null },
      { data: { matched_statement_id: 5 }, error: null },
      { data: { id: 2, amount_minor: 50_000 }, error: null },
      { data: { matched_statement_id: 5 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const args = {
      orgId: 7,
      amountMinor: 50_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    };
    await record(args);
    await record(args);

    const [first, second] = db.calls.filter((c) => c.op === "insert");
    // payments_provider_txn_uk is unique on (org, provider, txn), so equal ids
    // mean the second payment of the day is refused as a duplicate of the first.
    expect(first?.payload?.["provider_txn_id"]).not.toBe(second?.payload?.["provider_txn_id"]);
  });

  it("reads the match back rather than trusting the insert, because the trigger is AFTER INSERT", async () => {
    db.results.push(
      { data: { id: 91, amount_minor: 180_000 }, error: null },
      { data: { matched_statement_id: null }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const recorded = await record({
      orgId: 7,
      amountMinor: 180_000,
      memo: "NOTHING LIKE A REFERENCE",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    });

    // RETURNING is evaluated before AFTER triggers run, so the inserted row
    // always carries a null match. The second call is what tells the truth.
    const [insert, readBack] = db.calls;
    expect(insert?.op).toBe("insert");
    expect(readBack?.table).toBe("payments");
    expect(readBack?.filters).toEqual([["id", 91]]);
    expect(recorded.matchedStatementId).toBeNull();
  });

  it("points a resolved payment at the week its money turned out to belong to", async () => {
    db.results.push(
      { data: { id: 92, amount_minor: 100_000 }, error: null },
      { data: { matched_statement_id: 5 }, error: null },
      { data: null, error: null },
    );
    const { recordPayment: record } = await realApi();

    await record({
      orgId: 7,
      amountMinor: 100_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:30:00.000Z",
      resolvesPaymentId: 91,
    });

    const update = db.calls.find((c) => c.op === "update");
    expect(update?.table).toBe("payments");
    expect(update?.payload).toEqual({ matched_statement_id: 5 });
    expect(update?.filters).toEqual([
      ["id", 91],
      ["org_id", 7],
    ]);
    // The new row carries the link the other way, so the pair is legible.
    const insert = db.calls.find((c) => c.op === "insert");
    expect(insert?.payload?.["raw"]).toEqual({
      source: "admin",
      recorded_by: "admin",
      resolves_payment_id: 91,
    });
  });

  it("leaves the original alone when the new payment matched nobody either", async () => {
    db.results.push(
      { data: { id: 92, amount_minor: 100_000 }, error: null },
      { data: { matched_statement_id: null }, error: null },
    );
    const { recordPayment: record } = await realApi();

    await record({
      orgId: 7,
      amountMinor: 100_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:30:00.000Z",
      resolvesPaymentId: 91,
    });

    expect(db.calls.find((c) => c.op === "update")).toBeUndefined();
  });
});

describe("Waiving, the row that reaches the database", () => {
  it("clears paid_at, because the check constraint ties it to paid alone", async () => {
    db.results.push({ data: { id: 3 }, error: null });
    const { waiveStatement: waive } = await realApi();

    await waive({ orgId: 7, statementId: 3, waivedBy: "admin" });

    const update = db.calls.find((c) => c.op === "update");
    expect(update?.table).toBe("billing_statements");
    expect(update?.payload).toEqual({
      status: "waived",
      paid_at: null,
      marked_paid_by: "admin",
    });
    expect(update?.filters).toEqual([
      ["id", 3],
      ["org_id", 7],
    ]);
  });

  it("credits nothing: paid_minor is never in the patch", async () => {
    db.results.push({ data: { id: 3 }, error: null });
    const { waiveStatement: waive } = await realApi();
    await waive({ orgId: 7, statementId: 3, waivedBy: "admin" });
    expect(db.calls.find((c) => c.op === "update")?.payload).not.toHaveProperty("paid_minor");
  });

  it("says so when RLS refuses by matching no rows rather than by raising", async () => {
    db.results.push({ data: null, error: null });
    const { waiveStatement: waive } = await realApi();
    await expect(waive({ orgId: 7, statementId: 3, waivedBy: "admin" })).rejects.toThrow(
      /no longer be an admin/i,
    );
  });
});

describe("What the caterer is owed, from the lines and not the statements", () => {
  it("reads billing_lines, which carry no debt", async () => {
    db.results.push({
      data: [
        { service_date: "2026-09-14", description: "Cơm gà", amount_minor: 45_000 },
        { service_date: "2026-09-14", description: "Cơm gà", amount_minor: 45_000 },
        { service_date: "2026-09-15", description: "Bún bò", amount_minor: 50_000 },
      ],
      error: null,
    });
    const { fetchCatererSummary: fetchSummary } = await realApi();

    const summary = await fetchSummary({ orgId: 7, periodId: 11, periodTotalMinor: 140_000 });

    expect(db.calls[0]?.table).toBe("billing_lines");
    expect(db.calls[0]?.filters).toEqual([
      ["org_id", 7],
      ["billing_period_id", 11],
    ]);
    expect(summary.totalMinor).toBe(140_000);
    expect(summary.count).toBe(3);
    expect(summary.days.map((d) => d.serviceDate)).toEqual(["2026-09-14", "2026-09-15"]);
    expect(summary.days[0]?.dishes).toEqual([
      { description: "Cơm gà", count: 2, amountMinor: 90_000 },
    ]);
  });

  it("counts a transferred meal once, by dish, because the kitchen cooked one", async () => {
    const { summariseForCaterer: summarise } = await realApi();
    const summary = summarise(
      [
        { serviceDate: "2026-09-14", description: "Cơm gà", amountMinor: 45_000 },
        { serviceDate: "2026-09-14", description: "Cơm gà", amountMinor: 45_000 },
        { serviceDate: "2026-09-14", description: "Phở bò", amountMinor: 40_000 },
      ],
      130_000,
    );
    expect(summary.days[0]?.dishes).toEqual([
      { description: "Cơm gà", count: 2, amountMinor: 90_000 },
      { description: "Phở bò", count: 1, amountMinor: 40_000 },
    ]);
    expect(summary.days[0]?.subtotalMinor).toBe(130_000);
    expect(summary.totalMinor).toBe(130_000);
  });
});

/* ----------------------------------------------------------------- the states */

describe("Payments, loading and failure", () => {
  it("shows a skeleton rather than the word Loading", async () => {
    fetchPayments.mockReturnValue(new Promise(() => {}));
    fetchCatererSummary.mockResolvedValue(CATERER);
    renderPayments();
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("repeats the database's own sentence and offers to try again", async () => {
    fetchPayments.mockRejectedValueOnce({ message: "permission denied for table payments" });
    fetchCatererSummary.mockResolvedValue(CATERER);
    renderPayments();

    expect(await screen.findByRole("heading", { name: "Payments did not load" })).toBeInTheDocument();
    expect(screen.getByText("permission denied for table payments")).toBeInTheDocument();

    serve();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Still to collect")).toBeInTheDocument();
  });

  it("reports a failure to load the caterer's week in place, and recovers", async () => {
    serve();
    fetchCatererSummary.mockRejectedValueOnce({ message: "network down" });
    renderPayments();

    expect(
      await screen.findByRole("heading", { name: "The caterer's week did not load" }),
    ).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();

    fetchCatererSummary.mockResolvedValue(CATERER);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("table", { name: /What the caterer is owed/ }),
    ).toBeInTheDocument();
  });
});

describe("Payments, a week with nothing on it", () => {
  it("says no week has been billed rather than showing an empty table", async () => {
    serve({ periods: [], statements: [] });
    renderPayments();
    expect(
      await screen.findByRole("heading", { name: "No week has been billed yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("treats a week that has not been billed yet as news, not as an error", async () => {
    serve({ periods: [WEEK_21], statements: [] });
    renderPayments();

    expect(
      await screen.findByRole("heading", { name: "This week has not been billed yet" }),
    ).toBeInTheDocument();
    // 21 to 27 September 2026 is a Monday to Sunday week, so it ends Monday.
    expect(screen.getByText(/priced once the week ends on Monday/)).toBeInTheDocument();
    expect(screen.getByText("Still running")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payments did not load" })).not.toBeInTheDocument();
  });

  it("says nobody ate when a closed week has no statements", async () => {
    serve({ periods: [{ ...WEEK_14, lineCount: 0, totalMinor: 0 }], statements: [] }, {
      ...CATERER,
      days: [],
      count: 0,
      totalMinor: 0,
      periodTotalMinor: 0,
    });
    renderPayments();

    expect(await screen.findByRole("heading", { name: "Nobody ate this week" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No meals this week" })).toBeInTheDocument();
  });
});

describe("Payments, the week", () => {
  it("leads with what is still to collect and shows every member's row", async () => {
    serve();
    renderPayments();

    expect(await screen.findByText("Still to collect")).toBeInTheDocument();
    expect(fetchPayments).toHaveBeenCalledWith({ orgId: 7 });
    // 130.000 unpaid from Tèo plus 60.000 left of Dinh's 100.000.
    expect(headline("Still to collect")).toHaveTextContent(money(190_000));
    expect(
      screen.getByText(`${money(40_000)} received of ${money(230_000)} billed to 2 people for 5 meals.`),
    ).toBeInTheDocument();

    // Person, meals, billed, received, still to pay, status, the control.
    const teo = within(await rowFor("Tèo")).getAllByRole("cell");
    expect(teo[0]).toHaveTextContent("LUNCH14TEO");
    expect(teo[1]).toHaveTextContent("3");
    expect(teo[2]).toHaveTextContent(money(130_000));
    expect(teo[3]).toHaveTextContent(money(0));
    expect(teo[4]).toHaveTextContent(money(130_000));
    expect(teo[5]).toHaveTextContent("Unpaid");

    const dinh = within(await rowFor("Dinh")).getAllByRole("cell");
    expect(dinh[2]).toHaveTextContent(money(100_000));
    expect(dinh[3]).toHaveTextContent(money(40_000));
    expect(dinh[4]).toHaveTextContent(money(60_000));
    expect(dinh[5]).toHaveTextContent("Part paid");
  });

  it("names the week, and says why there is no later one", async () => {
    serve({ periods: [WEEK_21, WEEK_14], statements: [statement(), DINH] });
    renderPayments();

    expect(await screen.findByRole("heading", { name: "21–27 September" })).toBeInTheDocument();
    const later = screen.getByRole("button", { name: "Later week" });
    expect(later).toHaveAttribute("aria-disabled", "true");
    expect(later).toHaveAccessibleDescription("This is the newest week.");
    // A reset to where you already are is a control that does nothing.
    expect(screen.queryByRole("button", { name: "Newest week" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Earlier week" }));
    expect(await screen.findByRole("heading", { name: "14–20 September" })).toBeInTheDocument();
    expect(await rowFor("Tèo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newest week" })).toBeInTheDocument();

    const earlier = screen.getByRole("button", { name: "Earlier week" });
    expect(earlier).toHaveAttribute("aria-disabled", "true");
    expect(earlier).toHaveAccessibleDescription(/reaches back 2 weeks/);
  });

  it("says why a settled week has nothing to record against it", async () => {
    serve({
      statements: [
        statement({ paidMinor: 130_000, status: "paid", paidAt: "2026-09-22T03:00:00Z" }),
        DINH,
      ],
    });
    renderPayments();

    const teo = await rowFor("Tèo");
    const button = within(teo).getByRole("button", { name: "Record" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(/Recording more would credit money nobody owes/);
    expect(within(teo).getByText("Paid")).toBeInTheDocument();
  });

  it("says a waived week is not being asked for, and counts it as nothing to collect", async () => {
    serve({ statements: [statement({ status: "waived" }), DINH] });
    renderPayments();

    const teo = await rowFor("Tèo");
    expect(within(teo).getByText("Waived")).toBeInTheDocument();
    expect(
      within(teo).getByRole("button", { name: "Record" }),
    ).toHaveAccessibleDescription(/waived, so nobody is being asked to pay it/);
    expect(headline("Still to collect")).toHaveTextContent(money(60_000));
    expect(
      screen.getByText(`One week is waived, so ${money(130_000)} of that is not being asked for.`),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------ money that lands */

describe("Payments, money that matched nobody", () => {
  it("leads with the stray payment, with the memo exactly as the bank sent it", async () => {
    serve({ unmatched: [STRAY] });
    renderPayments();

    const list = await screen.findByRole("list", { name: "Unmatched payments" });
    const item = within(list).getAllByRole("listitem")[0];
    expect(item).toBeDefined();
    expect(within(item!).getByText(money(100_000))).toBeInTheDocument();
    // The typo is the clue, so it is shown untouched: LUNCH14TE0 with a zero.
    expect(within(item!).getByText(STRAY.memo!)).toBeInTheDocument();
    // 03:30Z is mid-morning in Ho Chi Minh City, which is the office's day.
    expect(within(item!).getByText("Arrived 22 Sept, 10:30 via sepay.")).toBeInTheDocument();
  });

  it("says what the empty list is for rather than showing nothing", async () => {
    serve();
    renderPayments();
    expect(
      await screen.findByRole("heading", { name: "Every payment found its person" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/carries nobody's reference lands here/)).toBeInTheDocument();
  });

  it("explains a payment the bank sent with no memo at all", async () => {
    serve({ unmatched: [{ ...STRAY, memo: null }] });
    renderPayments();
    expect(
      await screen.findByText("No memo at all, which is why nothing could match it."),
    ).toBeInTheDocument();
  });

  it("applies a stray payment by recording one against that person's reference", async () => {
    serve({ unmatched: [STRAY] });
    recordPayment.mockResolvedValue({ id: 500, amountMinor: 100_000, matchedStatementId: 1 });
    renderPayments();

    await userEvent.click(await screen.findByRole("button", { name: "Apply to a person" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: `Apply ${rawMoney(100_000)} to a person` }),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: /Tèo · 14–20 September/ }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    // The confirm step names the money, the person and the memo, in one sentence.
    expect(
      within(dialog).getByText(
        `Credit ${money(100_000)} to Tèo for 14–20 September, with the memo LUNCH14TEO.`,
      ),
    ).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      amountMinor: 100_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
      // The money arrived when the bank says it did, not when it was worked out.
      receivedAt: STRAY.receivedAt,
      resolvesPaymentId: 91,
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(`Recorded ${rawMoney(100_000)} from Tèo`),
    );
  });

  it("refuses to apply anything when nobody is being asked to pay", async () => {
    serve({
      unmatched: [STRAY],
      statements: [
        statement({ paidMinor: 130_000, status: "paid", paidAt: "2026-09-22T03:00:00Z" }),
      ],
    });
    renderPayments();

    await userEvent.click(await screen.findByRole("button", { name: "Apply to a person" }));
    const dialog = await screen.findByRole("dialog");
    const review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription(
      "Nobody is being asked to pay anything, so there is no week to credit.",
    );
  });
});

/* ------------------------------------------------------------- the confirm step */

describe("Payments, recording against a person", () => {
  it("pre-fills the outstanding amount and that person's reference as the memo", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    expect(
      within(dialog).getByRole("heading", { name: "Tèo · 14–20 September" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Amount received")).toHaveValue("130000");
    expect(within(dialog).getByLabelText("Memo")).toHaveValue("LUNCH14TEO");
    expect(within(dialog).getByText(`That is ${money(130_000)}.`)).toBeInTheDocument();
  });

  it("writes nothing until the confirmation is answered", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(
      within(dialog).getByText(
        `Credit ${money(130_000)} to Tèo for 14–20 September, with the memo LUNCH14TEO.`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Nothing has been written yet. This is the write.")).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();

    // Backing out of the confirmation writes nothing either.
    await userEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByLabelText("Amount received")).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      amountMinor: 130_000,
      memo: "LUNCH14TEO",
      recordedBy: "admin",
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(`Recorded ${rawMoney(130_000)} from Tèo`),
    );
    // The screen refetches, so the row it wrote is read back rather than guessed.
    await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
  });

  it("reads a typed amount through the shared parser and shows it back", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const amount = within(dialog).getByLabelText("Amount received");
    await userEvent.clear(amount);
    await userEvent.type(amount, "45k");
    expect(within(dialog).getByText(`That is ${money(45_000)}.`)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(
      within(dialog).getByText(
        `Credit ${money(45_000)} to Tèo for 14–20 September, with the memo LUNCH14TEO.`,
      ),
    ).toBeInTheDocument();
  });

  it("says why it cannot record an empty amount or an empty memo", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.clear(within(dialog).getByLabelText("Amount received"));
    let review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription("Type the amount that arrived first.");

    await userEvent.type(within(dialog).getByLabelText("Amount received"), "130000");
    await userEvent.clear(within(dialog).getByLabelText("Memo"));
    review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription(/matches nobody/);
  });

  it("warns when the memo has lost the reference that decides who is credited", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const memo = within(dialog).getByLabelText("Memo");
    await userEvent.clear(memo);
    await userEvent.type(memo, "tien com trua");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(/does not contain LUNCH14TEO, so it will not land on this week/),
    ).toBeInTheDocument();
  });

  it("accepts the reference inside a real bank memo, accents and all", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const memo = within(dialog).getByLabelText("Memo");
    await userEvent.clear(memo);
    await userEvent.type(memo, "CT DEN:lunch14teo chuyển tiền");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(within(dialog).queryByText(/does not contain LUNCH14TEO/)).not.toBeInTheDocument();
  });

  it("says the money is not credited anywhere else when it overshoots", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const amount = within(dialog).getByLabelText("Amount received");
    await userEvent.clear(amount);
    await userEvent.type(amount, "200000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(
        `That is more than the ${money(130_000)} still to pay. The extra stays on this week and is not credited to any other.`,
      ),
    ).toBeInTheDocument();
  });

  it("swaps the verb for a busy state while the write is in flight", async () => {
    serve();
    let settle: (v: api.RecordedPayment) => void = () => {};
    recordPayment.mockReturnValue(
      new Promise<api.RecordedPayment>((resolve) => {
        settle = resolve;
      }),
    );
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));

    expect(await within(dialog).findByRole("button", { name: "Recording…" })).toBeInTheDocument();
    settle({ id: 500, amountMinor: 130_000, matchedStatementId: 1 });
    await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
  });

  it("says so when the payment it just wrote landed on nobody", async () => {
    serve();
    recordPayment.mockResolvedValue({ id: 500, amountMinor: 130_000, matchedStatementId: null });
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Recorded, but the memo matched nobody"),
    );
  });
});

describe("Payments, waiving", () => {
  it("confirms, says it is not money, and writes the waiver", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    expect(
      within(dialog).getByText(/Waiving records that Tèo is not being asked to pay/),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Waive this week" }));
    expect(
      within(dialog).getByText("Stop asking Tèo for 14–20 September."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/No money is recorded and nothing is credited/)).toBeInTheDocument();
    expect(waiveStatement).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Waive" }));
    await waitFor(() => expect(waiveStatement).toHaveBeenCalledTimes(1));
    expect(waiveStatement.mock.calls[0]?.[0]).toEqual({
      orgId: 7,
      statementId: 1,
      waivedBy: "admin",
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Waived Tèo's week"));
    // Waiving is not a payment, and must never go in as one.
    expect(recordPayment).not.toHaveBeenCalled();
  });
});

describe("Payments, nothing offers an undo", () => {
  const UNDO = /undo|reverse|refund|delete|remove|unrecord|take it back/i;

  it("says a payment cannot be taken back, and offers no way to", async () => {
    serve({ unmatched: [STRAY] });
    renderPayments();
    await screen.findByText("Still to collect");

    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAccessibleName(UNDO);
    }

    const dialog = await openSettle("Tèo");
    expect(within(dialog).getByText(/cannot be taken back from this screen/)).toBeInTheDocument();
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button).not.toHaveAccessibleName(UNDO);
    }

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByText(/cannot be taken back from this screen/)).toBeInTheDocument();
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button).not.toHaveAccessibleName(UNDO);
    }
  });

  it("says a waiver cannot be put back either", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");
    await userEvent.click(within(dialog).getByRole("button", { name: "Waive this week" }));
    expect(within(dialog).getByText(/This screen cannot put it back/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- the caterer half */

describe("Payments, what the caterer is owed", () => {
  it("lists the week by day and dish, with a subtotal and a grand total", async () => {
    serve();
    renderPayments();

    const table = await screen.findByRole("table", { name: /What the caterer is owed/ });
    const rows = within(table).getAllByRole("row");
    // Header, two day rows, three dish rows, and the footer.
    expect(rows).toHaveLength(7);

    const monday = rows[1];
    expect(within(monday!).getByText(formatDay("2026-09-14"))).toBeInTheDocument();
    expect(within(monday!).getByText(money(130_000))).toBeInTheDocument();

    expect(within(rows[2]!).getByText("Cơm gà")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("2")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(money(90_000))).toBeInTheDocument();

    const footer = rows[rows.length - 1];
    expect(within(footer!).getByText("The whole week")).toBeInTheDocument();
    expect(within(footer!).getByText(money(230_000))).toBeInTheDocument();
    expect(screen.getByText("The caterer is owed")).toBeInTheDocument();
    expect(screen.getByText("5 meals across 2 days.")).toBeInTheDocument();
  });

  it("says why it is not the same number as what people owe", async () => {
    serve();
    renderPayments();
    expect(
      await screen.findByText(/nobody cooked a debt/),
    ).toBeInTheDocument();
  });

  it("excludes debt carried forward, which the statements above it include", async () => {
    // Tèo ate 130.000 of food and still owes 90.000 from the week before, so
    // his statement is 220.000 and the caterer is owed 130.000. Adding the
    // statements up to pay the caterer would overcharge by exactly the debt.
    serve({
      statements: [
        statement({ carriedInMinor: 90_000, totalDueMinor: 220_000 }),
      ],
      periods: [{ ...WEEK_14, totalMinor: 130_000, lineCount: 3 }],
    }, {
      days: [
        {
          serviceDate: "2026-09-14",
          dishes: [
            { description: "Cơm gà", count: 2, amountMinor: 90_000 },
            { description: "Phở bò", count: 1, amountMinor: 40_000 },
          ],
          count: 3,
          subtotalMinor: 130_000,
        },
      ],
      count: 3,
      totalMinor: 130_000,
      periodTotalMinor: 130_000,
    });
    renderPayments();

    await screen.findByText("Still to collect");
    // What people owe carries the debt.
    expect(screen.getByText(`${money(0)} received of ${money(220_000)} billed to 1 person for 3 meals.`)).toBeInTheDocument();
    const teo = await rowFor("Tèo");
    expect(within(teo).getByText(/includes 90.000 ₫ carried over/)).toBeInTheDocument();

    // What the caterer is owed does not.
    const table = await screen.findByRole("table", { name: /What the caterer is owed/ });
    const footer = within(table).getAllByRole("row").at(-1);
    expect(within(footer!).getByText(money(130_000))).toBeInTheDocument();
    expect(within(table).queryByText(money(220_000))).not.toBeInTheDocument();
    expect(fetchCatererSummary).toHaveBeenCalledWith({
      orgId: 7,
      periodId: 11,
      periodTotalMinor: 130_000,
    });
  });

  it("says the two totals disagree rather than silently picking one", async () => {
    serve({}, { ...CATERER, periodTotalMinor: 200_000 });
    renderPayments();

    expect(
      await screen.findByText(
        `These do not agree. The meals listed here add up to ${money(230_000)}, and this week's own recorded total is ${money(200_000)}. One of them is stale, so check before you pay.`,
      ),
    ).toBeInTheDocument();
  });
});

/* ==========================================================================
   Settling the week
   ========================================================================== */

/** The message the feature exists for, in the shape the caterer sends it. */
const CATERER_MESSAGE = "cơm tấm 50k, tuần rồi em ăn 5 phần, bún bò 60k, tổng cộng là 550k";

/** The week the settle panel works on: open, so it can still be billed. */
const OPEN = WEEK_21;

function serveSettlement(over: Partial<SettlementWeek> = {}) {
  serve({ periods: [OPEN], statements: [] }, { ...CATERER, days: [], count: 0, totalMinor: 0 });
  const week = settlementWeek({
    periodId: OPEN.periodId,
    periodStart: OPEN.periodStart,
    periodEnd: OPEN.periodEnd,
    ...over,
  });
  fetchSettlementWeek.mockResolvedValue(week);
  return week;
}

async function readTheMessage(message = CATERER_MESSAGE) {
  const box = await screen.findByLabelText("The caterer’s message");
  await userEvent.click(box);
  await userEvent.paste(message);
  await userEvent.click(screen.getByRole("button", { name: "Read the message" }));
}

/** The reconciliation row for one dish, so a count can be read off it. */
function dishRow(name: string): HTMLElement {
  const table = screen.getByRole("table", {
    name: "The caterer's message checked against the board",
  });
  const row = within(table).getByText(name).closest("tr");
  if (row === null) throw new Error(`no row for "${name}"`);
  return row;
}

describe("Applying the caterer's prices, the writes that reach the database", () => {
  it("prices every menu row, then re-fires the snapshot onto the orders", async () => {
    db.results.push(
      { data: [{ id: 101 }, { id: 111 }], error: null },
      { data: [{ id: 5001 }], error: null },
      { data: [{ id: 5002 }, { id: 5003 }], error: null },
    );
    const { applyCatererPrices: apply } = await realApi();

    const applied = await apply({
      orgId: 7,
      prices: [{ name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [101, 111] }],
    });

    expect(applied).toEqual({ dishes: 1, menuItems: 2, orderItems: 3 });

    const [priced, first, second] = db.calls;
    expect(priced).toMatchObject({
      table: "menu_items",
      op: "update",
      payload: { price_minor: 50_000 },
    });
    expect(priced?.filters).toContainEqual(["org_id", 7]);

    // The re-snapshot, and the whole reason pricing the menu is not enough.
    // `order_items_snapshot` is BEFORE UPDATE **OF menu_item_id**, so naming
    // that column is what re-fires it; writing the id back over itself is what
    // makes the write a no-op to the data.
    expect(first).toMatchObject({
      table: "order_items",
      op: "update",
      payload: { menu_item_id: 101 },
    });
    expect(first?.filters).toContainEqual(["menu_item_id", 101]);
    expect(second).toMatchObject({
      table: "order_items",
      op: "update",
      payload: { menu_item_id: 111 },
    });
    expect(second?.filters).toContainEqual(["menu_item_id", 111]);
  });

  it("does not re-snapshot when the price could not be written", async () => {
    // A locked menu is exactly this: `menu_items_frozen` refuses the dish
    // change. Going on to touch the orders would claim a price that is not
    // there.
    db.results.push({
      data: null,
      error: { message: "the menu is locked; dishes can no longer be changed" },
    });
    const { applyCatererPrices: apply } = await realApi();

    await expect(
      apply({ orgId: 7, prices: [{ name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [101] }] }),
    ).rejects.toMatchObject({ message: /the menu is locked/ });

    expect(db.calls.map((c) => c.table)).toEqual(["menu_items"]);
  });

  it("bills the week through settle_period, the only way in from a browser", async () => {
    db.results.push({ data: [{ lines: 5, statements: 2, total_minor: 380_000 }], error: null });
    const { settlePeriod: settle } = await realApi();

    expect(await settle(12)).toEqual({ lines: 5, statements: 2, totalMinor: 380_000 });
    expect(db.rpcCalls).toEqual([{ fn: "settle_period", args: { p_period_id: 12 } }]);
  });

  it("says so rather than reporting zero when the run returns nothing", async () => {
    db.results.push({ data: [], error: null });
    const { settlePeriod: settle } = await realApi();

    await expect(settle(12)).rejects.toThrow(/not billed/i);
  });
});

describe("Checking the caterer's message against the board", () => {
  it("says how many meals are waiting on a price and why the week is open", async () => {
    serveSettlement();
    renderPayments();

    expect(
      await screen.findByText(
        /7 meals this week are still waiting on a price.*held off the bill.*cannot close/s,
      ),
    ).toBeInTheDocument();
  });

  it("shows their count beside ours, each named for whose it is", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();

    const table = await screen.findByRole("table", {
      name: "The caterer's message checked against the board",
    });
    expect(within(table).getByText("Their count")).toBeInTheDocument();
    expect(within(table).getByText("Our count")).toBeInTheDocument();

    const row = dishRow("Cơm tấm");
    expect(within(row).getByText("5")).toBeInTheDocument();
    expect(within(row).getByText("4")).toBeInTheDocument();
  });

  it("makes a disagreement impossible to miss, and says which number is whose", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();

    const row = dishRow("Cơm tấm");
    expect(within(row).getByText("Counts differ")).toBeInTheDocument();
    expect(
      within(row).getByText("The caterer counted 5, the board recorded 4. Check before you pay."),
    ).toBeInTheDocument();
  });

  it("says a count is missing rather than showing nothing", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();

    const row = dishRow("Bún bò");
    expect(within(row).getByText("They did not say")).toBeInTheDocument();
    expect(within(row).getByText(/priced this without saying how many/)).toBeInTheDocument();
  });

  it("keeps a dish the caterer names that we never served", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage("cơm tấm 50k 4 phần, bún bò 60k 3 phần, phở gà 45k 2 phần");

    const row = dishRow("Phở gà");
    expect(within(row).getByText("Not on our board")).toBeInTheDocument();
    expect(within(row).getByText("Never served")).toBeInTheDocument();
  });

  it("keeps a dish we served that their message omits", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage("cơm tấm 50k 4 phần");

    const row = dishRow("Bún bò");
    expect(within(row).getByText("Not in their message")).toBeInTheDocument();
    // Twice over: the narrow layout puts the price under the dish name and the
    // wide one gives it a column. Both have to say there is not one.
    expect(within(row).getAllByText("Price to come").length).toBeGreaterThan(0);
  });

  it("keeps their arithmetic, their stated total and ours apart", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();

    expect(screen.getByText("Their prices at our counts")).toBeInTheDocument();
    // 4 x 50.000 + 3 x 60.000, the board's counts and their prices.
    expect(screen.getByText(money(380_000))).toBeInTheDocument();
    expect(screen.getByText("The total they stated")).toBeInTheDocument();
    expect(screen.getByText(money(550_000))).toBeInTheDocument();
  });
});

describe("Settling the week", () => {
  it("names every price, the meals it moves and the figure the week lands on", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();
    await userEvent.click(screen.getByRole("button", { name: "Settle the week" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 dishes get a price, across 2 menu rows.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/copied onto 7 meals already eaten, so this changes what people owe/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(new RegExp(money(380_000)))).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing has been written yet/)).toBeInTheDocument();
  });

  it("writes the prices, bills the week, and reports what the run returned", async () => {
    serveSettlement();
    applyCatererPrices.mockResolvedValue({ dishes: 2, menuItems: 2, orderItems: 7 });
    settlePeriod.mockResolvedValue({ lines: 5, statements: 2, totalMinor: 380_000 });
    renderPayments();
    await readTheMessage();
    await userEvent.click(screen.getByRole("button", { name: "Settle the week" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Settle the week" }),
    );

    await waitFor(() =>
      expect(applyCatererPrices).toHaveBeenCalledWith({
        orgId: 7,
        prices: [
          { name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [101] },
          { name: "Bún bò", priceMinor: 60_000, menuItemIds: [102] },
        ],
      }),
    );
    expect(settlePeriod).toHaveBeenCalledWith(OPEN.periodId);
    expect(success).toHaveBeenCalledWith(
      `Settled 21–27 September: priced 2 dishes onto 7 meals, and billed 5 meals into 2 statements, ${rawMoney(
        380_000,
      )}.`,
    );
  });

  /**
   * The menus of the week being settled are all `locked` by the time the
   * caterer writes -- the tick locks on cutoff -- and that is the ordinary
   * case, not an obstacle. `enforce_menu_item_frozen` exempts a price going
   * from NULL to a value, so the write is expected to go through with nothing
   * said about it.
   */
  it("prices a locked week without a word about it being locked", async () => {
    serveSettlement();
    renderPayments();
    await readTheMessage();

    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
    const settleButton = screen.getByRole("button", { name: /Settle the week/ });
    expect(settleButton).not.toHaveAttribute("aria-disabled");

    await userEvent.click(settleButton);
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Settle the week" }),
    );

    await waitFor(() => expect(applyCatererPrices).toHaveBeenCalled());
    expect(settlePeriod).toHaveBeenCalledWith(OPEN.periodId);
  });

  it("reports a dish the board already priced differently, and does not write it", async () => {
    // The exemption is NULL to a value and nothing wider, so this row cannot
    // be re-priced. Attempting it would raise and abort the dishes after it;
    // skipping it quietly would hide a disagreement about money.
    serveSettlement({
      dishes: [
        pricedDish("Cơm tấm", 45_000),
        dish({
          name: "Bún bò",
          ourCount: 3,
          waitingCount: 3,
          menuItemIds: [102],
          unpricedMenuItemIds: [102],
        }),
      ],
    });
    renderPayments();
    await readTheMessage();

    const row = dishRow("Cơm tấm");
    expect(within(row).getByText("Price already set")).toBeInTheDocument();
    expect(
      within(row).getByText(
        new RegExp(`The board already charges ${money(45_000)} for this.*nothing here changes`),
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Settle the week/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        new RegExp(`board already prices Cơm tấm at ${money(45_000)}.*says ${money(50_000)}`),
      ),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Settle the week" }));

    // Only the dish that was still waiting is written.
    await waitFor(() =>
      expect(applyCatererPrices).toHaveBeenCalledWith({
        orgId: 7,
        prices: [{ name: "Bún bò", priceMinor: 60_000, menuItemIds: [102] }],
      }),
    );
  });

  it("writes only the rows still waiting when a dish is part priced across the week", async () => {
    // Monday was priced at 45.000 before the menu locked; Tuesday never was.
    // The exemption reaches Tuesday's row and not Monday's, so the apply must
    // carry exactly one of the two ids -- handing it both would raise on
    // Monday and abort every dish after it.
    serveSettlement({
      dishes: [
        dish({
          name: "Cơm tấm",
          ourCount: 4,
          waitingCount: 1,
          pricedTotalMinor: 45_000 * 3,
          menuItemIds: [101, 111],
          unpricedMenuItemIds: [111],
          existingPricesMinor: [45_000],
          days: ["2026-09-21", "2026-09-22"],
        }),
        dish({
          name: "Bún bò",
          ourCount: 3,
          waitingCount: 3,
          menuItemIds: [102],
          unpricedMenuItemIds: [102],
        }),
      ],
    });
    renderPayments();
    await readTheMessage();

    const row = dishRow("Cơm tấm");
    expect(within(row).getByText("Price already set")).toBeInTheDocument();
    expect(
      within(row).getByText(new RegExp(`only the 1 still waiting would take ${money(50_000)}`)),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Settle the week/ }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Settle the week" }),
    );

    await waitFor(() =>
      expect(applyCatererPrices).toHaveBeenCalledWith({
        orgId: 7,
        prices: [
          { name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [111] },
          { name: "Bún bò", priceMinor: 60_000, menuItemIds: [102] },
        ],
      }),
    );
  });

  it("bills the week even when every price is already in", async () => {
    serveSettlement({
      dishes: [pricedDish("Cơm tấm", 50_000), pricedDish("Bún bò", 60_000, { ourCount: 3 })],
      unpricedOrders: 0,
    });
    renderPayments();
    await readTheMessage();

    await userEvent.click(screen.getByRole("button", { name: /Settle the week/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("No price on this week changes. This runs the billing and nothing else."),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Settle the week" }));
    await waitFor(() => expect(settlePeriod).toHaveBeenCalledWith(OPEN.periodId));
    expect(applyCatererPrices).toHaveBeenCalledWith({ orgId: 7, prices: [] });
  });

  it("counts what the week will bill from the board's own prices, not the caterer's", async () => {
    // Cơm tấm is settled at 45.000 for 4, and stays there. Bún bò takes the
    // caterer's 60.000 for 3. So 180.000 + 180.000, never 50.000 x 4.
    serveSettlement({
      dishes: [
        pricedDish("Cơm tấm", 45_000),
        dish({
          name: "Bún bò",
          ourCount: 3,
          waitingCount: 3,
          menuItemIds: [102],
          unpricedMenuItemIds: [102],
        }),
      ],
    });
    renderPayments();
    await readTheMessage();

    expect(screen.getByText("What this week will bill")).toBeInTheDocument();
    expect(screen.getByText(money(360_000))).toBeInTheDocument();
  });

  it("will not settle before the message has been read", async () => {
    serveSettlement();
    renderPayments();

    await screen.findByLabelText("The caterer’s message");
    expect(screen.queryByRole("button", { name: /Settle the week/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read the message" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
