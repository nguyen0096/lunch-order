import { fetchBoard } from "../src/web/api/board.js";

// Who the Board has a row for. Somebody who left keeps the orders whose
// ordering had closed, and those count in the day's total, so the Board reads
// every membership and keeps a gone one only while they have a placed order
// in the range.
const client = vi.hoisted(() => ({
  from: vi.fn(), filters: [] as string[],
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: () => ({ auth: {}, from: client.from }) };
});

function query(table: string, data: unknown) {
  const q: Record<string, unknown> = {};
  for (const step of ["select", "gte", "lte", "in", "order", "single", "maybeSingle"]) q[step] = () => q;
  q.eq = (col: string, val: unknown) => {
    client.filters.push(`${table}.${col}=${String(val)}`);
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null, count: 0 });
  return q;
}

const member = (profile_id: string, name: string, status: "active" | "inactive") => ({
  profile_id, short_code: name.toUpperCase(), display_name: name, status, profiles: { full_name: name },
});

const order = (id: number, profile_id: string, status: "placed" | "cancelled") => ({
  id, profile_id, service_date: "2026-10-14", status, source: "member",
  order_items: [{ menu_item_id: 11, item_name_snapshot: "Pho", line_total_minor: 50000, quantity: 1, note: null }],
});

function serve(memberships: unknown[], orders: unknown[]) {
  client.from.mockImplementation((table: string) =>
    query(table, table === "memberships" ? memberships : table === "orders" ? orders : []),
  );
}

const read = () =>
  fetchBoard({ orgId: 1, from: "2026-10-12", to: "2026-10-18", meProfileId: "me", today: "2026-10-05" });

beforeEach(() => {
  vi.clearAllMocks();
  client.filters = [];
});

describe("the Board's rows", () => {
  it("reads every membership, not only the active ones", async () => {
    serve([], []);
    await read();
    expect(client.filters).toContain("memberships.org_id=1");
    expect(client.filters.filter((f) => f.startsWith("memberships.status"))).toEqual([]);
  });

  it("keeps somebody gone only while they have a placed order in the range, after everybody here", async () => {
    serve(
      [
        member("binh", "Binh", "inactive"),
        member("me", "Neyu", "active"),
        member("an", "An", "active"),
        member("cuong", "Cuong", "inactive"),
        member("dung", "Dung", "inactive"),
      ],
      [order(1, "binh", "placed"), order(2, "cuong", "cancelled"), order(3, "an", "placed")],
    );
    const board = await read();
    expect(board.members.map((m) => [m.name, m.gone])).toEqual([
      ["Neyu", false],
      ["An", false],
      ["Binh", true],
    ]);
    // Her cell is read like anybody's, so the day's total counts it.
    expect(board.cells.get("binh|2026-10-14")?.status).toBe("placed");
  });

  it("names somebody gone on a meal passed to them", async () => {
    client.from.mockImplementation((table: string) =>
      query(table,
        table === "memberships" ? [member("me", "Neyu", "active"), member("binh", "Binh", "inactive")]
        : table === "orders" ? [order(1, "me", "placed")]
        : table === "meal_transfers" ? [{ order_id: 1, to_profile_id: "binh", status: "accepted" }]
        : []),
    );
    const board = await read();
    expect(board.cells.get("me|2026-10-14")?.transferredToName).toBe("Binh");
  });
});
