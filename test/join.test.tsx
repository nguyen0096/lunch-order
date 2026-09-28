import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JoinScreen } from "../src/web/components/JoinScreen.js";
import { NoOfficeScreen } from "../src/web/components/SignInScreen.js";
import * as api from "../src/web/api.js";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return { ...actual, acceptInvitation: vi.fn(), previewInvitation: vi.fn() };
});

const acceptInvitation = vi.mocked(api.acceptInvitation);
const previewInvitation = vi.mocked(api.previewInvitation);

const TOKEN = "0b7c9f2e-1111-4222-8333-944455556666";
const LIVE: api.InvitationPreview = {
  orgName: "Acme",
  role: "member",
  expiresAt: "2026-10-12T09:00:00Z",
  state: "valid",
};

beforeEach(() => {
  vi.clearAllMocks();
  previewInvitation.mockResolvedValue(LIVE);
});

describe("Join", () => {
  it("sends you to the board of the office you just joined, not the first one you had", async () => {
    acceptInvitation.mockResolvedValue({ slug: "acme", name: "Acme" });
    const onJoined = vi.fn();
    render(<JoinScreen token={TOKEN} onJoined={onJoined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("Joined Acme.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the board" })).toHaveAttribute(
      "href",
      "#/o/acme/board",
    );
    expect(onJoined).toHaveBeenCalledTimes(1);
  });
});

describe("Join, before accepting", () => {
  it("offers nothing to accept while it is still asking where the link leads", () => {
    previewInvitation.mockReturnValue(new Promise(() => {}));
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);

    expect(screen.getByLabelText("Loading the invitation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    expect(previewInvitation).toHaveBeenCalledWith(TOKEN);
  });

  it("names the office and the role before Accept", async () => {
    previewInvitation.mockResolvedValue({ ...LIVE, role: "admin" });
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.getByText(/invited to Acme as an admin/)).toBeInTheDocument();
    expect(screen.getByText("This invitation is valid until 12 Oct 2026.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
  });

  it("says a member is joining as a member", async () => {
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);
    expect(await screen.findByText(/invited to Acme as a member/)).toBeInTheDocument();
  });

  it("says a link that matches nothing is not valid, and offers no Accept", async () => {
    previewInvitation.mockResolvedValue(null);
    render(<JoinScreen token="not-a-token" onJoined={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Invitation not found" })).toBeInTheDocument();
    expect(screen.getByText(/That invitation link is not valid/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("says an expired invitation expired, naming the office, and offers no Accept", async () => {
    previewInvitation.mockResolvedValue({ ...LIVE, state: "expired", expiresAt: "2026-09-01T09:00:00Z" });
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Invitation expired" })).toBeInTheDocument();
    expect(screen.getByText(/Your invitation to Acme expired on 1 Sept 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("says a used invitation was used, and offers no Accept", async () => {
    previewInvitation.mockResolvedValue({ ...LIVE, state: "used" });
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Invitation already used" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("says when it could not ask, and asks again on Try again", async () => {
    previewInvitation.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<JoinScreen token={TOKEN} onJoined={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "The invitation did not load" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(previewInvitation).toHaveBeenCalledTimes(2);
  });
});

describe("No office", () => {
  it("does not tell somebody an admin removed that they have never joined, when it cannot tell", () => {
    render(
      <NoOfficeScreen
        email="neyu@example.com"
        fullName="Neyu"
        mayFoundOffice={false}
        onSignOut={vi.fn()}
        onCreated={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
    expect(screen.queryByText(/yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/If you left it, its join code brings you back. If an\s+admin removed you/)).toBeInTheDocument();
  });
});

describe("No office, when the database has answered", () => {
  function renderWith(removedFrom: string[], leftFrom: string[] = []) {
    render(
      <NoOfficeScreen
        email="neyu@example.com"
        fullName="Neyu"
        removedFrom={removedFrom}
        leftFrom={leftFrom}
        mayFoundOffice={false}
        onSignOut={vi.fn()}
        onCreated={vi.fn()}
        onJoined={vi.fn()}
      />,
    );
  }

  it("tells a removed member which office removed them, and that the code will not help", () => {
    renderWith(["Acme"]);
    expect(screen.getByText(
      "You were removed from Acme. Its join code will not bring you back; ask an admin there to add you back.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/not a member of any office/)).not.toBeInTheDocument();
    expect(screen.queryByText(/If you left it/)).not.toBeInTheDocument();
  });

  it("names every office they were removed from", () => {
    renderWith(["Acme", "Beta", "Gamma"]);
    expect(screen.getByText(
      "You were removed from Acme, Beta and Gamma. Their join codes will not bring you back; ask an admin there to add you back.",
    )).toBeInTheDocument();
  });

  it("tells somebody who left, without saying anybody removed them", () => {
    renderWith([], ["Acme"]);
    expect(screen.getByText(
      "You're signed in as neyu@example.com, but you're not active in any office. You're no longer a member of Acme. Its join code will bring you back.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("says both when both happened", () => {
    renderWith(["Acme"], ["Beta"]);
    expect(screen.getByText(/You were removed from Acme/)).toBeInTheDocument();
    expect(screen.getByText("You're no longer a member of Beta. Its join code will bring you back.")).toBeInTheDocument();
  });

  it("tells somebody new they are new, and nothing about removals", () => {
    renderWith([]);
    expect(screen.getByText(/You're signed in as neyu@example.com, but you're not a member of any office yet/)).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("still offers the join code either way", () => {
    renderWith(["Acme"]);
    expect(screen.getByRole("button", { name: "Join with a code" })).toBeInTheDocument();
  });
});
