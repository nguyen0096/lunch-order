import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { BillScreen } from "../src/web/components/BillScreen.js";
import * as api from "../src/web/api.js";
import type {
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
};

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  orgs: [{ org: ORG, role: "member", shortCode: "NEYU", displayName: "Neyu" }],
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
    paymentRef: "LUNCH14NEYU",
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

function serve(over: Partial<Bill> = {}) {
  const bill: Bill = { weeks: [week()], payment: PAYMENT, ...over };
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
  it("leads with the amount, the reference and a code carrying both", async () => {
    serve({ weeks: [OPEN_WEEK, week()] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "14–20 September" })).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(180_000));
    expect(screen.getByText("LUNCH14NEYU")).toBeInTheDocument();
    expect(screen.getByText("Unpaid")).toBeInTheDocument();

    // The code is built here, so what it encodes is assertable: the amount the
    // member still owes and the reference that matches the payment back.
    const qr = screen.getByRole("img", { name: /VietQR code/ });
    expect(qr).toHaveTextContent(
      `VietQR code for ${money(180_000)} to CONG TY ABC, reference LUNCH14NEYU`,
    );
    expect(screen.getByText("113366668888")).toBeInTheDocument();
    // 970415 is VietinBank. A phone that will not scan leaves somebody typing
    // the transfer in by hand, and a BIN is not something a person can type.
    expect(screen.getByText("VietinBank")).toBeInTheDocument();
    expect(screen.getByText(PAYMENT.note!)).toBeInTheDocument();
  });

  it("says where the money went when a previous week was carried in", async () => {
    serve({
      weeks: [
        week({
          statement: statement({
            mealsMinor: 180_000,
            carriedInMinor: 90_000,
            totalDueMinor: 270_000,
          }),
        }),
      ],
    });
    renderBill();

    expect(await screen.findByText("You owe")).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(270_000));
    expect(
      screen.getByText(`Includes ${money(90_000)} carried over from the week before.`),
    ).toBeInTheDocument();
  });

  it("shows the reference and says why there is no code when no bank is set up", async () => {
    serve({ payment: { vietqr: null, note: null } });
    renderBill();

    expect(await screen.findByText("LUNCH14NEYU")).toBeInTheDocument();
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

    expect(await screen.findByText("Still to pay")).toBeInTheDocument();
    expect(headline("Still to pay")).toHaveTextContent(money(80_000));
    expect(
      screen.getByText(`Received so far: ${money(100_000)} of ${money(180_000)}.`),
    ).toBeInTheDocument();
    expect(screen.getByText("Part paid")).toBeInTheDocument();

    // The code carries the remainder, not the original total: a second
    // transfer for the full amount is an overpayment nobody asked for.
    expect(screen.getByRole("img", { name: /VietQR code/ })).toHaveTextContent(
      `VietQR code for ${money(80_000)} to CONG TY ABC, reference LUNCH14NEYU`,
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

    expect(await screen.findByText("Paid in full")).toBeInTheDocument();
    expect(headline("Paid in full")).toHaveTextContent(money(180_000));
    // 03:00Z is mid-morning in Ho Chi Minh City, which is the office's day.
    expect(screen.getByText("4 meals, received 22 September.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByText("LUNCH14NEYU")).not.toBeInTheDocument();
  });

  it("still says the current week is running", async () => {
    serve({
      weeks: [
        OPEN_WEEK,
        week({ statement: statement({ paidMinor: 180_000, status: "paid", paidAt: "2026-09-22T03:00:00Z" }) }),
      ],
    });
    renderBill();

    expect(await screen.findByText("Paid in full")).toBeInTheDocument();
    expect(
      screen.getByText("This week is still open. It closes Monday."),
    ).toBeInTheDocument();
  });

  it("treats a waived week as settled and asks for nothing", async () => {
    serve({ weeks: [week({ statement: statement({ status: "waived" }) })] });
    renderBill();

    expect(await screen.findByText("Nothing to pay")).toBeInTheDocument();
    expect(headline("Nothing to pay")).toHaveTextContent(money(0));
    expect(screen.getByText("Waived")).toBeInTheDocument();
    expect(screen.getByText(/An admin waived this week/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /VietQR code/ })).not.toBeInTheDocument();
  });
});

describe("Bill, which week leads", () => {
  it("leads with the unpaid week even when a newer one is still open", async () => {
    serve({ weeks: [OPEN_WEEK, week()] });
    renderBill();

    const lead = await screen.findByRole("article");
    expect(within(lead).getByRole("heading", { name: "14–20 September" })).toBeInTheDocument();
    expect(within(lead).getByText("You owe")).toBeInTheDocument();
  });

  it("leads with the newest unsettled week, because the older one is carried into it", async () => {
    serve({
      weeks: [
        week({
          periodId: 12,
          periodStart: "2026-09-21",
          periodEnd: "2026-09-27",
          statement: statement({
            id: 2,
            paymentRef: "LUNCH21NEYU",
            carriedInMinor: 180_000,
            totalDueMinor: 360_000,
          }),
        }),
        week(),
      ],
    });
    renderBill();

    const lead = await screen.findByRole("article");
    expect(within(lead).getByRole("heading", { name: "21–27 September" })).toBeInTheDocument();
    expect(headline("You owe")).toHaveTextContent(money(360_000));

    // The older week is listed, and says plainly that it is not a second debt.
    const past = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(past).toHaveLength(1);
    expect(within(past[0]!).getByRole("heading", { name: "14–20 September" })).toBeInTheDocument();
    expect(
      within(past[0]!).getByText(
        `${money(180_000)} of this is still to pay, and it is carried into the week above.`,
      ),
    ).toBeInTheDocument();
  });
});

describe("Bill, past weeks", () => {
  it("says what the list will hold rather than showing nothing", async () => {
    serve({ weeks: [week()] });
    renderBill();

    expect(await screen.findByRole("heading", { name: "No earlier weeks" })).toBeInTheDocument();
    expect(screen.getByText(/once it has been billed and the next one has started/i)).toBeInTheDocument();
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
    expect(past).toHaveLength(1);
    expect(within(past[0]!).getByRole("heading", { name: "7–13 September" })).toBeInTheDocument();
    expect(within(past[0]!).getByText(money(135_000))).toBeInTheDocument();
    expect(within(past[0]!).getByText("Paid")).toBeInTheDocument();
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
    "Put this in the transfer message. Only transfers carrying it reach this app, " +
    "so one sent without it leaves your bill unpaid with nothing for an admin to find.";

  /** The heading's own row, so "Required" is read as labelling the reference. */
  function referenceHeading(): HTMLElement {
    const node = screen.getByRole("heading", { name: "Payment reference" }).parentElement;
    if (node === null) throw new Error("no row around the reference heading");
    return node;
  }

  it("labels the reference required and says what a transfer without it costs", async () => {
    serve();
    renderBill();

    expect(await screen.findByText("LUNCH14NEYU")).toBeInTheDocument();
    expect(within(referenceHeading()).getByText("Required")).toBeInTheDocument();
    expect(screen.getByText(REQUIRED)).toBeInTheDocument();
  });

  it("no longer promises an admin will sort an unreferenced transfer out", async () => {
    serve();
    renderBill();
    await screen.findByText("LUNCH14NEYU");

    expect(screen.queryByText(/sort out by hand/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/waits for an admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/matched to your name/i)).not.toBeInTheDocument();
  });

  it("says it wherever the reference is offered, code or no code", async () => {
    serve({ payment: { vietqr: null, note: null } });
    renderBill();

    expect(await screen.findByText("LUNCH14NEYU")).toBeInTheDocument();
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

describe("Bill, copying the reference", () => {
  it("puts the reference on the clipboard and says so", async () => {
    const user = userEvent.setup();
    serve();
    renderBill();
    await screen.findByText("You owe");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Copied"));
    expect(await navigator.clipboard.readText()).toBe("LUNCH14NEYU");
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
