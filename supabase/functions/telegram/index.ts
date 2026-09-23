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
  addDaysIso, decodeCallback, encodeCallback, escapeHtml, formatServiceDate,
  humanError, isJoinCode, isLinkToken, joinCodeInPrompt, namePrompt, normalizeJoinCode,
  NOTHING_TO_LEAVE, orderingClosedReason, orgHeading, parseCommand, renderDayText,
  renderExitCancelledText, renderExitRefusedText, renderLeaveConfirmText, renderLeftText,
  renderNothingBilledText, renderOfferText, renderStatementText, renderUnlinkConfirmText,
  renderUnlinkedText, targetMenu, todayIn, vietQrLink,
  type CallbackAction, type ExitKind, type Money,
} from "../_shared/telegram.ts";
import { formatMoney, type Currency } from "../_shared/money.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

const HELP = [
  "<b>What I can do</b>",
  "/order - the next menu, and order from it",
  "/cancel - cancel your next order",
  "/me - what you owe this week",
  "/unlink - disconnect this chat, and stay a member",
  "/leave - leave your office",
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
  /** telegram_links' own key, which is what /unlink clears. */
  membershipId: number;
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

  if (links.length === 0) {
    // Somebody asking to be let out of a chat that is already out hears that
    // it has happened, not "I don't know who you are yet", which reads as a
    // refusal of the thing they asked for.
    const exiting = command?.name === "leave" || command?.name === "unlink";
    return await say(chatId, exiting ? NOTHING_TO_LEAVE : NOT_CONNECTED);
  }

  switch (command?.name) {
    // "today" is the name this command shipped under and is deliberately absent
    // from HELP: it was wrong (ordering closes the night before, so it showed
    // tomorrow), but people have it in their fingers.
    case "order":
    case "today": return await onOrder(chatId, links);
    case "me": return await onMe(chatId, links);
    case "cancel": return await onCancel(chatId, links);
    case "leave": return await onExitCommand(chatId, links, "leave");
    case "unlink": return await onExitCommand(chatId, links, "unlink");
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

  const returning = await dormantLink(chatId, org.id);
  if (returning !== null) return await join(chatId, code, returning.profileId, returning.fullName);

  const known = soleProfile(links);
  if (known !== null) return await join(chatId, code, known.profileId, known.fullName);

  await sayPrompt(chatId, namePrompt(org.name, code));
}

/**
 * The membership this chat already has in that office, now deactivated.
 *
 * What /leave promises: the same join code brings you back to the same
 * membership, short code and history. It only holds if the bot recognises the
 * person coming back, and linksForChat cannot -- it answers with active
 * memberships, and theirs is not one. telegram_links still binds this chat to
 * them, and join_with_code() reactivates the very membership that row points at.
 *
 * Without this they are signed up as a second, separate person, and
 * join_with_code then refuses that with "This Telegram chat is already linked
 * to somebody else", where somebody else is them.
 *
 * Read with the connection's own role for linksForChat's reason: an inactive
 * membership resolves to nobody, so there is nobody to act as yet. It grants
 * nothing -- join_with_code decides, and it hands back the lowest role whatever
 * they were before, so a deactivation that removed authority is not undone here.
 */
async function dormantLink(
  chatId: number, orgId: number,
): Promise<{ profileId: string; fullName: string } | null> {
  const [row] = await asSystem((tx) =>
    tx<Array<{ profile_id: string; full_name: string }>>`
      select m.profile_id, p.full_name
        from public.telegram_links tl
        join public.memberships m on m.id = tl.membership_id
        join public.profiles p on p.id = m.profile_id
       where tl.chat_id = ${chatId} and tl.org_id = ${orgId}`
  );
  return row ? { profileId: row.profile_id, fullName: row.full_name } : null;
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

  // Asked again here for the reason the two checks above are: a step that
  // decides who somebody is must decide it against the moment they answered,
  // not the moment they were asked.
  const returning = await dormantLink(chatId, org.id);
  if (returning !== null) return await join(chatId, code, returning.profileId, returning.fullName);

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

/* ------------------------------------------------------------------- /order */

async function onOrder(chatId: number, links: Link[]): Promise<void> {
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
  items: Array<{ id: number; name: string; price_minor: number | null }>;
};

/** A menu and why ordering from it is shut, or null when it is open. */
type Target = { menu: MenuRow; closedReason: string | null };

/**
 * Either the week ahead, or the one menu a button named.
 *
 * A tapped button names its own menu, so that day is read whether or not it is
 * still the next one; a bare command has only a window, and resolveTarget picks
 * from it. `today` bounds that window and is passed in rather than read here,
 * so the day the window starts on is the same day the choice is made against.
 */
async function menuRows(
  tx: Tx, link: Link, today: string, menuId?: number,
): Promise<MenuRow[]> {
  return await tx<MenuRow[]>`
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
       and case when ${menuId ?? null}::bigint is null
                then m.service_date between ${today}::date
                                        and ${addDaysIso(today, 6)}::date
                else m.id = ${menuId ?? null}::bigint
           end
     group by m.id
     order by m.service_date`;
}

/**
 * Which menu a command that named none is about. THE one answer.
 *
 * /order and /cancel both arrive here, so they cannot disagree about which day
 * they are talking about: one window read, and the choice within it made by
 * targetMenu(), which is pure and covered by test/telegram.test.ts.
 */
async function resolveTarget(tx: Tx, link: Link): Promise<Target | null> {
  const now = new Date();
  const today = todayIn(link.org.timezone, now);
  const rows = await menuRows(tx, link, today);

  const chosen = targetMenu(
    rows.map((row) => ({
      serviceDate: row.service_date,
      status: row.status,
      orderCutoffAt: row.order_cutoff_at,
      row,
    })),
    { today, isAdmin: link.isAdmin, now, timeZone: link.org.timezone },
  );
  return chosen === null ? null : { menu: chosen.menu.row, closedReason: chosen.closedReason };
}

/** The menu a button named, which resolveTarget may well no longer pick. */
async function targetById(tx: Tx, link: Link, menuId: number): Promise<Target | null> {
  const now = new Date();
  const [menu] = await menuRows(tx, link, todayIn(link.org.timezone, now), menuId);
  if (menu === undefined) return null;

  return {
    menu,
    closedReason: orderingClosedReason({
      menu: {
        serviceDate: menu.service_date,
        status: menu.status,
        orderCutoffAt: menu.order_cutoff_at,
      },
      isAdmin: link.isAdmin,
      now,
      timeZone: link.org.timezone,
    }),
  };
}

/** The next menu, and where this member stands on it. */
async function dayView(tx: Tx, link: Link, showOrgName: boolean): Promise<Rendered> {
  const target = await resolveTarget(tx, link);
  if (target === null) {
    return {
      text: `${orgHeader(link, showOrgName)}No menu is up yet. I'll be here when there is one.`,
      keyboard: [],
    };
  }
  return renderDay(link, showOrgName, target, await myOrder(tx, link, target.menu.id));
}

/**
 * One named menu, redrawn after a tap.
 *
 * `order` is what the write that prompted the redraw returned, so the common
 * path does not read back a row it has only just written itself.
 */
async function menuView(
  tx: Tx, link: Link, showOrgName: boolean, menuId: number, order?: OrderRow | null,
): Promise<Rendered> {
  const target = await targetById(tx, link, menuId);
  if (target === null) {
    return { text: `${orgHeader(link, showOrgName)}That menu is gone.`, keyboard: [] };
  }
  return renderDay(
    link, showOrgName, target,
    order === undefined ? await myOrder(tx, link, menuId) : order,
  );
}

/** A member belonging to two offices needs to be told which one is speaking. */
function orgHeader(link: Link, showOrgName: boolean): string {
  return orgHeading(showOrgName ? link.org.name : null);
}

function renderDay(
  link: Link, showOrgName: boolean, target: Target, order: OrderRow | null,
): Rendered {
  const { menu, closedReason } = target;

  // The words are renderDayText()'s, in src/shared, so a price the caterer has
  // not set is one sentence the whole app over and vitest can reach it. This
  // function is the adapter from database rows and the keyboard.
  const text = renderDayText({
    orgName: showOrgName ? link.org.name : null,
    serviceDate: menu.service_date,
    closedReason,
    orderCutoffAt: menu.order_cutoff_at,
    timeZone: link.org.timezone,
    dishes: menu.items.map((d) => ({ name: d.name, priceMinor: d.price_minor })),
    order: order === null ? null : {
      status: order.status,
      dishName: order.item_name_snapshot,
      amountMinor: order.line_total_minor,
    },
  }, moneyIn(link.org));

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

  return { text, keyboard };
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
  const money = moneyIn(link.org);
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

  return rows.map((t) => ({
    text: renderOfferText({
      fromName: t.from_name,
      serviceDate: t.service_date,
      dishName: t.item_name_snapshot,
      amountMinor: t.line_total_minor,
    }, money),
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
  }));
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
    const orgName = links.length > 1 ? link.org.name : null;

    // billing_statements is own-row under RLS and the profile_id filter says so
    // out loud. Nobody ever sees anybody else's balance through this bot.
    //
    // The unpriced count rides along in the same transaction, because the
    // statement and what the statement had to leave out have to describe one
    // moment. run_billing() skips an order whose dish has no price, so without
    // this the total reads as the final word on a week that is still growing.
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx) => ({
        statement: (await tx<StatementRow[]>`
          select s.meal_count, s.meals_minor, s.carried_in_minor, s.total_due_minor,
                 s.paid_minor, s.payment_ref, s.status,
                 bp.period_start::text as period_start,
                 bp.period_end::text   as period_end
            from public.billing_statements s
            left join public.billing_periods bp on bp.id = s.billing_period_id
           where s.org_id = ${link.org.id} and s.profile_id = ${link.profileId}::uuid
           order by s.billing_period_id desc
           limit 1`)[0] ?? null,
        // Read straight off the member's own rows rather than through
        // v_order_charges: order_items.profile_id is the person who PLACED the
        // order, so those are the rows order_items_own actually shows them.
        // Not bounded by the statement's week, deliberately -- a member with no
        // statement at all still has meals waiting on a price, and that is the
        // case the old "Nothing billed to you yet." read most wrongly.
        unpriced: (await tx<Array<{ n: number }>>`
          select count(*)::int as n
            from public.orders o
            join public.order_items oi on oi.order_id = o.id
           where o.org_id = ${link.org.id}
             and o.profile_id = ${link.profileId}::uuid
             and o.status = 'placed'
             and oi.unit_price_minor is null`)[0]?.n ?? 0,
      }))
    );

    if (!outcome.ok) {
      await say(chatId, orgHeading(orgName) + escapeHtml(outcome.reason));
      continue;
    }
    const { statement, unpriced } = outcome.value;
    if (statement === null) {
      await say(chatId, renderNothingBilledText(orgName, unpriced));
      continue;
    }

    await say(chatId, renderStatement(statement, link, orgName, unpriced));
  }
}

function renderStatement(
  s: StatementRow, link: Link, orgName: string | null, unpricedMeals: number,
): string {
  const outstanding = s.total_due_minor - s.paid_minor;

  // The QR is built here because vietQrLink() needs the org's payment_config,
  // which is a database row rather than a sentence.
  const qr = vietQrLink(link.org.payment_config, {
    amountMinor: Math.max(outstanding, 0),
    minorUnits: link.org.currency_minor_units,
    addInfo: s.payment_ref,
  });

  return orgHeading(orgName) + renderStatementText({
    periodStart: s.period_start,
    periodEnd: s.period_end,
    mealCount: s.meal_count,
    mealsMinor: s.meals_minor,
    carriedInMinor: s.carried_in_minor,
    totalDueMinor: s.total_due_minor,
    paidMinor: s.paid_minor,
    status: s.status,
    paymentRef: s.payment_ref,
    unpricedMeals,
  }, moneyIn(link.org), qr);
}

/* ------------------------------------------------------------------ /cancel */

/** Which order was cancelled, and the day it was for, named by the menu. */
type Cancellation =
  | { result: "no-menu" }
  | { result: "none" | "already" | "cancelled"; day: string };

async function onCancel(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const head = orgHeader(link, links.length > 1);

    // Read and write in one transaction: split across two, the cutoff could
    // pass between them, and the order read would not be the order cancelled.
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx): Promise<Cancellation> => {
        // The same menu /order offers, resolved the same way. Working out the
        // day again here is what made the two commands disagree.
        const target = await resolveTarget(tx, link);
        if (target === null) return { result: "no-menu" };
        const day = formatServiceDate(target.menu.service_date);

        // menu_id, not service_date: (menu_id, profile_id) is
        // orders_menu_profile_uk, so this is at most one row, and it is the
        // row the member actually placed rather than whatever sits on today.
        const [order] = await tx<Array<{ id: number; status: string }>>`
          select o.id, o.status from public.orders o
           where o.menu_id = ${target.menu.id}
             and o.profile_id = ${link.profileId}::uuid`;
        if (!order) return { result: "none", day };
        if (order.status === "cancelled") return { result: "already", day };

        // Members have no DELETE on orders on purpose: cancelling is a status
        // change, which keeps the audit trail and holds the one-order-per-day
        // slot so a republished menu cannot silently resurrect it.
        await tx`update public.orders
                    set status = 'cancelled', cancelled_at = now()
                  where id = ${order.id} and profile_id = ${link.profileId}::uuid`;
        return { result: "cancelled", day };
      })
    );

    if (!outcome.ok) {
      await say(chatId, head + escapeHtml(outcome.reason));
      continue;
    }
    const done = outcome.value;
    await say(chatId, head + (
      done.result === "no-menu"
        ? "There's no menu up, so there's nothing to cancel."
        : done.result === "none"
        ? `You have no order for ${done.day}.`
        : done.result === "already"
        ? `Your order for ${done.day} is already cancelled.`
        : `Cancelled your order for ${done.day}.`
    ));
  }
}

/* --------------------------------------------------------- /leave, /unlink */

/**
 * Both ways out, asked before either is taken.
 *
 * Neither command acts on the message that names it. A mistyped /leave that
 * removed somebody from their office would be unrecoverable by them alone --
 * a member who joined through Telegram has no web session to undo it with --
 * so the message is a question, and the answer is a tap that onExitCallback
 * re-checks against this chat's links and against RLS.
 *
 * One question per office, because a chat can belong to several and each has
 * its own membership, its own bill and its own join code. The heading names
 * which is being asked about whenever there is more than one.
 */
async function onExitCommand(chatId: number, links: Link[], kind: ExitKind): Promise<void> {
  for (const link of links) {
    const orgName = links.length > 1 ? link.org.name : null;

    // Read as the member, so it is their own sight of their own office: the
    // join code is the one way back and belongs in the question, not in a
    // message they get only once the door has shut behind them.
    const outcome = await attempt(() => asMember(link.profileId, (tx) => joinCodeOf(tx, link)));
    if (!outcome.ok) {
      await say(chatId, orgHeading(orgName) + escapeHtml(outcome.reason));
      continue;
    }

    const message = { orgName, joinCode: outcome.value };
    await say(
      chatId,
      kind === "leave" ? renderLeaveConfirmText(message) : renderUnlinkConfirmText(message),
      [[
        {
          text: exitLabel(kind === "leave" ? "Leave" : "Disconnect", link, links.length > 1),
          callback_data: encodeCallback(exitAction(kind, link.org.id, true)),
        },
        {
          text: kind === "leave" ? "Stay" : "Keep connected",
          callback_data: encodeCallback(exitAction(kind, link.org.id, false)),
        },
      ]],
    );
  }
}

function exitAction(kind: ExitKind, orgId: number, confirmed: boolean): CallbackAction {
  return kind === "leave"
    ? { kind: "leave", orgId, confirmed }
    : { kind: "unlink", orgId, confirmed };
}

/**
 * Button text, which Telegram renders literally: not HTML, so not escaped, and
 * escaping it would print &amp; on the button of an office called A & B.
 */
function exitLabel(verb: string, link: Link, showOrgName: boolean): string {
  if (!showOrgName) return verb;
  const name = link.org.name;
  return `${verb} ${name.length > 40 ? `${name.slice(0, 39)}…` : name}`;
}

/** The office's shared join code, read as the member: the way back in. */
async function joinCodeOf(tx: Tx, link: Link): Promise<string | null> {
  const [org] = await tx<Array<{ telegram_join_code: string | null }>>`
    select o.telegram_join_code from public.organizations o where o.id = ${link.org.id}`;
  return org?.telegram_join_code ?? null;
}

/**
 * The tap, which is where either thing actually happens.
 *
 * leave_office() is called rather than reimplemented: it refuses for somebody
 * who still owes money and for the only owner, in sentences written for people,
 * and attempt() brings those back as they were written. Rewriting either rule
 * here would be a second copy of it, and the copy would drift.
 */
async function onExitCallback(
  cb: CallbackQuery, chatId: number, messageId: number,
  link: Link, showOrgName: boolean,
  action: { kind: ExitKind; confirmed: boolean },
): Promise<void> {
  const orgName = showOrgName ? link.org.name : null;

  if (!action.confirmed) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, "Nothing changed.");
    return await edit(chatId, messageId, renderExitCancelledText(orgName, action.kind));
  }

  const outcome = await attempt(() =>
    asMember(link.profileId, async (tx) => {
      // Before the write, not after: leaving deactivates the membership, and
      // organizations_select then stops showing the office at all, so the code
      // that brings them back would be unreadable a statement too late.
      const joinCode = await joinCodeOf(tx, link);

      if (action.kind === "leave") {
        await tx`select public.leave_office(${link.org.id})`;
        return { joinCode, changed: true };
      }

      // The membership and the link_token stay. chat_id is the whole of what
      // makes this chat this member, so clearing it is what stops the bot
      // asking and stops it telling; the token means reconnecting from the web
      // app is still one tap. Narrowed to this chat so a link redeemed from
      // another one in the meantime is not cleared by a stale button.
      const rows = await tx`update public.telegram_links
                               set chat_id = null, linked_at = null
                             where membership_id = ${link.membershipId}
                               and chat_id = ${chatId}
                         returning membership_id`;
      return { joinCode, changed: rows.length > 0 };
    })
  );

  if (!outcome.ok) {
    await answerCallbackQuery(BOT_TOKEN, cb.id, outcome.reason, true);
    // The alert is gone the moment it is dismissed, and "settle up before you
    // leave" is an instruction somebody needs to still be able to read.
    return await say(chatId, renderExitRefusedText(orgName, action.kind, outcome.reason));
  }

  const { joinCode, changed } = outcome.value;
  if (!changed) {
    // An UPDATE that matches nothing is silent, so this is the one outcome that
    // would otherwise be reported as a success that never happened.
    await answerCallbackQuery(BOT_TOKEN, cb.id, "That didn't go through. Try again.", true);
    return;
  }

  await answerCallbackQuery(
    BOT_TOKEN, cb.id, action.kind === "leave" ? "You've left." : "Disconnected.");
  await edit(chatId, messageId, action.kind === "leave"
    ? renderLeftText({ orgName, joinCode })
    : renderUnlinkedText({ orgName, joinCode }));
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

  if (action.kind === "leave" || action.kind === "unlink") {
    return await onExitCallback(
      cb, chat.id, messageId, link, links.length > 1,
      { kind: action.kind, confirmed: action.confirmed });
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
    asMember(link.profileId, async (tx) => {
      const written = action.kind === "pick"
        ? await placeOrder(tx, link, menuId, action.itemId)
        : await clearOrder(tx, link, menuId);
      if (written.refusal !== null) {
        return { reason: written.refusal, dish: null, rendered: null };
      }
      // Redrawn inside the SAME transaction on the common path: one round trip
      // instead of two, and the write and the message the member is left
      // looking at are one snapshot. Nothing is read back that was only just
      // written -- the write returned the order itself.
      return {
        reason: null,
        dish: written.order?.item_name_snapshot ?? null,
        rendered: await menuView(tx, link, links.length > 1, menuId, written.order),
      };
    })
  );

  const reason = outcome.ok ? outcome.value.reason : outcome.reason;
  const dish = outcome.ok ? outcome.value.dish : null;

  await answerCallbackQuery(
    BOT_TOKEN, cb.id,
    // Naming the dish lets the confirmation stand on its own, before the
    // message underneath it has been redrawn and whether or not it ever is.
    reason ?? (action.kind === "pick"
      ? (dish === null ? "Ordered" : `Ordered ${dish}`)
      : "Cancelled"),
    reason !== null,
  );

  const rendered = outcome.ok ? outcome.value.rendered : null;
  if (rendered !== null) {
    return await edit(chat.id, messageId, rendered.text, rendered.keyboard);
  }

  // A second transaction, deliberately: a refusal above was a thrown database
  // error, which rolled the first one back and took its reads with it, so the
  // redraw could not have ridden along. Redrawing from the database leaves the
  // member looking at what is actually true rather than at their failed tap.
  // They already have the verdict from the callback answer, so a failed redraw
  // leaves the old message alone rather than talking twice.
  const redrawn = await attempt(() =>
    asMember(link.profileId, (tx) => menuView(tx, link, links.length > 1, menuId)));
  if (redrawn.ok) await edit(chat.id, messageId, redrawn.value.text, redrawn.value.keyboard);
}

/**
 * Which org a tapped button belongs to. Read with the connection's own role
 * because the chat has not been narrowed to one member yet, and it returns only
 * an org id, which the caller must still match against this chat's own links.
 */
async function orgOfCallback(action: CallbackAction): Promise<number | null> {
  // /leave and /unlink name their org in the payload, because there is no row
  // to look it up from -- the button IS about the membership. That is no
  // weaker: the answer is matched against this chat's own links either way,
  // which is the check that matters, and the id is a claim until it is.
  if (action.kind === "leave" || action.kind === "unlink") return action.orgId;

  // Picked apart out here rather than inside the callback, where a union this
  // wide is no longer narrowed to the two shapes that carry a row id.
  const transferId = action.kind === "transfer" ? action.transferId : null;
  const menuId = action.kind === "transfer" ? 0 : action.menuId;

  const [row] = await asSystem((tx) =>
    transferId !== null
      ? tx<Array<{ org_id: number }>>`
          select t.org_id from public.meal_transfers t where t.id = ${transferId}`
      : tx<Array<{ org_id: number }>>`
          select m.org_id from public.menus m where m.id = ${menuId}`
  );
  return row?.org_id ?? null;
}

/** The member's order as the write left it, or the sentence refusing the write. */
type Written =
  | { refusal: string; order?: undefined }
  | { refusal: null; order: OrderRow | null };

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
): Promise<Written> {
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
  if (!order) return { refusal: "That menu is gone." };

  await tx`delete from public.order_items where order_id = ${order.id}`;
  const [item] = await tx<Array<{
    item_name_snapshot: string; line_total_minor: number | null;
  }>>`
    insert into public.order_items
      (order_id, org_id, profile_id, menu_id, menu_item_id,
       item_name_snapshot, unit_price_minor)
    values (${order.id}, ${order.org_id}, ${link.profileId}::uuid, ${order.menu_id}, ${itemId},
            -- Overwritten unconditionally by the snapshot trigger; sent only
            -- because the columns are NOT NULL.
            '', 0)
    -- order_items_snapshot is BEFORE INSERT and line_total_minor is generated
    -- from what it writes, so these come back spelled and priced as the caterer
    -- has them. That is the redraw's copy of the order and the name the
    -- callback answer confirms, without a second read of the row.
    returning item_name_snapshot, line_total_minor`;

  return {
    refusal: null,
    order: {
      id: order.id,
      status: "placed",
      item_name_snapshot: item?.item_name_snapshot ?? null,
      line_total_minor: item?.line_total_minor ?? null,
    },
  };
}

async function clearOrder(tx: Tx, link: Link, menuId: number): Promise<Written> {
  const [order] = await tx<Array<{ id: number }>>`
    update public.orders
       set status = 'cancelled', cancelled_at = now()
     where menu_id = ${menuId}
       and profile_id = ${link.profileId}::uuid
       and status = 'placed'
    returning id`;

  // No row updated means nothing was placed, which the day message renders the
  // same way it renders a cancelled one.
  return {
    refusal: null,
    order: order === undefined ? null : {
      id: order.id,
      status: "cancelled",
      item_name_snapshot: null,
      line_total_minor: null,
    },
  };
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
      profile_id: string; membership_id: number; full_name: string; role: string;
      org_id: number; org_name: string; timezone: string; currency: string;
      currency_minor_units: number; locale: string; payment_config: unknown;
    }>>`
      select m.profile_id, tl.membership_id, p.full_name, m.role,
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
    membershipId: r.membership_id,
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

/**
 * The one amount formatter the messages are handed.
 *
 * It takes a number, never a nullable one: a missing price is words, and
 * priceText() in src/shared/telegram.ts is where that decision is made. An
 * `?? 0` here is what would put "0 ₫" on somebody's bill.
 */
function moneyIn(org: Org): Money {
  const currency: Currency = {
    code: org.currency, minorUnits: org.currency_minor_units, locale: org.locale,
  };
  return (minor: number) => formatMoney(minor, currency);
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
