import { fetchTransfers, offerStands } from "../src/web/api/board.js";

// An offer can be left waiting on a cancelled order, or on the order placed
// again after it. The database refuses accepting either, so the Board must not
// put Accept and Decline in front of it.
const client = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: () => ({ auth: { getUser: vi.fn() }, from: client.from }) };
});

function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const step of ["select", "eq", "gte", "order"]) q[step] = () => q;
  q.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return q;
}

const ME = "00000000-0000-0000-0000-0000000000d1";
const TEO = "00000000-0000-0000-0000-0000000000a1";

function offer(id: number, order: { status: string; placed_at: string }, createdAt: string) {
  return {
    id, order_id: 100 + id, status: "pending", from_profile_id: TEO, to_profile_id: ME,
    reason: null, created_at: createdAt,
    orders: { service_date: "2026-10-20", ...order, order_items: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.from.mockImplementation((table: string) => {
    if (table === "meal_transfers") {
      return query({
        data: [
          offer(1, { status: "placed", placed_at: "2026-10-02T06:00:00.000+00:00" }, "2026-10-02T07:00:00.000+00:00"),
          offer(2, { status: "placed", placed_at: "2026-10-02T08:00:00.000+00:00" }, "2026-10-02T07:00:00.000+00:00"),
          offer(3, { status: "cancelled", placed_at: "2026-10-02T06:00:00.000+00:00" }, "2026-10-02T07:00:00.000+00:00"),
        ],
        error: null,
      });
    }
    if (table === "orders" || table === "memberships") return query({ data: [], error: null });
    throw new Error(`no read of ${table} expected`);
  });
});

describe("an offer made to me", () => {
  it("is shown to answer while its order stands as it was offered", async () => {
    const { incoming } = await fetchTransfers({ orgId: 7, meProfileId: ME, openPeriodStart: "2026-10-19" });
    expect(incoming.map((t) => t.id)).toEqual([1]);
  });

  it("is not, once the order was placed again after it or is cancelled", () => {
    expect(offerStands({ orderStatus: "placed", placedAt: "2026-10-02T08:00:00Z", offeredAt: "2026-10-02T07:00:00Z" }))
      .toBe(false);
    expect(offerStands({ orderStatus: "cancelled", placedAt: "2026-10-02T06:00:00Z", offeredAt: "2026-10-02T07:00:00Z" }))
      .toBe(false);
    expect(offerStands({ orderStatus: "placed", placedAt: "2026-10-02T07:00:00Z", offeredAt: "2026-10-02T07:00:00Z" }))
      .toBe(true);
  });

  it("still counts as live on the meal, so nobody offers it twice", async () => {
    const { live } = await fetchTransfers({ orgId: 7, meProfileId: ME, openPeriodStart: "2026-10-19" });
    expect([...live.keys()].sort()).toEqual([101, 102, 103]);
  });
});
