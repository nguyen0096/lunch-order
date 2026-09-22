import { supabase } from "./supabase.js";
import { projectStandingDays } from "../shared/projection.js";
import type { Me, Menu, MyOrder, Org, Role } from "../shared/types.js";

type OrgRow = {
  id: number; slug: string; name: string; timezone: string;
  currency: string; currency_minor_units: number; locale: string;
  default_cutoff_local_time: string; billing_week_starts_on: number;
};

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    timezone: r.timezone,
    currency: { code: r.currency, minorUnits: r.currency_minor_units, locale: r.locale },
    defaultCutoffLocalTime: r.default_cutoff_local_time,
    billingWeekStartsOn: r.billing_week_starts_on,
  };
}

/**
 * Who am I and which orgs do I belong to. RLS means this returns only the
 * caller's own memberships, so no filter is needed or wanted here: adding one
 * would imply the security lives in the query, which it does not.
 */
export async function fetchMe(): Promise<Me | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  // profile_id must be filtered explicitly. memberships is readable org-wide
  // so the board can show colleagues' names, which means an unfiltered query
  // returns EVERY member's row -- and orgs[0] could then be the owner's,
  // rendering a plain member with admin privileges in the UI.
  const { data, error } = await supabase
    .from("memberships")
    .select(
      `role, short_code, display_name,
       organizations ( id, slug, name, timezone, currency, currency_minor_units,
                       locale, default_cutoff_local_time, billing_week_starts_on )`,
    )
    .eq("profile_id", auth.user.id)
    .eq("status", "active");
  if (error) throw error;

  const { data: profile } = await supabase
    .from("profiles").select("full_name, email").eq("id", auth.user.id).single();

  return {
    profileId: auth.user.id,
    fullName: profile?.full_name ?? auth.user.email ?? "",
    email: profile?.email ?? auth.user.email ?? "",
    orgs: (data ?? []).flatMap((row) => {
      const org = row.organizations as unknown as OrgRow | null;
      if (!org) return [];
      return [{
        org: toOrg(org),
        role: row.role as Role,
        shortCode: row.short_code,
        displayName: row.display_name ?? profile?.full_name ?? auth.user.email ?? "",
      }];
    }),
  };
}

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
 * one even if this code tried.
 */
export async function setOrder(args: {
  orgId: number; menuId: number; serviceDate: string; profileId: string;
  itemId: number | null; existing: MyOrder | null;
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
    const { error } = await supabase.from("order_items").insert({
      order_id: orderId, org_id: args.orgId, profile_id: args.profileId,
      menu_id: args.menuId, menu_item_id: args.itemId,
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

/**
 * Postgres error messages from our triggers are written for people -- "ordering
 * for 2026-09-14 closed at 16:00 13/09" -- so show them as they are. Anything
 * else gets a generic line rather than leaking a constraint name at a member.
 */
export function humanError(e: unknown): string {
  const err = e as { message?: string; code?: string } | null;
  if (!err?.message) return "Something went wrong. Try again.";
  if (/permission denied for function/i.test(err.message)) {
    return `Server misconfiguration: ${err.message}. This is not something you did.`;
  }
  if (err.code === "42501" || /row-level security/i.test(err.message)) {
    return "You don't have permission to do that.";
  }
  if (/violates|constraint|duplicate key/i.test(err.message)) {
    return "That change conflicts with something else. Reload and try again.";
  }
  return err.message;
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
  dishes: Array<{ id: number; name: string; priceMinor: number }>;
};

export type BoardCell = {
  orderId: number;
  status: "placed" | "cancelled";
  source: "member" | "standing" | "admin";
  dishName: string | null;
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
               order_items ( item_name_snapshot, line_total_minor )`)
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

  type LineRow = { item_name_snapshot: string; line_total_minor: number | null };
  const cells = new Map<string, BoardCell>();
  for (const o of ordersRes.data ?? []) {
    const lines = (o.order_items ?? []) as unknown as LineRow[];
    const amount = lines.reduce((sum, l) => sum + (l.line_total_minor ?? 0), 0);
    cells.set(cellKey(o.profile_id, o.service_date), {
      orderId: o.id,
      status: o.status as BoardCell["status"],
      source: o.source as BoardCell["source"],
      dishName: lines[0]?.item_name_snapshot ?? null,
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

/* -------------------------------------------------- profile and membership */

/**
 * Display name is per-org: the same person may be "Neil" in one office and
 * their full name in another, so this writes the membership, not the profile.
 */
export async function setDisplayName(args: {
  orgId: number; profileId: string; displayName: string;
}): Promise<void> {
  const trimmed = args.displayName.trim();
  if (trimmed === "") throw new Error("A display name cannot be blank.");
  const { error } = await supabase
    .from("memberships")
    .update({ display_name: trimmed })
    .eq("org_id", args.orgId)
    .eq("profile_id", args.profileId);
  if (error) throw error;
}

export type Invitation = {
  id: number; email: string; role: string; token: string;
  expiresAt: string; acceptedAt: string | null;
};

export async function fetchInvitations(orgId: number): Promise<Invitation[]> {
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, token, expires_at, accepted_at")
    .eq("org_id", orgId)
    .order("id", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, email: r.email, role: r.role, token: r.token,
    expiresAt: r.expires_at, acceptedAt: r.accepted_at,
  }));
}

export async function createInvitation(args: {
  orgId: number; email: string; role: "member" | "admin"; invitedBy: string;
}): Promise<Invitation> {
  const { data, error } = await supabase
    .from("invitations")
    .upsert({
      org_id: args.orgId, email: args.email.trim().toLowerCase(),
      role: args.role, invited_by: args.invitedBy,
    }, { onConflict: "org_id,email" })
    .select("id, email, role, token, expires_at, accepted_at")
    .single();
  if (error) throw error;
  return {
    id: data.id, email: data.email, role: data.role, token: data.token,
    expiresAt: data.expires_at, acceptedAt: data.accepted_at,
  };
}

export async function revokeInvitation(id: number): Promise<void> {
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) throw error;
}

/**
 * The only way a non-member gets into an org. Every check lives in the
 * database function: an invitee is in no org, so no RLS policy could grant
 * them sight of their own invitation row.
 */
export async function acceptInvitation(token: string): Promise<{ slug: string; name: string }> {
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) throw error;
  const row = (data as Array<{ org_slug: string; org_name: string }> | null)?.[0];
  if (!row) throw new Error("That invitation could not be used.");
  return { slug: row.org_slug, name: row.org_name };
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

export async function fetchTransfers(args: {
  orgId: number; meProfileId: string; fromDate: string;
}): Promise<{ incoming: TransferRow[]; outgoing: TransferRow[]; giveable: GiveableOrder[] }> {
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
      .gte("service_date", args.fromDate)
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
  const live = new Map<number, string>();
  for (const t of rows) {
    if (t.status === "pending" || t.status === "accepted") live.set(t.orderId, t.toName);
  }

  return {
    incoming: rows.filter((t) => t.toProfileId === args.meProfileId && t.status === "pending"),
    outgoing: rows.filter((t) => t.fromProfileId === args.meProfileId),
    giveable: (ordersRes.data ?? []).map((o) => {
      const lines = (o.order_items ?? []) as unknown as Line[];
      return {
        orderId: o.id,
        serviceDate: o.service_date,
        dishName: lines[0]?.item_name_snapshot ?? null,
        amountMinor: lines.reduce((s, l) => s + (l.line_total_minor ?? 0), 0) || null,
        pendingWith: live.get(o.id) ?? null,
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
  orgId: number; orderId: number; toProfileId: string;
  createdBy: string; reason: string | null;
}): Promise<void> {
  const { error } = await supabase.from("meal_transfers").insert({
    org_id: args.orgId,
    order_id: args.orderId,
    to_profile_id: args.toProfileId,
    // Overwritten by the trigger from the order; sent only because it is NOT NULL.
    from_profile_id: args.createdBy,
    created_by: args.createdBy,
    reason: args.reason,
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

/**
 * Every upcoming order in the org, for an admin recording a swap between two
 * other people. Members can read these too (the board is shared), but only an
 * admin can create a transfer against someone else's order.
 */
export async function fetchOrgUpcomingOrders(args: {
  orgId: number; fromDate: string;
}): Promise<Array<{
  orderId: number; serviceDate: string; profileId: string; memberName: string;
  dishName: string | null; amountMinor: number | null; pendingWith: string | null;
}>> {
  const [ordersRes, membersRes, transfersRes] = await Promise.all([
    supabase
      .from("orders")
      .select(`id, service_date, profile_id,
               order_items ( item_name_snapshot, line_total_minor )`)
      .eq("org_id", args.orgId)
      .eq("status", "placed")
      .gte("service_date", args.fromDate)
      .order("service_date"),
    supabase
      .from("memberships")
      .select(`profile_id, short_code, display_name, profiles ( full_name )`)
      .eq("org_id", args.orgId)
      .eq("status", "active"),
    supabase
      .from("meal_transfers")
      .select(`order_id, to_profile_id, status`)
      .eq("org_id", args.orgId)
      .in("status", ["pending", "accepted"]),
  ]);
  for (const r of [ordersRes, membersRes, transfersRes]) if (r.error) throw r.error;

  const nameOf = new Map<string, string>();
  for (const m of membersRes.data ?? []) {
    const prof = m.profiles as unknown as { full_name: string } | null;
    nameOf.set(m.profile_id, m.display_name ?? prof?.full_name ?? m.short_code);
  }
  const live = new Map<number, string>();
  for (const t of transfersRes.data ?? []) {
    live.set(t.order_id, nameOf.get(t.to_profile_id) ?? "someone");
  }

  type Line = { item_name_snapshot: string; line_total_minor: number | null };
  return (ordersRes.data ?? []).map((o) => {
    const lines = (o.order_items ?? []) as unknown as Line[];
    return {
      orderId: o.id,
      serviceDate: o.service_date,
      profileId: o.profile_id,
      memberName: nameOf.get(o.profile_id) ?? "someone",
      dishName: lines[0]?.item_name_snapshot ?? null,
      amountMinor: lines.reduce((s, l) => s + (l.line_total_minor ?? 0), 0) || null,
      pendingWith: live.get(o.id) ?? null,
    };
  });
}

export type OrgMember = {
  membershipId: number;
  profileId: string;
  email: string;
  name: string;
  role: "member" | "admin" | "owner";
  status: "active" | "inactive";
  isMe: boolean;
};

export async function fetchOrgMembers(args: {
  orgId: number; meProfileId: string;
}): Promise<OrgMember[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select(`id, profile_id, role, status, short_code, display_name,
             profiles ( email, full_name )`)
    .eq("org_id", args.orgId);
  if (error) throw error;

  return (data ?? []).map((m) => {
    const prof = m.profiles as unknown as { email: string; full_name: string } | null;
    return {
      membershipId: m.id,
      profileId: m.profile_id,
      email: prof?.email ?? "",
      name: m.display_name ?? prof?.full_name ?? m.short_code,
      role: m.role as OrgMember["role"],
      status: m.status as OrgMember["status"],
      isMe: m.profile_id === args.meProfileId,
    };
  }).sort((a, b) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1,
  );
}

/**
 * Change a role or deactivate someone.
 *
 * Invitations deliberately cannot lower a role -- a stale link should not
 * quietly reduce access weeks later -- so demotion needs an explicit act, and
 * this is it. The role-guard trigger still refuses to let anyone change their
 * own role, so an admin cannot lock themselves out or promote themselves.
 */
export async function updateMembership(args: {
  membershipId: number;
  role?: "member" | "admin" | "owner";
  status?: "active" | "inactive";
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (args.role) patch["role"] = args.role;
  if (args.status) patch["status"] = args.status;
  const { error } = await supabase
    .from("memberships").update(patch).eq("id", args.membershipId);
  if (error) throw error;
}

/* -------------------------------------------------------------- telegram */

export type TelegramLink = {
  membershipId: number;
  linkToken: string;
  /** True once the member has completed /start from a Telegram chat. */
  linked: boolean;
};

/**
 * This member's bot link, or null if they have never had one.
 *
 * The profile_id filter is mandatory, not defensive: telegram_links_admin lets
 * an org admin read every row in the org, so an unfiltered query hands an admin
 * a colleague's link_token -- the single credential that binds a Telegram chat
 * to a membership. That is exactly why this table is separate from memberships.
 */
export async function fetchTelegramLink(
  orgId: number, profileId: string,
): Promise<TelegramLink | null> {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("membership_id, link_token, chat_id, memberships!inner ( profile_id )")
    .eq("org_id", orgId)
    .eq("memberships.profile_id", profileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    membershipId: data.membership_id,
    linkToken: data.link_token,
    linked: data.chat_id !== null,
  };
}

/**
 * Mint the row on demand rather than on read: a token that exists only because
 * somebody opened Preferences is a credential nobody asked for.
 */
export async function createTelegramLink(
  orgId: number, profileId: string,
): Promise<TelegramLink> {
  const membership = await supabase
    .from("memberships").select("id")
    .eq("org_id", orgId).eq("profile_id", profileId).single();
  if (membership.error) throw membership.error;

  const { data, error } = await supabase
    .from("telegram_links")
    .upsert({ membership_id: membership.data.id, org_id: orgId }, { onConflict: "membership_id" })
    .select("membership_id, link_token, chat_id")
    .single();
  if (error) throw error;
  return {
    membershipId: data.membership_id,
    linkToken: data.link_token,
    linked: data.chat_id !== null,
  };
}

/**
 * Disconnect the chat, keeping the token so reconnecting is one tap. The bot
 * resolves a chat through chat_id alone, so clearing it is what actually stops
 * it answering.
 */
export async function unlinkTelegram(membershipId: number): Promise<void> {
  const { error } = await supabase
    .from("telegram_links")
    .update({ chat_id: null, linked_at: null })
    .eq("membership_id", membershipId);
  if (error) throw error;
}
