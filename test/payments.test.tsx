import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { PaymentsScreen } from "../src/web/components/PaymentsScreen.js";
import * as api from "../src/web/api.js";
import type {
  CatererSummary,
  PaymentsData,
  PaymentsPeriod,
  PaymentsPerson,
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
      gte: step(((column: string, value: unknown) => call.filters.push([column, value])) as never),
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
    movePayment: vi.fn(),
    voidPayment: vi.fn(),
    fetchPersonPayments: vi.fn(),
  };
});

const fetchPayments = vi.mocked(api.fetchPayments);
const fetchCatererSummary = vi.mocked(api.fetchCatererSummary);
const fetchSettlementWeek = vi.mocked(api.fetchSettlementWeek);
const applyCatererPrices = vi.mocked(api.applyCatererPrices);
const settlePeriod = vi.mocked(api.settlePeriod);
const recordPayment = vi.mocked(api.recordPayment);
const waiveStatement = vi.mocked(api.waiveStatement);
const movePayment = vi.mocked(api.movePayment);
const voidPayment = vi.mocked(api.voidPayment);
const fetchPersonPayments = vi.mocked(api.fetchPersonPayments);
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
  businessDayStartsAt: "08:30",
  businessDayEndsAt: "17:30",
};

const ME: Me = {
  profileId: "admin",
  fullName: "Chi",
  email: "chi@example.com",
  mayFoundOffice: true,
  orgs: [{ org: ORG, role: "admin", shortCode: "CHI", paymentRef: "LUNCHCHI", displayName: "Chi" }],
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
    // The week's own reference. A bill printed before
    // `money_belongs_to_a_person` still carries one and it still matches, but
    // nothing on this screen asks anybody to type it any more.
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

/**
 * The account the screen now leads with. `balance_minor` is charged less
 * credited, so a negative one is a person in credit, which is what a top-up
 * looks like once it is on the books.
 */
function person(over: Partial<PaymentsPerson> = {}): PaymentsPerson {
  return {
    profileId: "teo",
    name: "Tèo",
    shortCode: "TEO",
    paymentRef: "LUNCHTEO",
    active: true,
    account: { chargedMinor: 130_000, creditedMinor: 0, balanceMinor: 130_000 },
    ...over,
  };
}

const TEO_ACCOUNT = person();

const DINH_ACCOUNT = person({
  profileId: "dinh",
  name: "Dinh",
  shortCode: "DINH",
  paymentRef: "LUNCHDINH",
  account: { chargedMinor: 100_000, creditedMinor: 40_000, balanceMinor: 60_000 },
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
    people: [TEO_ACCOUNT, DINH_ACCOUNT],
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

/** The row for one person in the people table. */
async function rowFor(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "People, this week and what they owe" });
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
  recordPayment.mockResolvedValue({
    id: 500,
    amountMinor: 130_000,
    profileId: "teo",
    matchedStatementId: 1,
  });
  waiveStatement.mockResolvedValue(undefined);
  movePayment.mockResolvedValue({ matchedStatementId: 1 });
  voidPayment.mockResolvedValue(undefined);
  fetchPersonPayments.mockResolvedValue([]);
  fetchSettlementWeek.mockResolvedValue(settlementWeek());
  applyCatererPrices.mockResolvedValue({ dishes: 0, menuItems: 0, orderItems: 0 });
  settlePeriod.mockResolvedValue({ lines: 0, statements: 0, totalMinor: 0 });
});

/* ---------------------------------------------------------- what gets written */

describe("Recording a payment, the row that reaches the database", () => {
  it("names the person and the provider, and supplies the three NOT NULL columns", async () => {
    db.results.push(
      { data: { id: 91, amount_minor: 180_000 }, error: null },
      { data: { profile_id: "teo", matched_statement_id: 5 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const recorded = await record({
      orgId: 7,
      profileId: "teo",
      amountMinor: 180_000,
      memo: "LUNCHTEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    });
    expect(recorded).toEqual({
      id: 91,
      amountMinor: 180_000,
      profileId: "teo",
      matchedStatementId: 5,
    });

    const insert = db.calls.find((c) => c.op === "insert");
    expect(insert?.table).toBe("payments");
    const row = insert?.payload ?? {};
    // `provider` defaults to 'sepay', so an admin's own record has to overwrite
    // it or the audit trail claims the bank reported money it never saw.
    expect(row["provider"]).toBe("manual");
    expect(row["provider"]).not.toBe("sepay");
    // Whose money it is, named on the row. Without it a memo the trigger
    // cannot read leaves money belonging to nobody.
    expect(row["profile_id"]).toBe("teo");
    // Both NOT NULL with no default: an insert that leaves either out fails.
    expect(row["received_at"]).toBe("2026-09-22T03:00:00.000Z");
    expect(row["raw"]).toEqual({ source: "admin", recorded_by: "admin" });
    expect(row["org_id"]).toBe(7);
    expect(row["amount_minor"]).toBe(180_000);
    expect(row["memo"]).toBe("LUNCHTEO");
    expect(String(row["provider_txn_id"])).not.toBe("");
  });

  it("records a top-up for somebody with no statement at all", async () => {
    // No week to attach to, so `matched_statement_id` comes back null. That is
    // not a failure any more: the money sits on the account as credit.
    db.results.push(
      { data: { id: 93, amount_minor: 500_000 }, error: null },
      { data: { profile_id: "quyt", matched_statement_id: null }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const recorded = await record({
      orgId: 7,
      profileId: "quyt",
      amountMinor: 500_000,
      memo: "LUNCHQUYT",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    });

    expect(recorded.profileId).toBe("quyt");
    expect(recorded.matchedStatementId).toBeNull();
    const row = db.calls.find((c) => c.op === "insert")?.payload ?? {};
    expect(row["profile_id"]).toBe("quyt");
    expect(row["provider"]).toBe("manual");
    // The stable reference, so the trigger finds the same person the row names
    // and redraws their weeks rather than leaving the money unattached.
    expect(row["memo"]).toBe("LUNCHQUYT");
    expect(row["raw"]).toEqual({ source: "admin", recorded_by: "admin" });
  });

  it("gives two cash payments on the same instant different transaction ids", async () => {
    db.results.push(
      { data: { id: 1, amount_minor: 50_000 }, error: null },
      { data: { profile_id: "teo", matched_statement_id: 5 }, error: null },
      { data: { id: 2, amount_minor: 50_000 }, error: null },
      { data: { profile_id: "teo", matched_statement_id: 5 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const args = {
      orgId: 7,
      profileId: "teo",
      amountMinor: 50_000,
      memo: "LUNCHTEO",
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

  it("reads the owner back rather than trusting the insert, because the trigger is AFTER INSERT", async () => {
    db.results.push(
      { data: { id: 91, amount_minor: 180_000 }, error: null },
      // The memo carries Dinh's reference, and the memo is what the trigger
      // matches on, so the money went to Dinh whatever the insert said.
      { data: { profile_id: "dinh", matched_statement_id: 9 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    const recorded = await record({
      orgId: 7,
      profileId: "teo",
      amountMinor: 180_000,
      memo: "LUNCHDINH",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:00:00.000Z",
    });

    // RETURNING is evaluated before AFTER triggers run, so the inserted row
    // carries whatever was sent. The second call is what tells the truth.
    const [insert, readBack] = db.calls;
    expect(insert?.op).toBe("insert");
    expect(readBack?.table).toBe("payments");
    expect(readBack?.filters).toEqual([["id", 91]]);
    expect(recorded.profileId).toBe("dinh");
  });

  it("writes the new row and nothing else: no payment is ever updated from here", async () => {
    db.results.push(
      { data: { id: 92, amount_minor: 100_000 }, error: null },
      { data: { profile_id: "teo", matched_statement_id: 5 }, error: null },
    );
    const { recordPayment: record } = await realApi();

    await record({
      orgId: 7,
      profileId: "teo",
      amountMinor: 100_000,
      memo: "LUNCHTEO",
      recordedBy: "admin",
      receivedAt: "2026-09-22T03:30:00.000Z",
    });

    expect(db.calls.find((c) => c.op === "update")).toBeUndefined();
    expect(db.calls.find((c) => c.op === "insert")?.payload?.["raw"]).toEqual({
      source: "admin",
      recorded_by: "admin",
    });
  });
});

describe("Moving and voiding, the call that reaches the database", () => {
  it("moves the payment itself, through move_payment, and writes no row", async () => {
    db.results.push({ data: [{ payment_id: 91, profile_id: "teo", matched_statement_id: 5 }], error: null });
    const { movePayment: move } = await realApi();

    const moved = await move({ paymentId: 91, toProfileId: "teo" });

    expect(db.rpcCalls).toEqual([
      { fn: "move_payment", args: { p_payment_id: 91, p_to_profile_id: "teo", p_reason: null } },
    ]);
    expect(db.calls).toEqual([]);
    expect(moved.matchedStatementId).toBe(5);
  });

  it("voids through void_payment, with the reason trimmed", async () => {
    const { voidPayment: voidIt } = await realApi();
    await voidIt({ paymentId: 92, reason: "  typed twice " });
    expect(db.rpcCalls).toEqual([
      { fn: "void_payment", args: { p_payment_id: 92, p_reason: "typed twice" } },
    ]);
    expect(db.calls).toEqual([]);
  });

  it("surfaces the database's refusal rather than a silent success", async () => {
    db.results.push({ data: null, error: { code: "42501", message: "only an admin of this office can move a payment" } });
    const { movePayment: move } = await realApi();
    await expect(move({ paymentId: 91, toProfileId: "teo" })).rejects.toMatchObject({ code: "42501" });
  });

  it("lists a person's live payments only, and offers a void on manual ones alone", async () => {
    db.results.push({
      data: [
        { id: 1, amount_minor: 50_000, memo: "x", received_at: "2026-09-22T03:30:00Z", provider: "manual" },
        { id: 2, amount_minor: 60_000, memo: "y", received_at: "2026-09-21T03:30:00Z", provider: "sepay" },
      ],
      error: null,
    });
    const { fetchPersonPayments: list } = await realApi();
    const rows = await list({ orgId: 7, profileId: "teo" });
    expect(db.calls[0]?.filters).toContainEqual(["voided_at", null]);
    expect(rows.map((r) => [r.id, r.voidable])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

describe("Money that matched nobody, the query behind the list", () => {
  /** Periods, memberships, accounts, strays, then resolvers, then statements. */
  function serveFetch(strays: unknown[], resolvers: unknown[] = []) {
    db.results.push(
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: strays, error: null },
    );
    if (strays.length > 0) db.results.push({ data: resolvers, error: null });
  }

  const STRAY_ROW = {
    id: 91,
    amount_minor: 100_000,
    memo: "CT DEN TK 113366668888",
    received_at: "2026-09-22T03:30:00Z",
    provider: "sepay",
  };

  it("asks whose the money is, not which week it hit", async () => {
    serveFetch([]);
    const { fetchPayments: fetch } = await realApi();

    await fetch({ orgId: 7 });

    const strayQuery = db.calls.find(
      (c) => c.table === "payments" && c.filters.some(([column]) => column === "profile_id"),
    );
    // A top-up lands on a person and touches no statement, so asking
    // `matched_statement_id is null` would list every top-up as a failure.
    expect(strayQuery?.filters).toContainEqual(["profile_id", null]);
    expect(strayQuery?.filters).not.toContainEqual(["matched_statement_id", null]);
  });

  it("never lists a voided payment, and ignores a voided copy's pointer", async () => {
    serveFetch([STRAY_ROW]);
    const { fetchPayments: fetch } = await realApi();

    await fetch({ orgId: 7 });

    const strayQuery = db.calls.find(
      (c) => c.table === "payments" && c.filters.some(([column]) => column === "profile_id"),
    );
    expect(strayQuery?.filters).toContainEqual(["voided_at", null]);
    const resolverQuery = db.calls.find(
      (c) => c.table === "payments" && c.filters.some(([column]) => column === "provider"),
    );
    expect(resolverQuery?.filters).toContainEqual(["voided_at", null]);
  });

  it("retires a stray somebody applied the old way, by recording a copy", async () => {
    serveFetch(
      [STRAY_ROW],
      [{ raw: { source: "admin", recorded_by: "admin", resolves_payment_id: 91 } }],
    );
    const { fetchPayments: fetch } = await realApi();

    const data = await fetch({ orgId: 7 });

    // The stray keeps its null profile for good: the money went in as a second
    // row. What takes it off the list is the pointer that row carries.
    expect(data.unmatched).toEqual([]);
  });

  it("keeps a stray nobody has dealt with", async () => {
    serveFetch([STRAY_ROW], [{ raw: { source: "admin", recorded_by: "admin" } }]);
    const { fetchPayments: fetch } = await realApi();

    const data = await fetch({ orgId: 7 });

    expect(data.unmatched).toEqual([
      {
        id: 91,
        amountMinor: 100_000,
        memo: STRAY_ROW.memo,
        receivedAt: STRAY_ROW.received_at,
        provider: "sepay",
      },
    ]);
  });
});

describe("Waiving, the call that reaches the database", () => {
  it("goes through waive_statement and touches no table", async () => {
    const { waiveStatement: waive } = await realApi();

    await waive({ statementId: 3 });

    expect(db.rpcCalls).toEqual([
      { fn: "waive_statement", args: { p_statement_id: 3, p_reason: null } },
    ]);
    expect(db.calls).toEqual([]);
  });

  it("surfaces the database's refusal", async () => {
    db.results.push({ data: null, error: { code: "42501", message: "only an admin of this office can waive a week" } });
    const { waiveStatement: waive } = await realApi();
    await expect(waive({ statementId: 3 })).rejects.toMatchObject({ code: "42501" });
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
    // Nobody can owe anything before a week has been billed, so there is no
    // account worth a row either.
    serve({
      periods: [],
      statements: [],
      people: [person({ account: { chargedMinor: 0, creditedMinor: 0, balanceMinor: 0 } })],
    });
    renderPayments();
    expect(
      await screen.findByRole("heading", { name: "No week has been billed yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a top-up taken before the first week was ever billed", async () => {
    serve({
      periods: [],
      statements: [],
      people: [
        person({ account: { chargedMinor: 0, creditedMinor: 500_000, balanceMinor: -500_000 } }),
      ],
    });
    renderPayments();

    const row = await rowFor("Tèo");
    expect(within(row).getByText("In credit")).toBeInTheDocument();
    expect(within(row).getAllByRole("cell")[3]).toHaveTextContent(money(500_000));
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
    // The caterer's half arrives on its own query, so it is awaited too.
    expect(
      await screen.findByRole("heading", { name: "No meals this week" }),
    ).toBeInTheDocument();
  });
});

describe("Payments, the week", () => {
  it("leads with what every account owes, and shows the week beside it", async () => {
    serve();
    renderPayments();

    expect(await screen.findByText("Still to collect")).toBeInTheDocument();
    expect(fetchPayments).toHaveBeenCalledWith({ orgId: 7 });
    // The accounts, not the week: 130.000 from Tèo and 60.000 from Dinh.
    expect(headline("Still to collect")).toHaveTextContent(money(190_000));
    expect(
      screen.getByText("Across every week, not only this one, from 2 people."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${money(230_000)} billed this week to 2 people for 5 meals.`),
    ).toBeInTheDocument();

    // Person, meals, billed this week, account, status, the control.
    const teo = within(await rowFor("Tèo")).getAllByRole("cell");
    // The stable reference, not the week's: it is what a saved transfer carries.
    expect(teo[0]).toHaveTextContent("LUNCHTEO");
    expect(teo[0]).not.toHaveTextContent("LUNCH14TEO");
    expect(teo[1]).toHaveTextContent("3");
    expect(teo[2]).toHaveTextContent(money(130_000));
    expect(teo[3]).toHaveTextContent(money(130_000));
    expect(teo[4]).toHaveTextContent("Unpaid");

    const dinh = within(await rowFor("Dinh")).getAllByRole("cell");
    expect(dinh[2]).toHaveTextContent(money(100_000));
    expect(dinh[3]).toHaveTextContent(money(60_000));
    expect(dinh[4]).toHaveTextContent("Unpaid");
  });

  it("keeps somebody who is behind but did not eat this week", async () => {
    // Their debt is in the figure at the top, so it has to be explainable by
    // a row underneath it. Before the account existed there was no such row.
    serve({
      statements: [DINH],
      people: [
        TEO_ACCOUNT,
        DINH_ACCOUNT,
      ],
    });
    renderPayments();

    const teo = within(await rowFor("Tèo")).getAllByRole("cell");
    expect(teo[1]).toHaveTextContent("0");
    expect(teo[2]).toHaveTextContent(money(0));
    expect(teo[3]).toHaveTextContent(money(130_000));
    expect(teo[4]).toHaveTextContent("Unpaid");
    expect(headline("Still to collect")).toHaveTextContent(money(190_000));
  });

  it("shows somebody in credit as in credit, never as a zero", async () => {
    const quyt = person({
      profileId: "quyt",
      name: "Quýt",
      shortCode: "QUYT",
      paymentRef: "LUNCHQUYT",
      account: { chargedMinor: 0, creditedMinor: 500_000, balanceMinor: -500_000 },
    });
    serve({ statements: [], people: [quyt] });
    renderPayments();

    const row = await rowFor("Quýt");
    const cells = within(row).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(money(500_000));
    expect(cells[3]).toHaveTextContent("in credit");
    expect(within(row).getByText("In credit")).toBeInTheDocument();
    expect(within(row).queryByText("Settled")).not.toBeInTheDocument();

    expect(headline("Still to collect")).toHaveTextContent(money(0));
    expect(screen.getByText("Nobody owes anything.")).toBeInTheDocument();
    expect(
      screen.getByText(
        `1 person paid ahead: ${money(500_000)} sits as credit and comes off their next lunches.`,
      ),
    ).toBeInTheDocument();
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

  it("still offers to record against a settled account, because that is a top-up", async () => {
    serve({
      statements: [
        statement({ paidMinor: 130_000, status: "paid", paidAt: "2026-09-22T03:00:00Z" }),
        DINH,
      ],
      people: [
        person({ account: { chargedMinor: 130_000, creditedMinor: 130_000, balanceMinor: 0 } }),
        DINH_ACCOUNT,
      ],
    });
    renderPayments();

    const teo = await rowFor("Tèo");
    expect(within(teo).getByText("Settled")).toBeInTheDocument();
    // Money above what somebody owes is no longer destroyed, so refusing it is
    // no longer a kindness.
    expect(within(teo).getByRole("button", { name: "Record" })).not.toHaveAttribute(
      "aria-disabled",
    );

    const dialog = await openSettle("Tèo");
    expect(
      within(dialog).getByText(
        "Nothing outstanding. Anything recorded here is a top-up against their next lunches.",
      ),
    ).toBeInTheDocument();
  });

  it("says a waived week is not being asked for, and takes it off the account", async () => {
    // `v_account_balance` leaves a waived statement out of `charged_minor`, so
    // the account says nothing is owed and the week says why.
    serve({
      statements: [statement({ status: "waived" }), DINH],
      people: [
        person({ account: { chargedMinor: 0, creditedMinor: 0, balanceMinor: 0 } }),
        DINH_ACCOUNT,
      ],
    });
    renderPayments();

    const teo = await rowFor("Tèo");
    expect(within(teo).getByText("Week waived")).toBeInTheDocument();
    expect(within(teo).getByText("Settled")).toBeInTheDocument();
    expect(headline("Still to collect")).toHaveTextContent(money(60_000));
    expect(
      screen.getByText(
        `One person's week is waived, so ${money(130_000)} of this week is not being asked for.`,
      ),
    ).toBeInTheDocument();

    const dialog = await openSettle("Tèo");
    expect(
      within(dialog).getByRole("button", { name: "Waive this week" }),
    ).toHaveAccessibleDescription("This week is already waived.");
  });

  it("says why there is no week to waive for somebody who did not eat", async () => {
    serve({ statements: [DINH] });
    renderPayments();

    const dialog = await openSettle("Tèo");
    expect(
      within(dialog).getByRole("button", { name: "Waive this week" }),
    ).toHaveAccessibleDescription(/no statement for 14–20 September/);
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

  it("applies a stray payment to a person by moving that payment", async () => {
    serve({ unmatched: [STRAY] });
    renderPayments();

    await userEvent.click(await screen.findByRole("button", { name: "Apply to a person" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: `Apply ${rawMoney(100_000)} to a person` }),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: `Tèo · owes ${rawMoney(130_000)}` }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(`Put ${money(100_000)} on Tèo's account.`),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Tèo would still owe ${money(30_000)}.`),
    ).toBeInTheDocument();
    expect(movePayment).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(movePayment).toHaveBeenCalledTimes(1));
    // The stray itself moves: no second payment is recorded for it.
    expect(movePayment.mock.calls[0]?.[0]).toEqual({ paymentId: 91, toProfileId: "teo" });
    expect(recordPayment).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(`Applied ${rawMoney(100_000)} to Tèo`),
    );
  });

  it("applies stray money to somebody who owes nothing, as a top-up", async () => {
    // It used to refuse: there was no unsettled week to credit, so the money
    // had nowhere to go. A credit is a negative balance now.
    const quyt = person({
      profileId: "quyt",
      name: "Quýt",
      shortCode: "QUYT",
      paymentRef: "LUNCHQUYT",
      account: { chargedMinor: 0, creditedMinor: 0, balanceMinor: 0 },
    });
    serve({ unmatched: [STRAY], statements: [], people: [quyt] });
    movePayment.mockResolvedValue({ matchedStatementId: null });
    renderPayments();

    await userEvent.click(await screen.findByRole("button", { name: "Apply to a person" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Quýt · nothing outstanding" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(
        "Quýt owes nothing, so all of it sits as credit and comes off their next lunches.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(movePayment).toHaveBeenCalledTimes(1));
    expect(movePayment.mock.calls[0]?.[0]).toEqual({ paymentId: 91, toProfileId: "quyt" });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(`Applied ${rawMoney(100_000)} to Quýt`),
    );
  });

  it("says nothing can be applied when nobody has joined yet", async () => {
    serve({ unmatched: [STRAY], statements: [], people: [] });
    renderPayments();

    await userEvent.click(await screen.findByRole("button", { name: "Apply to a person" }));
    const dialog = await screen.findByRole("dialog");
    const review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription(
      "Nobody has joined this office yet, so there is nobody to credit.",
    );
  });
});

/* ------------------------------------------------------------------ top-ups */

describe("Payments, a top-up", () => {
  const QUYT = person({
    profileId: "quyt",
    name: "Quýt",
    shortCode: "QUYT",
    paymentRef: "LUNCHQUYT",
    account: { chargedMinor: 0, creditedMinor: 0, balanceMinor: 0 },
  });

  async function openTopUp(): Promise<HTMLElement> {
    await userEvent.click(await screen.findByRole("button", { name: "Record a top-up" }));
    return screen.findByRole("dialog");
  }

  it("records money from somebody with nothing outstanding", async () => {
    serve({ statements: [], people: [QUYT] });
    recordPayment.mockResolvedValue({
      id: 501,
      amountMinor: 500_000,
      profileId: "quyt",
      matchedStatementId: null,
    });
    renderPayments();

    const dialog = await openTopUp();
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Quýt · nothing outstanding" }));

    // The reference is filled in with the person, because it is what the
    // database matches on.
    expect(within(dialog).getByLabelText("Memo")).toHaveValue("LUNCHQUYT");
    await userEvent.type(within(dialog).getByLabelText("Amount received"), "500k");
    expect(within(dialog).getByText(`That is ${money(500_000)}.`)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(
      within(dialog).getByText(`Credit ${money(500_000)} to Quýt, with the memo LUNCHQUYT.`),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Quýt owes nothing, so all of it sits as credit and comes off their next lunches.",
      ),
    ).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Record the top-up" }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    expect(recordPayment.mock.calls[0]?.[0]).toMatchObject({
      orgId: 7,
      profileId: "quyt",
      amountMinor: 500_000,
      memo: "LUNCHQUYT",
      recordedBy: "admin",
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        `Recorded a top-up of ${rawMoney(500_000)} from Quýt`,
      ),
    );
    await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
  });

  it("will not write until a person and an amount are both named", async () => {
    serve({ statements: [], people: [QUYT] });
    renderPayments();

    const dialog = await openTopUp();
    let review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription("Choose whose money this is first.");

    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Quýt · nothing outstanding" }));
    review = within(dialog).getByRole("button", { name: "Review" });
    expect(review).toHaveAttribute("aria-disabled", "true");
    expect(review).toHaveAccessibleDescription("Type the amount that arrived first.");
  });

  it("is offered even before the office has billed a week", async () => {
    serve({ periods: [], statements: [], people: [QUYT] });
    renderPayments();

    expect(
      await screen.findByRole("heading", { name: "No week has been billed yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record a top-up" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("says why it cannot be offered when nobody has joined", async () => {
    serve({ periods: [], statements: [], people: [] });
    renderPayments();

    const button = await screen.findByRole("button", { name: "Record a top-up" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Nobody has joined this office yet.");
  });

  it("does not offer to top up somebody who has left", async () => {
    serve({
      statements: [],
      people: [QUYT, person({ profileId: "gone", name: "Cũ", shortCode: "CU", active: false })],
    });
    renderPayments();

    const dialog = await openTopUp();
    await userEvent.click(within(dialog).getByRole("combobox"));
    expect(await screen.findByRole("option", { name: /Quýt/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Cũ/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- the confirm step */

describe("Payments, recording against a person", () => {
  it("pre-fills what the account owes and that person's stable reference", async () => {
    // The account, not the week. Somebody three weeks behind used to be asked
    // for the newest week alone, which is what carry-forward papered over.
    serve({
      statements: [statement()],
      people: [
        person({ account: { chargedMinor: 220_000, creditedMinor: 30_000, balanceMinor: 190_000 } }),
      ],
    });
    renderPayments();
    const dialog = await openSettle("Tèo");

    expect(within(dialog).getByRole("heading", { name: "Tèo" })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        `Owes ${money(190_000)}. That is every week they have eaten, not only this one.`,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Amount received")).toHaveValue("190000");
    expect(within(dialog).getByLabelText("Memo")).toHaveValue("LUNCHTEO");
    expect(within(dialog).getByText(`That is ${money(190_000)}.`)).toBeInTheDocument();
  });

  it("writes nothing until the confirmation is answered", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(
      within(dialog).getByText(`Credit ${money(130_000)} to Tèo, with the memo LUNCHTEO.`),
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
      profileId: "teo",
      amountMinor: 130_000,
      memo: "LUNCHTEO",
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
      within(dialog).getByText(`Credit ${money(45_000)} to Tèo, with the memo LUNCHTEO.`),
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

  it("says what a memo without the reference does, and does not refuse it", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const memo = within(dialog).getByLabelText("Memo");
    await userEvent.clear(memo);
    await userEvent.type(memo, "tien com trua");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    // The row names Tèo, so the money is his either way. What the memo can
    // still do is hand it to somebody else, which is worth saying.
    expect(
      within(dialog).getByText(
        /does not contain LUNCHTEO. The money is recorded as Tèo's either way/,
      ),
    ).toBeInTheDocument();
  });

  it("accepts the reference inside a real bank memo, accents and all", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const memo = within(dialog).getByLabelText("Memo");
    await userEvent.clear(memo);
    await userEvent.type(memo, "CT DEN:lunchteo chuyển tiền");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(within(dialog).queryByText(/does not contain LUNCHTEO/)).not.toBeInTheDocument();
  });

  it("says the extra becomes credit rather than disappearing", async () => {
    // It used to be destroyed: `greatest(due - paid, 0)` turned every
    // overpayment into a zero, so the screen had to warn about it. It is
    // credit now, and the sentence says so.
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const amount = within(dialog).getByLabelText("Amount received");
    await userEvent.clear(amount);
    await userEvent.type(amount, "200000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(
        `That settles Tèo's account, and the last ${money(70_000)} sits as credit against their next lunches.`,
      ),
    ).toBeInTheDocument();
  });

  it("says when the money leaves the account short", async () => {
    serve();
    renderPayments();
    const dialog = await openSettle("Tèo");

    const amount = within(dialog).getByLabelText("Amount received");
    await userEvent.clear(amount);
    await userEvent.type(amount, "30000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

    expect(
      within(dialog).getByText(`Tèo would still owe ${money(100_000)}.`),
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
    settle({ id: 500, amountMinor: 130_000, profileId: "teo", matchedStatementId: 1 });
    await waitFor(() => expect(fetchPayments).toHaveBeenCalledTimes(2));
  });

  it("says so when the memo handed the money to somebody else", async () => {
    // The insert names the person, but the trigger matches on the memo and
    // overrules it. That is silent in the database and it is about money.
    serve();
    recordPayment.mockResolvedValue({
      id: 500,
      amountMinor: 130_000,
      profileId: "dinh",
      matchedStatementId: 2,
    });
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        `Recorded ${rawMoney(130_000)}, but the memo did not put it on Tèo`,
      ),
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
    expect(
      within(dialog).getByText(/No money is recorded and nothing is credited/),
    ).toBeInTheDocument();
    expect(waiveStatement).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Waive" }));
    await waitFor(() => expect(waiveStatement).toHaveBeenCalledTimes(1));
    expect(waiveStatement.mock.calls[0]?.[0]).toEqual({ statementId: 1 });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Waived Tèo's week"));
    // Waiving is not a payment, and must never go in as one.
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("says the week is gone and reloads the list when a re-bill deleted it", async () => {
    serve();
    const message = "that week has nothing on it any more, so there is nothing to waive";
    waiveStatement.mockRejectedValue({ code: "P0002", message });
    renderPayments();
    const dialog = await openSettle("Tèo");
    const loadsBefore = fetchPayments.mock.calls.length;

    await userEvent.click(within(dialog).getByRole("button", { name: "Waive this week" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Waive" }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(message));
    await waitFor(() => expect(fetchPayments.mock.calls.length).toBeGreaterThan(loadsBefore));
    expect(success).not.toHaveBeenCalledWith("Waived Tèo's week");
  });
});

describe("Payments, putting a mistake right", () => {
  const CASH = {
    id: 700,
    amountMinor: 50_000,
    memo: "cash",
    receivedAt: "2026-09-22T03:30:00Z",
    provider: "manual",
    voidable: true,
  };
  const BANK = { ...CASH, id: 701, provider: "sepay", voidable: false };

  it("lists what is on the person's account, and offers a void on money recorded by hand only", async () => {
    serve();
    fetchPersonPayments.mockResolvedValue([CASH, BANK]);
    renderPayments();
    const dialog = await openSettle("Tèo");

    const list = await within(dialog).findByRole("list", { name: "Payments on Tèo's account" });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0] as HTMLElement).getByRole("button", { name: "Void" })).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByRole("button", { name: "Void" })).toBeNull();
    expect(within(items[1] as HTMLElement).getByRole("button", { name: "Move" })).toBeInTheDocument();
  });

  it("voids only once a reason is given, and says it stays on the record", async () => {
    serve();
    fetchPersonPayments.mockResolvedValue([CASH]);
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(await within(dialog).findByRole("button", { name: "Void" }));
    expect(within(dialog).getByText(/stays on the record, marked void/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Void" });
    expect(confirm).toHaveAccessibleDescription("Say why it is being voided.");

    await userEvent.type(within(dialog).getByLabelText("Why"), "Recorded twice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Void" }));
    await waitFor(() =>
      expect(voidPayment).toHaveBeenCalledWith({ paymentId: 700, reason: "Recorded twice" }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith(`Voided ${rawMoney(50_000)}`));
  });

  it("moves a payment to somebody else, never offering the person it is on", async () => {
    serve();
    fetchPersonPayments.mockResolvedValue([BANK]);
    renderPayments();
    const settle = await openSettle("Tèo");

    await userEvent.click(await within(settle).findByRole("button", { name: "Move" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: `Move ${rawMoney(50_000)} off Tèo` }),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("combobox"));
    expect(screen.queryByRole("option", { name: /^Tèo/ })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: /^Dinh/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByText(`Move ${money(50_000)} from Tèo to Dinh.`)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(movePayment).toHaveBeenCalledWith({ paymentId: 701, toProfileId: "dinh" }),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(`Moved ${rawMoney(50_000)} from Tèo to Dinh`),
    );
  });

  const MOVED = "that payment was moved by somebody else just now; reload and try again";

  it("closes the move and reloads the list when somebody else moved the payment first", async () => {
    serve();
    fetchPersonPayments.mockResolvedValue([BANK]);
    movePayment.mockRejectedValue({ code: "55000", message: MOVED });
    renderPayments();
    const settle = await openSettle("Tèo");

    await userEvent.click(await within(settle).findByRole("button", { name: "Move" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: /^Dinh/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    const loadsBefore = fetchPayments.mock.calls.length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(MOVED));
    await waitFor(() => expect(fetchPayments.mock.calls.length).toBeGreaterThan(loadsBefore));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reloads the list and the person's payments when a void is refused", async () => {
    serve();
    fetchPersonPayments.mockResolvedValue([CASH]);
    voidPayment.mockRejectedValue({ code: "55000", message: MOVED });
    renderPayments();
    const dialog = await openSettle("Tèo");

    await userEvent.click(await within(dialog).findByRole("button", { name: "Void" }));
    await userEvent.type(within(dialog).getByLabelText("Why"), "Recorded twice");
    const loadsBefore = fetchPayments.mock.calls.length;
    const personLoadsBefore = fetchPersonPayments.mock.calls.length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Void" }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(MOVED));
    await waitFor(() => expect(fetchPayments.mock.calls.length).toBeGreaterThan(loadsBefore));
    await waitFor(() =>
      expect(fetchPersonPayments.mock.calls.length).toBeGreaterThan(personLoadsBefore),
    );
    expect(success).not.toHaveBeenCalledWith(`Voided ${rawMoney(50_000)}`);
  });
});

describe("Payments, nothing offers an undo", () => {
  const UNDO = /undo|reverse|refund|delete|remove|unrecord|take it back/i;

  it("says a payment cannot be edited, and offers no way to erase one", async () => {
    serve({ unmatched: [STRAY] });
    renderPayments();
    await screen.findByText("Still to collect");

    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAccessibleName(UNDO);
    }

    const dialog = await openSettle("Tèo");
    expect(within(dialog).getByText(/cannot be edited/)).toBeInTheDocument();
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button).not.toHaveAccessibleName(UNDO);
    }

    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(within(dialog).getByText(/cannot be edited/)).toBeInTheDocument();
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

  it("is the week's food, while what people owe is every week they have eaten", async () => {
    // Tèo ate 130.000 of food this week and still owes 90.000 from the week
    // before. The caterer is owed 130.000 and Tèo owes 220.000, and neither
    // figure is a mistake: paying the caterer the sum of the accounts would
    // hand them a debt nobody cooked.
    serve({
      statements: [statement()],
      people: [
        person({ account: { chargedMinor: 220_000, creditedMinor: 0, balanceMinor: 220_000 } }),
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
    // The account carries every week.
    expect(headline("Still to collect")).toHaveTextContent(money(220_000));
    expect(
      screen.getByText(`${money(130_000)} billed this week to 1 person for 3 meals.`),
    ).toBeInTheDocument();
    const teo = within(await rowFor("Tèo")).getAllByRole("cell");
    expect(teo[2]).toHaveTextContent(money(130_000));
    expect(teo[3]).toHaveTextContent(money(220_000));

    // What the caterer is owed carries one week and no debt at all.
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
  it("sends every dish in one call, so the week is priced whole or not at all", async () => {
    db.results.push({ data: [{ dishes: 2, menu_items: 3, order_items: 7 }], error: null });
    const { applyCatererPrices: apply } = await realApi();

    const applied = await apply({
      orgId: 7,
      prices: [
        { name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [101, 111] },
        { name: "Phở", priceMinor: 45_000, menuItemIds: [102] },
      ],
    });

    expect(applied).toEqual({ dishes: 2, menuItems: 3, orderItems: 7 });
    // One transaction, not a request per dish and per menu row: a refusal part
    // way used to leave some dishes priced and the rest not.
    expect(db.calls).toEqual([]);
    expect(db.rpcCalls).toEqual([{
      fn: "apply_caterer_prices",
      args: {
        p_org_id: 7,
        p_prices: [
          { price_minor: 50_000, menu_item_ids: [101, 111] },
          { price_minor: 45_000, menu_item_ids: [102] },
        ],
      },
    }]);
  });

  it("passes the database's refusal on, having written nothing itself", async () => {
    db.results.push({
      data: null,
      error: { message: "the menu is locked; dishes can no longer be changed" },
    });
    const { applyCatererPrices: apply } = await realApi();

    await expect(
      apply({ orgId: 7, prices: [{ name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [101] }] }),
    ).rejects.toMatchObject({ message: /the menu is locked/ });

    expect(db.calls).toEqual([]);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["apply_caterer_prices"]);
  });

  it("makes no call when there is nothing unpriced to write", async () => {
    const { applyCatererPrices: apply } = await realApi();

    expect(
      await apply({ orgId: 7, prices: [{ name: "Cơm tấm", priceMinor: 50_000, menuItemIds: [] }] }),
    ).toEqual({ dishes: 0, menuItems: 0, orderItems: 0 });
    expect(db.rpcCalls).toEqual([]);
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
