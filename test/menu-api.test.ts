import { DishInUseError, fetchDishTakers, publishMenu } from "../src/web/api/menu.js";
import { humanError } from "../src/web/api/core.js";

// What the Menu screen reads about a dish's orders, and what it hears when
// publishing is refused, with the Supabase client faked at its edge.
const client = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), filters: [] as string[], selects: [] as string[],
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: () => ({ auth: {}, from: client.from, rpc: client.rpc }) };
});

/** A query builder that records its filters and resolves to `data`. */
function query(data: unknown) {
  const q: Record<string, unknown> = {};
  for (const step of ["in", "order"]) q[step] = () => q;
  q.select = (cols: string) => {
    client.selects.push(cols);
    return q;
  };
  q.eq = (col: string, val: unknown) => {
    client.filters.push(`${col}=${String(val)}`);
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  client.filters = [];
  client.selects = [];
});

describe("fetchDishTakers", () => {
  it("holds every dish with a line on it, names only placed orders, and keeps the system's apart", async () => {
    client.from.mockImplementation((table: string) =>
      table === "order_items"
        ? query([
            { menu_item_id: 101, profile_id: "teo", auto_assigned: false, orders: { status: "placed" } },
            { menu_item_id: 101, profile_id: "an", auto_assigned: false, orders: { status: "cancelled" } },
            // Every order on 102 was cancelled: nobody to name, still held.
            { menu_item_id: 102, profile_id: "quy", auto_assigned: false, orders: { status: "cancelled" } },
            // Written by the system on a one-dish menu: nobody chose it.
            { menu_item_id: 103, profile_id: "vy", auto_assigned: true, orders: { status: "placed" } },
          ])
        : query([
            { profile_id: "teo", display_name: "Tèo" },
            { profile_id: "vy", display_name: "Vy" },
          ]),
    );

    const { chosen, system } = await fetchDishTakers(5);

    expect(chosen).toEqual(new Map([[101, ["Tèo"]], [102, []]]));
    expect(system).toEqual(new Set([103]));
    // Neither kind of line may be filtered out in the query: whether the
    // system's hold depends on the day's stage, which only the screen knows.
    expect(client.filters).toEqual(["menu_id=5"]);
    expect(client.selects.join(" ")).toMatch(/auto_assigned/);
  });
});

describe("publishMenu's refusals", () => {
  const args = {
    orgId: 1, profileId: "me", serviceDate: "2026-10-02", cutoffAt: "2026-10-01T14:00:00Z",
    dishes: [{ id: 101, name: "Cơm gà", priceMinor: 45_000 }], sourceText: "", parseMeta: {},
  };

  it("turns the order line's foreign key into DishInUseError, naming the dish's id", async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23503",
        message:
          'update or delete on table "menu_items" violates foreign key constraint "order_items_menu_item_fk" on table "order_items"',
        details: 'Key (id, menu_id)=(102, 11) is still referenced from table "order_items".',
      },
    });

    const refusal = await publishMenu(args).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(DishInUseError);
    expect((refusal as DishInUseError).dishId).toBe(102);
    // Not the generic "conflicts with something else. Reload", which would
    // throw away the list being checked.
    expect(humanError(refusal)).toBe(
      "A dish being removed has an order on it, so it cannot be removed. Keep it, or mark its new row as the same dish.",
    );
  });

  it("still refuses without an id when the detail is missing", async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: "23503", message: 'violates foreign key constraint "order_items_menu_item_fk"' },
    });
    const refusal = await publishMenu(args).catch((e: unknown) => e);
    expect((refusal as DishInUseError).dishId).toBeNull();
  });

  it("passes any other refusal through unchanged", async () => {
    const other = { code: "P0001", message: "the menu is locked; dishes can no longer be changed" };
    client.rpc.mockResolvedValue({ data: null, error: other });
    await expect(publishMenu(args)).rejects.toBe(other);
  });
});
