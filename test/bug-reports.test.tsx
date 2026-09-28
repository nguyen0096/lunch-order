import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { AppShell, switchTarget } from "../src/web/components/AppShell.js";
import { BugReportsScreen } from "../src/web/components/BugReportsScreen.js";
import * as api from "../src/web/api.js";
import { bugReportContext, bugReportProblem, type BugReport } from "../src/web/api.js";
import type { Me, Org, Role } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. The context builder and the validation stay
// real, because what gets attached to a report is most of what is under test.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    sendBugReport: vi.fn(),
    fetchBugReports: vi.fn(),
    setBugReportResolved: vi.fn(),
  };
});

const sendBugReport = vi.mocked(api.sendBugReport);
const fetchBugReports = vi.mocked(api.fetchBugReports);
const setBugReportResolved = vi.mocked(api.setBugReportResolved);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

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
  mayFoundOffice: true,
  orgs: [
    { org: ORG, role: "owner", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" },
  ],
};

function shell(role: Role) {
  render(
    <AppShell
      org={ORG}
      role={role}
      offices={[{ org: ORG, role }]}
      page="board"
      displayName="Nguyễn Neyu"
      email="neyu@example.com"
      mayFoundOffice={false}
      onSignOut={vi.fn()}
      onCreated={vi.fn()}
      onJoined={vi.fn()}
    >
      <p>the board</p>
    </AppShell>,
  );
}

async function openAccountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: /Account: Nguyễn Neyu/ })[0]!);
  const email = await screen.findByText("neyu@example.com");
  return email.closest("[data-slot='popover-content']") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#/o/test-office/bill";
});

/* ---------------------------------------------------------------- the menu */

describe("the account menu", () => {
  it.each<Role>(["member", "admin", "owner"])(
    "offers a %s Report a bug, directly above Sign out",
    async (role) => {
      const user = userEvent.setup();
      shell(role);
      const panel = await openAccountMenu(user);

      const items = within(panel)
        .getAllByRole("button")
        .map((b) => b.textContent);
      const signOut = items.indexOf("Sign out");
      expect(signOut).toBeGreaterThan(0);
      expect(items[signOut - 1]).toBe("Report a bug");
    },
  );

  it.each<Role>(["member", "admin"])("does not offer a %s the Bug reports screen", async (role) => {
    const user = userEvent.setup();
    shell(role);
    const panel = await openAccountMenu(user);
    expect(within(panel).queryByRole("link", { name: "Bug reports" })).not.toBeInTheDocument();
  });

  it("offers the owner the Bug reports screen", async () => {
    const user = userEvent.setup();
    shell("owner");
    const panel = await openAccountMenu(user);
    expect(within(panel).getByRole("link", { name: "Bug reports" })).toHaveAttribute(
      "href",
      "#/o/test-office/bug-reports",
    );
  });

  it("keeps the owner on Bug reports across a switch only where they are an owner", () => {
    expect(switchTarget("bug-reports", "owner")).toBe("bug-reports");
    expect(switchTarget("bug-reports", "admin")).toBe("board");
    expect(switchTarget("bug-reports", "member")).toBe("board");
  });
});

/* -------------------------------------------------------------- the dialog */

describe("reporting a bug", () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    shell("member");
    const panel = await openAccountMenu(user);
    await user.click(within(panel).getByRole("button", { name: "Report a bug" }));
    return screen.findByRole("dialog", { name: "Report a bug" });
  }

  it("will not send an empty report, and says why", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    const send = within(dialog).getByRole("button", { name: "Send report" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByText("Say what went wrong first", { selector: ".sr-only" }))
      .toBeInTheDocument();

    await user.click(send);
    expect(sendBugReport).not.toHaveBeenCalled();
  });

  it("sends the description with the page, version and browser attached, then closes", async () => {
    sendBugReport.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText("What went wrong"), "  The bill shows 0 ₫  ");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(sendBugReport).toHaveBeenCalledTimes(1));
    const args = sendBugReport.mock.calls[0]![0];
    expect(args.orgId).toBe(7);
    expect(args.description).toBe("  The bill shows 0 ₫  ");
    expect(args.context.route).toBe("#/o/test-office/bill");
    expect(args.context.userAgent).toBe(navigator.userAgent);
    expect(args.context.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(args.context.viewport).toMatch(/^\d+x\d+$/);

    expect(success).toHaveBeenCalledWith("Report sent");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the text and shows the database's sentence when it is refused", async () => {
    sendBugReport.mockRejectedValue({
      message: "you have sent 10 bug reports in the last hour; the owner has them all, so try again later",
      code: "54000",
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    const field = within(dialog).getByLabelText("What went wrong");
    await user.type(field, "Nothing loads");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("you have sent 10 bug reports in the last hour");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue("Nothing loads");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("what a report carries", () => {
  it("reads the route, browser and window size from the page", () => {
    const ctx = bugReportContext({
      location: { hash: "#/o/acme/board?now=2026-09-10" } as Location,
      navigator: { userAgent: "Mozilla/5.0 Test" } as Navigator,
      innerWidth: 390,
      innerHeight: 844,
    });
    expect(ctx).toMatchObject({
      route: "#/o/acme/board?now=2026-09-10",
      userAgent: "Mozilla/5.0 Test",
      viewport: "390x844",
    });
    expect(ctx.appVersion).not.toBe("");
  });

  it("cuts what the browser says to the columns' limits rather than losing the report", () => {
    const ctx = bugReportContext({
      location: { hash: `#/${"x".repeat(900)}` } as Location,
      navigator: { userAgent: "u".repeat(900) } as Navigator,
      innerWidth: 1,
      innerHeight: 1,
    });
    expect(ctx.route).toHaveLength(500);
    expect(ctx.userAgent).toHaveLength(500);
  });

  it("refuses blank and over-long descriptions in words", () => {
    expect(bugReportProblem("   ")).toBe("Say what went wrong first");
    expect(bugReportProblem("x".repeat(2001))).toBe(
      "A report can be 2000 characters at most, and this one is 2001",
    );
    expect(bugReportProblem("It broke")).toBeNull();
  });
});

/* -------------------------------------------------------------- the screen */

const REPORTS: BugReport[] = [
  {
    id: 12,
    reporterName: "Tèo",
    description: "The <b>board</b> & the bill disagree",
    route: "#/o/test-office/board",
    appVersion: "0.1.0+abc1234",
    userAgent: "Mozilla/5.0 Newer",
    viewport: "390x844",
    createdAt: "2026-09-28T02:30:00Z",
    resolvedAt: null,
  },
  {
    id: 11,
    reporterName: "Dinh",
    description: "Older report",
    route: null,
    appVersion: null,
    userAgent: null,
    viewport: null,
    createdAt: "2026-09-27T02:30:00Z",
    resolvedAt: "2026-09-27T05:00:00Z",
  },
];

describe("the Bug reports screen", () => {
  function renderScreen() {
    return render(<BugReportsScreen me={ME} org={ORG} role="owner" />);
  }

  it("shows a skeleton while loading, then the reports in the order they came", async () => {
    fetchBugReports.mockResolvedValue(REPORTS);
    const { container } = renderScreen();
    expect(container.querySelector("[data-slot='skeleton']")).not.toBeNull();

    const cards = await screen.findAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Report #12", "Report #11"]);
    expect(fetchBugReports).toHaveBeenCalledWith({ orgId: 7, meProfileId: "me" });
  });

  it("shows the description as text and every context field", async () => {
    fetchBugReports.mockResolvedValue(REPORTS);
    renderScreen();
    const card = (await screen.findByRole("article", { name: "Report #12" })) as HTMLElement;

    expect(within(card).getByText("The <b>board</b> & the bill disagree")).toBeInTheDocument();
    expect(within(card).getByText("Tèo")).toBeInTheDocument();
    expect(within(card).getByText("28 Sept 2026, 09:30")).toBeInTheDocument();
    expect(within(card).getByText("#/o/test-office/board")).toBeInTheDocument();
    expect(within(card).getByText("0.1.0+abc1234")).toBeInTheDocument();
    expect(within(card).getByText("Mozilla/5.0 Newer")).toBeInTheDocument();
    expect(within(card).getByText("390x844")).toBeInTheDocument();

    const older = screen.getByRole("article", { name: "Report #11" });
    expect(within(older).getAllByText("Not recorded")).toHaveLength(4);
    expect(within(older).getByText("Resolved")).toBeInTheDocument();
  });

  it("says what to expect when nothing has been reported", async () => {
    fetchBugReports.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText("Nothing reported yet")).toBeInTheDocument();
  });

  it("says it did not load, and tries again", async () => {
    fetchBugReports.mockRejectedValueOnce(new Error("network down")).mockResolvedValue([]);
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText("Bug reports did not load")).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing reported yet")).toBeInTheDocument();
  });

  it("marks a report resolved and reopens one", async () => {
    fetchBugReports.mockResolvedValue(REPORTS);
    setBugReportResolved.mockImplementation(async ({ resolved }) => ({
      resolvedAt: resolved ? "2026-09-28T03:00:00Z" : null,
    }));
    const user = userEvent.setup();
    renderScreen();

    const newer = (await screen.findByRole("article", { name: "Report #12" })) as HTMLElement;
    await user.click(within(newer).getByRole("button", { name: "Resolve" }));
    expect(setBugReportResolved).toHaveBeenCalledWith({ id: 12, resolved: true });
    expect(await within(newer).findByText("Resolved")).toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("Resolved");

    const older = screen.getByRole("article", { name: "Report #11" });
    await user.click(within(older).getByRole("button", { name: "Reopen" }));
    expect(setBugReportResolved).toHaveBeenCalledWith({ id: 11, resolved: false });
    await waitFor(() => expect(within(older).queryByText("Resolved")).not.toBeInTheDocument());
    expect(success).toHaveBeenCalledWith("Reopened");
  });
});
