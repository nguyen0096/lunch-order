import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { BillScreen } from "../src/web/components/BillScreen.js";
import * as api from "../src/web/api.js";
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
  businessDayStartsAt: "08:30",
  businessDayEndsAt: "17:30",
};

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" }],
};

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

    expect(await screen.findByRole("heading", { name: "Nothing owed yet" })).toBeInTheDocument();
    // 21 to 27 September 2026 is a Monday to Sunday week, so it closes Monday.
    expect(screen.getByText("This week closes Monday.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("explains itself to somebody who has never been billed at all", async () => {
    serve({ weeks: [] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "Nothing owed yet" })).toBeInTheDocument();
    expect(screen.getByText(/first bill arrives at the end of a week you eat in/i)).toBeInTheDocument();
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
    expect(screen.getByText("LUNCHNEYU")).toBeInTheDocument();
    expect(screen.getAllByText("Unpaid").length).toBeGreaterThan(0);

    // The code is built here, so what it encodes is assertable: the amount the
    // member still owes and the reference that matches the payment back.
    const qr = screen.getByRole("img", { name: /VietQR code/ });
    expect(qr).toHaveTextContent(
      `VietQR code for ${money(180_000)} to CONG TY ABC, reference LUNCHNEYU`,
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
    expect(screen.getByText(/Across 2 weeks/)).toBeInTheDocument();
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

    expect(await screen.findByText("LUNCHNEYU")).toBeInTheDocument();
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
      screen.getByText(`4 meals billed, ${money(100_000)} received.`),
    ).toBeInTheDocument();
    expect(screen.getByText("Part paid")).toBeInTheDocument();

    // The code carries the remainder, not the original total: a second
    // transfer for the full amount is an overpayment nobody asked for.
    expect(screen.getByRole("img", { name: /VietQR code/ })).toHaveTextContent(
      `VietQR code for ${money(80_000)} to CONG TY ABC, reference LUNCHNEYU`,
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
    expect(headline("Nothing to pay")).toHaveTextContent(money(0));
    expect(screen.getByText("4 meals, all settled.")).toBeInTheDocument();
    // 03:00Z is mid-morning in Ho Chi Minh City, which is the office's day.
    expect(screen.getByText("Settled 22 September.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByText("LUNCHNEYU")).not.toBeInTheDocument();
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
    expect(headline("Nothing to pay")).toHaveTextContent(money(0));
    // The meals happened; the charge did not. Nothing to pay, and the week
    // below still says Waived so it is clear why.
    expect(screen.getByText("4 meals, all settled.")).toBeInTheDocument();
    expect(screen.getByText("Waived")).toBeInTheDocument();
    // The sentence moved to the week it is about: the account says only that
    // there is nothing to pay, because for the account there is not.
    expect(screen.queryByText(/An admin waived this week/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
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
    expect(within(weeks[0]!).getByRole("heading", { name: "21–27 September" })).toBeInTheDocument();
    expect(within(weeks[1]!).getByRole("heading", { name: "14–20 September" })).toBeInTheDocument();
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
    const card = screen.getByRole("article");
    expect(within(card).getAllByText("In credit")).toHaveLength(2); // badge and label
    expect(
      within(card).getAllByText("In credit").map((n) => n.closest("p")).find(Boolean),
    ).toHaveTextContent(money(100_000));
    expect(screen.getByText(/comes off your next lunches/)).toBeInTheDocument();
    // Nothing to transfer, so nothing to transfer with.
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.queryByText("LUNCHNEYU")).not.toBeInTheDocument();
  });

  it("uses the person's own reference, not the week's", async () => {
    serve({ weeks: [week()] });
    renderBill();

    // It carried the ISO week and changed every Monday, so nobody could save
    // the transfer in their banking app.
    expect(await screen.findByText("LUNCHNEYU")).toBeInTheDocument();
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
    expect(within(past[1]!).getByRole("heading", { name: "7–13 September" })).toBeInTheDocument();
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
  const REQUIRED =
    "Put this in the transfer message. It is yours for good, the same every week. " +
    "Only transfers carrying it reach this app, so one sent without it leaves your " +
    "bill unpaid with nothing for an admin to find.";

  /** The top-up instruction, on the screen of somebody who owes something. */
  const EXTRA =
    "Send more than this if you like. Anything above what you owe stays on your " +
    "account and comes off your next lunches.";

  it("tells somebody who owes money how to pay ahead, where they already are", async () => {
    // The likeliest person to pay ahead is somebody already making a transfer,
    // and the Pay ahead block is only offered to accounts with nothing owing.
    // Newly true, too: until the account landed the extra was clamped away by
    // `greatest(due - paid, 0)` and left the books entirely.
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByText(EXTRA)).toBeInTheDocument();
  });

  it("says nothing about paying extra where nothing is owed, because there is no extra", async () => {
    serve({ weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })] });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    expect(screen.queryByText(EXTRA)).not.toBeInTheDocument();
  });

  /** The heading's own row, so "Required" is read as labelling the reference. */
  function referenceHeading(): HTMLElement {
    const node = screen.getByRole("heading", { name: "Payment reference" }).parentElement;
    if (node === null) throw new Error("no row around the reference heading");
    return node;
  }

  it("labels the reference required and says what a transfer without it costs", async () => {
    serve();
    renderBill();

    expect(await screen.findByText("LUNCHNEYU")).toBeInTheDocument();
    expect(within(referenceHeading()).getByText("Required")).toBeInTheDocument();
    expect(screen.getByText(REQUIRED)).toBeInTheDocument();
  });

  it("no longer promises an admin will sort an unreferenced transfer out", async () => {
    serve();
    renderBill();
    await screen.findByText("LUNCHNEYU");

    expect(screen.queryByText(/sort out by hand/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/waits for an admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/matched to your name/i)).not.toBeInTheDocument();
  });

  it("says it wherever the reference is offered, code or no code", async () => {
    serve({ payment: { vietqr: null, note: null } });
    renderBill();

    expect(await screen.findByText("LUNCHNEYU")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(within(referenceHeading()).getByText("Required")).toBeInTheDocument();
    expect(screen.getByText(REQUIRED)).toBeInTheDocument();
  });

  it("says nothing about it on a week with nothing left to pay", async () => {
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
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
    expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument();
  });
});

describe("Bill, paying ahead", () => {
  it("offers a code with no amount when there is nothing to pay", async () => {
    const user = userEvent.setup();
    serve({ weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })] });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    // Folded away: somebody who owes nothing came here to confirm that.
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pay ahead" }));

    expect(await screen.findByText("LUNCHNEYU")).toBeInTheDocument();
    // A static code, because the whole point of paying ahead is that the
    // payer picks the sum. A dynamic one would fix it at scan time.
    expect(screen.getByRole("img", { name: /amount up to you/ })).toBeInTheDocument();
    expect(screen.getByText(/You type the amount/)).toBeInTheDocument();
  });

  it("offers it to somebody already in credit, who is the likeliest to use it", async () => {
    const user = userEvent.setup();
    serve({
      weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })],
      account: { chargedMinor: 180_000, creditedMinor: 280_000, balanceMinor: -100_000 },
    });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    await user.click(screen.getByRole("button", { name: "Pay ahead" }));
    expect(await screen.findByRole("img", { name: /VietQR code/ })).toBeInTheDocument();
  });

  it("says why there is no code rather than showing a broken one", async () => {
    const user = userEvent.setup();
    serve({
      weeks: [week({ statement: statement({ paidMinor: 180_000, status: "paid" }) })],
      payment: { vietqr: null, note: null },
    });
    renderBill();

    await screen.findByRole("heading", { name: "Your account" });
    await user.click(screen.getByRole("button", { name: "Pay ahead" }));
    expect(screen.getByText(/has not set up bank transfer yet/i)).toBeInTheDocument();
  });

  it("does not offer it while something is still owed, because the bill above is the code", async () => {
    serve({ weeks: [week()] });
    renderBill();

    await screen.findByText("You owe");
    expect(screen.queryByRole("button", { name: "Pay ahead" })).not.toBeInTheDocument();
  });
});

describe("Bill, copying the reference", () => {
  it("puts the reference on the clipboard and says so", async () => {
    const user = userEvent.setup();
    serve();
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Copied"));
    expect(await navigator.clipboard.readText()).toBe("LUNCHNEYU");
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

      const button = await screen.findByRole("button", { name: "Copy" });
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
