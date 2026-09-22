/**
 * The Telegram webhook: the interface most people will actually use.
 *
 * Three things make this safe enough to be a public HTTPS endpoint:
 *
 *  1. Telegram is the only caller. Every update carries the
 *     X-Telegram-Bot-Api-Secret-Token set at setWebhook time, compared here in
 *     constant time against TELEGRAM_WEBHOOK_SECRET. Without that check this is
 *     an unauthenticated write endpoint to the database, because the body is
 *     JSON somebody else chose.
 *
 *  2. It never writes as the service role. chat_id -> telegram_links ->
 *     memberships -> profile_id is resolved with the service key, and every
 *     domain write then goes through a client authenticated AS that member, so
 *     the cutoff trigger, the menu lifecycle and the transfer consent rules
 *     apply exactly as they do for the browser. See _shared/userToken.ts.
 *
 *  3. The database's own refusals are passed through word for word. Those
 *     messages ("ordering for 2026-09-23 closed at 21:00 22/09") are written
 *     for people; inventing our own wording here would be a second, quietly
 *     wrong copy of the rule.
 *
 * DEPLOY WITH JWT VERIFICATION DISABLED. Telegram sends no project JWT, so the
 * platform gate would reject every update before this code runs:
 *   supabase functions deploy telegram --no-verify-jwt
 * scripts/deploy-functions.sh does this. There is no CORS block, unlike
 * parse-assist, because no browser ever calls this.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { memberClient, serviceClient } from "../_shared/userToken.ts";
import { secretsMatch } from "../_shared/secrets.ts";
import {
  answerCallbackQuery, editMessageText, sendMessage, type InlineKeyboard,
} from "../_shared/telegramApi.ts";
import {
  addDaysIso, decodeCallback, encodeCallback, escapeHtml, formatCutoffIn, formatServiceDate,
  humanError, isLinkToken, nextOrderableDay, orderingClosedReason, parseCommand, todayIn,
  vietQrLink,
} from "../_shared/telegram.ts";
import { formatMoney, type Currency } from "../_shared/money.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

const HELP = [
  "<b>What I can do</b>",
  "/today - the next menu, and order from it",
  "/cancel - cancel today's order",
  "/me - what you owe this week",
  "/help - this message",
].join("\n");

/* ------------------------------------------------------------------- types */

type Org = {
  id: number;
  name: string;
  timezone: string;
  currency: string;
  currency_minor_units: number;
  locale: string;
  payment_config: unknown;
};

type Link = {
  membershipId: number;
  profileId: string;
  isAdmin: boolean;
  org: Org;
};

type MenuRow = {
  id: number;
  org_id: number;
  service_date: string;
  status: string;
  order_cutoff_at: string;
  menu_items: Array<{
    id: number; name: string; price_minor: number; position: number; is_available: boolean;
  }> | null;
};

type OrderRow = {
  id: number;
  status: string;
  source: string;
  order_items: Array<{
    menu_item_id: number; item_name_snapshot: string; line_total_minor: number | null;
  }> | null;
};

/** Everything humanError() reads, so a refusal we raise ourselves fits too. */
type Failure = { message?: string; code?: string } | null;

/* ---------------------------------------------------------------- entry point */

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  if (!await secretsMatch(req.headers.get("X-Telegram-Bot-Api-Secret-Token"), WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (BOT_TOKEN === "") {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return new Response("not configured", { status: 500 });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // 200 whatever happened downstream. Telegram redelivers a non-2xx, and a
  // redelivery of an update we already acted on would order lunch twice.
  try {
    await handle(update);
  } catch (e) {
    console.error("telegram handler escaped its own guard", e);
  }
  return new Response("ok");
});

async function handle(update: Record<string, unknown>): Promise<void> {
  const callback = update["callback_query"] as CallbackQuery | undefined;
  const message = (update["message"] ?? update["edited_message"]) as Message | undefined;

  try {
    if (callback) return await onCallback(callback);
    if (!message) return; // joins, leaves, channel posts: nothing to answer
    return await onMessage(message);
  } catch (e) {
    // A thrown error here is ours, not the member's: a missing secret, or
    // Postgres unreachable. Say so rather than going quiet, because a bot that
    // silently ignores you is indistinguishable from one that is switched off.
    console.error("telegram update failed", e);
    const chatId = callback?.message?.chat.id ?? message?.chat.id;
    if (callback) await answerCallbackQuery(BOT_TOKEN, callback.id, "Something went wrong.", true);
    if (chatId !== undefined) {
      await say(chatId, "Something went wrong on our side. Try again in a minute.");
    }
  }
}

type Message = {
  chat: { id: number; type?: string };
  text?: string;
  from?: { first_name?: string };
};
type CallbackQuery = {
  id: string;
  data?: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
};

/* -------------------------------------------------------------- messages in */

async function onMessage(message: Message): Promise<void> {
  const chatId = message.chat.id;
  const command = parseCommand(message.text ?? "");

  // In a group the bot may see ordinary conversation if privacy mode is off.
  // Answering all of it would make the bot the loudest member of the office.
  if (command === null && (message.chat.type ?? "private") !== "private") return;

  if (command?.name === "start" && command.arg !== "") {
    return await onStart(chatId, command.arg);
  }

  const links = await linksForChat(chatId);
  if (links.length === 0) {
    // Says nothing about whether an account exists: an unlinked chat and a
    // chat belonging to nobody get the same answer.
    await say(chatId,
      "To use this bot, open the lunch app, go to <b>Preferences</b> and tap " +
      "<b>Connect Telegram</b>. That gives you a link which brings you back here.");
    return;
  }

  switch (command?.name) {
    case "today": return await onToday(chatId, links);
    case "me": return await onMe(chatId, links);
    case "cancel": return await onCancel(chatId, links);
    case "start":
    case "help": {
      const name = escapeHtml(message.from?.first_name ?? "there");
      await say(chatId, `Hi ${name}, you're connected.\n\n${HELP}`);
      return;
    }
    default:
      await say(chatId, HELP);
      return;
  }
}

/* ------------------------------------------------------------------- /start */

async function onStart(chatId: number, token: string): Promise<void> {
  const unknown =
    "That link isn't valid any more. Open the lunch app, go to <b>Preferences</b> " +
    "and tap <b>Connect Telegram</b> for a fresh one.";

  if (!isLinkToken(token)) return await say(chatId, unknown);

  // There is no member to act as yet: whoever sent this is not yet anybody.
  // The link_token is the credential, which is why telegram_links sits outside
  // memberships at all -- RLS cannot hide a column, so a token on a row every
  // colleague can read would be readable by every colleague.
  const admin = serviceClient();
  const { data: link, error } = await admin
    .from("telegram_links")
    .select("membership_id, org_id, chat_id, organizations ( name )")
    .eq("link_token", token)
    .maybeSingle();

  if (error) {
    console.error("link lookup failed", error);
    return await say(chatId, "Something went wrong looking that link up. Try again.");
  }
  if (!link) return await say(chatId, unknown);

  const orgName = escapeHtml(
    (link.organizations as unknown as { name: string } | null)?.name ?? "your office",
  );

  if (link.chat_id === chatId) {
    return await say(chatId, `You're already connected to <b>${orgName}</b>.\n\n${HELP}`);
  }

  const { error: upd } = await admin
    .from("telegram_links")
    .update({ chat_id: chatId, linked_at: new Date().toISOString() })
    .eq("membership_id", link.membership_id);

  if (upd) {
    // telegram_links_chat_uk is unique on (org_id, chat_id) where chat_id is
    // not null, so this is somebody else in the same office already using this
    // chat. Their name is withheld: the person holding this token has not been
    // authenticated as anybody yet.
    if (upd.code === "23505") {
      return await say(chatId,
        `This Telegram account is already connected to another member of <b>${orgName}</b>. ` +
        "Ask them to disconnect in Preferences, or use a different Telegram account.");
    }
    console.error("link update failed", upd);
    return await say(chatId, "Something went wrong connecting you. Try again.");
  }

  await say(chatId, `Connected to <b>${orgName}</b>.\n\n${HELP}`);
}

/* ------------------------------------------------------------------- /today */

async function onToday(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const member = await memberClient(link.profileId);
    const rendered = await renderDay(member, link, links.length > 1);
    await say(chatId, rendered.text, rendered.keyboard);

    const offers = await renderOffers(member, link);
    for (const offer of offers) await say(chatId, offer.text, offer.keyboard);
  }
}

async function renderDay(
  member: SupabaseClient, link: Link, showOrgName: boolean, menuId?: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const now = new Date();
  const today = todayIn(link.org.timezone, now);
  const currency = currencyOf(link.org);

  const header = showOrgName ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";
  const fields = `id, org_id, service_date, status, order_cutoff_at,
                  menu_items ( id, name, price_minor, position, is_available )`;
  const gate = { isAdmin: link.isAdmin, now, timeZone: link.org.timezone };

  let menu: MenuRow;
  let closedReason: string | null;

  if (menuId === undefined) {
    const { data, error } = await member
      .from("menus").select(fields)
      .eq("org_id", link.org.id)
      .gte("service_date", today)
      .lte("service_date", addDaysIso(today, 6));
    if (error) return { text: escapeHtml(humanError(error)), keyboard: [] };

    const chosen = nextOrderableDay(
      ((data ?? []) as unknown as MenuRow[]).map((m) => ({
        serviceDate: m.service_date, status: m.status, orderCutoffAt: m.order_cutoff_at, row: m,
      })),
      { ...gate, today },
    );
    if (!chosen) {
      return { text: `${header}No menu is up yet. I'll be here when there is one.`, keyboard: [] };
    }
    menu = chosen.menu.row;
    closedReason = chosen.closedReason;
  } else {
    // A button names its own menu, so that day is shown whether or not it is
    // still the next one; the reason below explains itself either way.
    const { data, error } = await member
      .from("menus").select(fields).eq("id", menuId).maybeSingle();
    if (error) return { text: escapeHtml(humanError(error)), keyboard: [] };
    if (!data) return { text: `${header}That menu is gone.`, keyboard: [] };
    menu = data as unknown as MenuRow;
    closedReason = orderingClosedReason({
      ...gate,
      menu: {
        serviceDate: menu.service_date,
        status: menu.status,
        orderCutoffAt: menu.order_cutoff_at,
      },
    });
  }

  const dishes = (menu.menu_items ?? [])
    .filter((i) => i.is_available)
    .sort((a, b) => a.position - b.position || a.id - b.id);

  const order = await myOrder(member, link, menu.id);

  const lines = [`${header}<b>${formatServiceDate(menu.service_date)}</b>`];
  if (closedReason !== null) {
    lines.push(escapeHtml(closedReason));
  } else {
    lines.push(`Orders close ${formatCutoffIn(menu.order_cutoff_at, link.org.timezone)}.`);
  }
  lines.push("");

  if (dishes.length === 0) {
    lines.push("No dishes on this menu.");
  } else {
    for (const d of dishes) {
      lines.push(`- ${escapeHtml(d.name)}  ${escapeHtml(formatMoney(d.price_minor, currency))}`);
    }
  }

  lines.push("");
  const line = order?.order_items?.[0];
  if (!order || order.status === "cancelled") {
    lines.push("You're <b>not</b> down as eating.");
  } else if (!line) {
    lines.push("You're down as eating, but haven't picked a dish yet.");
  } else {
    lines.push(
      `You: <b>${escapeHtml(line.item_name_snapshot)}</b>` +
      (line.line_total_minor === null
        ? ""
        : ` (${escapeHtml(formatMoney(line.line_total_minor, currency))})`),
    );
  }

  const keyboard: InlineKeyboard = closedReason !== null
    ? []
    : dishes.map((d) => [{
      text: d.name.length > 40 ? `${d.name.slice(0, 39)}…` : d.name,
      callback_data: encodeCallback({ kind: "pick", menuId: menu.id, itemId: d.id }),
    }]);
  if (closedReason === null && order && order.status === "placed") {
    keyboard.push([{
      text: "Not eating today",
      callback_data: encodeCallback({ kind: "clear", menuId: menu.id }),
    }]);
  }

  return { text: lines.join("\n"), keyboard };
}

async function myOrder(
  member: SupabaseClient, link: Link, menuId: number,
): Promise<OrderRow | null> {
  // profile_id is mandatory, not defensive: orders became org-wide readable
  // with the shared board, so without it this returns every colleague's order.
  const { data } = await member
    .from("orders")
    .select("id, status, source, order_items ( menu_item_id, item_name_snapshot, line_total_minor )")
    .eq("menu_id", menuId)
    .eq("profile_id", link.profileId)
    .maybeSingle();
  return (data ?? null) as unknown as OrderRow | null;
}

/* ---------------------------------------------------------------- transfers */

async function renderOffers(
  member: SupabaseClient, link: Link,
): Promise<Array<{ text: string; keyboard: InlineKeyboard }>> {
  const { data, error } = await member
    .from("meal_transfers")
    .select(`id, from_profile_id,
             orders ( service_date, order_items ( item_name_snapshot, line_total_minor ) )`)
    .eq("org_id", link.org.id)
    .eq("to_profile_id", link.profileId)
    .eq("status", "pending");
  if (error || !data || data.length === 0) return [];

  const names = await namesIn(member, link.org.id);
  const currency = currencyOf(link.org);

  return data.map((t) => {
    const order = t.orders as unknown as
      { service_date: string; order_items: Array<{ item_name_snapshot: string; line_total_minor: number | null }> } | null;
    const item = order?.order_items?.[0];
    const who = escapeHtml(names.get(t.from_profile_id) ?? "A colleague");
    const what = item
      ? `${escapeHtml(item.item_name_snapshot)}${
        item.line_total_minor === null
          ? ""
          : ` (${escapeHtml(formatMoney(item.line_total_minor, currency))})`
      }`
      : "their lunch";
    const day = order ? formatServiceDate(order.service_date) : "an upcoming day";
    return {
      text: `${who} is offering you ${what} on <b>${day}</b>.\n` +
        "If you accept, the cost moves to your bill.",
      keyboard: [[
        {
          text: "Accept",
          callback_data: encodeCallback({ kind: "transfer", transferId: t.id, decision: "accepted" }),
        },
        {
          text: "Decline",
          callback_data: encodeCallback({ kind: "transfer", transferId: t.id, decision: "declined" }),
        },
      ]],
    };
  });
}

async function namesIn(member: SupabaseClient, orgId: number): Promise<Map<string, string>> {
  const { data } = await member
    .from("memberships")
    .select("profile_id, short_code, display_name, profiles ( full_name )")
    .eq("org_id", orgId)
    .eq("status", "active");
  const out = new Map<string, string>();
  for (const m of data ?? []) {
    const prof = m.profiles as unknown as { full_name: string } | null;
    out.set(m.profile_id, m.display_name ?? prof?.full_name ?? m.short_code);
  }
  return out;
}

/* ---------------------------------------------------------------------- /me */

async function onMe(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const member = await memberClient(link.profileId);
    const currency = currencyOf(link.org);

    // billing_statements is own-row under RLS and the profile_id filter says so
    // out loud. Nobody ever sees anybody else's balance through this bot.
    const { data, error } = await member
      .from("billing_statements")
      .select(`meal_count, meals_minor, carried_in_minor, total_due_minor, paid_minor,
               payment_ref, status, billing_periods ( period_start, period_end )`)
      .eq("org_id", link.org.id)
      .eq("profile_id", link.profileId)
      .order("billing_period_id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      await say(chatId, escapeHtml(humanError(error)));
      continue;
    }

    const head = links.length > 1 ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";
    if (!data) {
      await say(chatId, `${head}Nothing billed to you yet.`);
      continue;
    }

    const period = data.billing_periods as unknown as
      { period_start: string; period_end: string } | null;
    const outstanding = Number(data.total_due_minor) - Number(data.paid_minor);

    const lines = [
      `${head}<b>${
        period
          ? `${formatServiceDate(period.period_start)} to ${formatServiceDate(period.period_end)}`
          : "Latest week"
      }</b>`,
      `${data.meal_count} meals: ${escapeHtml(formatMoney(Number(data.meals_minor), currency))}`,
    ];
    if (Number(data.carried_in_minor) > 0) {
      lines.push(
        `Owed from before: ${escapeHtml(formatMoney(Number(data.carried_in_minor), currency))}`,
      );
    }
    lines.push(
      `<b>Total due: ${escapeHtml(formatMoney(Number(data.total_due_minor), currency))}</b>`,
    );
    if (Number(data.paid_minor) > 0) {
      lines.push(`Paid so far: ${escapeHtml(formatMoney(Number(data.paid_minor), currency))}`);
    }
    lines.push(`Status: ${escapeHtml(data.status)}`);
    lines.push("");
    lines.push(`Put <code>${escapeHtml(data.payment_ref)}</code> in the transfer message.`);

    const qr = vietQrLink(link.org.payment_config, {
      amountMinor: Math.max(outstanding, 0),
      minorUnits: link.org.currency_minor_units,
      addInfo: data.payment_ref,
    });
    if (qr) lines.push(`<a href="${escapeHtml(qr)}">Pay by QR</a>`);

    await say(chatId, lines.join("\n"));
  }
}

/* ------------------------------------------------------------------ /cancel */

async function onCancel(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const member = await memberClient(link.profileId);
    const today = todayIn(link.org.timezone, new Date());
    const head = links.length > 1 ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";

    const { data: order, error } = await member
      .from("orders")
      .select("id, status")
      .eq("org_id", link.org.id)
      .eq("profile_id", link.profileId)
      .eq("service_date", today)
      .maybeSingle();

    if (error) {
      await say(chatId, head + escapeHtml(humanError(error)));
      continue;
    }
    if (!order) {
      await say(chatId, `${head}You have no order for ${formatServiceDate(today)}.`);
      continue;
    }
    if (order.status === "cancelled") {
      await say(chatId, `${head}Your order for ${formatServiceDate(today)} is already cancelled.`);
      continue;
    }

    const failure = await cancel(member, order.id);
    await say(chatId, failure
      ? head + escapeHtml(humanError(failure))
      : `${head}Cancelled your order for ${formatServiceDate(today)}.`);
  }
}

/**
 * Members have no DELETE on orders on purpose: cancelling is a status change,
 * which keeps the audit trail and holds the one-order-per-day slot so a
 * republished menu cannot silently resurrect it.
 */
async function cancel(member: SupabaseClient, orderId: number): Promise<Failure> {
  const { error } = await member
    .from("orders")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", orderId);
  return error;
}

/* ------------------------------------------------------------- button taps */

async function onCallback(cb: CallbackQuery): Promise<void> {
  const chat = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  const action = decodeCallback(cb.data ?? "");

  if (chat === undefined || messageId === undefined || action === null) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, "That button has expired.");
    return;
  }

  const links = await linksForChat(chat);
  if (links.length === 0) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, "This chat is no longer connected.", true);
    return;
  }

  // Which member acts is decided by the chat, never by the button; the button
  // only says which org's row it refers to, and a chat linked in two orgs must
  // not act in the wrong one. Everything after this is re-checked by RLS and
  // the triggers as that member.
  const orgId = await orgOfCallback(action);
  const link = links.find((l) => l.org.id === orgId);
  if (!link) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, "That button isn't for this chat.", true);
    return;
  }
  const member = await memberClient(link.profileId);

  if (action.kind === "transfer") {
    const { error } = await member
      .from("meal_transfers")
      .update({ status: action.decision })
      .eq("id", action.transferId);
    await answerCallbackQuery(
      BOT_TOKEN, cb.id,
      error ? humanError(error) : action.decision === "accepted" ? "Accepted" : "Declined",
      error !== null,
    );
    if (!error) {
      await edit(chat, messageId,
        action.decision === "accepted"
          ? "You accepted this meal. It will appear on your bill."
          : "You declined this meal.");
    }
    return;
  }

  const menuId = action.menuId;
  const failure = action.kind === "pick"
    ? await placeOrder(member, link, menuId, action.itemId)
    : await clearOrder(member, link, menuId);

  await answerCallbackQuery(
    BOT_TOKEN, cb.id,
    failure ? humanError(failure) : action.kind === "pick" ? "Ordered" : "Cancelled",
    failure !== null,
  );

  // Redrawn from the database either way, so a refusal leaves the member
  // looking at what is actually true rather than at their failed tap.
  const rendered = await renderDay(member, link, links.length > 1, menuId);
  await edit(chat, messageId, rendered.text, rendered.keyboard);
}

/**
 * Which org a tapped button belongs to. Read with the service key because the
 * chat has not been narrowed to one member yet, and it returns only an org id,
 * which the caller must still match against this chat's own links.
 */
async function orgOfCallback(action: { kind: string; menuId?: number; transferId?: number }) {
  const admin = serviceClient();
  if (action.kind === "transfer") {
    const { data } = await admin
      .from("meal_transfers").select("org_id").eq("id", action.transferId ?? 0).maybeSingle();
    return data?.org_id ?? null;
  }
  const { data } = await admin
    .from("menus").select("org_id").eq("id", action.menuId ?? 0).maybeSingle();
  return data?.org_id ?? null;
}

/**
 * The same sequence setOrder() runs in the web app. Prices are never sent: the
 * snapshot trigger fills them, and the column grant means this client could not
 * write one even if it tried.
 */
async function placeOrder(
  member: SupabaseClient, link: Link, menuId: number, itemId: number,
): Promise<Failure> {
  const { data: menu, error: menuErr } = await member
    .from("menus").select("id, org_id, service_date").eq("id", menuId).maybeSingle();
  if (menuErr) return menuErr;
  if (!menu) return { message: "That menu is gone." };

  const existing = await myOrder(member, link, menuId);
  let orderId = existing?.id;

  if (orderId === undefined) {
    const { data, error } = await member.from("orders").insert({
      org_id: menu.org_id, menu_id: menu.id, service_date: menu.service_date,
      profile_id: link.profileId, created_by: link.profileId, source: "member",
    }).select("id").single();
    if (error) return error;
    orderId = data.id;
  } else if (existing?.status === "cancelled") {
    const { error } = await member
      .from("orders").update({ status: "placed", cancelled_at: null }).eq("id", orderId);
    if (error) return error;
  }

  const { error: del } = await member.from("order_items").delete().eq("order_id", orderId);
  if (del) return del;

  const { error } = await member.from("order_items").insert({
    order_id: orderId, org_id: menu.org_id, profile_id: link.profileId,
    menu_id: menu.id, menu_item_id: itemId,
    // Overwritten unconditionally by the snapshot trigger; sent only because
    // the columns are NOT NULL.
    item_name_snapshot: "", unit_price_minor: 0,
  });
  return error;
}

async function clearOrder(
  member: SupabaseClient, link: Link, menuId: number,
): Promise<Failure> {
  const existing = await myOrder(member, link, menuId);
  if (!existing || existing.status === "cancelled") return null;
  return await cancel(member, existing.id);
}

/* ------------------------------------------------------------------ plumbing */

/**
 * Who this chat is. One person may belong to two offices with different
 * Telegram groups, so this is a list: every command answers for each of them
 * rather than making the member remember which office the bot is "in".
 */
async function linksForChat(chatId: number): Promise<Link[]> {
  const admin = serviceClient();
  const { data, error } = await admin
    .from("telegram_links")
    .select(`membership_id,
             memberships!inner ( profile_id, role, status ),
             organizations!inner ( id, name, timezone, currency, currency_minor_units,
                                   locale, payment_config )`)
    .eq("chat_id", chatId)
    .eq("memberships.status", "active");

  if (error) {
    console.error("chat lookup failed", error);
    return [];
  }

  return (data ?? []).flatMap((row) => {
    const m = row.memberships as unknown as { profile_id: string; role: string } | null;
    const org = row.organizations as unknown as Org | null;
    if (!m || !org) return [];
    return [{
      membershipId: row.membership_id,
      profileId: m.profile_id,
      isAdmin: m.role === "admin" || m.role === "owner",
      org,
    }];
  });
}

function currencyOf(org: Org): Currency {
  return { code: org.currency, minorUnits: org.currency_minor_units, locale: org.locale };
}

async function say(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const res = await sendMessage(BOT_TOKEN, chatId, text, { parseMode: "HTML", keyboard });
  if (!res.ok) console.error("sendMessage failed", res.status, res.description);
}

async function edit(
  chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard,
): Promise<void> {
  const res = await editMessageText(BOT_TOKEN, chatId, messageId, text, {
    parseMode: "HTML", keyboard,
  });
  // "message is not modified" means the reader already sees this, which is the
  // outcome we wanted; anything else is worth a log line and nothing more.
  if (!res.ok && !/message is not modified/i.test(res.description)) {
    console.error("editMessageText failed", res.status, res.description);
  }
}
