import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/web/App.js";
import * as api from "../src/web/api.js";
import type { Me, Org } from "../src/shared/types.js";

type AuthListener = (event: string, session: { user: { id: string } } | null) => void;

// The auth client is the edge being faked: App is what turns its events into
// fetches, and that translation is what is under test.
const auth = vi.hoisted(() => ({ listeners: [] as AuthListener[] }));

vi.mock("../src/web/supabase.js", () => ({
  configError: null,
  signIn: vi.fn(),
  signOut: vi.fn(),
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthListener) => {
        auth.listeners.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                auth.listeners = auth.listeners.filter((l) => l !== cb);
              },
            },
          },
        };
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

vi.mock("../src/web/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web/api.js")>();
  return { ...actual, fetchMe: vi.fn() };
});

// A board that holds a draft of its own, which is what every real screen does
// and what a remount or a stray reload throws away.
vi.mock("../src/web/components/BoardScreen.js", async () => {
  const { createElement, useState } = await import("react");
  function BoardScreen({ org }: { org: Org }) {
    const [draft, setDraft] = useState("");
    return createElement("label", null, `Board of ${org.name}`,
      createElement("input", { value: draft, onChange: (e: { target: { value: string } }) => setDraft(e.target.value) }),
    );
  }
  return { BoardScreen };
});

const fetchMe = vi.mocked(api.fetchMe);

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
const OTHER: Org = { ...ORG, id: 8, slug: "other-office", name: "Other Office" };

const ME: Me = {
  profileId: "me",
  fullName: "Neyu",
  email: "neyu@example.com",
  mayFoundOffice: true,
  orgs: [
    { org: ORG, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" },
    { org: OTHER, role: "member", shortCode: "NEYU", paymentRef: "LUNCHNEYU", displayName: "Neyu" },
  ],
};

/** What supabase-js does: announce the session to every listener. */
function emit(event: string, userId: string | null) {
  act(() => {
    for (const l of auth.listeners) l(event, userId === null ? null : { user: { id: userId } });
  });
}

function at(url: string) {
  window.history.replaceState(null, "", url);
}

const board = (name: string) => screen.findByRole("textbox", { name: `Board of ${name}` });

beforeEach(() => {
  vi.clearAllMocks();
  auth.listeners = [];
  sessionStorage.clear();
  at("/#/o/test-office/board");
});

describe("App, who is signed in", () => {
  it("refetches the account when the user changes, not on every auth event", async () => {
    fetchMe.mockResolvedValue(ME);
    render(<App />);
    emit("INITIAL_SESSION", "me");
    const draft = await board("Test Office");
    await userEvent.type(draft, "half a thought");

    // Refocusing the tab and the hourly refresh, as supabase-js reports them.
    emit("SIGNED_IN", "me");
    emit("TOKEN_REFRESHED", "me");
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Board of Test Office" })).toHaveValue(
      "half a thought",
    );

    fetchMe.mockResolvedValue(null);
    emit("SIGNED_OUT", null);
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });

  it("shows a failed first read as an error with a retry, not as the sign-in page", async () => {
    fetchMe.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<App />);
    emit("INITIAL_SESSION", "me");

    expect(await screen.findByRole("heading", { name: "Lunch did not load" })).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();

    fetchMe.mockResolvedValue(ME);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await board("Test Office")).toBeInTheDocument();
  });

  it("says why the last sign-in came back empty", async () => {
    fetchMe.mockResolvedValue(null);
    render(<App oauthError="Signing in with Google was cancelled. Press the button to try again." />);
    emit("INITIAL_SESSION", null);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Signing in with Google was cancelled",
    );
  });
});

describe("App, routes", () => {
  it("puts back the route somebody signed in from", async () => {
    sessionStorage.setItem("lunch.returnTo", "#/o/other-office/board");
    // Where Google leaves them: the bare origin.
    at("/");
    fetchMe.mockResolvedValue(ME);
    render(<App />);
    emit("INITIAL_SESSION", "me");

    expect(await board("Other Office")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/o/other-office/board");
    expect(sessionStorage.getItem("lunch.returnTo")).toBeNull();
  });

  it("redirects an unknown office without leaving an entry for Back to bounce off", async () => {
    at("/#/o/nowhere/board");
    const before = window.history.length;
    fetchMe.mockResolvedValue(ME);
    render(<App />);
    emit("INITIAL_SESSION", "me");

    expect(await board("Test Office")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/o/test-office/board");
    expect(window.history.length).toBe(before);
  });

  it("starts the screen afresh in another office", async () => {
    fetchMe.mockResolvedValue(ME);
    render(<App />);
    emit("INITIAL_SESSION", "me");
    await userEvent.type(await board("Test Office"), "for the first office");

    act(() => {
      window.location.hash = "#/o/other-office/board";
    });

    expect(await board("Other Office")).toHaveValue("");
  });
});
