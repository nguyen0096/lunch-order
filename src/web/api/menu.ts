/**
 * The admin's menu editor: what a date currently holds, what the caterer's
 * message parses to, and publishing.
 */

import { supabase } from "../supabase.js";
import { isoWeekday } from "../../shared/dates.js";
import type { MenuStatus } from "../../shared/types.js";

/* ------------------------------------------------------- admin: publishing */

/** `id` is the menu_items row this stands for; absent means a dish being added. */
/** `priceMinor` null means the caterer has not priced it yet. */
export type DraftDish = { id?: number; name: string; priceMinor: number | null };

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
 * Create or replace a day's menu, then publish it.
 *
 * Publishing is what materializes standing orders, so it happens last and only
 * once the admin has reviewed the parse. The raw pasted text is stored beside
 * the result: the parser will be wrong sometimes and that text is the evidence.
 */
export async function publishMenu(args: {
  orgId: number; profileId: string; serviceDate: string;
  cutoffAt: string; dishes: DraftDish[]; sourceText: string;
  parseMeta: Record<string, unknown>;
}): Promise<PublishResult> {
  const existing = await supabase
    .from("menus").select("id, status")
    .eq("org_id", args.orgId).eq("service_date", args.serviceDate).maybeSingle();
  if (existing.error) throw existing.error;

  let menuId: number | undefined = existing.data?.id;
  let standingBefore = 0;

  if (menuId === undefined) {
    const ins = await supabase.from("menus").insert({
      org_id: args.orgId, service_date: args.serviceDate,
      order_cutoff_at: args.cutoffAt, created_by: args.profileId,
      source_text: args.sourceText, parse_meta: args.parseMeta,
    }).select("id").single();
    if (ins.error) throw ins.error;
    menuId = ins.data.id as number;
  } else {
    standingBefore = await countStandingOrders(menuId);
    const upd = await supabase.from("menus").update({
      order_cutoff_at: args.cutoffAt,
      source_text: args.sourceText,
      parse_meta: args.parseMeta,
    }).eq("id", menuId);
    if (upd.error) throw upd.error;
  }

  await reconcileDishes(menuId, args.orgId, args.dishes);

  const pub = await supabase.from("menus").update({ status: "published" }).eq("id", menuId);
  if (pub.error) throw pub.error;

  // Standing orders materialize from a trigger on the status change, not from
  // here. The client used to call materialize_standing_orders by RPC, which
  // failed on a missing EXECUTE grant -- and granting it would have let any
  // signed-in user trigger materialization in another org.
  //
  // Read back what the publish actually produced. An admin cannot otherwise
  // tell whether it worked, and the standing-order count is the part they have
  // no other way to see. The difference, not the total: republishing a menu
  // materializes nothing, and a toast claiming otherwise would be a lie.
  const standingAfter = await countStandingOrders(menuId);

  return {
    menuId,
    dishes: args.dishes.length,
    standingOrders: Math.max(0, standingAfter - standingBefore),
    wasUpdate: existing.data !== null,
  };
}

async function countStandingOrders(menuId: number): Promise<number> {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("menu_id", menuId)
    .eq("source", "standing")
    .eq("status", "placed");
  if (error) throw error;
  return count ?? 0;
}

/**
 * Bring a menu's dishes in line with the draft, in place.
 *
 * Deliberately not delete-then-reinsert. order_items references menu_items ON
 * DELETE RESTRICT, so wiping the list is refused the moment anyone has chosen a
 * dish -- and that is exactly the state in which an admin still has to be able
 * to correct a price. Updating the row in place keeps its id, and every order
 * already placed keeps the price it snapshotted, so no bill moves.
 *
 * Removing a dish somebody ordered is still refused, by the same FK. That one
 * is right: the alternative is losing an order silently.
 */
async function reconcileDishes(menuId: number, orgId: number, dishes: DraftDish[]): Promise<void> {
  const current = await supabase.from("menu_items").select("id").eq("menu_id", menuId);
  if (current.error) throw current.error;

  const live = new Set((current.data ?? []).map((r) => r.id as number));
  const keep = new Set(dishes.flatMap((d) => (d.id !== undefined && live.has(d.id) ? [d.id] : [])));
  const gone = [...live].filter((id) => !keep.has(id));

  // Removals first: a rename that reuses a departing dish's name would
  // otherwise collide with the unique index on (menu_id, lower(btrim(name))).
  if (gone.length > 0) {
    const del = await supabase.from("menu_items").delete().in("id", gone);
    if (del.error) throw del.error;
  }

  for (const [i, d] of dishes.entries()) {
    if (d.id === undefined || !keep.has(d.id)) continue;
    const upd = await supabase
      .from("menu_items")
      .update({ name: d.name, price_minor: d.priceMinor, position: i })
      .eq("id", d.id);
    if (upd.error) throw upd.error;
  }

  const added = dishes.flatMap((d, i) =>
    d.id !== undefined && keep.has(d.id)
      ? []
      : [{ menu_id: menuId, org_id: orgId, name: d.name, price_minor: d.priceMinor, position: i }],
  );
  if (added.length > 0) {
    const ins = await supabase.from("menu_items").insert(added);
    if (ins.error) throw ins.error;
  }
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
      .eq("menu_id", args.menuId),
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
 */
export async function fetchDishTakers(menuId: number): Promise<Map<number, string[]>> {
  const { data, error } = await supabase
    .from("order_items")
    .select("menu_item_id, profile_id, orders!inner(status)")
    .eq("menu_id", menuId)
    .eq("orders.status", "placed");
  if (error) throw error;

  const ids = [...new Set((data ?? []).map((r) => r.profile_id as string))];
  if (ids.length === 0) return new Map();

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

  const out = new Map<number, string[]>();
  for (const row of data ?? []) {
    const id = row.menu_item_id as number | null;
    if (id === null) continue;
    const name = names.get(row.profile_id as string) ?? "";
    const list = out.get(id) ?? [];
    list.push(name === "" ? "Somebody" : name);
    out.set(id, list);
  }
  for (const [, list] of out) list.sort((a, b) => a.localeCompare(b));
  return out;
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

/** Status of each day in a range, for the admin's day picker. */
export async function fetchMenuCalendar(args: {
  orgId: number; from: string; to: string;
}): Promise<Map<string, { status: string; dishes: number }>> {
  const { data, error } = await supabase
    .from("menus")
    .select("service_date, status, menu_items(count)")
    .eq("org_id", args.orgId)
    .gte("service_date", args.from)
    .lte("service_date", args.to);
  if (error) throw error;

  const out = new Map<string, { status: string; dishes: number }>();
  for (const m of data ?? []) {
    const counted = m.menu_items as unknown as Array<{ count: number }> | null;
    out.set(m.service_date, { status: m.status, dishes: counted?.[0]?.count ?? 0 });
  }
  return out;
}

/**
 * Move a menu between statuses, for the transitions the app never offered.
 *
 * `enforce_menu_lifecycle` is the authority on which are legal and refuses the
 * rest with a sentence written for a person, so this sends the status and lets
 * the database answer. The three that matter here were all permitted from the
 * first migration and reachable from nowhere:
 *
 *   published -> draft      take it back, only while nobody has ordered
 *   locked    -> published  reopen a day the cutoff closed
 *   published/locked -> cancelled   lunch is off
 *
 * Un-publishing with orders on it is refused by the trigger, not by a check
 * here: the count can change between reading it and pressing the button, and
 * the database is the only place that sees both at once.
 */
export async function setMenuStatus(args: {
  menuId: number;
  status: "draft" | "published" | "cancelled";
}): Promise<void> {
  const { error } = await supabase
    .from("menus")
    .update({ status: args.status })
    .eq("id", args.menuId);
  if (error) throw error;
}
