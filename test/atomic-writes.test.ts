import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Board's dish choice and the Menu screen's Publish are one database
 * function call each, so that a refusal or a second device part way through
 * cannot leave half of either written. What is asserted is the call that
 * reaches the client: one RPC, no table writes beside it, and nothing the
 * database decides for itself (who the order belongs to, prices) sent at all.
 */
const db = vi.hoisted(() => {
  const tables: string[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const results: Array<{ data: unknown; error: unknown }> = [];
  return {
    tables,
    rpcCalls,
    results,
    from(table: string) {
      tables.push(table);
      throw new Error(`no table call expected, got ${table}`);
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(results.shift() ?? { data: null, error: null });
    },
  };
});

vi.mock("../src/web/supabase.js", () => ({
  configError: null,
  supabase: {
    from: (table: string) => db.from(table),
    rpc: (fn: string, args: unknown) => db.rpc(fn, args),
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { setOrder, publishMenu } = await import("../src/web/api.js");

beforeEach(() => {
  db.tables.length = 0;
  db.rpcCalls.length = 0;
  db.results.length = 0;
});

const CELL = { orgId: 7, menuId: 5, serviceDate: "2026-10-14", profileId: "me" };

describe("setOrder", () => {
  it("is one call to set_my_order, naming the menu, the dish and the note only", async () => {
    await setOrder({ ...CELL, itemId: 12, note: "  ít cay  ", existing: null });

    expect(db.tables).toEqual([]);
    // No profile: the function takes the caller from the session, so the order
    // is always their own. No price: the snapshot trigger copies it.
    expect(db.rpcCalls).toEqual([
      { fn: "set_my_order", args: { p_menu_id: 5, p_menu_item_id: 12, p_note: "ít cay" } },
    ]);
  });

  it("sends an emptied note as null, and a long one cut to the constraint's 120", async () => {
    await setOrder({ ...CELL, itemId: 12, note: "   ", existing: null });
    await setOrder({ ...CELL, itemId: 12, note: "x".repeat(200), existing: null });

    expect(db.rpcCalls.map((c) => (c.args as { p_note: string | null }).p_note))
      .toEqual([null, "x".repeat(120)]);
  });

  it("is the same one call for an existing, even a cancelled, order", async () => {
    await setOrder({
      ...CELL, itemId: 13, note: null,
      existing: {
        id: 42, status: "cancelled", source: "standing",
        itemId: null, itemName: null, unitPriceMinor: null,
      },
    });

    expect(db.rpcCalls).toEqual([
      { fn: "set_my_order", args: { p_menu_id: 5, p_menu_item_id: 13, p_note: null } },
    ]);
  });

  it("passes the database's refusal on", async () => {
    db.results.push({ data: null, error: { message: "ordering for 14/10 closed at 21:00 13/10" } });

    await expect(setOrder({ ...CELL, itemId: 12, existing: null }))
      .rejects.toMatchObject({ message: /closed at/ });
  });
});

describe("publishMenu", () => {
  const ARGS = {
    orgId: 7,
    profileId: "me",
    serviceDate: "2026-10-14",
    cutoffAt: "2026-10-13T14:00:00.000Z",
    dishes: [
      { id: 101, name: "Cơm gà", priceMinor: 45_000 },
      { name: "Phở", priceMinor: null },
    ],
    sourceText: "Cơm gà 45k\nPhở",
    parseMeta: { readBy: "rules" },
  };

  it("is one call to publish_menu with the dishes in display order", async () => {
    db.results.push({
      data: [{ menu_id: 11, standing_orders: 3, was_update: false }], error: null,
    });

    const result = await publishMenu(ARGS);

    expect(db.tables).toEqual([]);
    expect(db.rpcCalls).toEqual([{
      fn: "publish_menu",
      args: {
        p_org_id: 7,
        p_service_date: "2026-10-14",
        p_cutoff_at: "2026-10-13T14:00:00.000Z",
        // An unpriced dish stays null all the way down; zero would be a price.
        p_dishes: [
          { id: 101, name: "Cơm gà", price_minor: 45_000 },
          { id: null, name: "Phở", price_minor: null },
        ],
        p_source_text: "Cơm gà 45k\nPhở",
        p_parse_meta: { readBy: "rules" },
      },
    }]);
    expect(result).toEqual({ menuId: 11, dishes: 2, standingOrders: 3, wasUpdate: false });
  });

  it("reports a republish as the database answers it", async () => {
    db.results.push({
      data: [{ menu_id: 11, standing_orders: 0, was_update: true }], error: null,
    });

    expect(await publishMenu(ARGS)).toEqual({
      menuId: 11, dishes: 2, standingOrders: 0, wasUpdate: true,
    });
  });

  it("passes the database's refusal on", async () => {
    db.results.push({
      data: null, error: { message: "the menu is locked; dishes can no longer be changed" },
    });

    await expect(publishMenu(ARGS)).rejects.toMatchObject({ message: /locked/ });
  });

  it("says so rather than reporting success when nothing comes back", async () => {
    db.results.push({ data: [], error: null });

    await expect(publishMenu(ARGS)).rejects.toThrow(/not published/);
  });
});
