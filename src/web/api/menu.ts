/**
 * The admin's menu editor: what a date currently holds, what the caterer's
 * message parses to, and publishing.
 */

import { supabase } from "../supabase.js";

/* ------------------------------------------------------- admin: publishing */

export type DraftDish = { name: string; priceMinor: number };

export type PublishResult = {
  menuId: number;
  dishes: number;
  /** Orders created from weekday preferences. The non-obvious consequence of
   *  publishing, so it is worth reporting rather than leaving to be discovered. */
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

  let menuId = existing.data?.id;

  if (menuId === undefined) {
    const ins = await supabase.from("menus").insert({
      org_id: args.orgId, service_date: args.serviceDate,
      order_cutoff_at: args.cutoffAt, created_by: args.profileId,
      source_text: args.sourceText, parse_meta: args.parseMeta,
    }).select("id").single();
    if (ins.error) throw ins.error;
    menuId = ins.data.id;
  } else {
    const upd = await supabase.from("menus").update({
      order_cutoff_at: args.cutoffAt,
      source_text: args.sourceText,
      parse_meta: args.parseMeta,
    }).eq("id", menuId);
    if (upd.error) throw upd.error;

    // Replacing dishes wholesale is only safe while nothing references them.
    // The FK from order_items is ON DELETE RESTRICT, so if anyone has already
    // ordered, the database refuses and the admin gets told rather than
    // silently losing an order.
    const del = await supabase.from("menu_items").delete().eq("menu_id", menuId);
    if (del.error) throw del.error;
  }

  const rows = args.dishes.map((d, i) => ({
    menu_id: menuId!, org_id: args.orgId,
    name: d.name, price_minor: d.priceMinor, position: i,
  }));
  const items = await supabase.from("menu_items").insert(rows);
  if (items.error) throw items.error;

  const pub = await supabase.from("menus").update({ status: "published" }).eq("id", menuId);
  if (pub.error) throw pub.error;

  // Standing orders materialize from a trigger on the status change, not from
  // here. The client used to call materialize_standing_orders by RPC, which
  // failed on a missing EXECUTE grant -- and granting it would have let any
  // signed-in user trigger materialization in another org.
  //
  // Read back what the publish actually produced. An admin cannot otherwise
  // tell whether it worked, and the standing-order count is the part they have
  // no other way to see.
  const counted = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("menu_id", menuId)
    .eq("source", "standing")
    .eq("status", "placed");
  if (counted.error) throw counted.error;

  return {
    menuId,
    dishes: args.dishes.length,
    standingOrders: counted.count ?? 0,
    wasUpdate: existing.data !== null,
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
