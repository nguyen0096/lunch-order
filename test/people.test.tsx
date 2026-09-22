import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { PeopleScreen } from "../src/web/components/PeopleScreen.js";
import * as api from "../src/web/api.js";
import type { Invitation, JoinCode, OrgMember } from "../src/web/api.js";
import type { Me, Org, Role } from "../src/shared/types.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Only the network edge is faked. `humanError` and `generateJoinCode` stay real:
// the first is how a refusal reaches the person, and the second is the thing
// that has to produce a code the column's own check constraint will accept.
vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return {
    ...actual,
    fetchOrgMembers: vi.fn(),
    fetchJoinCode: vi.fn(),
    setJoinCode: vi.fn(),
    fetchInvitations: vi.fn(),
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    updateMembership: vi.fn(),
  };
});

const fetchOrgMembers = vi.mocked(api.fetchOrgMembers);
const fetchJoinCode = vi.mocked(api.fetchJoinCode);
const setJoinCode = vi.mocked(api.setJoinCode);
const fetchInvitations = vi.mocked(api.fetchInvitations);
const createInvitation = vi.mocked(api.createInvitation);
const revokeInvitation = vi.mocked(api.revokeInvitation);
const updateMembership = vi.mocked(api.updateMembership);
const success = vi.mocked(toast.success);
const failure = vi.mocked(toast.error);

/* ------------------------------------------------------------------ fixture */

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

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
  orgs: [{ org: ORG, role: "admin", shortCode: "NEYU", displayName: "Neyu" }],
};

const CODE = "KJ7PQ2MN";

/** The alphabet the column's check constraint allows, and nothing else. */
const SAFE_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12}$/;

/**
 * Sorted the way `fetchOrgMembers` sorts: active first, then by name. `Sếp` is
 * the owner and has no email address, which is the common case here -- people
 * join from Telegram and never have one.
 */
function makeMembers(meRole: Role = "admin"): OrgMember[] {
  return [
    {
      membershipId: 1, profileId: "me", email: "neyu@example.com", name: "Neyu",
      shortCode: "NEYU", role: meRole, status: "active", createdAt: ago(40 * DAY), isMe: true,
    },
    {
      membershipId: 2, profileId: "sep", email: "", name: "Sếp",
      shortCode: "SEP", role: "owner", status: "active", createdAt: ago(50 * DAY), isMe: false,
    },
    {
      membershipId: 3, profileId: "teo", email: "", name: "Tèo",
      shortCode: "TEO", role: "member", status: "active", createdAt: ago(2 * DAY), isMe: false,
    },
    {
      membershipId: 4, profileId: "dinh", email: "", name: "Dinh",
      shortCode: "DINH", role: "member", status: "inactive", createdAt: ago(10 * DAY), isMe: false,
    },
  ];
}

const INVITATION: Invitation = {
  id: 9, email: "ketoan@congty.vn", role: "member", token: "tok-1",
  // An hour past five days, so the elapsed time between building this and
  // rendering it cannot round the label down to four.
  expiresAt: ahead(5 * DAY + 3_600_000), acceptedAt: null,
};

function serve(
  over: { members?: OrgMember[]; code?: JoinCode; invitations?: Invitation[] } = {},
) {
  fetchOrgMembers.mockResolvedValue(over.members ?? makeMembers());
  fetchJoinCode.mockResolvedValue(over.code ?? { code: CODE, setAt: ago(3 * DAY) });
  fetchInvitations.mockResolvedValue(over.invitations ?? []);
  // The database echoes back what it stored, so the screen shows the real row.
  setJoinCode.mockImplementation(async (a) => ({ code: a.code, setAt: new Date().toISOString() }));
  updateMembership.mockResolvedValue(undefined);
  revokeInvitation.mockResolvedValue(undefined);
}

function renderPeople(role: Role = "admin") {
  return render(<PeopleScreen me={ME} org={ORG} role={role} />);
}

/** The member list row for one person. Scoped, because names repeat elsewhere. */
function memberRow(name: string): HTMLElement {
  const list = screen.getByRole("list", { name: "Members" });
  const row = within(list)
    .getAllByRole("listitem")
    .find((li) => li.textContent?.includes(name));
  if (!row) throw new Error(`no member row for ${name}`);
  return row;
}

function control(name: string, label: string): HTMLElement {
  return within(memberRow(name)).getByRole("button", { name: label });
}

async function settled() {
  return screen.findByRole("list", { name: "Members" });
}

/**
 * The modules a QR draws are a pure function of its payload, so rendering the
 * payload we expect and comparing the paths is how a test says what the code on
 * screen actually carries. Nothing else about the SVG reveals it.
 */
function qrPath(el: Element | null | undefined): string {
  const svg = el?.closest("svg") ?? el;
  return Array.from(svg?.querySelectorAll("path") ?? [])
    .map((p) => p.getAttribute("d") ?? "")
    .join("|");
}

function referenceQr(value: string): string {
  const view = render(
    <QRCodeSVG
      value={value}
      marginSize={4}
      level="M"
      size={160}
      bgColor="transparent"
      fgColor="currentColor"
    />,
  );
  const path = qrPath(view.container.querySelector("svg"));
  view.unmount();
  return path;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------- loading and error */

describe("People, loading and error", () => {
  it("shows a skeleton shaped like the screen, not the word Loading", async () => {
    fetchOrgMembers.mockReturnValue(new Promise(() => {}));
    fetchJoinCode.mockReturnValue(new Promise(() => {}));
    fetchInvitations.mockReturnValue(new Promise(() => {}));
    renderPeople();

    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("reports a failed read with the database's own words and offers a retry", async () => {
    fetchOrgMembers.mockRejectedValue({ message: "JWT expired" });
    fetchJoinCode.mockResolvedValue({ code: CODE, setAt: null });
    fetchInvitations.mockResolvedValue([]);
    renderPeople();

    expect(await screen.findByText("JWT expired")).toBeInTheDocument();

    serve();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(CODE)).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- join code */

describe("People, the join code", () => {
  it("leads with the code and says when it was last set", async () => {
    serve();
    renderPeople();

    expect(await screen.findByText(CODE)).toBeInTheDocument();
    expect(screen.getByText("Set 3 days ago")).toBeInTheDocument();
  });

  it("says a code predates the record rather than inventing a date", async () => {
    serve({ code: { code: CODE, setAt: null } });
    renderPeople();

    expect(await screen.findByText(CODE)).toBeInTheDocument();
    expect(screen.getByText(/Set before this was recorded/)).toBeInTheDocument();
    // The lie this avoids: any date at all for a code nobody stamped.
    expect(screen.queryByText(/^Set \d/)).not.toBeInTheDocument();
  });

  it("offers Create, not Rotate, when the org has no code yet", async () => {
    serve({ code: { code: null, setAt: null } });
    renderPeople();

    expect(await screen.findByRole("heading", { name: "No join code yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a join code" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
  });

  it("creates a code the check constraint accepts, and shows it", async () => {
    serve({ code: { code: null, setAt: null } });
    renderPeople();

    await userEvent.click(await screen.findByRole("button", { name: "Create a join code" }));

    await waitFor(() => expect(setJoinCode).toHaveBeenCalledTimes(1));
    const written = setJoinCode.mock.calls[0]![0].code;
    expect(written).toMatch(SAFE_CODE);
    // The four characters people mistype off a phone are not in the alphabet.
    expect(written).not.toMatch(/[IO01]/);
    expect(setJoinCode.mock.calls[0]![0].orgId).toBe(7);
    expect(success).toHaveBeenCalledWith("Created");
    expect(await screen.findByText(written)).toBeInTheDocument();
  });

  it("copies the code", async () => {
    const user = userEvent.setup();
    serve();
    renderPeople();

    await screen.findByText(CODE);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(success).toHaveBeenCalledWith("Copied"));
    expect(await navigator.clipboard.readText()).toBe(CODE);
  });

  it("asks before rotating, and says the old code dies while nobody is removed", async () => {
    serve();
    renderPeople();

    await screen.findByText(CODE);
    await userEvent.click(screen.getByRole("button", { name: "Rotate" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stops working straight away/)).toBeInTheDocument();
    expect(within(dialog).getByText(/rotating removes nobody/i)).toBeInTheDocument();
    // Nothing is written until the confirmation is the thing that is pressed.
    expect(setJoinCode).not.toHaveBeenCalled();
  });

  it("rotates to a different code and shows the new one", async () => {
    serve();
    renderPeople();

    await screen.findByText(CODE);
    await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));

    await waitFor(() => expect(setJoinCode).toHaveBeenCalledTimes(1));
    const written = setJoinCode.mock.calls[0]![0].code;
    expect(written).toMatch(SAFE_CODE);
    expect(written).not.toBe(CODE);
    expect(success).toHaveBeenCalledWith("Rotated");
    expect(await screen.findByText(written)).toBeInTheDocument();
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("puts the bot's deep link in the QR, not the bare code", async () => {
    vi.stubEnv("VITE_TELEGRAM_BOT", "lunchbot");
    serve();
    renderPeople();

    const title = await screen.findByTitle(`Join Test Office on Telegram with code ${CODE}`);
    const drawn = qrPath(title);

    expect(drawn).toBe(referenceQr(`https://t.me/lunchbot/?start=${CODE}`));
    // A QR of the code alone scans to a string the person then has to carry
    // somewhere by hand, which is the work the QR exists to remove.
    expect(drawn).not.toBe(referenceQr(CODE));
    expect(screen.getByText("Scanning opens the bot with this code already typed.")).toBeInTheDocument();
  });

  it("falls back to the raw /start command in a build with no bot username", async () => {
    serve();
    renderPeople();

    expect(await screen.findByText(`/start ${CODE}`)).toBeInTheDocument();
    expect(screen.queryByTitle(/Join Test Office on Telegram/)).not.toBeInTheDocument();
  });

  it("keeps the old code on screen when the database refuses the rotation", async () => {
    serve();
    setJoinCode.mockRejectedValue({ code: "42501", message: "permission denied" });
    renderPeople();

    await screen.findByText(CODE);
    await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate" }),
    );

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("You don't have permission to do that."),
    );
    expect(success).not.toHaveBeenCalled();
    expect(screen.getByText(CODE)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------ recent joins */

describe("People, recent joins", () => {
  it("lists who arrived, newest first, with when", async () => {
    serve();
    renderPeople();

    const list = within(await screen.findByRole("list", { name: "Recent joins" }));
    const rows = list.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Tèo");
    expect(rows[0]).toHaveTextContent("Joined 2 days ago");
    expect(rows[1]).toHaveTextContent("Dinh");
    expect(rows[3]).toHaveTextContent("Sếp");
  });

  it("tells an office of one what to do next instead of showing an empty list", async () => {
    serve({ members: [makeMembers()[0]!] });
    renderPeople();

    expect(
      await screen.findByRole("heading", { name: "Nobody else has joined yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Share this to add your first colleague.")).toBeInTheDocument();
    // The code still leads: an office of one is the case the code exists for.
    expect(screen.getByText(CODE)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------- roles */

describe("People, the role rules", () => {
  it("refuses your own row and says why, rather than greying it out", async () => {
    serve();
    renderPeople();
    await settled();

    const mine = memberRow("Neyu");
    const makeMember = within(mine).getByRole("button", { name: "Make member" });
    expect(makeMember).toHaveAttribute("aria-disabled", "true");
    // Still focusable and hoverable, which is the point of aria-disabled here.
    expect(makeMember).not.toBeDisabled();
    expect(
      within(mine).getAllByText("You cannot change your own role. Ask another admin or the owner."),
    ).toHaveLength(2);

    await userEvent.click(makeMember);
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it("will not let an admin appoint an owner, and says so on the control", async () => {
    serve();
    renderPeople("admin");
    await settled();

    const makeOwner = control("Tèo", "Make owner");
    expect(makeOwner).toHaveAttribute("aria-disabled", "true");
    expect(
      within(memberRow("Tèo")).getByText("Only an owner can appoint another owner."),
    ).toBeInTheDocument();

    await userEvent.click(makeOwner);
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it("will not let an admin stand the owner down, and says so on the control", async () => {
    serve();
    renderPeople("admin");
    await settled();

    const owner = memberRow("Sếp");
    for (const label of ["Make member", "Make admin"]) {
      expect(within(owner).getByRole("button", { name: label })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    expect(within(owner).getAllByText("Only an owner can stand down an owner.")).toHaveLength(2);
    expect(within(owner).getByRole("button", { name: "Deactivate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(owner).getByText("Only an owner can deactivate an owner.")).toBeInTheDocument();

    await userEvent.click(within(owner).getByRole("button", { name: "Make member" }));
    await userEvent.click(within(owner).getByRole("button", { name: "Deactivate" }));
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it("lets an owner appoint another owner", async () => {
    serve({ members: makeMembers("owner") });
    renderPeople("owner");
    await settled();

    const makeOwner = control("Tèo", "Make owner");
    expect(makeOwner).not.toHaveAttribute("aria-disabled");
    await userEvent.click(makeOwner);

    await waitFor(() => expect(updateMembership).toHaveBeenCalledWith({
      membershipId: 3,
      role: "owner",
    }));
    expect(success).toHaveBeenCalledWith("Tèo is now an owner");
  });

  it("lets an owner stand another owner down", async () => {
    serve({ members: makeMembers("owner") });
    renderPeople("owner");
    await settled();

    const demote = control("Sếp", "Make admin");
    expect(demote).not.toHaveAttribute("aria-disabled");
    await userEvent.click(demote);

    await waitFor(() => expect(updateMembership).toHaveBeenCalledWith({
      membershipId: 2,
      role: "admin",
    }));
    expect(success).toHaveBeenCalledWith("Sếp is now an admin");
  });

  it("names the new role when one changes, so it is not a silent success", async () => {
    serve();
    renderPeople();
    await settled();

    await userEvent.click(control("Tèo", "Make admin"));

    await waitFor(() => expect(updateMembership).toHaveBeenCalledWith({
      membershipId: 3,
      role: "admin",
    }));
    expect(success).toHaveBeenCalledWith("Tèo is now an admin");
    // The list is re-read, so the badge comes from the database, not from hope.
    expect(fetchOrgMembers).toHaveBeenCalledTimes(2);
  });

  it("reports a refused role change instead of failing silently", async () => {
    serve();
    updateMembership.mockRejectedValue({
      code: "42501",
      message: "only an owner can appoint or stand down another owner",
    });
    renderPeople();
    await settled();

    await userEvent.click(control("Tèo", "Make admin"));

    await waitFor(() =>
      expect(failure).toHaveBeenCalledWith("You don't have permission to do that."),
    );
    expect(success).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ status */

describe("People, deactivating", () => {
  it("deactivates a member and reports it", async () => {
    serve();
    renderPeople();
    await settled();

    await userEvent.click(control("Tèo", "Deactivate"));

    await waitFor(() => expect(updateMembership).toHaveBeenCalledWith({
      membershipId: 3,
      status: "inactive",
    }));
    expect(success).toHaveBeenCalledWith("Deactivated Tèo");
  });

  it("refuses to let you deactivate yourself, and says why", async () => {
    serve();
    renderPeople();
    await settled();

    const mine = within(memberRow("Neyu"));
    const deactivate = mine.getByRole("button", { name: "Deactivate" });
    expect(deactivate).toHaveAttribute("aria-disabled", "true");
    expect(mine.getByText("You cannot deactivate yourself. Ask another admin.")).toBeInTheDocument();

    await userEvent.click(deactivate);
    expect(updateMembership).not.toHaveBeenCalled();
  });

  it("offers Reactivate for somebody already deactivated", async () => {
    serve();
    renderPeople();
    await settled();

    const row = within(memberRow("Dinh"));
    expect(row.getByText("inactive")).toBeInTheDocument();
    await userEvent.click(row.getByRole("button", { name: "Reactivate" }));

    await waitFor(() => expect(updateMembership).toHaveBeenCalledWith({
      membershipId: 4,
      status: "active",
    }));
    expect(success).toHaveBeenCalledWith("Reactivated Dinh");
  });
});

/* ----------------------------------------------------------------- identity */

describe("People, members without an email address", () => {
  it("identifies a Telegram member by short code and shows no empty email", async () => {
    serve();
    renderPeople();
    await settled();

    const teo = memberRow("Tèo");
    expect(within(teo).getByText("TEO")).toBeInTheDocument();
    expect(teo.textContent).not.toContain("@");

    // And an address is still shown for the one person who has one.
    expect(within(memberRow("Neyu")).getByText("neyu@example.com")).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- invitations */

describe("People, email invitations", () => {
  it("says what the empty list means instead of showing nothing", async () => {
    serve();
    renderPeople();

    expect(
      await screen.findByRole("heading", { name: "No invitations waiting" }),
    ).toBeInTheDocument();
  });

  it("invites one address with the chosen role", async () => {
    serve();
    createInvitation.mockResolvedValue({ ...INVITATION, email: "sep@congty.vn", role: "admin" });
    renderPeople();
    await settled();

    await userEvent.type(screen.getByLabelText("Email address"), "sep@congty.vn");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "admin");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith({
      orgId: 7,
      email: "sep@congty.vn",
      role: "admin",
      invitedBy: "me",
    }));
    expect(success).toHaveBeenCalledWith("Invited sep@congty.vn");
  });

  it("cannot offer owner, because an invitation can never mint one", async () => {
    serve();
    renderPeople();
    await settled();

    const roles = within(screen.getByLabelText("Role")).getAllByRole("option");
    expect(roles.map((o) => o.textContent)).toEqual(["Member", "Admin"]);
  });

  it("lists a waiting invitation with its expiry and revokes it", async () => {
    serve({ invitations: [INVITATION] });
    renderPeople();

    const list = within(await screen.findByRole("list", { name: "Invitations" }));
    expect(list.getByText("ketoan@congty.vn")).toBeInTheDocument();
    expect(list.getByText(/expires in 5 days/)).toBeInTheDocument();

    await userEvent.click(list.getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith(9));
    expect(success).toHaveBeenCalledWith("Revoked ketoan@congty.vn");
  });

  it("leaves an accepted invitation out of the waiting list", async () => {
    serve({ invitations: [{ ...INVITATION, acceptedAt: ago(DAY) }] });
    renderPeople();

    expect(
      await screen.findByRole("heading", { name: "No invitations waiting" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("ketoan@congty.vn")).not.toBeInTheDocument();
  });
});
