/**
 * Putting right what the app recorded for a day that is already over.
 *
 * The read side is the board's own loader plus what the board deliberately
 * does not carry. `fetchBoard` already answers "who ate what on which day" for
 * a week, in the shape every other screen reads it in, so the corrections
 * screen shows exactly what the app thinks happened rather than a second
 * opinion assembled from the same tables. What it does not carry is the part
 * only this screen needs: how many portions and at what price each meal was
 * snapshotted, whether the week has been billed, what has already been
 * corrected, and where each person's account stands.
 *
 * The write side is four RPCs and nothing else. They own the Telegram message
 * to the affected member and the `order_corrections` row, which is why nothing
 * here touches `orders`, `order_items` or `menu_items` directly.
 */

import { supabase } from "../supabase.js";
import { cellKey, fetchBoard, type BoardDay } from "./board.js";
import type { BillPeriodStatus } from "./billing.js";

/** What a correction may carry as an explanation. The database enforces it too. */
export const REASON_MAX = 200;

/**
 * One person's meal on one day, as the record stands.
 *
 * One dish per order: the board writes one, and `correct_meal` replaces rather
 * than appends. An order carrying no dish at all is somebody marked down as
 * eating before a dish was chosen, and it has no portion and no price.
 */
export type RecordedMeal = {
  orderId: number;
  profileId: string;
  serviceDate: string;
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
  /** Set when this meal was handed on, and the other person now pays for it. */
  transferredToName: string | null;
};

/**
 * One correction that has already been made, as `order_corrections` records it.
 *
 * A reprice belongs to a dish rather than to a person, so `profileId` and
 * `orderId` are both null on one. Nothing that renders these may assume there
 * is somebody to name.
 */
export type CorrectionEntry = {
  id: number;
  serviceDate: string;
  kind: "meal" | "off_menu" | "removal" | "reprice";
  orderId: number | null;
  menuItemId: number | null;
  /** The affected member. Null on a reprice. */
  profileId: string | null;
  /** What the record says now, rendered when the correction was written. */
  summary: string;
  reason: string | null;
  madeBy: string;
  madeAt: string;
};

/** The billing week the days on screen fall in. */
export type CorrectionsPeriod = {
  periodId: number;
  periodStart: string;
  /** Inclusive. */
  periodEnd: string;
  status: BillPeriodStatus;
  /** When the week was settled. Null until it closes. */
  closedAt: string | null;
};

export type CorrectionsMember = {
  profileId: string;
  name: string;
  /** Positive is a debt, negative is credit, as on the Bill screen. */
  balanceMinor: number;
};

export type CorrectionsWeek = {
  days: BoardDay[];
  /** Everybody in the office, by name. No "you" first: this screen is about them. */
  members: CorrectionsMember[];
  /** Keyed `cellKey(profileId, serviceDate)`. */
  meals: Map<string, RecordedMeal>;
  /** Null when no billing period covers the week yet, which is an open week. */
  period: CorrectionsPeriod | null;
  /** Newest first, across the whole week. */
  entries: CorrectionEntry[];
};

type LineRow = {
  order_id: number;
  menu_item_id: number;
  item_name_snapshot: string;
  quantity: number;
  unit_price_minor: number | null;
  note: string | null;
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
  profile_id: string | null;
  summary: string;
  reason: string | null;
  made_by: string;
  made_at: string;
};

type BalanceRow = { profile_id: string; balance_minor: number | string | null };

/**
 * One week, as the admin finalising it needs to read it.
 *
 * The four supplementary queries run together and are all bounded by the week:
 * the lines by the orders the board found, the rest by the date range. None of
 * them is a second reading of something `fetchBoard` already answered.
 */
export async function fetchCorrectionsWeek(args: {
  orgId: number;
  from: string;
  /** Inclusive. */
  to: string;
  meProfileId: string;
  today: string;
}): Promise<CorrectionsWeek> {
  const board = await fetchBoard(args);

  const orderIds = [...board.cells.values()]
    .filter((c) => c.status === "placed" && c.orderId > 0)
    .map((c) => c.orderId);

  const [linesRes, periodRes, entriesRes, balancesRes] = await Promise.all([
    orderIds.length === 0
      ? Promise.resolve({ data: [] as LineRow[], error: null })
      : supabase
          .from("order_items")
          .select("order_id, menu_item_id, item_name_snapshot, quantity, unit_price_minor, note")
          .eq("org_id", args.orgId)
          .in("order_id", orderIds),
    supabase
      .from("billing_periods")
      .select("id, period_start, period_end, status, closed_at")
      .eq("org_id", args.orgId)
      // A void week is a retracted week, as everywhere else. The overlap test
      // rather than an exact match: the screen's week is the org's billing
      // week, and a period that does not line up is still the period whose
      // status decides whether these days can be corrected.
      .neq("status", "void")
      .lte("period_start", args.to)
      .gte("period_end", args.from)
      .order("period_start", { ascending: false })
      .limit(1),
    supabase
      .from("order_corrections")
      .select(
        "id, service_date, kind, order_id, menu_item_id, profile_id, summary, reason, made_by, made_at",
      )
      .eq("org_id", args.orgId)
      .gte("service_date", args.from)
      .lte("service_date", args.to)
      .order("made_at", { ascending: false }),
    supabase
      .from("v_account_balance")
      .select("profile_id, balance_minor")
      .eq("org_id", args.orgId),
  ]);

  if (linesRes.error) throw linesRes.error;
  if (periodRes.error) throw periodRes.error;
  if (entriesRes.error) throw entriesRes.error;
  if (balancesRes.error) throw balancesRes.error;

  const lineByOrder = new Map<number, LineRow>();
  for (const line of (linesRes.data ?? []) as LineRow[]) {
    if (!lineByOrder.has(line.order_id)) lineByOrder.set(line.order_id, line);
  }

  const balanceOf = new Map<string, number>();
  for (const row of (balancesRes.data ?? []) as BalanceRow[]) {
    // `sum(bigint)` is numeric, and PostgREST sends numeric as a string once it
    // outgrows a JSON number. Left as one it would concatenate downstream.
    balanceOf.set(row.profile_id, Number(row.balance_minor ?? 0));
  }

  const meals = new Map<string, RecordedMeal>();
  for (const member of board.members) {
    for (const day of board.days) {
      const key = cellKey(member.profileId, day.serviceDate);
      const cell = board.cells.get(key);
      if (cell === undefined || cell.status !== "placed") continue;
      const line = lineByOrder.get(cell.orderId) ?? null;
      meals.set(key, {
        orderId: cell.orderId,
        profileId: member.profileId,
        serviceDate: day.serviceDate,
        menuItemId: line?.menu_item_id ?? null,
        dishName: line?.item_name_snapshot ?? null,
        quantity: line?.quantity ?? 0,
        unitPriceMinor: line?.unit_price_minor ?? null,
        amountMinor:
          line === null || line.unit_price_minor === null
            ? null
            : line.unit_price_minor * line.quantity,
        note: line?.note ?? null,
        transferredToName: cell.transferredToName,
      });
    }
  }

  const periodRow = ((periodRes.data ?? []) as PeriodRow[])[0];

  return {
    days: board.days,
    members: board.members
      .map((m) => ({
        profileId: m.profileId,
        name: m.name,
        balanceMinor: balanceOf.get(m.profileId) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "vi")),
    meals,
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
      kind: e.kind as CorrectionEntry["kind"],
      orderId: e.order_id,
      menuItemId: e.menu_item_id,
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
 * An empty box is not a reason.
 *
 * The column is nullable and the absence of an explanation has to reach the
 * database as null, or every correction made without one carries a string that
 * reads as an explanation somebody gave.
 */
function given(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * `returns table (...)` reaches PostgREST as an array and a composite as an
 * object. Which one these are is the migration's business, not the screen's.
 */
function onlyRow<T>(data: unknown): T | null {
  return ((Array.isArray(data) ? data[0] : data) ?? null) as T | null;
}

export type CorrectedMeal = {
  orderId: number;
  /** The affected member's account as the database now has it. */
  balanceMinor: number;
};

/** What the record says this person had, replaced with what they actually had. */
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
  if (row === null) {
    throw new Error("The correction did not come back. Reload the day and check what it says.");
  }
  return { orderId: row.order_id, balanceMinor: Number(row.balance_minor) };
}

export type CorrectedOffMenu = CorrectedMeal & {
  /** The dish the correction added to that day's menu. */
  menuItemId: number;
};

/**
 * A dish that was served and was never on the menu, with the price it cost.
 *
 * The same act as picking a dish, one step further: the dish does not exist
 * yet, so the price comes with it. It joins the day's menu, which is what lets
 * it be repriced afterwards like any other.
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

  const row = onlyRow<{
    order_id: number;
    menu_item_id: number;
    balance_minor: number | string;
  }>(data);
  if (row === null) {
    throw new Error("The correction did not come back. Reload the day and check what it says.");
  }
  return {
    orderId: row.order_id,
    menuItemId: row.menu_item_id,
    balanceMinor: Number(row.balance_minor),
  };
}

/** A meal that did not happen, taken off the record and off the bill. */
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
  if (row === null) {
    throw new Error("The removal did not come back. Reload the day and check what it says.");
  }
  return { balanceMinor: Number(row.balance_minor) };
}

export type RepricedDish = {
  /** Order lines the new price was written onto. */
  lines: number;
  /** People whose bill moved. */
  people: number;
};

/**
 * One dish, one day, one price, on every line at once.
 *
 * The caterer charging something other than the menu said is a fact about the
 * dish, not about each person who ate it, so it is corrected once rather than
 * person by person. It is also the only control on this screen that moves
 * several people's money in one press.
 */
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
  if (row === null) {
    throw new Error("The price change did not come back. Reload the day and check the prices.");
  }
  return { lines: row.lines, people: row.people };
}
