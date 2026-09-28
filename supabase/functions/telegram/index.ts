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
 *  3. A join code is checked by the database, not here.
 *     private.join_office_with_code always grants the 'member' role, is the
 *     only way in for somebody with no email address, and is the only thing
 *     that binds a chat as it joins. It runs as the system, because the chat id
 *     it is given is one Telegram sent past gate 1; the browser's
 *     public.join_with_code takes no chat at all.
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
  answerCallbackQuery, deleteMyCommands, editMessageText, sendMessage, setMyCommands,
  type InlineKeyboard,
} from "../_shared/telegramApi.ts";
import {
  addDaysIso, commandsFor, decodeCallback, encodeCallback, escapeHtml, formatServiceDate,
  helpFor, humanError, isJoinCode, isLinkToken, joinCodeInPrompt, namePrompt,
  NOBODY_TO_PASS_IT_TO, normalizeJoinCode, NOTHING_TO_LEAVE, NOTHING_TO_PASS_ON,
  orderingClosedReason, orgHeading, parseCommand, randomDish, renderAccountText,
  renderDayText, renderExitCancelledText, renderExitRefusedText, renderHandoverOfferedText,
  renderHandoverPickText, renderLeaveConfirmText, renderLeftText, renderOfferText,
  renderUnlinkConfirmText, renderUnlinkedText, targetMenu, todayIn, vietQrLink,
  type CallbackAction, type ExitKind, type Handover, type MemberKind, type Money,
} from "../_shared/telegram.ts";
import { formatMoney, type Currency } from "../_shared/money.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

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
  /** profiles.full_name, not the per-org display name: the join writes it. */
  fullName: string;
  /**
   * Whether this member has a way in that is not this chat.
   *
   * profiles.email is null for exactly one kind of person: somebody signed up
   * by joining with a code off an anonymous sign-in, who has no password, no
   * Google account and no address anybody could send a magic link to. See
   * 20260924100000_emailless_members. It is the only column in the schema that
   * records the difference, and it is what decides which exit this chat is
   * offered.
   */
  hasWebAccount: boolean;
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
      // Republished here as well as on the four events that change it, so a
      // chat linked before this bot ever called setMyCommands gets its menu
      // the first time somebody asks for help rather than never.
      await say(chatId, `Hi ${name}, you're connected.\n\n${await publishCommands(chatId, links)}`);
      return;
    }
    default:
      await say(chatId, helpFor(memberKind(links)));
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
    return await say(chatId,
      `You're already connected to <b>${orgName}</b>.\n\n${await refreshCommands(chatId)}`);
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

  await say(chatId, `Connected to <b>${orgName}</b>.\n\n${await refreshCommands(chatId)}`);
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
 * The join writes profiles.full_name and private.suggest_short_code()
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
      `You're already connected to <b>${escapeHtml(org.name)}</b>.\n\n` +
      `${await refreshCommands(chatId)}`);
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
 * them, and the join reactivates the very membership that row points at.
 *
 * Without this they are signed up as a second, separate person, and
 * the join then refuses that with "This Telegram chat is already linked
 * to somebody else", where somebody else is them.
 *
 * Read with the connection's own role for linksForChat's reason: an inactive
 * membership resolves to nobody, so there is nobody to act as yet. It grants
 * nothing: the join decides. It refuses somebody an admin removed, and it
 * hands back the lowest role to somebody who left, whatever they were before.
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
      `You're already connected to <b>${escapeHtml(org.name)}</b>.\n\n` +
      `${await refreshCommands(chatId)}`);
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
 * because the join overwrites profiles.full_name unconditionally.
 */
function soleProfile(links: Link[]): { profileId: string; fullName: string } | null {
  const distinct = new Map(links.map((l) => [l.profileId, l.fullName] as const));
  const only = [...distinct.entries()][0];
  return distinct.size === 1 && only ? { profileId: only[0], fullName: only[1] } : null;
}

/** Postgres's undefined_function. */
const UNDEFINED_FUNCTION = "42883";

/**
 * Joining, and binding this chat to the membership in the same transaction.
 *
 * `profileId` is this chat's own identity or one signed up for it a moment
 * ago, and `chatId` came in an update that passed the webhook secret, which is
 * what entitles this call to bind the one to the other.
 */
async function join(
  chatId: number, code: string, profileId: string, name: string,
): Promise<void> {
  const outcome = await attempt(async () => {
    try {
      return await asSystem((tx) =>
        tx<Array<{ org_name: string }>>`
          select j.org_name
            from private.join_office_with_code(
              ${profileId}::uuid, ${code}, ${name}, null, ${chatId}::bigint) j`);
    } catch (e) {
      // A database still without 20261013100000, for the minutes a deploy
      // runs ahead of the migration. Remove with the old join_with_code.
      if (!isDatabaseError(e) || e.code !== UNDEFINED_FUNCTION) throw e;
      return await asMember(profileId, (tx) =>
        tx<Array<{ org_name: string }>>`
          select j.org_name from public.join_with_code(${code}, ${name}, ${chatId}) j`);
    }
  });
  await sayJoined(chatId, outcome);
}

/**
 * Signing somebody up who has no account at all.
 *
 * signInAnonymously() creates a real GoTrue user, which is the whole reason
 * this path exists: an account here is a GoTrue account. The handle_new_user
 * trigger creates the profile as 'New member', and the join, seconds later,
 * replaces the placeholder with the name they just gave.
 *
 * A join that fails after the sign-in leaves an anonymous user with no
 * membership behind. That is left alone on purpose: the alternative is handing
 * this webhook the admin API and the power to delete accounts, to tidy up a row
 * that costs nothing and that nobody can sign in to.
 */
async function signUpAndJoin(chatId: number, code: string, name: string): Promise<void> {
  const client = signedOutClient();
  const { data, error: signInError } = await client.auth.signInAnonymously();
  const profileId = data.user?.id;
  if (signInError || !profileId) {
    console.error("anonymous sign-in failed", signInError);
    return await say(chatId, "I couldn't create an account for you just now. Try again shortly.");
  }
  await join(chatId, code, profileId, name);
}

async function sayJoined(
  chatId: number,
  outcome: { ok: true; value: Array<{ org_name: string }> } | { ok: false; reason: string },
): Promise<void> {
  if (!outcome.ok) return await say(chatId, escapeHtml(outcome.reason));
  const orgName = escapeHtml(outcome.value[0]?.org_name ?? "your office");
  // The menu is published from what the join just wrote, not from what was
  // true when this update arrived: somebody who joined by code has no web
  // account, and the list they are given has to know that already.
  await say(chatId, `You're in, at <b>${orgName}</b>.\n\n${await refreshCommands(chatId)}`);
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
        days: await dayViews(tx, link, links.length > 1),
        offers: await offerViews(tx, link),
      })));
    if (!outcome.ok) {
      await say(chatId, escapeHtml(outcome.reason));
      continue;
    }

    for (const day of outcome.value.days) await say(chatId, day.text, day.keyboard);
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
    { today, now, timeZone: link.org.timezone },
  );
  return chosen === null ? null : { menu: chosen.menu.row, closedReason: chosen.closedReason };
}

/** The menu a button named, which resolveTarget may well no longer pick. */
async function targetById(tx: Tx, link: Link, menuId: number): Promise<Target | null> {
  const now = new Date();
  const [menu] = await menuRows(tx, link, todayIn(link.org.timezone, now), menuId);
  return menu === undefined ? null : targetOf(link, menu, now);
}

/** One menu row, and why ordering from it is shut, at one instant. */
function targetOf(link: Link, menu: MenuRow, now: Date): Target {
  return {
    menu,
    closedReason: orderingClosedReason({
      menu: {
        serviceDate: menu.service_date,
        status: menu.status,
        orderCutoffAt: menu.order_cutoff_at,
      },
      now,
      timeZone: link.org.timezone,
    }),
  };
}

/** The next menu, where this member stands on it, and today's meal beside it. */
async function dayViews(tx: Tx, link: Link, showOrgName: boolean): Promise<Rendered[]> {
  const target = await resolveTarget(tx, link);
  if (target === null) {
    return [{
      text: `${orgHeader(link, showOrgName)}No menu is up yet. I'll be here when there is one.`,
      keyboard: [],
    }];
  }

  const views = [renderDay(link, showOrgName, target, await myMeal(tx, link, target.menu.id))];
  const stillMine = await todaysMeal(tx, link, showOrgName, target.menu.service_date);
  if (stillMine !== null) views.push(stillMine);
  return views;
}

/**
 * Today's own lunch, when today is not the day the message above is about.
 *
 * The day somebody needs to pass a meal on is almost never the day they can
 * still order for. Ordering shuts the evening before, so from the cutoff until
 * the kitchen has finished, resolveTarget has moved on to tomorrow while
 * today's lunch is still sitting there with their name on it -- and being
 * called into a meeting at eleven is the whole case passing a meal on exists
 * for. So /order says so rather than leaving today unreachable.
 *
 * Null whenever there is nothing to add: no menu today, today is already the
 * day being shown, or they are not down as eating on it. /order is not a diary.
 */
async function todaysMeal(
  tx: Tx, link: Link, showOrgName: boolean, shownDate: string,
): Promise<Rendered | null> {
  const now = new Date();
  const today = todayIn(link.org.timezone, now);
  if (shownDate === today) return null;

  const menu = (await menuRows(tx, link, today)).find((m) => m.service_date === today);
  if (menu === undefined) return null;

  const meal = await myMeal(tx, link, menu.id);
  if (meal.order === null || meal.order.status !== "placed") return null;
  return renderDay(link, showOrgName, targetOf(link, menu, now), meal);
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
  return renderDay(link, showOrgName, target, await myMeal(tx, link, menuId, order));
}

/** A member belonging to two offices needs to be told which one is speaking. */
function orgHeader(link: Link, showOrgName: boolean): string {
  return orgHeading(showOrgName ? link.org.name : null);
}

function renderDay(
  link: Link, showOrgName: boolean, target: Target, meal: Meal,
): Rendered {
  const { menu, closedReason } = target;
  const { order, handover } = meal;

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
    handover,
  }, moneyIn(link.org));

  const keyboard: InlineKeyboard = closedReason !== null ? [] : menu.items.map((d) => [{
    text: buttonLabel(d.name),
    callback_data: encodeCallback({ kind: "pick", menuId: menu.id, itemId: d.id }),
  }]);
  // Beside the dishes rather than instead of them, and only where there is
  // something to choose between: the board shows its dice on two dishes or
  // more for the same reason, because with one dish there is nothing to
  // randomise and the dish's own button already orders it.
  if (closedReason === null && menu.items.length > 1) {
    keyboard.push([{
      text: "Surprise me",
      callback_data: encodeCallback({ kind: "surprise", menuId: menu.id }),
    }]);
  }
  if (closedReason === null && order && order.status === "placed") {
    keyboard.push([{
      text: "Not eating today",
      callback_data: encodeCallback({ kind: "clear", menuId: menu.id }),
    }]);
  }
  // Outside the closed guard, deliberately. Ordering shuts at the cutoff and
  // passing a meal on outlives it by most of a day: somebody finding at eleven
  // that they cannot make lunch is the case this exists for, and by then the
  // headcount has long gone to the caterer. How late is too late belongs to
  // enforce_transfer_rules, not to this keyboard, and it says so in its own
  // words. Withheld only where the meal is already spoken for, because
  // transfers_one_live_uk would turn a second offer into a unique violation.
  if (order !== null && order.status === "placed" && handover === null) {
    keyboard.push([{
      text: "Pass this meal on",
      callback_data: encodeCallback({ kind: "handover", menuId: menu.id }),
    }]);
  }

  return { text, keyboard };
}

/**
 * Button text, which Telegram renders literally: not HTML, so not escaped, and
 * escaping it would spell an ampersand out on the button of a dish called
 * Bún & Chả. Trimmed because a long label wraps a row out of legibility.
 */
function buttonLabel(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

type OrderRow = {
  id: number;
  status: string;
  /** The dish they are already on, which is the one "Surprise me" must avoid. */
  menu_item_id: number | null;
  item_name_snapshot: string | null;
  line_total_minor: number | null;
};

/** This member's own meal on a day, and whoever it is on its way to. */
type Meal = { order: OrderRow | null; handover: Handover | null };

async function myOrder(tx: Tx, link: Link, menuId: number): Promise<OrderRow | null> {
  // The profile_id filter is mandatory, not defensive: orders became org-wide
  // readable with the shared board, so without it this returns a colleague's
  // order as if it were this member's own.
  const [row] = await tx<OrderRow[]>`
    select o.id, o.status, oi.menu_item_id, oi.item_name_snapshot, oi.line_total_minor
      from public.orders o
      left join lateral (
        select i.menu_item_id, i.item_name_snapshot, i.line_total_minor
          from public.order_items i where i.order_id = o.id
         order by i.id limit 1) oi on true
     where o.menu_id = ${menuId} and o.profile_id = ${link.profileId}::uuid`;
  return row ?? null;
}

/**
 * The order and its handover together, because the day message needs both.
 *
 * `order` is passed in on the path where the write that prompted the redraw
 * already returned it. The transfer is read either way: nothing on that path
 * wrote one, and a pick on a meal already offered leaves the offer standing.
 */
async function myMeal(
  tx: Tx, link: Link, menuId: number, order?: OrderRow | null,
): Promise<Meal> {
  const mine = order === undefined ? await myOrder(tx, link, menuId) : order;
  if (mine === null || mine.status !== "placed") return { order: mine, handover: null };
  return { order: mine, handover: await liveHandover(tx, link, mine.id) };
}

/**
 * The dish "Surprise me" lands on, or null when there is nothing to land on.
 *
 * The rule is randomDish()'s, in src/shared, which is the board's rule too:
 * anything but the dish they already have, and the whole menu again when that
 * leaves nothing. Read inside the caller's transaction, so the dish that is
 * ordered is one that was on the menu at the moment it was ordered.
 */
async function surpriseItemId(tx: Tx, link: Link, menuId: number): Promise<number | null> {
  const [menu] = await menuRows(tx, link, todayIn(link.org.timezone, new Date()), menuId);
  if (menu === undefined) return null;
  const mine = await myOrder(tx, link, menuId);
  return randomDish(menu.items, { excludeId: mine?.menu_item_id ?? null })?.id ?? null;
}

/**
 * The live offer or settled pass on one of this member's own orders.
 *
 * transfers_one_live_uk makes this at most one row, which is exactly why the
 * day message reports it rather than offering the button a second time: a
 * second offer on the same meal is a unique violation, not a queue.
 *
 * from_profile_id pins it to meals this member is giving away.
 * transfers_select_party would also show them meals coming the other way, and
 * those are offerViews', which speak for the other side of the same row.
 */
async function liveHandover(tx: Tx, link: Link, orderId: number): Promise<Handover | null> {
  const [row] = await tx<Array<{ status: string; to_name: string | null }>>`
    select t.status,
           coalesce(mem.display_name, p.full_name, mem.short_code) as to_name
      from public.meal_transfers t
      left join public.memberships mem
             on mem.org_id = t.org_id and mem.profile_id = t.to_profile_id
      left join public.profiles p on p.id = t.to_profile_id
     where t.order_id = ${orderId}
       and t.from_profile_id = ${link.profileId}::uuid
       and t.status in ('pending','accepted')`;
  if (!row) return null;
  return { status: row.status === "accepted" ? "accepted" : "pending", toName: row.to_name };
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

/**
 * Everybody else in the office, as this member is allowed to see them.
 *
 * memberships_select shows a member their whole office, which is what the
 * board's own picker is built on. Named by membership rather than by profile
 * because the button has to carry the id home and callback_data has 64 bytes
 * for everything; the profile is resolved from it inside the transaction that
 * writes, so a stale button cannot name somebody who has since left.
 *
 * display_name first, because that is the name the office chose for them and
 * the name their colleagues see on the board.
 */
async function otherMembers(tx: Tx, link: Link): Promise<Array<{ id: number; name: string }>> {
  return await tx<Array<{ id: number; name: string }>>`
    select m.id, coalesce(m.display_name, p.full_name, m.short_code) as name
      from public.memberships m
      join public.profiles p on p.id = m.profile_id
     where m.org_id = ${link.org.id}
       and m.status = 'active'
       and m.profile_id <> ${link.profileId}::uuid
     order by name, m.id`;
}

/**
 * Passing a meal on, which until now could only be done from the board.
 *
 * Two taps and no typing: the day's message offers the meal, this replaces it
 * with the office, and the colleague's own button writes the transfer. The
 * question takes over the message it was asked from rather than arriving as a
 * new one, so "never mind" can put the day back exactly as it was.
 *
 * Nothing here decides whether the pass is allowed. RLS decides that the order
 * being given away is this member's own, and enforce_transfer_rules refuses a
 * meal on a closed bill and a lunch that is already over, in sentences written
 * for people that attempt() brings back as they were written. Reimplementing
 * either of those here would be a second copy of a rule, and the copy would
 * drift.
 */
async function onHandoverCallback(
  cb: CallbackQuery, chatId: number, messageId: number,
  link: Link, showOrgName: boolean,
  action: Extract<CallbackAction, { kind: "day" | "handover" | "handTo" }>,
): Promise<void> {
  const menuId = action.menuId;
  // Picked apart out here rather than inside the callback, for orgOfCallback's
  // reason: a union this wide is no longer narrowed once it is read from
  // inside a closure, and only one of these three shapes names a colleague.
  const membershipId = action.kind === "handTo" ? action.membershipId : null;

  // "Never mind". The question took over the day's own message, so the way
  // back is to put that message back rather than to leave a dead keyboard.
  if (action.kind === "day") {
    await answerCallbackQuery(BOT_TOKEN, cb.id);
    return await redraw(chatId, messageId, link, showOrgName, menuId);
  }

  const outcome = await attempt(() =>
    asMember(link.profileId, async (tx) => {
      const target = await targetById(tx, link, menuId);
      if (target === null) return refused("That menu is gone.");

      // Read rather than trusted: the button was drawn against a meal that may
      // since have been cancelled, passed on already, or never existed, and
      // the message it was drawn on is still sitting in the chat.
      const { order, handover } = await myMeal(tx, link, menuId);
      if (order === null || order.status !== "placed") return refused(NOTHING_TO_PASS_ON);
      // transfers_one_live_uk is what would otherwise stop this, as a unique
      // violation whose words are about an index rather than about the meal.
      // The board greys the same two cases out in these words.
      if (handover !== null) {
        const who = handover.toName ?? "a colleague";
        return refused(handover.status === "accepted"
          ? `Already passed to ${who}.`
          : `Already offered to ${who}.`);
      }

      const meal = {
        orgName: showOrgName ? link.org.name : null,
        serviceDate: target.menu.service_date,
        dishName: order.item_name_snapshot,
        amountMinor: order.line_total_minor,
      };
      const money = moneyIn(link.org);

      if (membershipId === null) {
        const others = await otherMembers(tx, link);
        if (others.length === 0) return refused(NOBODY_TO_PASS_IT_TO);
        return {
          refusal: null,
          toName: null,
          rendered: {
            text: renderHandoverPickText(meal, money),
            keyboard: [
              ...others.map((o) => [{
                text: buttonLabel(o.name),
                callback_data: encodeCallback({
                  kind: "handTo", menuId, membershipId: o.id,
                }),
              }]),
              // Last, and its own row, so the thumb reaching for it is nowhere
              // near a colleague's name.
              [{ text: "Never mind", callback_data: encodeCallback({ kind: "day", menuId }) }],
            ] as InlineKeyboard,
          },
        };
      }

      const [to] = await tx<Array<{ profile_id: string; name: string }>>`
        select m.profile_id, coalesce(m.display_name, p.full_name, m.short_code) as name
          from public.memberships m
          join public.profiles p on p.id = m.profile_id
         where m.id = ${membershipId}
           and m.org_id = ${link.org.id}
           and m.status = 'active'
           and m.profile_id <> ${link.profileId}::uuid`;
      if (!to) return refused("That colleague isn't in this office any more.");

      // org_id and from_profile_id are overwritten by the trigger from the
      // order; they are sent only because both columns are NOT NULL. The same
      // insert the Bill screen's createTransfer() makes, so one trigger
      // decides for both surfaces who may pass what, and when.
      await tx`insert into public.meal_transfers
                 (org_id, order_id, to_profile_id, from_profile_id, created_by)
               values (${link.org.id}, ${order.id}, ${to.profile_id}::uuid,
                       ${link.profileId}::uuid, ${link.profileId}::uuid)`;

      return {
        refusal: null,
        toName: to.name,
        rendered: {
          text: renderHandoverOfferedText({ ...meal, toName: to.name }, money),
          // Deliberately none. The offer is the other person's to answer now,
          // and a keyboard here would be a button for taking it back that
          // neither the board nor this bot has anywhere else.
          keyboard: [] as InlineKeyboard,
        },
      };
    })
  );

  const refusal = outcome.ok ? outcome.value.refusal : outcome.reason;
  const toName = outcome.ok ? outcome.value.toName : null;
  await answerCallbackQuery(
    BOT_TOKEN, cb.id,
    refusal ?? (toName === null ? undefined : `Offered to ${toName}`),
    refusal !== null,
  );

  const rendered = outcome.ok ? outcome.value.rendered : null;
  if (rendered !== null) {
    return await edit(chatId, messageId, rendered.text, rendered.keyboard);
  }
  // Every refusal here says the message the button was on is out of date, so
  // the member is left looking at what is true rather than at the stale offer
  // they tapped. They already have the verdict from the callback answer.
  await redraw(chatId, messageId, link, showOrgName, menuId);
}

/** A refusal in the shape onHandoverCallback's two branches both return. */
function refused(reason: string): {
  refusal: string; toName: null; rendered: null;
} {
  return { refusal: reason, toName: null, rendered: null };
}

/**
 * The day's own message again, in place of whatever has taken it over.
 *
 * Its own transaction: a refusal above was a thrown database error, which
 * rolled back the reads that could otherwise have ridden along with it. A
 * redraw that itself fails leaves the old message alone rather than talking
 * twice.
 */
async function redraw(
  chatId: number, messageId: number, link: Link, showOrgName: boolean, menuId: number,
): Promise<void> {
  const redrawn = await attempt(() =>
    asMember(link.profileId, (tx) => menuView(tx, link, showOrgName, menuId)));
  if (redrawn.ok) await edit(chatId, messageId, redrawn.value.text, redrawn.value.keyboard);
}

/* ---------------------------------------------------------------------- /me */

/**
 * The account, not the newest week.
 *
 * `balance_minor` is positive for a debt and negative for credit; the amounts
 * are cast because `sum(bigint)` is `numeric`, and db.ts teaches the driver to
 * parse int8 and nothing else, so a numeric would arrive as a string.
 */
type AccountRow = {
  charged_minor: number;
  credited_minor: number;
  balance_minor: number;
  /** memberships', not a statement's: the one that does not change weekly. */
  payment_ref: string;
};

const NO_ACCOUNT: AccountRow = {
  charged_minor: 0, credited_minor: 0, balance_minor: 0, payment_ref: "",
};

async function onMe(chatId: number, links: Link[]): Promise<void> {
  for (const link of links) {
    const orgName = links.length > 1 ? link.org.name : null;

    // Every row here is the member's own under RLS and the profile_id filters
    // say so out loud. Nobody ever sees anybody else's balance through this bot.
    //
    // One transaction, because the balance, the weeks behind it and what it had
    // to leave out have to describe one moment. run_billing() skips an order
    // whose dish has no price, so without the last of these the number reads as
    // the final word on an account that is still growing.
    const outcome = await attempt(() =>
      asMember(link.profileId, async (tx) => ({
        account: (await tx<AccountRow[]>`
          select b.charged_minor::bigint  as charged_minor,
                 b.credited_minor::bigint as credited_minor,
                 b.balance_minor::bigint  as balance_minor,
                 m.payment_ref
            from public.memberships m
            join public.v_account_balance b
              on b.org_id = m.org_id and b.profile_id = m.profile_id
           where m.org_id = ${link.org.id}
             and m.profile_id = ${link.profileId}::uuid`)[0] ?? NO_ACCOUNT,
        // Waived weeks are outside the balance, so they are outside the count
        // of weeks that explains it too.
        weeks: (await tx<Array<{ behind: number }>>`
          select count(*) filter (where status in ('unpaid','partial'))::int as behind
            from public.billing_statements
           where org_id = ${link.org.id}
             and profile_id = ${link.profileId}::uuid
             and status <> 'waived'`)[0] ?? { behind: 0 },
        // Read straight off the member's own rows rather than through
        // v_order_charges: order_items.profile_id is the person who PLACED the
        // order, so those are the rows order_items_own actually shows them.
        // Not bounded by a billing week, deliberately -- a member with nothing
        // billed at all still has meals waiting on a price, and that is the
        // case "Nothing has been billed to you yet." reads most wrongly.
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
    await say(chatId, orgHeading(orgName) + renderAccount(outcome.value, link));
  }
}

function renderAccount(
  me: {
    account: AccountRow;
    weeks: { behind: number };
    unpriced: number;
  },
  link: Link,
): string {
  const owed = Math.max(me.account.balance_minor, 0);

  // The QR is built here because vietQrLink() needs the org's payment_config,
  // which is a database row rather than a sentence. None where nothing is
  // owed: a code that pays zero, or pays a credit again, is a trap.
  const qr = owed === 0 ? null : vietQrLink(link.org.payment_config, {
    amountMinor: owed,
    minorUnits: link.org.currency_minor_units,
    addInfo: me.account.payment_ref,
  });

  return renderAccountText({
    balanceMinor: me.account.balance_minor,
    chargedMinor: me.account.charged_minor,
    creditedMinor: me.account.credited_minor,
    weeksBehind: me.weeks.behind,
    paymentRef: me.account.payment_ref,
    unpricedMeals: me.unpriced,
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

function exitLabel(verb: string, link: Link, showOrgName: boolean): string {
  return showOrgName ? buttonLabel(`${verb} ${link.org.name}`) : verb;
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
  // After the message, not before it: the menu is the smaller promise of the
  // two, and a chat that has just left its last office should not be left with
  // a `/` button offering to cancel an order it can no longer place.
  await refreshCommands(chatId);
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

  if (action.kind === "day" || action.kind === "handover" || action.kind === "handTo") {
    return await onHandoverCallback(cb, chat.id, messageId, link, links.length > 1, action);
  }

  const menuId = action.menuId;
  const outcome = await attempt(() =>
    asMember(link.profileId, async (tx) => {
      // The roll happens on the tap, not when the keyboard was drawn, so a
      // second tap is a second roll rather than the same dish again.
      const itemId = action.kind === "pick"
        ? action.itemId
        : action.kind === "surprise"
        ? await surpriseItemId(tx, link, menuId)
        : null;
      if (action.kind === "surprise" && itemId === null) {
        return { reason: "There's nothing on this menu to pick from.", dish: null, rendered: null };
      }

      const written = itemId === null
        ? await clearOrder(tx, link, menuId)
        : await placeOrder(tx, link, menuId, itemId);
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
    // It carries most of the weight for "Surprise me", which is the one tap
    // whose outcome the member could not have predicted.
    reason ?? (action.kind === "clear"
      ? "Cancelled"
      : dish === null ? "Ordered" : `Ordered ${dish}`),
    reason !== null,
  );

  const rendered = outcome.ok ? outcome.value.rendered : null;
  if (rendered !== null) {
    return await edit(chat.id, messageId, rendered.text, rendered.keyboard);
  }

  // Redrawn from the database, so the member is left looking at what is
  // actually true rather than at their failed tap.
  await redraw(chat.id, messageId, link, links.length > 1, menuId);
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
      menu_item_id: itemId,
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
      menu_item_id: null,
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
      profile_id: string; membership_id: number; full_name: string;
      has_web_account: boolean;
      org_id: number; org_name: string; timezone: string; currency: string;
      currency_minor_units: number; locale: string; payment_config: unknown;
    }>>`
      select m.profile_id, tl.membership_id, p.full_name,
             p.email is not null as has_web_account,
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
    hasWebAccount: r.has_web_account,
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

/* ------------------------------------------------------- the command menu */

/**
 * Which list this chat gets.
 *
 * One link with no web account is enough to make the whole chat Telegram-only,
 * and deliberately so. A chat can hold two memberships in two offices, and the
 * two lists differ by exactly one command: offering /leave to somebody who
 * also has a web account costs them nothing, because /unlink still works when
 * typed, whereas offering /unlink to somebody who has no other way in puts a
 * one-tap route to being locked out of their own bill in front of them.
 */
function memberKind(links: Link[]): MemberKind {
  return links.some((l) => !l.hasWebAccount) ? "telegram-only" : "web";
}

/**
 * Publish this chat's command menu, and hand back the help that agrees with it.
 *
 * The two are one decision, which is why one call does both: the list behind
 * the `/` button and the list /help prints are the same list, and a bot whose
 * help advertises a command its own menu withholds is telling somebody two
 * different things about the same office.
 *
 * A failure is logged and swallowed. setMyCommands is cosmetic; every command
 * works whether or not Telegram ever heard about it, and a chat left with a
 * stale menu is a far better outcome than a join that reports itself failed.
 */
async function publishCommands(chatId: number, links: Link[]): Promise<string> {
  const kind = memberKind(links);
  const res = links.length === 0
    ? await deleteMyCommands(BOT_TOKEN, chatId)
    : await setMyCommands(BOT_TOKEN, chatId, commandsFor(kind));
  if (!res.ok) console.error("command menu not updated", res.status, res.description);
  return helpFor(kind);
}

/** The same, for the paths that have just changed what linksForChat answers. */
async function refreshCommands(chatId: number): Promise<string> {
  return await publishCommands(chatId, await linksForChat(chatId));
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
