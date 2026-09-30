import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBoard, fetchMenu } from "../src/web/api/board.js";
import { fetchDishTakers, fetchPublishImpact } from "../src/web/api/menu.js";

// Every dish on a menu is on offer: there is no availability to filter on,
// and the column is dropped once no deployed client selects it. A read that
// still named it would fail whole the moment it goes.
const client = vi.hoisted(() => ({
  from: vi.fn(), selects: [] as string[], filters: [] as string[],
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: () => ({ auth: {}, from: client.from }) };
});

/** A query builder that records its select and resolves to `data`. */
function query(data: unknown) {
  const q: Record<string, unknown> = {};
  for (const step of ["gte", "lte", "in", "order", "single", "maybeSingle"]) q[step] = () => q;
  q.eq = (col: string, val: unknown) => {
    client.filters.push(`${col}=${String(val)}`);
    return q;
  };
  q.select = (cols: string) => {
    client.selects.push(cols);
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null, count: 0 });
  return q;
}

const DISHES = [
  { id: 12, name: "Pho", price_minor: 50000, position: 1 },
  { id: 11, name: "Com ga", price_minor: 45000, position: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  client.selects = [];
  client.filters = [];
});

describe("the Board's reads of a menu", () => {
  it("fetchMenu returns every dish, in order, without availability", async () => {
    client.from.mockImplementation(() =>
      query({
        id: 5, org_id: 1, service_date: "2026-10-14", status: "published",
        order_cutoff_at: "2026-10-14T03:00:00Z", menu_items: DISHES,
      }),
    );
    const menu = await fetchMenu(1, "2026-10-14");
    expect(menu?.items).toEqual([
      { id: 11, name: "Com ga", priceMinor: 45000, position: 0 },
      { id: 12, name: "Pho", priceMinor: 50000, position: 1 },
    ]);
    expect(client.selects.join(" ")).not.toMatch(/available/);
  });

  it("fetchBoard offers every dish on the day", async () => {
    client.from.mockImplementation((table: string) =>
      query(table === "menus"
        ? [{ id: 5, service_date: "2026-10-14", status: "published",
             order_cutoff_at: "2026-10-14T03:00:00Z", menu_items: DISHES }]
        : []),
    );
    const board = await fetchBoard({
      orgId: 1, from: "2026-10-14", to: "2026-10-14", meProfileId: "me", today: "2026-10-01",
    });
    expect(board.days[0]?.dishes).toEqual([
      { id: 11, name: "Com ga", priceMinor: 45000 },
      { id: 12, name: "Pho", priceMinor: 50000 },
    ]);
    expect(client.selects.join(" ")).not.toMatch(/available/);
  });
});

describe("the bot's read of a menu", () => {
  it("joins every dish, with no availability in its SQL", () => {
    const bot = readFileSync(
      join(import.meta.dirname, "..", "supabase", "functions", "telegram", "index.ts"),
      "utf8",
    );
    expect(bot).not.toMatch(/is_available/);
    expect(bot.replace(/\s+/g, " ")).toContain(
      "left join public.menu_items mi on mi.menu_id = m.id where m.org_id",
    );
  });
});

// A line the system wrote on a one-dish menu is nobody's choice: the Menu
// screen must not say "Ordered by" for it, nor refuse to remove its dish.
describe("the Menu screen's count of who chose a dish", () => {
  it("fetchDishTakers reads only lines somebody wrote", async () => {
    client.from.mockImplementation(() => query([]));
    await fetchDishTakers(5);
    expect(client.filters).toContain("auto_assigned=false");
  });

  it("the publish impact counts only lines somebody wrote as chosen", async () => {
    client.from.mockImplementation(() => query([]));
    await fetchPublishImpact({ orgId: 1, serviceDate: "2026-10-14", menuId: 5 });
    expect(client.filters.filter((f) => f === "auto_assigned=false")).toHaveLength(1);
  });
});
