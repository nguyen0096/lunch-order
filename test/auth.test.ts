import { AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { fetchMe } from "../src/web/api/core.js";
import { signIn, signOut } from "../src/web/supabase.js";

// The client itself is the edge. The error classes stay real, because telling
// "no session" from "no network" by class is what is under test.
const client = vi.hoisted(() => ({
  getUser: vi.fn(),
  signOut: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: () => ({
      auth: {
        getUser: client.getUser,
        signOut: client.signOut,
        signInWithOAuth: client.signInWithOAuth,
      },
      from: () => {
        throw new Error("no table read expected");
      },
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("fetchMe", () => {
  it("is signed out when there is no session", async () => {
    client.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(fetchMe()).resolves.toBeNull();
  });

  it("throws on a dropped connection instead of reporting the person signed out", async () => {
    client.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("Failed to fetch", 0),
    });
    await expect(fetchMe()).rejects.toThrow("Failed to fetch");
  });
});

describe("signing in and out", () => {
  it("signs out of this device only", async () => {
    client.signOut.mockResolvedValue({ error: null });
    await signOut();
    expect(client.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("parks the route before leaving for Google", async () => {
    client.signInWithOAuth.mockResolvedValue({ data: {}, error: null });
    window.history.replaceState(null, "", "/#/join/0b7c9f2e-1111-4222-8333-944455556666");
    await signIn();
    expect(sessionStorage.getItem("lunch.returnTo")).toBe(
      "#/join/0b7c9f2e-1111-4222-8333-944455556666",
    );
    expect(client.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google" }),
    );
  });
});
