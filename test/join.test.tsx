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
  return { ...actual, acceptInvitation: vi.fn() };
});

const acceptInvitation = vi.mocked(api.acceptInvitation);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Join", () => {
  it("sends you to the board of the office you just joined, not the first one you had", async () => {
    acceptInvitation.mockResolvedValue({ slug: "acme", name: "Acme" });
    const onJoined = vi.fn();
    render(<JoinScreen token="0b7c9f2e-1111-4222-8333-944455556666" onJoined={onJoined} />);

    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("Joined Acme.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the board" })).toHaveAttribute(
      "href",
      "#/o/acme/board",
    );
    expect(onJoined).toHaveBeenCalledTimes(1);
  });
});

describe("No office", () => {
  it("does not tell somebody an admin removed that they have never joined", () => {
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
    expect(screen.getByText(/An admin may have removed you/)).toBeInTheDocument();
  });
});
