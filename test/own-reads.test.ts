import { fetchMe, joinWithCode } from "../src/web/api/core.js";
import { fetchTelegramLinks, previewInvitation } from "../src/web/api/people.js";
import { createTelegramLink, fetchTelegramLink } from "../src/web/api/settings.js";

// The reads that answer for the caller alone go through functions, because
// the rows behind them are closed to a browser. What is under test is that the
// browser asks the function, and never the table.
const client = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: () => ({ auth: { getUser: client.getUser }, rpc: client.rpc, from: client.from }),
  };
});

/** A query builder whose every step returns itself and which resolves to `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const step of ["select", "eq", "single", "maybeSingle"]) q[step] = () => q;
  q.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return q;
}

const TOKEN = "0b7c9f2e-1111-4222-8333-944455556666";

beforeEach(() => {
  vi.clearAllMocks();
  client.from.mockImplementation((table: string) => {
    throw new Error(`no read of ${table} expected`);
  });
});

describe("the Telegram link", () => {
  it("is read through my_telegram_link, not from telegram_links", async () => {
    client.rpc.mockResolvedValue({
      data: [{ membership_id: 3, link_token: TOKEN, linked: true }],
      error: null,
    });
    await expect(fetchTelegramLink(7)).resolves.toEqual({
      membershipId: 3, linkToken: TOKEN, linked: true,
    });
    expect(client.rpc).toHaveBeenCalledWith("my_telegram_link", { p_org_id: 7 });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("is null when there is none yet", async () => {
    client.rpc.mockResolvedValue({ data: [], error: null });
    await expect(fetchTelegramLink(7)).resolves.toBeNull();
  });

  it("is minted through create_my_telegram_link", async () => {
    client.rpc.mockResolvedValue({
      data: [{ membership_id: 3, link_token: TOKEN, linked: false }],
      error: null,
    });
    await expect(createTelegramLink(7)).resolves.toEqual({
      membershipId: 3, linkToken: TOKEN, linked: false,
    });
    expect(client.rpc).toHaveBeenCalledWith("create_my_telegram_link", { p_org_id: 7 });
    expect(client.from).not.toHaveBeenCalled();
  });
});

describe("who in the office linked Telegram", () => {
  it("reads only linked rows, and never the token or the chat id", async () => {
    const steps: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const step of ["select", "eq", "not"]) {
      q[step] = (...args: unknown[]) => {
        steps.push([step, args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data: [
          { membership_id: 3, linked_at: "2026-09-03T02:00:00Z" },
          { membership_id: 5, linked_at: null },
        ],
        error: null,
      });
    client.from.mockImplementation((table: string) => {
      if (table !== "telegram_links") throw new Error(`no read of ${table} expected`);
      return q;
    });

    const links = await fetchTelegramLinks(7);

    expect([...links]).toEqual([[3, "2026-09-03T02:00:00Z"], [5, null]]);
    expect(steps).toEqual([
      ["select", ["membership_id, linked_at"]],
      ["eq", ["org_id", 7]],
      ["not", ["chat_id", "is", null]],
    ]);
  });
});

describe("previewing an invitation", () => {
  it("does not ask about a token that is not shaped like one", async () => {
    await expect(previewInvitation("not-a-token")).resolves.toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("maps the office, role, expiry and state", async () => {
    client.rpc.mockResolvedValue({
      data: [{ org_name: "Acme", role: "admin", expires_at: "2026-10-12T09:00:00Z", state: "valid" }],
      error: null,
    });
    await expect(previewInvitation(TOKEN)).resolves.toEqual({
      orgName: "Acme", role: "admin", expiresAt: "2026-10-12T09:00:00Z", state: "valid",
    });
    expect(client.rpc).toHaveBeenCalledWith("invitation_preview", { p_token: TOKEN });
  });

  it("is null for a token that matches nothing", async () => {
    client.rpc.mockResolvedValue({ data: [], error: null });
    await expect(previewInvitation(TOKEN)).resolves.toBeNull();
  });
});

describe("fetchMe, for somebody with no office", () => {
  function signedInWith(memberships: unknown[]) {
    client.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "u@x.test" } }, error: null });
    client.from.mockImplementation((table: string) =>
      query(
        table === "memberships"
          ? { data: memberships, error: null }
          : table === "profiles"
            ? { data: { full_name: "U", email: "u@x.test" }, error: null }
            : { data: { enabled: false }, error: null },
      ));
  }

  it("names the offices they were removed from apart from the ones they left", async () => {
    signedInWith([]);
    client.rpc.mockResolvedValue({
      data: [{ org_name: "Acme", removed: true }, { org_name: "Beta", removed: false }],
      error: null,
    });
    const me = await fetchMe();
    expect(me?.removedFrom).toEqual(["Acme"]);
    expect(me?.leftFrom).toEqual(["Beta"]);
    expect(client.rpc).toHaveBeenCalledWith("my_former_offices");
  });

  it("says nothing it does not know when the question fails", async () => {
    signedInWith([]);
    client.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const me = await fetchMe();
    expect(me).not.toBeNull();
    expect(me?.removedFrom).toBeUndefined();
    expect(me?.leftFrom).toBeUndefined();
  });

  it("does not ask somebody who is in an office", async () => {
    signedInWith([{
      role: "member", short_code: "U", short_code_changes: 0, display_name: null,
      payment_ref: "LUNCHU",
      organizations: { id: 1, slug: "acme", name: "Acme", timezone: "Asia/Ho_Chi_Minh" },
    }]);
    const me = await fetchMe();
    expect(me?.orgs).toHaveLength(1);
    expect(me?.removedFrom).toBeUndefined();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("joining with a code from the browser", () => {
  it("names no Telegram chat: only the bot binds one", async () => {
    client.rpc.mockResolvedValue({ data: [{ org_slug: "acme", org_name: "Acme" }], error: null });
    await expect(joinWithCode({ code: " kgsd4582 ", displayName: " Neyu " }))
      .resolves.toEqual({ slug: "acme", name: "Acme" });
    expect(client.rpc).toHaveBeenCalledWith("join_with_code", {
      p_code: "KGSD4582", p_display_name: "Neyu", p_short_code: null,
    });
    expect(client.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_chat_id");
  });
});
