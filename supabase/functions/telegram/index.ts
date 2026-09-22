/**
 * The Telegram webhook: the interface most people will actually use.
 *
 * Four things make this safe enough to be a public HTTPS endpoint, and they
 * only work in this order.
 *
 *  1. Telegram is the only caller. Every update carries the
 *     X-Telegram-Bot-Api-Secret-Token set at setWebhook time, compared here in
 *     constant time against TELEGRAM_WEBHOOK_SECRET. Without that check this is
 *     an unauthenticated write endpoint to the database, because the body is
 *     JSON somebody else chose, and every gate below is reasoning about a
 *     chat_id that the caller made up.
 *
 *  2. A chat is somebody only through telegram_links. chat_id -> membership ->
 *     profile_id is the one binding, and it is read with the connection's own
 *     role because at that moment we do not yet know who is asking.
 *
 *  3. A join code is checked by the database, not here. public.join_with_code
 *     is SECURITY DEFINER, always grants the 'member' role, and is the only way
 *     in for somebody with no email address.
 *
 *  4. Every domain read and write then runs AS that member, inside one
 *     transaction, over a direct Postgres connection. See _shared/db.ts: the
 *     service role would silently skip the cutoff, the menu lifecycle check and
 *     the transfer consent rules, because each of those triggers opens with
 *     `if private.is_service() then return ...`.
 *
 * PRIVATE CHATS ONLY for anything personal. In a group, chat_id is the ROOM.
 * Linking it would make one membership stand for everybody present, so whoever
 * typed /me would be reading a colleague's balance and whoever tapped a dish
 * would be ordering in their name. organizations.telegram_group_chat_id stays
 * what it has always been: an address the outbox broadcasts to, never an
 * identity.
 *
 * The database's own refusals are passed through word for word. Those messages
 * ("ordering for 2026-09-23 closed at 21:00 22/09") are written for people;
 * inventing our own wording here would be a second, quietly wrong copy of the
 * rule.
 *
 * DEPLOY WITH JWT VERIFICATION DISABLED. Telegram sends no project JWT, so the
 * platform gate would reject every update before gate 1 above ever ran:
 *   supabase functions deploy telegram --no-verify-jwt
 * scripts/deploy-functions.sh does this. There is no CORS block, unlike
 * parse-assist, because no browser ever calls this.
 */
import { asMember, asSystem, isDatabaseError, type Tx } from "../_shared/db.ts";
import { signedOutClient } from "../_shared/supabaseClient.ts";
import { secretsMatch } from "../_shared/secrets.ts";
import {
  answerCallbackQuery, editMessageText, sendMessage, type InlineKeyboard,
} from "../_shared/telegramApi.ts";
import {
  addDaysIso, decodeCallback, encodeCallback, escapeHtml, formatCutoffIn, formatServiceDate,
  humanError, isJoinCode, isLinkToken, joinCodeInPrompt, namePrompt, nextOrderableDay,
  normalizeJoinCode, orderingClosedReason, parseCommand, todayIn, vietQrLink,
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

// Says nothing about whether an account exists: an unlinked chat and a chat
// belonging to nobody get the same answer. It names both doors, because the two
// kinds of member arrive by different ones.
const NOT_CONNECTED = [
  "I don't know who you are yet.",
  "",
  "If your office gave you a <b>join code</b>, send it to me and I'll sign you up.",
  "",
  "If you already use the lunch app, open it, go to <b>Preferences</b> and tap " +
  "<b>Connect Telegram</b>. That gives you a link which brings you back here.",
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
  profileId: string;
  /** profiles.full_name, not the per-org display name: join_with_code writes it. */
  fullName: string;
  isAdmin: boolean;
  org: Org;
};

type Chat = { id: number; type?: string };
type Sender = { id: number; is_bot?: boolean; first_name?: string };
type Message = {
  chat: Chat;
  text?: string;
  from?: Sender;
  reply_to_message?: { text?: string; from?: Sender };
};
type CallbackQuery = {
  id: string;
  data?: string;
  message?: { message_id: number; chat: Chat };
};

type Rendered = { text: string; keyboard: InlineKeyboard };

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
    // Anything reaching here is ours, not the member's: the database was
    // unreachable, or a secret is missing. A refusal from Postgres never gets
    // this far, because attempt() turns those into words further down. Say so
    // rather than going quiet, because a bot that silently ignores you is
    // indistinguishable from one that is switched off.
    console.error("telegram update failed", e);
    const chatId = callback?.message?.chat.id ?? message?.chat.id;
    if (callback) await answerCallbackQuery(BOT_TOKEN, callback.id, "Something went wrong.", true);
    if (chatId !== undefined) {
      await say(chatId, "Something went wrong on our side. Try again in a minute.");
    }
  }
}

/**
 * A refusal from the database, turned into the sentence it was written to be.
 *
 * Anything that is not a refusal is rethrown on purpose: a dead socket is not
 * something to explain to somebody who asked what is for lunch, and its message
 * names our infrastructure.
 */
async function attempt<T>(
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (e) {
    if (!isDatabaseError(e)) throw e;
    return { ok: false, reason: humanError(e) };
  }
}

/* -------------------------------------------------------------- messages in */

async function onMessage(message: Message): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text ?? "";
  const command = parseCommand(text);

  if ((message.chat.type ?? "private") !== "private") {
    // In a group the bot may also see ordinary conversation if privacy mode is
    // off, and answering all of it would make it the loudest member of the
    // office. Nothing personal happens here either way; see the header.
    if (command?.name === "start" || command?.name === "help") {
      await say(chatId,
        "I take orders in a private chat, so that each order belongs to one " +
        "person. Message me directly and I'll get you set up.");
    }
    return;
  }

  const links = await linksForChat(chatId);

  if (command?.name === "start" && isLinkToken(command.arg)) {
    return await onLinkToken(chatId, command.arg);
  }

  // A join code arrives as /start CODE from a group's invite link, or on its
  // own from somebody who copied it off a whiteboard. The two shapes cannot be
  // confused: a link token is a uuid, a join code is not.
  const code = command?.name === "start" && isJoinCode(command.arg)
    ? command.arg
    : command === null && links.length === 0 && isJoinCode(text)
    ? text
    : null;
  if (code !== null) return await onJoinCode(chatId, links, code);

  // The answer to our own name prompt. Telegram hands the prompt back in
  // reply_to_message, which is where the join code has been waiting: this
  // function keeps nothing between two updates, and a conversation-state table
  // would be a fourth door into a schema whose doors are the point.
  if (command === null && message.reply_to_message?.from?.is_bot === true) {
    const pending = joinCodeInPrompt(message.reply_to_message.text);
    if (pending !== null) return await onName(chatId, links, pending, text);
  }

  if (links.length === 0) return await say(chatId, NOT_CONNECTED);

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

/* --------------------------------------------------------- joining an office */

/**
 * Redeeming a link_token, for somebody who already has a web account.
 *
 * There is no member to act as yet: whoever sent this is not yet anybody. The
 * token IS the credential, which is why telegram_links sits outside memberships
 * at all -- RLS cannot hide a column, so a token on a row every colleague can
 * read would be readable by every colleague.
 */
async function onLinkToken(chatId: number, token: string): Promise<void> {
  const unknown =
    "That link isn't valid any more. Open the lunch app, go to <b>Preferences</b> " +
    "and tap <b>Connect Telegram</b> for a fresh one.";

  const [link] = await asSystem((tx) =>
    tx<Array<{ membership_id: number; chat_id: number | null; org_name: string }>>`
      select tl.membership_id, tl.chat_id, o.name as org_name
        from public.telegram_links tl
        join public.organizations o on o.id = tl.org_id
       where tl.link_token = ${token}::uuid`
  );
  if (!link) return await say(chatId, unknown);

  const orgName = escapeHtml(link.org_name);
  if (link.chat_id === chatId) {
    return await say(chatId, `You're already connected to <b>${orgName}</b>.\n\n${HELP}`);
  }

  try {
    await asSystem((tx) =>
      tx`update public.telegram_links
            set chat_id = ${chatId}, linked_at = now()
          where membership_id = ${link.membership_id}`);
  } catch (e) {
    if (!isDatabaseError(e)) throw e;
    // telegram_links_chat_uk is unique on (org_id, chat_id) where chat_id is
    // not null, so 23505 here is somebody else in the same office already
    // using this chat. Their name is withheld: whoever holds this token has
    // not been authenticated as anybody yet.
    if (e.code === "23505") {
      return await say(chatId,
        `This Telegram account is already connected to another member of <b>${orgName}</b>. ` +
        "Ask them to disconnect in Preferences, or use a different Telegram account.");
    }
    console.error("link redemption failed", e);
    return await say(chatId, "Something went wrong connecting you. Try again.");
  }

  await say(chatId, `Connected to <b>${orgName}</b>.\n\n${HELP}`);
}

/** The org a join code opens, read before anything is created. */
async function orgForJoinCode(code: string): Promise<{ id: number; name: string } | null> {
  const [org] = await asSystem((tx) =>
    tx<Array<{ id: number; name: string }>>`
      select o.id, o.name from public.organizations o
       where o.telegram_join_code = ${code} and o.status = 'active'`
  );
  return org ?? null;
}

/**
 * Step one of joining: work out whether a name is needed, and ask for it.
 *
 * The code is validated first, and deliberately before any account exists.
 * join_with_code() writes profiles.full_name and private.suggest_short_code()
 * then folds that name into the code printed on bank transfer memos, so the
 * name has to be in hand before the signup -- and an anonymous user created for
 * a signup that is then abandoned is a row nobody can ever sign in to again.
 */
async function onJoinCode(chatId: number, links: Link[], raw: string): Promise<void> {
  const code = normalizeJoinCode(raw);
  const org = await orgForJoinCode(code);
  if (org === null) return await say(chatId, "That join code is not valid.");

  if (links.some((l) => l.org.id === org.id)) {
    return await say(chatId,
      `You're already connected to <b>${escapeHtml(org.name)}</b>.\n\n${HELP}`);
  }

  const known = soleProfile(links);
  if (known !== null) return await join(chatId, code, known.profileId, known.fullName);

  await sayPrompt(chatId, namePrompt(org.name, code));
}

/** Step two: the reply to that prompt, which is the first time a name exists. */
async function onName(
  chatId: number, links: Link[], code: string, raw: string,
): Promise<void> {
  const name = raw.trim();
  if (name === "") {
    return await sayPrompt(chatId, "I still need a name. Reply to this with it.\n\n" +
      `Join code: ${escapeHtml(code)}`);
  }

  const org = await orgForJoinCode(code);
  if (org === null) return await say(chatId, "That join code is not valid.");
  if (links.some((l) => l.org.id === org.id)) {
    return await say(chatId,
      `You're already connected to <b>${escapeHtml(org.name)}</b>.\n\n${HELP}`);
  }

  const known = soleProfile(links);
  if (known !== null) return await join(chatId, code, known.profileId, known.fullName);
  return await signUpAndJoin(chatId, code, name);
}

/**
 * The chat's single existing identity, if it has exactly one.
 *
 * Somebody who is already a member of one office and joins a second is the same
 * person, so they join as themselves. Signing them up again would split one
 * human across two accounts, and the anonymous account has no email address to
 * ever merge them back with. Their existing name is passed through unchanged
 * because join_with_code() overwrites profiles.full_name unconditionally.
 */
function soleProfile(links: Link[]): { profileId: string; fullName: string } | null {
  const distinct = new Map(links.map((l) => [l.profileId, l.fullName] as const));
  const only = [...distinct.entries()][0];
  return distinct.size === 1 && only ? { profileId: only[0], fullName: only[1] } : null;
}

async function join(
  chatId: number, code: string, profileId: string, name: string,
): Promise<void> {
  const outcome = await attempt(() =>
    asMember(profileId, (tx) =>
      tx<Array<{ org_name: string }>>`
        select j.org_name from public.join_with_code(${code}, ${name}, ${chatId}) j`)
  );
  await sayJoined(chatId, outcome);
}

/**
 * Signing somebody up who has no account at all.
 *
 * signInAnonymously() returns a real GoTrue session signed with the project's
 * current key, which is the whole reason this path exists: nothing outside
 * GoTrue can produce a token PostgREST will trust. The handle_new_user trigger
 * creates the profile as 'New member', and join_with_code, called seconds later
 * on that same session, replaces the placeholder with the name they just gave.
 *
 * A join that fails after the sign-in leaves an anonymous user with no
 * membership behind. That is left alone on purpose: the alternative is handing
 * this webhook the admin API and the power to delete accounts, to tidy up a row
 * that costs nothing and that nobody can sign in to.
 */
async function signUpAndJoin(chatId: number, code: string, name: string): Promise<void> {
  const client = signedOutClient();
  const { error: signInError } = await client.auth.signInAnonymously();
  if (signInError) {
    console.error("anonymous sign-in failed", signInError);
    return await say(chatId, "I couldn't create an account for you just now. Try again shortly.");
  }

  const { data, error } = await client.rpc("join_with_code", {
    p_code: code, p_display_name: name, p_chat_id: chatId,
  });
  await sayJoined(chatId, error
    ? { ok: false, reason: humanError(error) }
    : { ok: true, value: (data ?? []) as Array<{ org_name: string }> });
}

async function sayJoined(
  chatId: number,
  outcome: { ok: true; value: Array<{ org_name: string }> } | { ok: false; reason: string },
): Promise<void> {
  if (!outcome.ok) return await say(chatId, escapeHtml(outcome.reason));
  const orgName = escapeHtml(outcome.value[0]?.org_name ?? "your office");
  await say(chatId, `You're in, at <b>${orgName}</b>.\n\n${HELP}`);
}

/* ------------------------------------------------------------------- /today */

async function onToday(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    // One transaction per member action, so the menu, the member's own order
    // and the offers waiting for them are all one consistent answer. Sending is
    // outside it: an HTTP call to Telegram must never hold a database
    // transaction open.
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx) => ({
        day: await dayView(tx, link, links.length > 1),
        offers: await offerViews(tx, link),
      })));
    if (!outcome.ok) {
      await say(chatId, escapeHtml(outcome.reason));
      continue;
    }

    await say(chatId, outcome.value.day.text, outcome.value.day.keyboard);
    for (const offer of outcome.value.offers) await say(chatId, offer.text, offer.keyboard);
  }
}

type MenuRow = {
  id: number;
  service_date: string;
  status: string;
  order_cutoff_at: string;
  items: Array<{ id: number; name: string; price_minor: number }>;
};

async function dayView(
  tx: Tx, link: Link, showOrgName: boolean, menuId?: number,
): Promise<Rendered> {
  const now = new Date();
  const today = todayIn(link.org.timezone, now);
  const currency = currencyOf(link.org);
  const header = showOrgName ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";
  const gate = { isAdmin: link.isAdmin, now, timeZone: link.org.timezone };

  const rows = await tx<MenuRow[]>`
    select m.id,
           m.service_date::text as service_date,
           m.status,
           -- ISO 8601 with an offset, which Date.parse reads identically on
           -- every runtime, unlike Postgres's own text rendering.
           to_json(m.order_cutoff_at) #>> '{}' as order_cutoff_at,
           coalesce(
             json_agg(json_build_object('id', mi.id, 'name', mi.name,
                                        'price_minor', mi.price_minor)
                      order by mi.position, mi.id)
               filter (where mi.id is not null),
             '[]'::json) as items
      from public.menus m
      left join public.menu_items mi on mi.menu_id = m.id and mi.is_available
     where m.org_id = ${link.org.id}
       -- A tapped button names its own menu, so that day is shown whether or
       -- not it is still the next one; /today names a window instead and picks
       -- from it. The reason line below explains itself either way.
       and case when ${menuId ?? null}::bigint is null
                then m.service_date between ${today}::date
                                        and ${addDaysIso(today, 6)}::date
                else m.id = ${menuId ?? null}::bigint
           end
     group by m.id
     order by m.service_date`;

  let menu: MenuRow;
  let closedReason: string | null;

  if (menuId === undefined) {
    const chosen = nextOrderableDay(
      rows.map((m) => ({
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
    const only = rows[0];
    if (!only) return { text: `${header}That menu is gone.`, keyboard: [] };
    menu = only;
    closedReason = orderingClosedReason({
      ...gate,
      menu: {
        serviceDate: menu.service_date,
        status: menu.status,
        orderCutoffAt: menu.order_cutoff_at,
      },
    });
  }

  const order = await myOrder(tx, link, menu.id);

  const lines = [`${header}<b>${formatServiceDate(menu.service_date)}</b>`];
  lines.push(closedReason !== null
    ? escapeHtml(closedReason)
    : `Orders close ${formatCutoffIn(menu.order_cutoff_at, link.org.timezone)}.`);
  lines.push("");

  if (menu.items.length === 0) {
    lines.push("No dishes on this menu.");
  } else {
    for (const d of menu.items) {
      lines.push(`- ${escapeHtml(d.name)}  ${escapeHtml(formatMoney(d.price_minor, currency))}`);
    }
  }

  lines.push("");
  if (!order || order.status === "cancelled") {
    lines.push("You're <b>not</b> down as eating.");
  } else if (order.item_name_snapshot === null) {
    lines.push("You're down as eating, but haven't picked a dish yet.");
  } else {
    lines.push(
      `You: <b>${escapeHtml(order.item_name_snapshot)}</b>` +
      (order.line_total_minor === null
        ? ""
        : ` (${escapeHtml(formatMoney(order.line_total_minor, currency))})`),
    );
  }

  const keyboard: InlineKeyboard = closedReason !== null ? [] : menu.items.map((d) => [{
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

type OrderRow = {
  id: number;
  status: string;
  item_name_snapshot: string | null;
  line_total_minor: number | null;
};

async function myOrder(tx: Tx, link: Link, menuId: number): Promise<OrderRow | null> {
  // The profile_id filter is mandatory, not defensive: orders became org-wide
  // readable with the shared board, so without it this returns a colleague's
  // order as if it were this member's own.
  const [row] = await tx<OrderRow[]>`
    select o.id, o.status, oi.item_name_snapshot, oi.line_total_minor
      from public.orders o
      left join lateral (
        select i.item_name_snapshot, i.line_total_minor
          from public.order_items i where i.order_id = o.id
         order by i.id limit 1) oi on true
     where o.menu_id = ${menuId} and o.profile_id = ${link.profileId}::uuid`;
  return row ?? null;
}

/* ---------------------------------------------------------------- transfers */

type OfferRow = {
  id: number;
  service_date: string;
  from_name: string | null;
  item_name_snapshot: string | null;
  line_total_minor: number | null;
};

async function offerViews(tx: Tx, link: Link): Promise<Rendered[]> {
  const currency = currencyOf(link.org);
  const rows = await tx<OfferRow[]>`
    select t.id,
           o.service_date::text as service_date,
           coalesce(mem.display_name, p.full_name, mem.short_code) as from_name,
           oi.item_name_snapshot, oi.line_total_minor
      from public.meal_transfers t
      join public.orders o on o.id = t.order_id
      left join lateral (
        select i.item_name_snapshot, i.line_total_minor
          from public.order_items i where i.order_id = o.id
         order by i.id limit 1) oi on true
      left join public.memberships mem
             on mem.org_id = t.org_id and mem.profile_id = t.from_profile_id
      left join public.profiles p on p.id = t.from_profile_id
     where t.org_id = ${link.org.id}
       and t.to_profile_id = ${link.profileId}::uuid
       and t.status = 'pending'
     order by o.service_date, t.id`;

  return rows.map((t) => {
    const who = escapeHtml(t.from_name ?? "A colleague");
    const what = t.item_name_snapshot === null ? "their lunch" : (
      escapeHtml(t.item_name_snapshot) +
      (t.line_total_minor === null
        ? ""
        : ` (${escapeHtml(formatMoney(t.line_total_minor, currency))})`)
    );
    return {
      text: `${who} is offering you ${what} on <b>${formatServiceDate(t.service_date)}</b>.\n` +
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

/* ---------------------------------------------------------------------- /me */

type StatementRow = {
  meal_count: number;
  meals_minor: number;
  carried_in_minor: number;
  total_due_minor: number;
  paid_minor: number;
  payment_ref: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
};

async function onMe(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const head = links.length > 1 ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";

    // billing_statements is own-row under RLS and the profile_id filter says so
    // out loud. Nobody ever sees anybody else's balance through this bot.
    const outcome = await attempt(() =>
      asMember(link.profileId, (tx) =>
        tx<StatementRow[]>`
          select s.meal_count, s.meals_minor, s.carried_in_minor, s.total_due_minor,
                 s.paid_minor, s.payment_ref, s.status,
                 bp.period_start::text as period_start,
                 bp.period_end::text   as period_end
            from public.billing_statements s
            left join public.billing_periods bp on bp.id = s.billing_period_id
           where s.org_id = ${link.org.id} and s.profile_id = ${link.profileId}::uuid
           order by s.billing_period_id desc
           limit 1`)
    );

    if (!outcome.ok) {
      await say(chatId, head + escapeHtml(outcome.reason));
      continue;
    }
    const statement = outcome.value[0];
    if (!statement) {
      await say(chatId, `${head}Nothing billed to you yet.`);
      continue;
    }

    await say(chatId, head + renderStatement(statement, link));
  }
}

function renderStatement(s: StatementRow, link: Link): string {
  const currency = currencyOf(link.org);
  const outstanding = s.total_due_minor - s.paid_minor;

  const lines = [
    `<b>${
      s.period_start !== null && s.period_end !== null
        ? `${formatServiceDate(s.period_start)} to ${formatServiceDate(s.period_end)}`
        : "Latest week"
    }</b>`,
    `${s.meal_count} meals: ${escapeHtml(formatMoney(s.meals_minor, currency))}`,
  ];
  if (s.carried_in_minor > 0) {
    lines.push(`Owed from before: ${escapeHtml(formatMoney(s.carried_in_minor, currency))}`);
  }
  lines.push(`<b>Total due: ${escapeHtml(formatMoney(s.total_due_minor, currency))}</b>`);
  if (s.paid_minor > 0) {
    lines.push(`Paid so far: ${escapeHtml(formatMoney(s.paid_minor, currency))}`);
  }
  lines.push(`Status: ${escapeHtml(s.status)}`);
  lines.push("");
  lines.push(`Put <code>${escapeHtml(s.payment_ref)}</code> in the transfer message.`);

  const qr = vietQrLink(link.org.payment_config, {
    amountMinor: Math.max(outstanding, 0),
    minorUnits: link.org.currency_minor_units,
    addInfo: s.payment_ref,
  });
  if (qr) lines.push(`<a href="${escapeHtml(qr)}">Pay by QR</a>`);

  return lines.join("\n");
}

/* ------------------------------------------------------------------ /cancel */

async function onCancel(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const today = todayIn(link.org.timezone, new Date());
    const head = links.length > 1 ? `<b>${escapeHtml(link.org.name)}</b>\n` : "";

    // Read and write in one transaction: split across two, the cutoff could
    // pass between them, and the order read would not be the order cancelled.
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx) => {
        const [order] = await tx<Array<{ id: number; status: string }>>`
          select o.id, o.status from public.orders o
           where o.org_id = ${link.org.id}
             and o.profile_id = ${link.profileId}::uuid
             and o.service_date = ${today}::date`;
        if (!order) return "none" as const;
        if (order.status === "cancelled") return "already" as const;

        // Members have no DELETE on orders on purpose: cancelling is a status
        // change, which keeps the audit trail and holds the one-order-per-day
        // slot so a republished menu cannot silently resurrect it.
        await tx`update public.orders
                    set status = 'cancelled', cancelled_at = now()
                  where id = ${order.id} and profile_id = ${link.profileId}::uuid`;
        return "cancelled" as const;
      })
    );

    if (!outcome.ok) {
      await say(chatId, head + escapeHtml(outcome.reason));
      continue;
    }
    const day = formatServiceDate(today);
    await say(chatId, head + (
      outcome.value === "none"
        ? `You have no order for ${day}.`
        : outcome.value === "already"
        ? `Your order for ${day} is already cancelled.`
        : `Cancelled your order for ${day}.`
    ));
  }
}

/* ------------------------------------------------------------- button taps */

async function onCallback(cb: CallbackQuery): Promise<void> {
  const chat = cb.message?.chat;
  const messageId = cb.message?.message_id;
  const action = decodeCallback(cb.data ?? "");

  if (!chat || messageId === undefined || action === null) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, "That button has expired.");
    return;
  }
  if ((chat.type ?? "private") !== "private") {
    // Same reason as onMessage: in a group the chat is the room, so this tap
    // would be attributed to whichever membership the room resolves to rather
    // than to the person whose thumb it was.
    await answerCallbackQuery(BOT_TOKEN, cb.id, "Message me directly to order.", true);
    return;
  }

  const links = await linksForChat(chat.id);
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

  if (action.kind === "transfer") {
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx) => {
        const rows = await tx`update public.meal_transfers
                                 set status = ${action.decision}
                               where id = ${action.transferId}
                           returning id`;
        return rows.length === 0 ? "That offer is no longer there." : null;
      })
    );
    const reason = outcome.ok ? outcome.value : outcome.reason;
    await answerCallbackQuery(
      BOT_TOKEN, cb.id,
      reason ?? (action.decision === "accepted" ? "Accepted" : "Declined"),
      reason !== null,
    );
    if (reason === null) {
      await edit(chat.id, messageId, action.decision === "accepted"
        ? "You accepted this meal. It will appear on your bill."
        : "You declined this meal.");
    }
    return;
  }

  const menuId = action.menuId;
  const outcome = await attempt(() =>
    asMember(link.profileId, (tx) =>
      action.kind === "pick"
        ? placeOrder(tx, link, menuId, action.itemId)
        : clearOrder(tx, link, menuId))
  );
  const reason = outcome.ok ? outcome.value : outcome.reason;

  await answerCallbackQuery(
    BOT_TOKEN, cb.id,
    reason ?? (action.kind === "pick" ? "Ordered" : "Cancelled"),
    reason !== null,
  );

  // A second transaction, deliberately: a refusal above rolled the first one
  // back, taking its reads with it. Redrawing from the database either way
  // leaves the member looking at what is actually true rather than at their
  // failed tap. They already have the verdict from the callback answer, so a
  // failed redraw leaves the old message alone rather than talking twice.
  const rendered = await attempt(() =>
    asMember(link.profileId, (tx) => dayView(tx, link, links.length > 1, menuId)));
  if (rendered.ok) await edit(chat.id, messageId, rendered.value.text, rendered.value.keyboard);
}

/**
 * Which org a tapped button belongs to. Read with the connection's own role
 * because the chat has not been narrowed to one member yet, and it returns only
 * an org id, which the caller must still match against this chat's own links.
 */
async function orgOfCallback(
  action: { kind: string; menuId?: number; transferId?: number },
): Promise<number | null> {
  const [row] = await asSystem((tx) =>
    action.kind === "transfer"
      ? tx<Array<{ org_id: number }>>`
          select t.org_id from public.meal_transfers t where t.id = ${action.transferId ?? 0}`
      : tx<Array<{ org_id: number }>>`
          select m.org_id from public.menus m where m.id = ${action.menuId ?? 0}`
  );
  return row?.org_id ?? null;
}

/**
 * The same sequence setOrder() runs in the web app, as one statement each.
 *
 * Prices are never sent: the snapshot trigger fills them, and the column grant
 * means this connection could not write one even as `authenticated`. The
 * returning-nothing case is the menu being invisible or gone, which RLS and the
 * FK would both have refused a moment later anyway.
 */
async function placeOrder(
  tx: Tx, link: Link, menuId: number, itemId: number,
): Promise<string | null> {
  // Insert-from-select so org_id and service_date cannot disagree with the
  // menu, and ON CONFLICT so re-picking a dish is one statement rather than a
  // read followed by a write that races it.
  const [order] = await tx<Array<{ id: number; org_id: number; menu_id: number }>>`
    insert into public.orders (org_id, menu_id, service_date, profile_id, created_by, source)
    select m.org_id, m.id, m.service_date, ${link.profileId}::uuid, ${link.profileId}::uuid, 'member'
      from public.menus m where m.id = ${menuId}
    on conflict (menu_id, profile_id) do update
       set status = 'placed', cancelled_at = null
    returning id, org_id, menu_id`;
  if (!order) return "That menu is gone.";

  await tx`delete from public.order_items where order_id = ${order.id}`;
  await tx`
    insert into public.order_items
      (order_id, org_id, profile_id, menu_id, menu_item_id,
       item_name_snapshot, unit_price_minor)
    values (${order.id}, ${order.org_id}, ${link.profileId}::uuid, ${order.menu_id}, ${itemId},
            -- Overwritten unconditionally by the snapshot trigger; sent only
            -- because the columns are NOT NULL.
            '', 0)`;
  return null;
}

async function clearOrder(tx: Tx, link: Link, menuId: number): Promise<string | null> {
  await tx`update public.orders
              set status = 'cancelled', cancelled_at = now()
            where menu_id = ${menuId}
              and profile_id = ${link.profileId}::uuid
              and status = 'placed'`;
  return null;
}

/* ------------------------------------------------------------------ plumbing */

/**
 * Who this chat is. One person may belong to two offices with different
 * Telegram groups, so this is a list: every command answers for each of them
 * rather than making the member remember which office the bot is "in".
 *
 * Read with the connection's own role because there is no member to act as
 * until this query has answered. It is the only read in this file that has to
 * be, and it is the one gate everything else stands on.
 */
async function linksForChat(chatId: number): Promise<Link[]> {
  const rows = await asSystem((tx) =>
    tx<Array<{
      profile_id: string; full_name: string; role: string;
      org_id: number; org_name: string; timezone: string; currency: string;
      currency_minor_units: number; locale: string; payment_config: unknown;
    }>>`
      select m.profile_id, p.full_name, m.role,
             o.id as org_id, o.name as org_name, o.timezone, o.currency,
             o.currency_minor_units, o.locale, o.payment_config
        from public.telegram_links tl
        join public.memberships m on m.id = tl.membership_id and m.status = 'active'
        join public.profiles p on p.id = m.profile_id
        join public.organizations o on o.id = tl.org_id
       where tl.chat_id = ${chatId}
       order by o.name, m.profile_id`
  );

  return rows.map((r) => ({
    profileId: r.profile_id,
    fullName: r.full_name,
    isAdmin: r.role === "admin" || r.role === "owner",
    org: {
      id: r.org_id,
      name: r.org_name,
      timezone: r.timezone,
      currency: r.currency,
      currency_minor_units: r.currency_minor_units,
      locale: r.locale,
      payment_config: r.payment_config,
    },
  }));
}

function currencyOf(org: Org): Currency {
  return { code: org.currency, minorUnits: org.currency_minor_units, locale: org.locale };
}

async function say(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const res = await sendMessage(BOT_TOKEN, chatId, text, { parseMode: "HTML", keyboard });
  if (!res.ok) console.error("sendMessage failed", res.status, res.description);
}

/** A question whose answer has to come back as a reply, carrying the question. */
async function sayPrompt(chatId: number, text: string): Promise<void> {
  const res = await sendMessage(BOT_TOKEN, chatId, text, {
    parseMode: "HTML",
    forceReply: { placeholder: "Your name" },
  });
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
