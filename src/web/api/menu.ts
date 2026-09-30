/**
 * The admin's menu editor: what a date currently holds, what the caterer's
 * message parses to, and publishing.
 */

import { supabase } from "../supabase.js";
import { isoWeekday } from "../../shared/dates.js";
import type { CatererLine, CatererOrder } from "../../shared/catererOrder.js";
import type { MenuStatus } from "../../shared/types.js";

/* ------------------------------------------------------- admin: publishing */

/** `id` is the menu_items row this stands for; absent means a dish being added. */
/** `priceMinor` null means the caterer has not priced it yet. */
export type DraftDish = { id?: number; name: string; priceMinor: number | null };

/**
 * Publishing tried to delete a dish that an order line still points at.
 *
 * `order_items_menu_item_fk` is `on delete restrict`, and a cancelled order
 * keeps its lines, so this is reachable even when nobody is eating the dish.
 * `dishId` is read from the refusal's detail; the caller knows the dish's
 * name and says the sentence.
 */
export class DishInUseError extends Error {
  constructor(readonly dishId: number | null) {
    super(
      "A dish being removed has an order on it, so it cannot be removed. Keep it, or mark its new row as the same dish.",
    );
    this.name = "DishInUseError";
  }
}

export type PublishResult = {
  menuId: number;
  dishes: number;
  /** Orders this publish created from weekday preferences. The non-obvious
   *  consequence of publishing, so it is worth reporting rather than leaving to
   *  be discovered. A republish creates none and says zero. */
  standingOrders: number;
  wasUpdate: boolean;
};

/**
 * Create or replace a day's menu, then publish it, in one call to
 * `publish_menu`, which is one transaction. As a dozen requests, a refusal part
 * way left a published menu with some of its dishes changed.
 *
 * Publishing is what materializes standing orders, so it happens last and only
 * once the admin has reviewed the parse. The raw pasted text is stored beside
 * the result: the parser will be wrong sometimes and that text is the evidence.
 *
 * The dishes are reconciled in place, not deleted and reinserted: a dish keeps
 * its row, and so every order on it keeps the price it snapshotted. Removing a
 * dish somebody ordered is refused by order_items' foreign key, which is right:
 * the alternative is losing an order silently.
 *
 * `standingOrders` is the difference the publish made, not the total:
 * republishing a menu materializes nothing, and a toast claiming otherwise
 * would be a lie.
 */
export async function publishMenu(args: {
  orgId: number; profileId: string; serviceDate: string;
  cutoffAt: string; dishes: DraftDish[]; sourceText: string;
  parseMeta: Record<string, unknown>;
}): Promise<PublishResult> {
  const { data, error } = await supabase.rpc("publish_menu", {
    p_org_id: args.orgId,
    p_service_date: args.serviceDate,
    p_cutoff_at: args.cutoffAt,
    p_dishes: args.dishes.map((d) => ({
      id: d.id ?? null, name: d.name, price_minor: d.priceMinor,
    })),
    p_source_text: args.sourceText,
    p_parse_meta: args.parseMeta,
  });
  if (error) {
    if (error.code === "23503" && /order_items_menu_item_fk/.test(error.message)) {
      // `Key (id, menu_id)=(231, 11) is still referenced from table "order_items".`
      const id = /Key \([^)]*\)=\((\d+)/.exec(error.details ?? "")?.[1];
      throw new DishInUseError(id === undefined ? null : Number(id));
    }
    throw error;
  }

  const row = (data as Array<{
    menu_id: number; standing_orders: number; was_update: boolean;
  }> | null)?.[0];
  if (!row) throw new Error("The menu was not published. Reload the screen and try again.");

  return {
    menuId: row.menu_id,
    dishes: args.dishes.length,
    standingOrders: row.standing_orders,
    wasUpdate: row.was_update,
  };
}

export async function fetchMenuForEdit(orgId: number, serviceDate: string) {
  const { data, error } = await supabase
    .from("menus")
    .select(`id, status, source_text, order_cutoff_at,
             menu_items ( id, name, price_minor, position )`)
    .eq("org_id", orgId).eq("service_date", serviceDate).maybeSingle();
  if (error) throw error;
  return data;
}

export type EditableMenu = {
  id: number;
  status: MenuStatus;
  /** The caterer's message as pasted, so re-opening a day shows its evidence. */
  sourceText: string;
  orderCutoffAt: string;
  items: Array<{ id: number; name: string; priceMinor: number | null; position: number }>;
};

/** `fetchMenuForEdit` in the shape the editor works in, dishes in display order. */
export async function fetchMenuEditor(
  orgId: number, serviceDate: string,
): Promise<EditableMenu | null> {
  const row = await fetchMenuForEdit(orgId, serviceDate);
  if (!row) return null;

  type ItemRow = { id: number; name: string; price_minor: number; position: number };
  const items = ((row.menu_items ?? []) as unknown as ItemRow[])
    .map((i) => ({ id: i.id, name: i.name, priceMinor: i.price_minor, position: i.position }))
    .sort((a, b) => a.position - b.position || a.id - b.id);

  return {
    id: row.id,
    status: row.status as MenuStatus,
    sourceText: row.source_text ?? "",
    orderCutoffAt: row.order_cutoff_at,
    items,
  };
}

/** What publishing this date would do to other people. */
export type PublishImpact = {
  /** Active members whose standing day covers this date: publishing orders for each. */
  standing: number;
  /** Orders already on this menu. Non-zero only once it has been published. */
  orders: number;
  /** Orders with a dish chosen. Those dishes can no longer be removed. */
  chosen: number;
};

/**
 * How many people a publish reaches, and what is already committed.
 *
 * The standing count mirrors the `union` inside `materialize_standing_orders`
 * -- the weekday rule minus skips, plus explicit forces, active members only --
 * because the confirmation has to name the number the trigger will actually
 * produce, not a looser one.
 */
export async function fetchPublishImpact(args: {
  orgId: number; serviceDate: string; menuId: number | null;
}): Promise<PublishImpact> {
  const weekday = isoWeekday(args.serviceDate);

  const [members, standing, exceptions] = await Promise.all([
    supabase.from("memberships").select("profile_id")
      .eq("org_id", args.orgId).eq("status", "active"),
    supabase.from("standing_orders").select("profile_id")
      .eq("org_id", args.orgId).eq("weekday", weekday).eq("is_enabled", true),
    supabase.from("standing_order_exceptions").select("profile_id, action")
      .eq("org_id", args.orgId).eq("service_date", args.serviceDate),
  ]);
  if (members.error) throw members.error;
  if (standing.error) throw standing.error;
  if (exceptions.error) throw exceptions.error;

  const active = new Set((members.data ?? []).map((m) => m.profile_id as string));
  const skips = new Set<string>();
  const forces = new Set<string>();
  for (const e of exceptions.data ?? []) {
    (e.action === "skip" ? skips : forces).add(e.profile_id as string);
  }

  const covered = new Set<string>();
  for (const s of standing.data ?? []) {
    const id = s.profile_id as string;
    if (active.has(id) && !skips.has(id)) covered.add(id);
  }
  for (const id of forces) if (active.has(id)) covered.add(id);

  if (args.menuId === null) return { standing: covered.size, orders: 0, chosen: 0 };

  const [orders, chosen] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true })
      .eq("menu_id", args.menuId).eq("status", "placed"),
    supabase.from("order_items").select("id", { count: "exact", head: true })
      .eq("menu_id", args.menuId).eq("auto_assigned", false),
  ]);
  if (orders.error) throw orders.error;
  if (chosen.error) throw chosen.error;

  return { standing: covered.size, orders: orders.count ?? 0, chosen: chosen.count ?? 0 };
}

/**
 * Who chose each dish on a menu, by `menu_items.id`.
 *
 * The editor used to say "4 orders already exist on this day" and leave the
 * admin to work out which dish they were on and whose they were. That is the
 * one question worth answering before removing a dish or calling lunch off,
 * and it is the admin who has to ring those people.
 *
 * Read from `order_items` rather than `orders`: an order with no dish chosen
 * belongs to nobody's dish and must not be counted against one.
 *
 * `chosen` is every line a person wrote, whatever its order's status. A
 * cancelled order keeps its lines and `order_items_menu_item_fk` restricts the
 * delete, so a dish chosen and then cancelled cannot be removed either. Such a
 * dish is in the map with no names: nobody to ring, but still on the record.
 *
 * `system` is the dishes carrying a line the system wrote on a one-dish menu.
 * Nobody chose those, so they name nobody, and `trg_menu_items_hold_menu`
 * deletes them with their dish, but only while the day is open. After that
 * they hold the dish like any other line, which only the caller, knowing the
 * day's stage, can decide.
 */
export type DishTakers = { chosen: Map<number, string[]>; system: Set<number> };

export async function fetchDishTakers(menuId: number): Promise<DishTakers> {
  const { data, error } = await supabase
    .from("order_items")
    .select("menu_item_id, profile_id, auto_assigned, orders!inner(status)")
    .eq("menu_id", menuId);
  if (error) throw error;

  const all = (data ?? []) as unknown as Array<{
    menu_item_id: number | null;
    profile_id: string;
    auto_assigned: boolean;
    orders: { status: string } | Array<{ status: string }> | null;
  }>;
  const system = new Set<number>();
  for (const r of all) if (r.auto_assigned && r.menu_item_id !== null) system.add(r.menu_item_id);
  const lines = all.filter((r) => !r.auto_assigned);
  const placed = (r: (typeof lines)[number]) => {
    const o = Array.isArray(r.orders) ? r.orders[0] : r.orders;
    return o?.status === "placed";
  };

  const out = new Map<number, string[]>();
  for (const r of lines) if (r.menu_item_id !== null) out.set(r.menu_item_id, []);

  const ids = [...new Set(lines.filter(placed).map((r) => r.profile_id))];
  if (ids.length === 0) return { chosen: out, system };

  // Names come from the membership, not the profile: an office knows people by
  // what they are called at work, and that is the column the board uses too.
  const { data: people, error: peopleError } = await supabase
    .from("memberships")
    .select("profile_id, display_name")
    .in("profile_id", ids);
  if (peopleError) throw peopleError;

  const names = new Map(
    (people ?? []).map((m) => [m.profile_id as string, (m.display_name as string | null) ?? ""]),
  );

  for (const row of lines) {
    if (row.menu_item_id === null || !placed(row)) continue;
    const name = names.get(row.profile_id) ?? "";
    out.get(row.menu_item_id)?.push(name === "" ? "Somebody" : name);
  }
  for (const [, list] of out) list.sort((a, b) => a.localeCompare(b));
  return { chosen: out, system };
}

/**
 * The day's orders, shaped for the message that goes to the caterer.
 *
 * One query for the orders with their dishes embedded, because the thing that
 * matters most is the order with NO dish on it: that person is a real head the
 * caterer cannot cook for, and a query that joined through `order_items` would
 * drop them silently. Counted separately and said out loud in the message.
 */
export async function fetchCatererOrder(args: {
  orgId: number;
  menuId: number;
  serviceDate: string;
  items: Array<{ id: number; name: string }>;
}): Promise<CatererOrder> {
  const { data, error } = await supabase
    .from("orders")
    .select("profile_id, order_items ( menu_item_id, note )")
    .eq("menu_id", args.menuId)
    .eq("status", "placed");
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    profile_id: string;
    order_items: Array<{ menu_item_id: number | null; note: string | null }> | null;
  }>;

  const ids = [...new Set(rows.map((r) => r.profile_id))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people, error: peopleError } = await supabase
      .from("memberships")
      .select("profile_id, display_name")
      .eq("org_id", args.orgId)
      .in("profile_id", ids);
    if (peopleError) throw peopleError;
    for (const m of people ?? []) {
      names.set(m.profile_id as string, (m.display_name as string | null) ?? "");
    }
  }

  const byItem = new Map<number, CatererLine>();
  for (const item of args.items) {
    byItem.set(item.id, { itemId: item.id, name: item.name, count: 0, notes: [] });
  }

  let unchosen = 0;
  for (const row of rows) {
    const chosen = (row.order_items ?? []).filter((i) => i.menu_item_id !== null);
    if (chosen.length === 0) {
      unchosen += 1;
      continue;
    }
    for (const item of chosen) {
      const line = byItem.get(item.menu_item_id as number);
      // A dish removed from the menu after somebody ordered it cannot happen
      // -- the trigger refuses it -- but an order for another day's item would
      // be a bug worth not hiding behind a crash.
      if (line === undefined) continue;
      line.count += 1;
      const note = item.note?.trim();
      if (note) {
        line.notes.push({ text: note, who: names.get(row.profile_id) || "Chưa có tên" });
      }
    }
  }

  return {
    serviceDate: args.serviceDate,
    lines: [...byItem.values()],
    unchosen,
  };
}

/* -------------------------------------------------- LLM parse assist */

export type AssistedMenu = {
  serviceDate: string | null;
  items: Array<{ name: string; priceMinor: number; note: string | null }>;
  notes: string[];
  model: string;
};

/**
 * Ask the parse-assist function to read a caterer's message.
 *
 * The model never writes anything: this populates an editable preview and the
 * admin still presses Publish. The DeepSeek key lives as an Edge Function
 * secret and is never in this bundle.
 */
export async function assistParse(args: {
  orgId: number; text: string; today: string;
}): Promise<AssistedMenu> {
  const { data, error } = await supabase.functions.invoke("parse-assist", {
    body: { orgId: args.orgId, text: args.text, today: args.today },
  });

  if (error) {
    // functions.invoke folds a non-2xx into an opaque error, so dig out the
    // function's own message -- "DEEPSEEK_API_KEY is not set" is far more
    // useful than "Edge Function returned a non-2xx status code".
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      const body = await ctx.json().catch(() => null) as
        { error?: string; message?: string } | null;
      if (body?.message) throw new Error(body.message);
      if (body?.error) throw new Error(body.error);
    }
    throw error;
  }
  return data as AssistedMenu;
}

/**
 * Status of each day in a range, for the admin's day picker.
 *
 * The cutoff comes back as well as the status, because the day picker labels
 * each day with its stage and two of the five stages are the clock's rather
 * than the status column's.
 */
export async function fetchMenuCalendar(args: {
  orgId: number; from: string; to: string;
}): Promise<Map<string, { status: string; dishes: number; orderCutoffAt: string | null }>> {
  const { data, error } = await supabase
    .from("menus")
    .select("service_date, status, order_cutoff_at, menu_items(count)")
    .eq("org_id", args.orgId)
    .gte("service_date", args.from)
    .lte("service_date", args.to);
  if (error) throw error;

  const out = new Map<string, { status: string; dishes: number; orderCutoffAt: string | null }>();
  for (const m of data ?? []) {
    const counted = m.menu_items as unknown as Array<{ count: number }> | null;
    out.set(m.service_date, {
      status: m.status,
      dishes: counted?.[0]?.count ?? 0,
      orderCutoffAt: m.order_cutoff_at as string | null,
    });
  }
  return out;
}

/**
 * Call lunch off for a day.
 *
 * The only status change the app makes. Un-publishing went first (a published
 * menu is editable in place, so it only ever hid a day that was still being
 * cooked) and reopening after it: a day whose ordering can reopen is a day
 * whose headcount was never final, and the caterer already has that count.
 *
 * `enforce_menu_lifecycle` is the authority on what is legal and refuses the
 * rest with a sentence written for a person, so this sends the status and lets
 * the database answer. Cancelling after the cutoff is refused there, not by a
 * check here: the cutoff can pass between reading it and pressing the button.
 */
export async function cancelMenu(args: { menuId: number }): Promise<void> {
  const { error } = await supabase
    .from("menus")
    .update({ status: "cancelled" })
    .eq("id", args.menuId);
  if (error) throw error;
}
