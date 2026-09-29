import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { BillScreen } from "../src/web/components/BillScreen.js";
import * as api from "../src/web/api.js";
import * as phone from "../src/web/phone.js";
import type {
  Account,
  Bill,
  BillLine,
  BillStatement,
  BillWeek,
  UnpricedMeal,
} from "../src/web/api.js";
import { formatMoney } from "../src/shared/money.js";
import { formatDay } from "../src/shared/dates.js";
import { foldMemo } from "../src/shared/sepay.js";
import type { PaymentConfig } from "../src/shared/payment.js";
import type { Me, Org } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError`, `outstandingMinor` and
// `isSettled` stay real, because which week leads and what it says are most of
// what these tests are about.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchBill: vi.fn(),
    fetchBillLines: vi.fn(),
    fetchUnpricedMeals: vi.fn(),
  };
});

// Leaving the page is the one thing jsdom cannot do.
vi.mock("../src/web/phone.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/web/phone.js")>()),
  openUrl: vi.fn(),
}));

// jsdom has no canvas, so the drawn PNG is faked and everything around it,
// the share-or-download choice included, stays real.
vi.mock("../src/web/components/bill/shareQr.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/web/components/bill/shareQr.js")>()),
  composeQrPng: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
}));

const fetchBill = vi.mocked(api.fetchBill);
const fetchBillLines = vi.mocked(api.fetchBillLines);
const fetchUnpricedMeals = vi.mocked(api.fetchUnpricedMeals);
const success = vi.mocked(toast.success);

/* ------------------------------------------------------------------ fixture */

const ORG: Org = {
  id: 7,
  slug: "test-office",
  name: "Test Office",
  timezone: "Asia/Ho_Chi_Minh",
  currency: { code: "VND", minorUnits: 0, locale: "vi-VN" },
  defaultCutoffLocalTime: "21:00:00",
  billingWeekStartsOn: 1,
  shortCode: "TEST",
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

/**
 * The reference as the screen composes it: the office, the word, the person.
 * One string in every state, so it can be saved as a repeating transfer.
 *
 * `LUNCHNEYU` remains what the database matches on, and this still contains it
 * once a bank memo is folded to letters and digits.
 */
const REF = "TEST LUNCH NEYU";

const PAYMENT: PaymentConfig = {
  vietqr: {
    bankBin: "970415",
    accountNumber: "113366668888",
    accountName: "CONG TY ABC",
  },
  note: "Pay Chi in cash if that is easier.",
};

// Testing Library collapses whitespace in the DOM before matching, and
// `formatMoney` puts a non-breaking space before the ₫. Normalising here keeps
// the expectations written in the currency the screen actually prints.
const money = (minor: number) => formatMoney(minor, ORG.currency).replace(/\u00a0/g, " ");

function statement(over: Partial<BillStatement> = {}): BillStatement {
  const base: BillStatement = {
    id: 1,
    mealCount: 4,
    mealsMinor: 180_000,
    carriedInMinor: 0,
    totalDueMinor: 180_000,
    paidMinor: 0,
    paymentRef: "LUNCHNEYU",
    status: "unpaid",
    paidAt: null,
  };
  return { ...base, ...over };
}

/** Mon 14 to Sun 20 September 2026, so the next week opens on a Monday. */
function week(over: Partial<BillWeek> = {}): BillWeek {
  return {
    periodId: 11,
    periodStart: "2026-09-14",
    periodEnd: "2026-09-20",
    periodStatus: "closed",
    lineCount: 4,
    statement: statement(),
    ...over,
  };
}

const OPEN_WEEK: BillWeek = {
  periodId: 12,
  periodStart: "2026-09-21",
  periodEnd: "2026-09-27",
  periodStatus: "open",
  lineCount: 0,
  statement: null,
};

/**
 * The account, derived from the weeks unless a test says otherwise.
 *
 * Most of these tests are about one week and do not care about the account,
 * and an account that contradicts the weeks beside it would make them lie. So
 * it is computed the way the database computes it: charges are every
 * non-waived week's meals, credits are what has been allocated against them.
 */
function accountFor(weeks: BillWeek[]): Account {
  let charged = 0;
  let credited = 0;
  for (const w of weeks) {
    if (w.statement === null || w.statement.status === "waived") continue;
    charged += w.statement.mealsMinor;
    credited += w.statement.paidMinor;
  }
  return { chargedMinor: charged, creditedMinor: credited, balanceMinor: charged - credited };
}

function serve(over: Partial<Bill> = {}) {
  const weeks = over.weeks ?? [week()];
  const bill: Bill = {
    weeks,
    account: accountFor(weeks),
    payment: PAYMENT,
    ...over,
  };
  fetchBill.mockResolvedValue(bill);
  return bill;
}

function renderBill() {
  return render(<BillScreen me={ME} org={ORG} role="member" />);
}

/** The label and the figure are one paragraph, so the label locates the figure. */
function headline(label: string): HTMLElement {
  const node = screen.getByText(label).closest("p");
  if (node === null) throw new Error(`no headline paragraph for "${label}"`);
  return node;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBillLines.mockResolvedValue([]);
  fetchUnpricedMeals.mockResolvedValue([]);
});

/* -------------------------------------------------------------------- tests */

describe("Bill, loading and failure", () => {
  it("shows a skeleton rather than the word Loading", async () => {
    fetchBill.mockReturnValue(new Promise(() => {}));
    renderBill();
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("repeats the database's own sentence and offers to try again", async () => {
    const user = userEvent.setup();
    fetchBill.mockRejectedValueOnce({ message: "permission denied for table payments" });
    renderBill();

    expect(
      await screen.findByRole("heading", { name: "Your bill did not load" }),
    ).toBeInTheDocument();
    expect(screen.getByText("permission denied for table payments")).toBeInTheDocument();

    serve();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You owe")).toBeInTheDocument();
  });

  it("asks only for my own statements, never the whole office's", async () => {
    serve();
    renderBill();
    await screen.findByText("You owe");
    expect(fetchBill).toHaveBeenCalledWith({ orgId: 7, profileId: "me" });
  });
});

describe("Bill, nothing owed", () => {
  it("says when the open week closes instead of showing an error", async () => {
    serve({ weeks: [OPEN_WEEK] });
    renderBill();

    expect(await screen.findByText("Nothing to pay")).toBeInTheDocument();
    // 21 to 27 September 2026 is a Monday to Sunday week, so it closes Monday.
    expect(screen.getByText("This week is still open. It closes Monday.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy the amount" })).not.toBeInTheDocument();
  });

  it("explains itself to somebody who has never been billed at all", async () => {
    serve({ weeks: [] });
    renderBill();

    expect(await screen.findByText("Nothing has been billed to you yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/first bill arrives at the end of a week you eat in/i),
    ).toBeInTheDocument();
  });

  /**
   * Reported from production by a member of an office that had never billed:
   * "I still don't see any topup QR or balance in any of my screen". The
   * screen short-circuited to an empty state with no figure and no code on it,
   * so the people with the most reason to pay ahead were the only ones who
   * could not.
   */
  it("shows the account and a way to pay with no statement and no payment", async () => {
    serve({ weeks: [] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(screen.getByText("Nothing to pay")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been billed to you yet.")).toBeInTheDocument();
    // Nothing to open and nothing to reveal: the transfer block is the card.
    expect(screen.getByText(REF)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /amount up to you/ })).toBeInTheDocument();
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
  });

  it("still hands out the reference when the office has set no bank details", async () => {
    serve({ weeks: [], payment: { vietqr: null, note: null } });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });

    expect(screen.getByText(REF)).toBeInTheDocument();
    expect(screen.getByText(/has not set up bank transfer yet/i)).toBeInTheDocument();
    // No code, and no list either: every row of it would be blank.
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
  });
});

describe("Bill, unpaid", () => {
  it("leads with the account, the reference and a code carrying both", async () => {
    serve({ weeks: [OPEN_WEEK, week()] });
    renderBill();

    // The account, not a week. Leading with a week meant paying that week,
    // and somebody three weeks behind paid the newest number.
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(180_000));
    expect(screen.getByText(REF)).toBeInTheDocument();
    expect(screen.getAllByText("Unpaid").length).toBeGreaterThan(0);

    // The code is built here, so what it encodes is assertable: the amount the
    // member still owes and the reference that matches the payment back.
    const qr = screen.getByRole("img", { name: /VietQR code/ });
    expect(qr).toHaveTextContent(
      `VietQR code for ${money(180_000)} to CONG TY ABC, reference ${REF}`,
    );
    expect(screen.getByText("113366668888")).toBeInTheDocument();
    // 970415 is VietinBank. A phone that will not scan leaves somebody typing
    // the transfer in by hand, and a BIN is not something a person can type.
    expect(screen.getByText("VietinBank")).toBeInTheDocument();
    expect(screen.getByText(PAYMENT.note!)).toBeInTheDocument();
  });

  it("adds two unpaid weeks up once, rather than carrying one into the other", async () => {
    // What carry-forward used to do, done by the account instead. The old
    // model put the older week's remainder on the newer statement as well, so
    // the same debt sat on two rows and any sum over weeks counted it twice.
    serve({
      weeks: [
        week({
          periodId: 12,
          periodStart: "2026-09-21",
          periodEnd: "2026-09-27",
          statement: statement({ id: 2, mealsMinor: 180_000, totalDueMinor: 180_000 }),
        }),
        week({ statement: statement({ mealsMinor: 90_000, totalDueMinor: 90_000 }) }),
      ],
    });
    renderBill();

    expect(await screen.findByText("You owe")).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(270_000));
    expect(screen.queryByText(/received\./)).not.toBeInTheDocument();
  });

  it("says a week is in the total above rather than carried into another week", async () => {
    serve({ weeks: [week({ statement: statement({ paidMinor: 50_000 }) })] });
    renderBill();

    expect(
      await screen.findByText(`${money(130_000)} of this week is still in what you owe above.`),
    ).toBeInTheDocument();
  });

  it("shows the reference and says why there is no code when no bank is set up", async () => {
    serve({ payment: { vietqr: null, note: null } });
    renderBill();

    expect(await screen.findByText(REF)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.getByText(/has not set up bank transfer yet/i)).toBeInTheDocument();
  });

  it("says the details are wrong rather than dropping the code silently", async () => {
    serve({
      payment: { vietqr: { bankBin: "97", accountNumber: "1", accountName: "X" }, note: null },
    });
    renderBill();

    expect(await screen.findByText(/are not a valid account/i)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
  });
});

describe("Bill, partial", () => {
  it("leads with what is left and still says what was received", async () => {
    serve({
      weeks: [
        week({
          statement: statement({ paidMinor: 100_000, status: "partial" }),
        }),
      ],
    });
    renderBill();

    expect(await screen.findByText("You owe")).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(80_000));
    expect(
      screen.getByText(`${money(180_000)} billed, ${money(100_000)} received.`),
    ).toBeInTheDocument();
    expect(screen.getByText("Part paid")).toBeInTheDocument();

    // The code carries the remainder, not the original total: a second
    // transfer for the full amount is an overpayment nobody asked for.
    expect(screen.getByRole("img", { name: /VietQR code/ })).toHaveTextContent(
      `VietQR code for ${money(80_000)} to CONG TY ABC, reference ${REF}`,
    );
  });
});

describe("Bill, paid", () => {
  it("is a receipt with nothing to do on it", async () => {
    serve({
      weeks: [
        week({
          statement: statement({
            paidMinor: 180_000,
            status: "paid",
            paidAt: "2026-09-22T03:00:00Z",
          }),
        }),
      ],
    });
    renderBill();

    expect(await screen.findByText("Nothing to pay")).toBeInTheDocument();
    // The figure stays. The label says whether there is anything to do; the
    // figure says how much you have got, and it is the same number in the
    // same place in all three states.
    expect(headline("Nothing to pay")).toHaveTextContent(money(0));
    expect(screen.getByText(`${money(180_000)} billed, all of it paid.`)).toBeInTheDocument();
    // 03:00Z is mid-morning in Ho Chi Minh City, which is the office's day.
    expect(screen.getByText("Settled 22 September.")).toBeInTheDocument();
    // A static code, because the amount is the payer's to choose.
    expect(screen.getByRole("img", { name: /amount up to you/ })).toBeInTheDocument();
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
  });

  it("still says the current week is running", async () => {
    serve({
      weeks: [
        OPEN_WEEK,
        week({ statement: statement({ paidMinor: 180_000, status: "paid", paidAt: "2026-09-22T03:00:00Z" }) }),
      ],
    });
    renderBill();

    expect(await screen.findByText("Nothing to pay")).toBeInTheDocument();
    expect(
      screen.getByText("This week is still open. It closes Monday."),
    ).toBeInTheDocument();
  });

  it("treats a waived week as settled and asks for nothing", async () => {
    serve({ weeks: [week({ statement: statement({ status: "waived" }) })] });
    renderBill();

    expect(await screen.findByText("Nothing to pay")).toBeInTheDocument();
    // The meals happened; the charge did not. Nothing was billed, nothing is
    // owed, and the week below still says Waived so it is clear why.
    expect(screen.getByText("Nothing has been billed to you yet.")).toBeInTheDocument();
    expect(screen.getByText("Waived")).toBeInTheDocument();
    // The sentence moved to the week it is about: the account says only that
    // there is nothing to pay, because for the account there is not.
    expect(screen.queryByText(/An admin waived this week/)).not.toBeInTheDocument();
    expect(headline("Nothing to pay")).toHaveTextContent(money(0));
  });
});

describe("Bill, the account and the weeks", () => {
  it("leads with the account whatever the weeks are doing", async () => {
    serve({ weeks: [OPEN_WEEK, week()] });
    renderBill();

    const lead = await screen.findByRole("article");
    expect(within(lead).getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(within(lead).getByText("You owe")).toBeInTheDocument();
    // No week is singled out. Which week to lead with was the question the
    // old screen kept getting wrong, and it no longer has to answer it.
    expect(within(lead).queryByRole("heading", { name: /September/ })).not.toBeInTheDocument();
  });

  it("lists every billed week, oldest debt included", async () => {
    serve({
      weeks: [
        week({
          periodId: 12,
          periodStart: "2026-09-21",
          periodEnd: "2026-09-27",
          statement: statement({ id: 2, mealsMinor: 180_000, totalDueMinor: 180_000 }),
        }),
        week(),
      ],
    });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    expect(headline("You owe")).toHaveTextContent(money(360_000));

    const weeks = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(weeks).toHaveLength(2);
    // The ISO week leads: it is what a bank statement and the caterer's own
    // messages name, and the dates say which days that was.
    expect(
      within(weeks[0]!).getByRole("heading", { name: "Week 39, 21–27 September" }),
    ).toBeInTheDocument();
    expect(
      within(weeks[1]!).getByRole("heading", { name: "Week 38, 14–20 September" }),
    ).toBeInTheDocument();
  });

  it("shows credit rather than clamping an overpayment to nothing", async () => {
    // The whole point. `greatest(due - paid, 0)` used to turn this into a
    // zero and the money left the books.
    serve({
      weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })],
      account: { chargedMinor: 180_000, creditedMinor: 280_000, balanceMinor: -100_000 },
    });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    expect(headline("In credit")).toHaveTextContent(money(100_000));
    expect(screen.getByText("This comes off your next lunches.")).toBeInTheDocument();
    // Nothing is owed, so the code carries no amount. It is still offered:
    // somebody already in credit is the likeliest person to add to it.
    expect(screen.getByRole("img", { name: /amount up to you/ })).toBeInTheDocument();
    expect(screen.getByText(REF)).toBeInTheDocument();
  });

  it("uses the person's own reference, not the week's", async () => {
    serve({ weeks: [week()] });
    renderBill();

    // The old reference welded the ISO week into the core, `LUNCH38NEYU`, so
    // it changed every Monday and nobody could save the transfer in their
    // banking app. What is shown now names the office and the person and
    // nothing else, and still carries the core the database matches on.
    const shown = await screen.findByText(REF);
    expect(foldMemo(shown.textContent ?? "")).toContain("LUNCHNEYU");
    expect(screen.queryByText(/LUNCH\d\d/)).not.toBeInTheDocument();
  });
});

describe("Bill, past weeks", () => {
  it("says what the list will hold rather than showing nothing", async () => {
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "Your weeks" })).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("lists an older week with its own total and status", async () => {
    serve({
      weeks: [
        week(),
        week({
          periodId: 10,
          periodStart: "2026-09-07",
          periodEnd: "2026-09-13",
          statement: statement({
            id: 0,
            paymentRef: "LUNCH07NEYU",
            paidMinor: 135_000,
            mealsMinor: 135_000,
            totalDueMinor: 135_000,
            status: "paid",
            paidAt: "2026-09-15T03:00:00Z",
          }),
        }),
      ],
    });
    renderBill();

    const past = within(await screen.findByRole("list")).getAllByRole("listitem");
    // Both weeks, newest first. The list is the whole history now, not
    // "everything except the one at the top".
    expect(past).toHaveLength(2);
    expect(
      within(past[1]!).getByRole("heading", { name: "Week 37, 7–13 September" }),
    ).toBeInTheDocument();
    expect(within(past[1]!).getByText(money(135_000))).toBeInTheDocument();
    expect(within(past[1]!).getByText("Paid")).toBeInTheDocument();
  });
});

describe("Bill, the meals behind the total", () => {
  const LINES: BillLine[] = [
    {
      id: 1,
      serviceDate: "2026-09-14",
      amountMinor: 45_000,
      description: "Cơm gà",
      mine: true,
      counterpartName: null,
    },
    {
      id: 2,
      serviceDate: "2026-09-15",
      amountMinor: 50_000,
      description: "Bún bò",
      mine: true,
      counterpartName: "Tèo",
    },
    {
      id: 3,
      serviceDate: "2026-09-16",
      amountMinor: 40_000,
      description: "Phở bò",
      mine: false,
      counterpartName: "Dinh",
    },
  ];

  it("fetches nothing until asked, then names who a moved meal belongs to", async () => {
    const user = userEvent.setup();
    serve();
    fetchBillLines.mockResolvedValue(LINES);
    renderBill();

    await screen.findByText("You owe");
    expect(fetchBillLines).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Show the meals" }));
    await waitFor(() => expect(fetchBillLines).toHaveBeenCalledWith({
      orgId: 7,
      periodId: 11,
      profileId: "me",
    }));

    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    // One header row plus three lines.
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByText(formatDay("2026-09-14"))).toBeInTheDocument();
    expect(within(rows[1]!).getByText(money(45_000))).toBeInTheDocument();

    expect(within(rows[2]!).getByText("Tèo gave you this one")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(money(50_000))).toBeInTheDocument();

    // A meal you gave away stays visible, and says it is not on your total.
    expect(within(rows[3]!).getByText("You gave this one to Dinh")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Not yours to pay")).toBeInTheDocument();
    expect(within(rows[3]!).queryByText(money(40_000))).not.toBeInTheDocument();
  });

  it("closes again without refetching", async () => {
    const user = userEvent.setup();
    serve();
    fetchBillLines.mockResolvedValue(LINES);
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Show the meals" }));
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Hide the meals" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show the meals" }));
    await screen.findByRole("table");
    expect(fetchBillLines).toHaveBeenCalledTimes(1);
  });

  it("says why it cannot itemise a week that billed no meals of its own", async () => {
    serve({
      weeks: [
        week({
          lineCount: 0,
          statement: statement({
            mealCount: 0,
            mealsMinor: 0,
            carriedInMinor: 180_000,
            totalDueMinor: 180_000,
          }),
        }),
      ],
    });
    renderBill();

    const button = await screen.findByRole("button", { name: "Show the meals" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(
      "This week billed no meals of its own, so there is nothing to itemise.",
    );
  });

  it("reports a failure to load the meals in place", async () => {
    const user = userEvent.setup();
    serve();
    fetchBillLines.mockRejectedValue({ message: "network down" });
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Show the meals" }));
    expect(
      await screen.findByRole("heading", { name: "The meals did not load" }),
    ).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();

    // The failure must not be terminal: the panel is closed and reopened all
    // the time, and a message that never clears looks like a dead screen.
    fetchBillLines.mockResolvedValue(LINES);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("says the week is empty rather than showing a bare table", async () => {
    const user = userEvent.setup();
    serve();
    fetchBillLines.mockResolvedValue([]);
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Show the meals" }));
    expect(
      await screen.findByRole("heading", { name: "No meals on this week" }),
    ).toBeInTheDocument();
  });
});

/**
 * SePay syncs only transactions whose memo carries LUNCH, because the office
 * account is often also somebody's own. A transfer without the reference is
 * therefore not unmatched money an admin can go and find on the Payments
 * screen: it never reaches this app at all. The screen has to say so, or the
 * payer believes they have paid and the bill goes on saying unpaid.
 */
describe("Bill, the reference as a requirement", () => {
  const KEEP =
    "Keep this in the transfer message. Without it the payment never reaches your " +
    "account here.";

  it("says what a transfer without the reference costs", async () => {
    // "Keep", not "put": with a code filling the memo in, the mistake that
    // actually happens is typing over the reference rather than forgetting it.
    serve();
    renderBill();

    expect(await screen.findByText(REF)).toBeInTheDocument();
    expect(screen.getByText(KEEP)).toBeInTheDocument();
  });

  it("says it with no code to fill the memo in, too", async () => {
    serve({ payment: { vietqr: null, note: null } });
    renderBill();

    expect(await screen.findByText(REF)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.getByText(KEEP)).toBeInTheDocument();
  });

  it("no longer promises an admin will sort an unreferenced transfer out", async () => {
    serve();
    renderBill();
    await screen.findByText(REF);

    expect(screen.queryByText(/sort out by hand/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/waits for an admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/matched to your name/i)).not.toBeInTheDocument();
  });

  it("hands it out on a settled account too, because paying ahead needs it", async () => {
    // It used to be withheld from anybody who owed nothing, on the grounds
    // that handing somebody the means to pay what they do not owe is an
    // instruction to overpay. A top-up is not an overpayment.
    serve({
      weeks: [
        week({
          statement: statement({
            paidMinor: 180_000,
            status: "paid",
            paidAt: "2026-09-22T03:00:00Z",
          }),
        }),
      ],
    });
    renderBill();

    expect(await screen.findByText("Paid")).toBeInTheDocument();
    expect(screen.getByText(REF)).toBeInTheDocument();
    expect(screen.getByText(KEEP)).toBeInTheDocument();
  });
});

/* ==========================================================================
   The transfer block: one code, and the four fields it encodes
   ========================================================================== */

describe("Bill, what the code is for", () => {
  it("is a payment while something is owed", async () => {
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "Pay by transfer" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top up" })).not.toBeInTheDocument();
  });

  it("is a top-up once there is nothing to pay", async () => {
    // The same code under a balance of zero reads as a demand for money
    // nobody owes. It is the same transfer; what it is for has changed.
    serve({ weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "Top up" })).toBeInTheDocument();
    expect(
      screen.getByText("What you send sits on your account and comes off your next lunches."),
    ).toBeInTheDocument();
  });

  it("is a top-up for somebody already in credit, who is the likeliest to send more", async () => {
    serve({
      weeks: [week({ statement: statement({ paidMinor: 280_000, status: "paid" }) })],
    });
    renderBill();

    expect(await screen.findByText("In credit")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top up" })).toBeInTheDocument();
  });
});

describe("Bill, the amount to send", () => {
  it("shows what is owed and copies it as bare digits", async () => {
    const user = userEvent.setup();
    serve({ weeks: [week()] });
    renderBill();

    await screen.findByText("Amount");
    await user.click(screen.getByRole("button", { name: "Copy the amount" }));

    await waitFor(() => expect(success).toHaveBeenCalledWith("Amount copied"));
    // Digits only. A grouping dot in a bank's amount field is read as a
    // decimal point by some of them, and on VND that is 180 dong.
    expect(await navigator.clipboard.readText()).toBe("180000");
  });

  it("answers the top-up question in one line, under the number it is about", async () => {
    serve({ weeks: [week()] });
    renderBill();

    expect(
      await screen.findByText("Send more if you like; anything above this stays on your account."),
    ).toBeInTheDocument();
  });

  it("drops the row entirely when nothing is owed", async () => {
    // A row reading "Any amount" under a headline that already says there is
    // nothing to pay restated the headline. The list is three rows, and the
    // code below is the one that carries no figure.
    serve({ weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })] });
    renderBill();

    expect(await screen.findByText(REF)).toBeInTheDocument();
    expect(screen.queryByText("Amount")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy the amount" })).not.toBeInTheDocument();
  });

  it("puts the figure in the code, and leaves it out when there is none", async () => {
    // Scan and confirm is the common case, so the code suggests the sum. The
    // payer's own bank is where it is finally settled either way.
    serve({ weeks: [week()] });
    const { unmount } = renderBill();
    expect(await screen.findByRole("img", { name: /VietQR code/ })).toHaveTextContent(
      `VietQR code for ${money(180_000)} to CONG TY ABC, reference ${REF}`,
    );
    unmount();

    serve({ weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })] });
    renderBill();
    expect(await screen.findByRole("img", { name: /amount up to you/ })).toBeInTheDocument();
  });
});

describe("Bill, the four fields of the payload", () => {
  it("lists what the code says, in the order a transfer is filled in", async () => {
    serve({ weeks: [week()] });
    renderBill();

    await screen.findByText("Amount");
    // Amount (54), Reference (62-08), Account (38-01-01), Bank (38-01-00):
    // what you put in, then where it goes.
    const labels = ["Amount", "Reference", "Account", "Bank"];
    for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("113366668888")).toBeInTheDocument();
    // 970415 is VietinBank. A BIN is not something a person can type into a
    // banking app.
    expect(screen.getByText("VietinBank")).toBeInTheDocument();
  });

  it("copies each field and says which one it copied", async () => {
    const user = userEvent.setup();
    serve({ weeks: [week()] });
    renderBill();
    await screen.findByText("Amount");

    for (const [name, toast, value] of [
      ["Copy the reference", "Reference copied", REF],
      ["Copy the account number", "Account number copied", "113366668888"],
      ["Copy the bank", "Bank copied", "VietinBank"],
    ] as const) {
      await user.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(success).toHaveBeenCalledWith(toast));
      expect(await navigator.clipboard.readText()).toBe(value);
    }
  });

  it("shows the account name but does not offer to copy it", async () => {
    // It is not in the payload at all: NAPAS resolves it at the bank. It is
    // here to catch a mistyped BIN, which otherwise produces a code that scans
    // perfectly and pays a stranger.
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByText("CONG TY ABC")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /account name/i })).not.toBeInTheDocument();
  });

  it("keeps the office's own note under the block", async () => {
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByText(PAYMENT.note!)).toBeInTheDocument();
  });
});

describe("Bill, copying the reference", () => {
  it("puts the reference on the clipboard and says so", async () => {
    const user = userEvent.setup();
    serve();
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Copy the reference" }));
    // Named, not "Copied": four buttons on this card copy four things, and a
    // toast that does not say which one is a toast that answers nothing.
    await waitFor(() => expect(success).toHaveBeenCalledWith("Reference copied"));
    expect(await navigator.clipboard.readText()).toBe(REF);
  });

  it("stays reachable and explains itself when the browser has no clipboard", async () => {
    // A page served over plain http, or an older browser, has no Clipboard API
    // at all. The control must still be reachable and say why it cannot act.
    // Removed explicitly because an earlier `userEvent.setup()` leaves a stub
    // attached to this jsdom window.
    const stub = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      serve();
      renderBill();

      const button = await screen.findByRole("button", { name: "Copy the reference" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(
        "Your browser will not let the page copy. Select the reference and copy it by hand.",
      );
    } finally {
      if (stub) Object.defineProperty(navigator, "clipboard", stub);
    }
  });
});

/* ==========================================================================
   Meals the caterer has not priced yet
   ========================================================================== */

/**
 * The caterer prices at the weekend, so a meal eaten on Tuesday can still have
 * no price on Friday. `run_billing` leaves those orders off the bill rather
 * than billing them at nothing, which is right and, left unsaid, produces a
 * total a member cannot reconcile with their own week.
 */
function waiting(over: Partial<UnpricedMeal> = {}): UnpricedMeal {
  return { orderId: 900, serviceDate: "2026-09-16", description: "Cơm tấm", ...over };
}

describe("A week still waiting on the caterer's price", () => {
  it("says how many meals the total leaves out, and why", async () => {
    serve();
    fetchUnpricedMeals.mockResolvedValue([waiting(), waiting({ orderId: 901 })]);
    renderBill();

    expect(
      await screen.findByText(
        /2 meals are waiting on the caterer's price and are not in this total/,
      ),
    ).toBeInTheDocument();
  });

  it("reads as one meal rather than 1 meals", async () => {
    serve();
    fetchUnpricedMeals.mockResolvedValue([waiting()]);
    renderBill();

    expect(
      await screen.findByText(/1 meal is waiting on the caterer's price and is not in this total/),
    ).toBeInTheDocument();
  });

  it("says nothing at all when every meal has a price", async () => {
    serve();
    renderBill();

    await waitFor(() => expect(headline("You owe")).toHaveTextContent(money(180_000)));
    expect(screen.queryByText(/waiting on the caterer/)).not.toBeInTheDocument();
  });

  it("turns 'nothing owed yet' into the reason nothing is owed", async () => {
    serve({ weeks: [OPEN_WEEK] });
    fetchUnpricedMeals.mockResolvedValue([waiting({ serviceDate: "2026-09-22" })]);
    renderBill();

    expect(
      await screen.findByText(/1 meal you ate is waiting on the caterer's price/),
    ).toBeInTheDocument();
  });

  it("counts a waiting meal against the week it was eaten in", async () => {
    // One in the lead week, one in the week before it. The lead card must not
    // claim the older one.
    serve({ weeks: [week(), week({ periodId: 10, periodStart: "2026-09-07", periodEnd: "2026-09-13", statement: statement({ id: 2 }) })] });
    fetchUnpricedMeals.mockResolvedValue([
      waiting({ serviceDate: "2026-09-16" }),
      waiting({ orderId: 901, serviceDate: "2026-09-09" }),
    ]);
    renderBill();

    const notes = await screen.findAllByText(/waiting on the caterer's price/);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.textContent).toMatch(/^1 meal is waiting/);
    }
  });

  it("lists the waiting meals in the itemisation, with no price on them", async () => {
    serve();
    fetchUnpricedMeals.mockResolvedValue([waiting({ description: "Bún bò" })]);
    fetchBillLines.mockResolvedValue([]);
    renderBill();

    await userEvent.click(await screen.findByRole("button", { name: "Show the meals" }));

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Bún bò")).toBeInTheDocument();
    expect(within(table).getByText("Price to come")).toBeInTheDocument();
    expect(
      within(table).getByText(/Waiting on the caterer.s price, so it is not on this total/),
    ).toBeInTheDocument();
  });

  it("offers the itemisation even when the week billed no line of its own", async () => {
    serve({ weeks: [week({ lineCount: 0 })] });
    fetchUnpricedMeals.mockResolvedValue([waiting()]);
    renderBill();

    expect(await screen.findByRole("button", { name: "Show the meals" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("says it could not check rather than silently reporting none", async () => {
    serve();
    fetchUnpricedMeals.mockRejectedValue(new Error("column v_order_charges.unpriced does not exist"));
    renderBill();

    expect(
      await screen.findByText(/could not check whether any of your meals are still waiting/),
    ).toBeInTheDocument();
    // The bill itself still loaded, so it is still shown.
    expect(headline("You owe")).toHaveTextContent(money(180_000));
  });
});

describe("Bill, paying from the phone", () => {
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
  const realUserAgent = navigator.userAgent;
  const openUrl = vi.mocked(phone.openUrl);

  function onDevice(userAgent: string, share?: Pick<Navigator, "share" | "canShare">) {
    Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
    Object.defineProperty(navigator, "share", { value: share?.share, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: share?.canShare, configurable: true });
  }

  afterEach(() => {
    onDevice(realUserAgent);
    localStorage.clear();
  });

  it("offers no bank app on a desktop, and a download rather than a share", async () => {
    serve({ weeks: [week()] });
    renderBill();

    await screen.findByText("Amount");
    expect(screen.queryByRole("button", { name: /bank app/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Download QR" })).toBeInTheDocument();
  });

  it("asks which app on the first tap, remembers it, and opens it with the reference copied", async () => {
    const user = userEvent.setup();
    onDevice(ANDROID);
    serve({ weeks: [week()] });
    const { unmount } = renderBill();

    await user.click(await screen.findByRole("button", { name: "Open your bank app" }));
    const picker = await screen.findByRole("dialog", { name: "Which bank app do you pay with?" });
    await user.type(within(picker).getByLabelText("Find your bank"), "a chau");
    await user.click(within(picker).getByRole("button", { name: "ACB One, Ngân hàng TMCP Á Châu" }));

    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://dl.vietqr.io/pay?app=acb", "android"));
    const sent = openUrl.mock.calls[0]![0];
    for (const bill of ["113366668888", "970415", "180000", "TEST", "LUNCH"]) {
      expect(sent).not.toContain(bill);
    }
    expect(await navigator.clipboard.readText()).toBe(REF);
    expect(success).toHaveBeenCalledWith("Reference copied. Paste it into the transfer message.");
    expect(screen.getByRole("status")).toHaveTextContent(
      `${REF} is copied. Paste it into the transfer message.`,
    );
    expect(localStorage.getItem(phone.BANK_APP_KEY)).toBe("acb");
    unmount();

    // Next visit, one tap.
    openUrl.mockClear();
    renderBill();
    await user.click(await screen.findByRole("button", { name: "Open ACB One" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Other bank app" })).toBeInTheDocument();
  });

  it("opens iOS in the tap's own tick, and says on the bill what was copied", async () => {
    const user = userEvent.setup();
    onDevice(IPHONE);
    localStorage.setItem(phone.BANK_APP_KEY, "mb");
    serve({ weeks: [week()] });
    renderBill();

    const button = await screen.findByRole("button", { name: "Open MB Bank" });
    // Blocked while the copy is still pending, so the open cannot wait for it.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(() => new Promise<void>(() => {}));
    await user.click(button);
    expect(openUrl).toHaveBeenCalledWith("https://dl.vietqr.io/pay?app=mb", "ios");
    writeText.mockRestore();
  });

  it("says so on the bill when the reference could not be copied", async () => {
    const user = userEvent.setup();
    onDevice(IPHONE);
    localStorage.setItem(phone.BANK_APP_KEY, "mb");
    serve({ weeks: [week()] });
    renderBill();

    const button = await screen.findByRole("button", { name: "Open MB Bank" });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    await user.click(button);

    expect(await screen.findByRole("status")).toHaveTextContent(
      `The reference could not be copied. Type ${REF} into the transfer message.`,
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("does not raise the keyboard over the picker on a touch screen", async () => {
    const user = userEvent.setup();
    onDevice(ANDROID);
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(pointer: coarse)" }));
    Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true });
    try {
      serve({ weeks: [week()] });
      renderBill();

      await user.click(await screen.findByRole("button", { name: "Open your bank app" }));
      const picker = await screen.findByRole("dialog", { name: "Which bank app do you pay with?" });
      expect(within(picker).getByLabelText("Find your bank")).not.toHaveFocus();
      expect(picker).toContainElement(document.activeElement as HTMLElement);
    } finally {
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("focuses the filter where there is a keyboard anyway", async () => {
    const user = userEvent.setup();
    onDevice(ANDROID);
    serve({ weeks: [week()] });
    renderBill();

    await user.click(await screen.findByRole("button", { name: "Open your bank app" }));
    const picker = await screen.findByRole("dialog", { name: "Which bank app do you pay with?" });
    await waitFor(() => expect(within(picker).getByLabelText("Find your bank")).toHaveFocus());
  });

  it("draws no code for an office that does not bill in dong, and says why", async () => {
    serve({ weeks: [week()] });
    render(
      <BillScreen
        me={ME}
        org={{ ...ORG, currency: { code: "USD", minorUnits: 2, locale: "en-US" } }}
        role="member"
      />,
    );

    expect(
      await screen.findByText(/A VietQR code can only ask for dong, and this office bills in USD/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /QR$/ })).not.toBeInTheDocument();
    // The details still say how to pay.
    expect(screen.getByText("113366668888")).toBeInTheDocument();
    expect(screen.getByText(REF)).toBeInTheDocument();
  });

  it("does not promise a filled-in transfer", async () => {
    onDevice(IPHONE);
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByText(/will not fill the transfer in/)).toBeInTheDocument();
  });

  it("forgets a remembered app this platform's list does not carry", async () => {
    onDevice(IPHONE);
    localStorage.setItem(phone.BANK_APP_KEY, "no-such-app");
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByRole("button", { name: "Open your bank app" })).toBeInTheDocument();
  });

  it.each([
    ["settled", statement({ paidMinor: 180_000, status: "paid" })],
    ["in credit", statement({ paidMinor: 280_000, status: "paid" })],
  ])("offers no bank app to somebody %s", async (_, s) => {
    onDevice(ANDROID);
    serve({ weeks: [week({ statement: s })] });
    renderBill();

    await screen.findByText(REF);
    expect(screen.queryByRole("button", { name: /bank app/ })).not.toBeInTheDocument();
  });

  it("offers no bank app when the office bills in anything but dong", async () => {
    onDevice(ANDROID);
    serve({ weeks: [week()] });
    render(
      <BillScreen
        me={ME}
        org={{ ...ORG, currency: { code: "USD", minorUnits: 2, locale: "en-US" } }}
        role="member"
      />,
    );

    await screen.findByText("Amount");
    expect(screen.queryByRole("button", { name: /bank app/ })).not.toBeInTheDocument();
  });

  it("shares the code as a PNG, with the amount and reference in the text", async () => {
    const user = userEvent.setup();
    const share = vi.fn(async (_data: ShareData) => {});
    onDevice(IPHONE, { share, canShare: () => true });
    serve({ weeks: [week()] });
    renderBill();

    // Re-queried: the button is a new element once the image is ready.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share QR" })).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(screen.getByRole("button", { name: "Share QR" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const data = share.mock.calls[0]![0];
    expect(data.files?.[0]?.name).toMatch(/^lunch-TEST-LUNCH-NEYU-\d{4}-\d{2}-\d{2}\.png$/);
    expect(data.files?.[0]?.type).toBe("image/png");
    expect(data.text).toContain(REF);
    expect(data.text).toContain(formatMoney(180_000, ORG.currency));
    expect(success).toHaveBeenCalledWith("QR shared");
  });
});
