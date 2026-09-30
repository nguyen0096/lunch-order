/**
 * The admin's Orders screen: what everybody had on each day of a week, and
 * the writes that set it on their behalf.
 *
 * The read side is the Board's own loader plus what the Board does not carry:
 * each meal's portions, price and provenance, the passes on the week's meals,
 * whether the week has been billed, what admins have changed, and where each
 * person's account stands. `fetchBoard` answers "who ate what" the way every
 * other screen reads it, so this screen shows the same record rather than a
 * second opinion assembled from the same tables.
 *
 * The write side is seven RPCs and nothing else. They own the audit row, the
 * re-bill and the Telegram message to the people affected, which is why
 * nothing here writes `orders`, `order_items`, `menu_items` or
 * `meal_transfers` directly.
 */

import { supabase } from "../supabase.js";
import { fetchBoard, type BoardDay } from "./board.js";
import type { BillPeriodStatus } from "./billing.js";

/** What a change may carry as an explanation. The database enforces it too. */
export const REASON_MAX = 200;

/** One person's placed meal on one day, as the record stands. */
export type RecordedMeal = {
  orderId: number;
  profileId: string;
  serviceDate: string;
  /** `admin` means an admin recorded it; the others are the member's. */
  source: "member" | "standing" | "admin";
  /** Who first put the row there, and when. */
  createdBy: string;
  createdAt: string;
  /** Null when the order records somebody eating without naming a dish. */
  menuItemId: number | null;
  dishName: string | null;
  /** 0 when there is no dish on the order. */
  quantity: number;
  /** Null while the caterer has not priced the dish. Never coalesced to 0. */
  unitPriceMinor: number | null;
  /** Quantity at that price, or null while there is no price to multiply. */
  amountMinor: number | null;
  /** How the person wanted it. It goes to the caterer, not to the ledger. */
  note: string | null;
};

/** A pass on one of the week's meals that is still live. */
export type PassRecord = {
  id: number;
  orderId: number;
  status: "pending" | "accepted";
  fromProfileId: string;
  toProfileId: string;
  createdBy: string;
  createdAt: string;
  /** When it was accepted. Null while it waits. */
  decidedAt: string | null;
  decidedBy: string | null;
};

export type CorrectionKind =
  | "meal"
  | "off_menu"
  | "removal"
  | "reprice"
  | "pass"
  | "pass_declined"
  | "pass_withdrawn"
  | "pass_undone";

/**
 * One change an admin made, as `order_corrections` records it.
 *
 * A reprice belongs to a dish rather than to a person, so `profileId` and
 * `orderId` are both null on one.
 */
export type CorrectionEntry = {
  id: number;
  serviceDate: string;
  kind: CorrectionKind;
  orderId: number | null;
  menuItemId: number | null;
  transferId: number | null;
  /** The meal's owner. Null on a reprice. */
  profileId: string | null;
  /** What the record said, rendered when the change was written. */
  summary: string;
  reason: string | null;
  madeBy: string;
  madeAt: string;
};

/** The billing week the days on screen fall in. */
export type OrdersPeriod = {
  periodId: number;
  periodStart: string;
  /** Inclusive. */
  periodEnd: string;
  status: BillPeriodStatus;
  /** When the week was settled. Null until it closes. */
  closedAt: string | null;
};

export type OrdersMember = {
  profileId: string;
  name: string;
  isMe: boolean;
  /** Positive is a debt, negative is credit, as on the Bill screen. */
  balanceMinor: number;
};

export type OrdersWeek = {
  days: BoardDay[];
  /** Everybody active in the office: the reader first, then by name. */
  members: OrdersMember[];
  /** Placed meals only, keyed `cellKey(profileId, serviceDate)`. */
  meals: Map<string, RecordedMeal>;
  /** Live passes by order id. */
  passes: Map<number, PassRecord>;
  /** Null when no billing period covers the week yet, which is an open week. */
  period: OrdersPeriod | null;
  /** Newest first, across the whole week. */
  entries: CorrectionEntry[];
};

type OrderRow = {
  id: number;
  created_by: string;
  created_at: string;
  order_items: Array<{
    menu_item_id: number;
    item_name_snapshot: string;
    quantity: number;
    unit_price_minor: number | null;
    note: string | null;
  }>;
};

type PassRow = {
  id: number;
  order_id: number;
  status: string;
  from_profile_id: string;
  to_profile_id: string;
  created_by: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

type PeriodRow = {
  id: number;
  period_start: string;
  period_end: string;
  status: string;
  closed_at: string | null;
};

type EntryRow = {
  id: number;
  service_date: string;
  kind: string;
  order_id: number | null;
  menu_item_id: number | null;
  transfer_id: number | null;
  profile_id: string | null;
  summary: string;
  reason: string | null;
  made_by: string;
  made_at: string;
};

type BalanceRow = { profile_id: string; balance_minor: number | string | null };

/**
 * One week, as the admin ordering for everybody needs to read it.
 *
 * The supplementary queries run together and are bounded by the week: the
 * orders and passes by the placed orders the board found, the rest by the
 * date range.
 */
export async function fetchOrdersWeek(args: {
  orgId: number;
  from: string;
  /** Inclusive. */
  to: string;
  meProfileId: string;
  today: string;
}): Promise<OrdersWeek> {
  const board = await fetchBoard(args);

  const placed = [...board.cells.entries()].filter(
    ([, c]) => c.status === "placed" && c.orderId > 0,
  );
  const orderIds = placed.map(([, c]) => c.orderId);

  const none = <T,>() => Promise.resolve({ data: [] as T[], error: null });
  const [ordersRes, passesRes, periodRes, entriesRes, balancesRes] = await Promise.all([
    orderIds.length === 0
      ? none<OrderRow>()
      : supabase
          .from("orders")
          .select(
            "id, created_by, created_at, order_items ( menu_item_id, item_name_snapshot, quantity, unit_price_minor, note )",
          )
          .eq("org_id", args.orgId)
          .in("id", orderIds),
    orderIds.length === 0
      ? none<PassRow>()
      : supabase
          .from("meal_transfers")
          .select(
            "id, order_id, status, from_profile_id, to_profile_id, created_by, created_at, decided_at, decided_by",
          )
          .eq("org_id", args.orgId)
          .in("order_id", orderIds)
          .in("status", ["pending", "accepted"]),
    supabase
      .from("billing_periods")
      .select("id, period_start, period_end, status, closed_at")
      .eq("org_id", args.orgId)
      // A void week is a retracted week. The overlap test rather than an
      // exact match: a period that does not line up with the screen's week is
      // still the one whose status decides whether these days can change.
      .neq("status", "void")
      .lte("period_start", args.to)
      .gte("period_end", args.from)
      .order("period_start", { ascending: false })
      .limit(1),
    supabase
      .from("order_corrections")
      .select(
        "id, service_date, kind, order_id, menu_item_id, transfer_id, profile_id, summary, reason, made_by, made_at",
      )
      .eq("org_id", args.orgId)
      .gte("service_date", args.from)
      .lte("service_date", args.to)
      .order("made_at", { ascending: false }),
    supabase.from("v_account_balance").select("profile_id, balance_minor").eq("org_id", args.orgId),
  ]);

  for (const r of [ordersRes, passesRes, periodRes, entriesRes, balancesRes]) {
    if (r.error) throw r.error;
  }

  const orderById = new Map<number, OrderRow>();
  for (const o of (ordersRes.data ?? []) as OrderRow[]) orderById.set(o.id, o);

  const balanceOf = new Map<string, number>();
  for (const row of (balancesRes.data ?? []) as BalanceRow[]) {
    // `sum(bigint)` is numeric, which PostgREST sends as a string once it
    // outgrows a JSON number. Left as one it would concatenate downstream.
    balanceOf.set(row.profile_id, Number(row.balance_minor ?? 0));
  }

  const meals = new Map<string, RecordedMeal>();
  for (const [key, cell] of placed) {
    const order = orderById.get(cell.orderId);
    const line = order?.order_items[0] ?? null;
    const [profileId = "", serviceDate = ""] = key.split("|");
    meals.set(key, {
      orderId: cell.orderId,
      profileId,
      serviceDate,
      source: cell.source,
      createdBy: order?.created_by ?? profileId,
      createdAt: order?.created_at ?? "",
      menuItemId: line?.menu_item_id ?? null,
      dishName: line?.item_name_snapshot ?? null,
      quantity: line?.quantity ?? 0,
      unitPriceMinor: line?.unit_price_minor ?? null,
      amountMinor:
        line === null || line.unit_price_minor === null ? null : line.unit_price_minor * line.quantity,
      note: line?.note ?? null,
    });
  }

  const passes = new Map<number, PassRecord>();
  for (const p of (passesRes.data ?? []) as PassRow[]) {
    passes.set(p.order_id, {
      id: p.id,
      orderId: p.order_id,
      status: p.status as PassRecord["status"],
      fromProfileId: p.from_profile_id,
      toProfileId: p.to_profile_id,
      createdBy: p.created_by,
      createdAt: p.created_at,
      decidedAt: p.decided_at,
      decidedBy: p.decided_by,
    });
  }

  const periodRow = ((periodRes.data ?? []) as PeriodRow[])[0];

  return {
    days: board.days,
    members: board.members
      .map((m) => ({
        profileId: m.profileId,
        name: m.name,
        isMe: m.isMe,
        balanceMinor: balanceOf.get(m.profileId) ?? 0,
      }))
      .sort((a, b) =>
        a.isMe === b.isMe ? a.name.localeCompare(b.name, "vi") : a.isMe ? -1 : 1,
      ),
    meals,
    passes,
    period:
      periodRow === undefined
        ? null
        : {
            periodId: periodRow.id,
            periodStart: periodRow.period_start,
            periodEnd: periodRow.period_end,
            status: periodRow.status as BillPeriodStatus,
            closedAt: periodRow.closed_at,
          },
    entries: ((entriesRes.data ?? []) as EntryRow[]).map((e) => ({
      id: e.id,
      serviceDate: e.service_date,
      kind: e.kind as CorrectionKind,
      orderId: e.order_id,
      menuItemId: e.menu_item_id,
      transferId: e.transfer_id,
      profileId: e.profile_id,
      summary: e.summary,
      reason: e.reason,
      madeBy: e.made_by,
      madeAt: e.made_at,
    })),
  };
}

/* ----------------------------------------------------------------- writing */

/**
 * An empty box is not a reason. The column is nullable, and a blank has to
 * reach the database as null or it reads as an explanation somebody gave.
 */
function given(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** `returns table (...)` reaches PostgREST as an array, a composite as an object. */
function onlyRow<T>(data: unknown): T | null {
  return ((Array.isArray(data) ? data[0] : data) ?? null) as T | null;
}

const LOST = "The change did not come back. Reload the week and check what it says.";

export type CorrectedMeal = {
  orderId: number;
  /** The meal owner's account as the database now has it. */
  balanceMinor: number;
};

/** This person's dish, portions and note on this day, set on their behalf. */
export async function correctMeal(args: {
  orgId: number;
  serviceDate: string;
  profileId: string;
  menuItemId: number;
  quantity: number;
  note: string | null;
  reason: string | null;
}): Promise<CorrectedMeal> {
  const { data, error } = await supabase.rpc("correct_meal", {
    p_org_id: args.orgId,
    p_service_date: args.serviceDate,
    p_profile_id: args.profileId,
    p_menu_item_id: args.menuItemId,
    p_quantity: args.quantity,
    p_note: given(args.note),
    p_reason: given(args.reason),
  });
  if (error) throw error;

  const row = onlyRow<{ order_id: number; balance_minor: number | string }>(data);
  if (row === null) throw new Error(LOST);
  return { orderId: row.order_id, balanceMinor: Number(row.balance_minor) };
}

export type CorrectedOffMenu = CorrectedMeal & {
  /** The dish the change added to that day's menu. */
  menuItemId: number;
};

/**
 * A dish that was never on the menu, with the price it cost. It joins the
 * day's menu, which is what lets it be repriced afterwards like any other.
 */
export async function correctMealOffMenu(args: {
  orgId: number;
  serviceDate: string;
  profileId: string;
  dishName: string;
  priceMinor: number;
  quantity: number;
  note: string | null;
  reason: string | null;
}): Promise<CorrectedOffMenu> {
  const { data, error } = await supabase.rpc("correct_meal_off_menu", {
    p_org_id: args.orgId,
    p_service_date: args.serviceDate,
    p_profile_id: args.profileId,
    p_dish_name: args.dishName.normalize("NFC").trim(),
    p_price_minor: args.priceMinor,
    p_quantity: args.quantity,
    p_note: given(args.note),
    p_reason: given(args.reason),
  });
  if (error) throw error;

  const row = onlyRow<{ order_id: number; menu_item_id: number; balance_minor: number | string }>(data);
  if (row === null) throw new Error(LOST);
  return { orderId: row.order_id, menuItemId: row.menu_item_id, balanceMinor: Number(row.balance_minor) };
}

/** A meal that did not happen, or will not: off the record and off the bill. */
export async function removeMeal(args: {
  orderId: number;
  reason: string | null;
}): Promise<{ balanceMinor: number }> {
  const { data, error } = await supabase.rpc("remove_meal", {
    p_order_id: args.orderId,
    p_reason: given(args.reason),
  });
  if (error) throw error;

  const row = onlyRow<{ balance_minor: number | string }>(data);
  if (row === null) throw new Error(LOST);
  return { balanceMinor: Number(row.balance_minor) };
}

export type RepricedDish = {
  /** Order lines the new price was written onto. */
  lines: number;
  /** People whose bill moved. */
  people: number;
};

/** One dish, one day, one price, on every line at once. */
export async function repriceDish(args: {
  menuItemId: number;
  priceMinor: number;
  reason: string | null;
}): Promise<RepricedDish> {
  const { data, error } = await supabase.rpc("reprice_dish", {
    p_menu_item_id: args.menuItemId,
    p_price_minor: args.priceMinor,
    p_reason: given(args.reason),
  });
  if (error) throw error;

  const row = onlyRow<{ lines: number; people: number }>(data);
  if (row === null) throw new Error(LOST);
  return { lines: row.lines, people: row.people };
}

/** Both people's accounts after a pass moved, as the database now has them. */
export type PassResult = {
  transferId: number;
  fromBalanceMinor: number;
  toBalanceMinor: number;
};

function passResult(data: unknown): PassResult {
  const row = onlyRow<{
    transfer_id: number;
    from_balance_minor: number | string;
    to_balance_minor: number | string;
  }>(data);
  if (row === null) throw new Error(LOST);
  return {
    transferId: row.transfer_id,
    fromBalanceMinor: Number(row.from_balance_minor),
    toBalanceMinor: Number(row.to_balance_minor),
  };
}

/** "This meal went to somebody else." Accepted at once; both are told. */
export async function recordPass(args: {
  orderId: number;
  toProfileId: string;
  reason: string | null;
}): Promise<PassResult> {
  const { data, error } = await supabase.rpc("record_pass", {
    p_order_id: args.orderId,
    p_to_profile_id: args.toProfileId,
    p_reason: given(args.reason),
  });
  if (error) throw error;
  return passResult(data);
}

export type PassAnswer = "accept" | "decline" | "withdraw";

/** A member's waiting offer, answered or withdrawn on their behalf. */
export async function answerPass(args: {
  transferId: number;
  answer: PassAnswer;
  reason: string | null;
}): Promise<PassResult> {
  const { data, error } = await supabase.rpc("answer_pass", {
    p_transfer_id: args.transferId,
    p_answer: args.answer,
    p_reason: given(args.reason),
  });
  if (error) throw error;
  return passResult(data);
}

/** An accepted pass reversed: the meal goes back on the giver's bill. */
export async function undoPass(args: {
  transferId: number;
  reason: string | null;
}): Promise<PassResult> {
  const { data, error } = await supabase.rpc("undo_pass", {
    p_transfer_id: args.transferId,
    p_reason: given(args.reason),
  });
  if (error) throw error;
  return passResult(data);
}
