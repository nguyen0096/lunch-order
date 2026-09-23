/**
 * The board and everything a member does on it: the menu for a day, placing
 * and cancelling orders, standing days, and handing a meal to a colleague.
 */

import { supabase } from "../supabase.js";
import { projectStandingDays } from "../../shared/projection.js";
import type { Menu, MyOrder } from "../../shared/types.js";

/** The menu for a service date, with its dishes in display order. */
export async function fetchMenu(orgId: number, serviceDate: string): Promise<Menu | null> {
  const { data, error } = await supabase
    .from("menus")
    .select(
      `id, org_id, service_date, status, order_cutoff_at,
       menu_items ( id, name, price_minor, position, is_available )`,
    )
    .eq("org_id", orgId)
    .eq("service_date", serviceDate)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  type ItemRow = {
    id: number; name: string; price_minor: number; position: number; is_available: boolean;
  };
  const items = ((data.menu_items ?? []) as unknown as ItemRow[])
    .map((i) => ({
      id: i.id, name: i.name, priceMinor: i.price_minor,
      position: i.position, isAvailable: i.is_available,
    }))
    .sort((a, b) => a.position - b.position || a.id - b.id);

  return {
    id: data.id,
    orgId: data.org_id,
    serviceDate: data.service_date,
    status: data.status as Menu["status"],
    orderCutoffAt: data.order_cutoff_at,
    items,
  };
}

/**
 * Place or update today's order. Prices are never sent: the database snapshots
 * them from menu_items, and the column grant means a browser could not write
 * one even if this code tried. The note is the third column a member may
 * write, and it hangs off the dish rather than the order because that is how
 * it is read out to the caterer.
 */
export async function setOrder(args: {
  orgId: number; menuId: number; serviceDate: string; profileId: string;
  itemId: number | null; note?: string | null; existing: MyOrder | null;
}): Promise<void> {
  let orderId = args.existing?.id;

  if (!orderId) {
    const { data, error } = await supabase
      .from("orders")
      .insert({
        org_id: args.orgId, menu_id: args.menuId, service_date: args.serviceDate,
        profile_id: args.profileId, created_by: args.profileId, source: "member",
      })
      .select("id").single();
    if (error) throw error;
    orderId = data.id;
  } else if (args.existing?.status === "cancelled") {
    const { error } = await supabase
      .from("orders").update({ status: "placed", cancelled_at: null }).eq("id", orderId);
    if (error) throw error;
  }

  const { error: del } = await supabase.from("order_items").delete().eq("order_id", orderId);
  if (del) throw del;

  if (args.itemId !== null) {
    const note = args.note?.trim();
    const { error } = await supabase.from("order_items").insert({
      order_id: orderId, org_id: args.orgId, profile_id: args.profileId,
      menu_id: args.menuId, menu_item_id: args.itemId,
      // The constraint takes null or 1 to 120 trimmed characters, so a field
      // somebody emptied has to arrive as null rather than as "".
      note: note ? note.slice(0, 120) : null,
      // Overwritten unconditionally by the snapshot trigger; sent only because
      // the columns are NOT NULL.
      item_name_snapshot: "", unit_price_minor: 0,
    });
    if (error) throw error;
  }
}

export async function cancelOrder(orderId: number): Promise<void> {
  const { error } = await supabase
    .from("orders")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) throw error;
}

/**
 * MY weekday rules. The profile_id filter is mandatory, not defensive:
 * standing_orders is readable org-wide by an admin, so without it an admin's
 * Preferences screen shows the union of everyone's weekdays as their own.
 */
export async function fetchStandingOrders(
  orgId: number, profileId: string,
): Promise<Set<number>> {
  const { data, error } = await supabase
    .from("standing_orders").select("weekday, is_enabled")
    .eq("org_id", orgId).eq("profile_id", profileId);
  if (error) throw error;
  return new Set((data ?? []).filter((r) => r.is_enabled).map((r) => r.weekday));
}

export async function setStandingOrder(args: {
  orgId: number; profileId: string; weekday: number; enabled: boolean;
}): Promise<void> {
  const { error } = await supabase.from("standing_orders").upsert(
    {
      org_id: args.orgId, profile_id: args.profileId,
      weekday: args.weekday, is_enabled: args.enabled,
    },
    { onConflict: "org_id,profile_id,weekday" },
  );
  if (error) throw error;
}

/* ---------------------------------------------------------------- the board */

export type BoardMember = {
  profileId: string;
  name: string;
  shortCode: string;
  isMe: boolean;
};

export type BoardDay = {
  serviceDate: string;
  menuId: number | null;
  status: Menu["status"] | null;
  orderCutoffAt: string | null;
  /** `priceMinor` is null until the caterer says; never coalesce it to 0. */
  dishes: Array<{ id: number; name: string; priceMinor: number | null }>;
};

export type BoardCell = {
  orderId: number;
  status: "placed" | "cancelled";
  source: "member" | "standing" | "admin";
  /** The menu item behind the snapshot, so a note can be saved against it. */
  itemId: number | null;
  dishName: string | null;
  /** How this person wants the dish. It goes to the caterer. */
  note: string | null;
  amountMinor: number | null;
  /** Set when this meal was handed to someone else and they accepted. */
  transferredToName: string | null;
};

export type Board = {
  days: BoardDay[];
  members: BoardMember[];
  /** Keyed `${profileId}|${serviceDate}`. */
  cells: Map<string, BoardCell>;
  /**
   * Days on a future date where MY weekday rule applies but no order row
   * exists yet -- because no menu has been published for that day. Rendered as
   * a faint tick meaning "you'll be added automatically", which is a
   * prediction, not a commitment.
   *
   * Deliberately computed rather than stored: the alternative is creating
   * order rows for dates that have no menu, which would invent a price-less
   * commitment and make the headcount query lie. Past days are never projected
   * -- what happened is whatever the rows say, which is the audit trail.
   *
   * Only ever your own row: standing_orders is own-row under RLS, so a member
   * genuinely cannot read a colleague's rules, and guessing at them would be
   * speculation presented as fact.
   */
  projected: Set<string>;
};

export const cellKey = (profileId: string, serviceDate: string) => `${profileId}|${serviceDate}`;

/**
 * The shared board for a date range: who is eating on which day.
 *
 * Every member can read every order in their org (see the shared_order_grid
 * migration), which is what makes this a board rather than a private list.
 * Writes are still own-row only.
 */
export async function fetchBoard(args: {
  orgId: number; from: string; to: string; meProfileId: string; today: string;
}): Promise<Board> {
  const [menusRes, membersRes, ordersRes, transfersRes, rulesRes, excRes] = await Promise.all([
    supabase
      .from("menus")
      .select(`id, service_date, status, order_cutoff_at,
               menu_items ( id, name, price_minor, position, is_available )`)
      .eq("org_id", args.orgId)
      .gte("service_date", args.from)
      .lte("service_date", args.to),
    supabase
      .from("memberships")
      .select(`profile_id, short_code, display_name, profiles ( full_name )`)
      .eq("org_id", args.orgId)
      .eq("status", "active"),
    supabase
      .from("orders")
      .select(`id, profile_id, service_date, status, source,
               order_items ( menu_item_id, item_name_snapshot, line_total_minor, note )`)
      .eq("org_id", args.orgId)
      .gte("service_date", args.from)
      .lte("service_date", args.to),
    supabase
      .from("meal_transfers")
      .select(`order_id, to_profile_id, status`)
      .eq("org_id", args.orgId)
      .eq("status", "accepted"),
    supabase
      // Projections are only ever about ME, and an admin can read the whole
      // org's rules -- so these two MUST filter on profile_id. Without it the
      // projection becomes the union of everyone's weekdays, and an admin sees
      // dashed ticks on days no rule of theirs covers.
      .from("standing_orders")
      .select(`weekday, is_enabled`)
      .eq("org_id", args.orgId)
      .eq("profile_id", args.meProfileId),
    supabase
      .from("standing_order_exceptions")
      .select(`service_date, action`)
      .eq("org_id", args.orgId)
      .eq("profile_id", args.meProfileId)
      .gte("service_date", args.from)
      .lte("service_date", args.to),
  ]);

  for (const r of [menusRes, membersRes, ordersRes, transfersRes, rulesRes, excRes]) {
    if (r.error) throw r.error;
  }

  type ItemRow = { id: number; name: string; price_minor: number; position: number; is_available: boolean };
  const menuByDate = new Map<string, BoardDay>();
  for (const m of menusRes.data ?? []) {
    const dishes = ((m.menu_items ?? []) as unknown as ItemRow[])
      .filter((i) => i.is_available)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((i) => ({ id: i.id, name: i.name, priceMinor: i.price_minor }));
    menuByDate.set(m.service_date, {
      serviceDate: m.service_date,
      menuId: m.id,
      status: m.status as Menu["status"],
      orderCutoffAt: m.order_cutoff_at,
      dishes,
    });
  }

  const days: BoardDay[] = [];
  for (let d = args.from; d <= args.to; d = addDaysIso(d, 1)) {
    days.push(
      menuByDate.get(d) ??
        { serviceDate: d, menuId: null, status: null, orderCutoffAt: null, dishes: [] },
    );
  }

  const nameOf = new Map<string, string>();
  const members: BoardMember[] = (membersRes.data ?? []).map((r) => {
    const prof = r.profiles as unknown as { full_name: string } | null;
    const name = r.display_name ?? prof?.full_name ?? r.short_code;
    nameOf.set(r.profile_id, name);
    return {
      profileId: r.profile_id,
      name,
      shortCode: r.short_code,
      isMe: r.profile_id === args.meProfileId,
    };
  });
  // You first, then everyone else alphabetically: you are the row you interact with.
  members.sort((a, b) =>
    a.isMe === b.isMe ? a.name.localeCompare(b.name) : a.isMe ? -1 : 1,
  );

  const transferTo = new Map<number, string>();
  for (const t of transfersRes.data ?? []) {
    transferTo.set(t.order_id, nameOf.get(t.to_profile_id) ?? "someone");
  }

  type LineRow = {
    menu_item_id: number | null;
    item_name_snapshot: string;
    line_total_minor: number | null;
    note: string | null;
  };
  const cells = new Map<string, BoardCell>();
  for (const o of ordersRes.data ?? []) {
    const lines = (o.order_items ?? []) as unknown as LineRow[];
    const amount = lines.reduce((sum, l) => sum + (l.line_total_minor ?? 0), 0);
    cells.set(cellKey(o.profile_id, o.service_date), {
      orderId: o.id,
      status: o.status as BoardCell["status"],
      source: o.source as BoardCell["source"],
      itemId: lines[0]?.menu_item_id ?? null,
      dishName: lines[0]?.item_name_snapshot ?? null,
      note: lines[0]?.note ?? null,
      amountMinor: lines.length > 0 ? amount : null,
      transferredToName: transferTo.get(o.id) ?? null,
    });
  }

  const projected = projectStandingDays({
    days: days.map((d) => d.serviceDate),
    today: args.today,
    weekdays: new Set(
      (rulesRes.data ?? []).filter((r) => r.is_enabled).map((r) => r.weekday),
    ),
    skips: new Set(
      (excRes.data ?? []).filter((e) => e.action === "skip").map((e) => e.service_date),
    ),
    forces: new Set(
      (excRes.data ?? []).filter((e) => e.action === "force").map((e) => e.service_date),
    ),
    hasOrder: (d) => cells.has(cellKey(args.meProfileId, d)),
  });

  return { days, members, cells, projected };
}

function addDaysIso(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- transfers */

export type TransferRow = {
  id: number;
  orderId: number;
  serviceDate: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  fromProfileId: string;
  fromName: string;
  toProfileId: string;
  toName: string;
  dishName: string | null;
  amountMinor: number | null;
  reason: string | null;
  createdAt: string;
};

/** A future order of mine that could be handed to someone else. */
export type GiveableOrder = {
  orderId: number;
  serviceDate: string;
  dishName: string | null;
  amountMinor: number | null;
  /** Non-null when it already has a live transfer, so it cannot be given again. */
  pendingWith: string | null;
};

/**
 * Everything the board needs in order to draw a transfer on the cell it
 * concerns: offers made to me, offers I made, and every live offer the caller
 * can see at all.
 *
 * `openPeriodStart` is the start of the OPEN BILLING WEEK, and naming it that
 * is the point. It used to be `fromDate`, and the caller passed `today`, so a
 * Tuesday meal could not be handed over on Thursday although the database
 * permits it: `enforce_transfer_rules` refuses only a meal already on a
 * *closed* bill. People remember on Thursday that Tuesday's lunch went to
 * somebody else, and the alternative to letting them say so is a bill that is
 * quietly wrong.
 */
export async function fetchTransfers(args: {
  orgId: number; meProfileId: string; openPeriodStart: string;
}): Promise<{
  incoming: TransferRow[];
  outgoing: TransferRow[];
  giveable: GiveableOrder[];
  /**
   * Live offers by order id. RLS decides how much of this there is: both
   * parties for a member, the whole org for an admin, which is what lets an
   * admin see that a meal is already spoken for before recording a swap.
   */
  live: Map<number, TransferRow>;
}> {
  const [transfersRes, ordersRes, membersRes] = await Promise.all([
    supabase
      .from("meal_transfers")
      .select(`id, order_id, status, from_profile_id, to_profile_id, reason, created_at,
               orders ( service_date, order_items ( item_name_snapshot, line_total_minor ) )`)
      .eq("org_id", args.orgId)
      .order("id", { ascending: false }),
    supabase
      .from("orders")
      .select(`id, service_date, order_items ( item_name_snapshot, line_total_minor )`)
      .eq("org_id", args.orgId)
      .eq("profile_id", args.meProfileId)
      .eq("status", "placed")
      .gte("service_date", args.openPeriodStart)
      .order("service_date"),
    supabase
      .from("memberships")
      .select(`profile_id, short_code, display_name, profiles ( full_name )`)
      .eq("org_id", args.orgId)
      .eq("status", "active"),
  ]);
  for (const r of [transfersRes, ordersRes, membersRes]) if (r.error) throw r.error;

  const nameOf = new Map<string, string>();
  for (const m of membersRes.data ?? []) {
    const prof = m.profiles as unknown as { full_name: string } | null;
    nameOf.set(m.profile_id, m.display_name ?? prof?.full_name ?? m.short_code);
  }

  type Line = { item_name_snapshot: string; line_total_minor: number | null };
  const rows: TransferRow[] = (transfersRes.data ?? []).map((t) => {
    const order = t.orders as unknown as
      { service_date: string; order_items: Line[] } | null;
    const lines = order?.order_items ?? [];
    return {
      id: t.id,
      orderId: t.order_id,
      serviceDate: order?.service_date ?? "",
      status: t.status as TransferRow["status"],
      fromProfileId: t.from_profile_id,
      fromName: nameOf.get(t.from_profile_id) ?? "someone",
      toProfileId: t.to_profile_id,
      toName: nameOf.get(t.to_profile_id) ?? "someone",
      dishName: lines[0]?.item_name_snapshot ?? null,
      amountMinor: lines.reduce((sum, l) => sum + (l.line_total_minor ?? 0), 0) || null,
      reason: t.reason,
      createdAt: t.created_at,
    };
  });

  // RLS shows a member only transfers they are party to, so no further
  // filtering is needed for safety -- this split is purely presentational.
  const live = new Map<number, TransferRow>();
  for (const t of rows) {
    if (t.status === "pending" || t.status === "accepted") live.set(t.orderId, t);
  }

  return {
    incoming: rows.filter((t) => t.toProfileId === args.meProfileId && t.status === "pending"),
    outgoing: rows.filter((t) => t.fromProfileId === args.meProfileId),
    live,
    giveable: (ordersRes.data ?? []).map((o) => {
      const lines = (o.order_items ?? []) as unknown as Line[];
      return {
        orderId: o.id,
        serviceDate: o.service_date,
        dishName: lines[0]?.item_name_snapshot ?? null,
        amountMinor: lines.reduce((s, l) => s + (l.line_total_minor ?? 0), 0) || null,
        pendingWith: live.get(o.id)?.toName ?? null,
      };
    }),
  };
}

/**
 * Offer a meal to a colleague. The trigger fills in from_profile_id from the
 * order and, when an admin does this, marks it accepted immediately -- an
 * admin recording a swap has already confirmed it with both people.
 */
export async function createTransfer(args: {
  orgId: number; orderId: number; toProfileId: string; createdBy: string;
}): Promise<void> {
  const { error } = await supabase.from("meal_transfers").insert({
    org_id: args.orgId,
    order_id: args.orderId,
    to_profile_id: args.toProfileId,
    // Overwritten by the trigger from the order; sent only because it is NOT NULL.
    from_profile_id: args.createdBy,
    created_by: args.createdBy,
  });
  if (error) throw error;
}

/**
 * Accept, decline or cancel. Which of these the caller is allowed to do is
 * decided by the database trigger, not here: only the recipient may accept or
 * decline, only the sender may cancel.
 */
export async function decideTransfer(id: number, status: "accepted" | "declined" | "cancelled") {
  const { error } = await supabase.from("meal_transfers").update({ status }).eq("id", id);
  if (error) throw error;
}
