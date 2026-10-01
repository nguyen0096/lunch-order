/**
 * Pure helpers shared by the Telegram bot and the web app.
 *
 * This file must stay import-free. The Edge Function reaches it through a
 * one-line re-export in supabase/functions/_shared, and Deno resolves
 * specifiers literally: a `./types.js` import here is a file that does not
 * exist on disk, so the bundle would fail at deploy time rather than in CI.
 *
 * Everything the bot renders goes through parse_mode HTML, so every value that
 * came from a person or a caterer is escaped before it reaches a message.
 */

/* ------------------------------------------------------------------ linking */

/**
 * The deep link that hands a member's link_token to the bot.
 *
 * Null when no bot username is configured, so the caller can show the token
 * and manual instructions instead of a link that goes nowhere.
 */
export function botDeepLink(botUsername: string, linkToken: string): string | null {
  const bot = botUsername.trim().replace(/^@/, "");
  if (bot === "" || linkToken.trim() === "") return null;
  return `https://t.me/${encodeURIComponent(bot)}/?start=${encodeURIComponent(linkToken)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A /start argument only ever gets as far as a database lookup if it is
 * shaped like a link_token. PostgREST turns a malformed uuid into a 400 whose
 * message names the column, which is a worse answer than "that link expired".
 */
export function isLinkToken(arg: string): boolean {
  return UUID_RE.test(arg.trim());
}

// The alphabet organizations_telegram_join_code_check spells out, minus the
// characters people misread off a phone screen: no O/0, no I/1.
const JOIN_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12}$/;

/**
 * The org's shared join code, as somebody with no web account arrives with.
 *
 * Folded to upper case first because join_with_code() does `upper(btrim(...))`
 * on the way in, so a code typed in lower case is the same code.
 */
export function isJoinCode(arg: string): boolean {
  return JOIN_CODE_RE.test(normalizeJoinCode(arg));
}

export function normalizeJoinCode(arg: string): string {
  return arg.trim().toUpperCase();
}

/* ------------------------------------------------------- the name prompt */

/**
 * The name has to be asked for BEFORE the account exists: join_with_code()
 * writes profiles.full_name and private.suggest_short_code() then folds that
 * name into the code printed on bank transfer memos. Signing somebody up first
 * would stamp them 'NEWM' forever, and abandoning the prompt would leave an
 * orphan auth user behind.
 *
 * Which means the bot has to remember a join code across two messages, and it
 * has nowhere to put it: an Edge Function keeps nothing between invocations and
 * a conversation-state table would be a third door into this schema. So the
 * prompt carries the code and is sent with force_reply, and Telegram hands it
 * straight back in reply_to_message. The conversation is the state.
 */
const JOIN_CODE_LABEL = "Join code: ";

export function namePrompt(orgName: string, joinCode: string): string {
  return [
    `Joining <b>${escapeHtml(orgName)}</b>.`,
    "",
    "What should people call you? Reply to this message with your name, and I'll",
    "sign you up. It's the name colleagues see next to your lunch.",
    "",
    // Last line, and read back anchored to the end, so an org that has named
    // itself "Join code: AAAAAA" cannot talk the bot into a different org.
    `${JOIN_CODE_LABEL}${escapeHtml(normalizeJoinCode(joinCode))}`,
  ].join("\n");
}

/** The code out of a prompt the bot sent, or null if this is not that message. */
export function joinCodeInPrompt(text: string | undefined): string | null {
  if (text === undefined) return null;
  const match = new RegExp(
    `(?:^|\\n)${JOIN_CODE_LABEL}([ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6,12})\\s*$`,
  ).exec(text);
  return match?.[1] ?? null;
}

/* ----------------------------------------------------------------- messages */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type Command = { name: string; arg: string };

/** `/start@LunchBot abc` -> { name: "start", arg: "abc" }. Null for plain text. */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const name = head.slice(1).split("@")[0]?.toLowerCase() ?? "";
  if (name === "") return null;
  return { name, arg };
}

/* ------------------------------------------------------- the command menu */

/**
 * Which way into the app a chat belongs to, and so which way out it is offered.
 *
 * A member who signed up on the web keeps their account whatever this chat
 * does, so /unlink is the exit that fits: it stops the bot talking and leaves
 * the membership alone, and ending a membership belongs in Settings, where
 * their account lives. A member who joined by sending a join code has no
 * account anywhere else, so /unlink would cut the only thread they have to
 * their own bill; /leave is the exit that means something to them.
 *
 * Both commands keep working when typed by hand whichever list a chat was
 * given. This decides what is offered, never what is permitted.
 */
export type MemberKind = "web" | "telegram-only";

/** setMyCommands' shape: a name without its slash, and one line about it. */
export type BotCommand = { command: string; description: string };

const EVERY_CHAT: BotCommand[] = [
  { command: "order", description: "the next menu, and order from it" },
  { command: "cancel", description: "cancel your next order" },
  { command: "me", description: "what you owe, and how to pay it" },
  { command: "help", description: "the list of commands" },
];

const UNLINK: BotCommand = {
  command: "unlink",
  description: "disconnect this chat, and stay a member",
};

const LEAVE: BotCommand = { command: "leave", description: "leave your office" };

/**
 * The list a chat is given, in the order Telegram shows it.
 *
 * /today is left out on purpose, as it always has been from the help: it was
 * named wrongly, it still works for the people who have it in their fingers,
 * and putting it in a menu would teach it to everybody else.
 */
export function commandsFor(kind: MemberKind): BotCommand[] {
  return [...EVERY_CHAT, kind === "web" ? UNLINK : LEAVE];
}

/**
 * /help, which says exactly what that chat's own command menu says.
 *
 * Built from the same list rather than written out beside it. One static help
 * string was how the bot came to advertise /leave to somebody whose menu did
 * not offer it, and /unlink to somebody it would have stranded.
 */
export function helpFor(kind: MemberKind): string {
  return [
    "<b>What I can do</b>",
    ...commandsFor(kind).map((c) => `/${c.command} - ${c.description}`),
  ].join("\n");
}

/* -------------------------------------------------------- callback payloads */

export type CallbackAction =
  | { kind: "pick"; menuId: number; itemId: number }
  | { kind: "clear"; menuId: number }
  // A dish nobody has chosen yet: the menu is read when the button is tapped,
  // not when it is drawn, so two taps are two rolls rather than the same dish
  // twice.
  | { kind: "surprise"; menuId: number }
  // The day itself, redrawn. The way back from a question that took over the
  // message, so answering "never mind" leaves the member where they started.
  | { kind: "day"; menuId: number }
  // Passing a meal on, in two taps: which day, then which colleague. The
  // colleague is named by membership rather than by profile because a
  // membership id is a small integer and a profile id is a 36-character uuid,
  // and callback_data has 64 bytes for everything.
  | { kind: "handover"; menuId: number }
  | { kind: "handTo"; menuId: number; membershipId: number }
  | { kind: "transfer"; transferId: number; decision: "accepted" | "declined" }
  // The org id rides along for the same reason menu_id does: it is a routing
  // key, matched against the chat's own links before anything happens, never
  // taken as proof of membership. `confirmed` carries the answer too, so
  // declining is a tap rather than an ignored message -- the handler then
  // redraws without the keyboard, and a button that can remove somebody from
  // their office stops existing rather than waiting in the chat for a thumb.
  | { kind: "leave"; orgId: number; confirmed: boolean }
  | { kind: "unlink"; orgId: number; confirmed: boolean };

/**
 * Telegram caps callback_data at 64 bytes and returns it to us verbatim, so it
 * is a routing key and never a fact: every id decoded here is re-checked
 * against RLS before anything is written.
 */
export function encodeCallback(a: CallbackAction): string {
  switch (a.kind) {
    case "pick": return `p:${a.menuId}:${a.itemId}`;
    case "clear": return `c:${a.menuId}`;
    case "surprise": return `s:${a.menuId}`;
    case "day": return `d:${a.menuId}`;
    case "handover": return `h:${a.menuId}`;
    case "handTo": return `h:${a.menuId}:${a.membershipId}`;
    case "transfer": return `t:${a.transferId}:${a.decision === "accepted" ? "a" : "d"}`;
    case "leave": return `l:${a.orgId}:${a.confirmed ? "y" : "n"}`;
    case "unlink": return `u:${a.orgId}:${a.confirmed ? "y" : "n"}`;
  }
}

export function decodeCallback(data: string): CallbackAction | null {
  const parts = data.split(":");
  const tag = parts[0];
  if (tag === "p" && parts.length === 3) {
    const menuId = toId(parts[1]);
    const itemId = toId(parts[2]);
    return menuId === null || itemId === null ? null : { kind: "pick", menuId, itemId };
  }
  if ((tag === "c" || tag === "s" || tag === "d") && parts.length === 2) {
    const menuId = toId(parts[1]);
    if (menuId === null) return null;
    if (tag === "c") return { kind: "clear", menuId };
    return tag === "s" ? { kind: "surprise", menuId } : { kind: "day", menuId };
  }
  if (tag === "h" && (parts.length === 2 || parts.length === 3)) {
    const menuId = toId(parts[1]);
    if (menuId === null) return null;
    if (parts.length === 2) return { kind: "handover", menuId };
    const membershipId = toId(parts[2]);
    return membershipId === null ? null : { kind: "handTo", menuId, membershipId };
  }
  if (tag === "t" && parts.length === 3) {
    const transferId = toId(parts[1]);
    if (transferId === null) return null;
    if (parts[2] === "a") return { kind: "transfer", transferId, decision: "accepted" };
    if (parts[2] === "d") return { kind: "transfer", transferId, decision: "declined" };
  }
  if ((tag === "l" || tag === "u") && parts.length === 3) {
    const orgId = toId(parts[1]);
    // Anything but the two letters we wrote is refused rather than read as a
    // no: a payload we do not recognise is one we cannot claim to understand,
    // and this pair of buttons is the wrong place to guess.
    if (orgId === null || (parts[2] !== "y" && parts[2] !== "n")) return null;
    const confirmed = parts[2] === "y";
    return tag === "l"
      ? { kind: "leave", orgId, confirmed }
      : { kind: "unlink", orgId, confirmed };
  }
  return null;
}

function toId(s: string | undefined): number | null {
  if (s === undefined || !/^[1-9][0-9]{0,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/* -------------------------------------------------------------------- dates */

/** The org's calendar date, the TypeScript twin of private.today_in(tz). */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA renders ISO order, which is the only locale property being relied on.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * "21:00 22/09", byte for byte what enforce_order_window() raises, so the
 * bot's warning and the database's refusal cannot describe the same cutoff
 * two different ways.
 */
export function formatCutoffIn(isoInstant: string, timeZone: string): string {
  const p = partsOf(new Date(isoInstant), timeZone, {
    hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false,
  });
  return `${p["hour"]}:${p["minute"]} ${p["day"]}/${p["month"]}`;
}

/** "Tue 23/09" for a bare service date. */
export function formatServiceDate(serviceDate: string): string {
  const p = partsOf(new Date(`${serviceDate}T00:00:00Z`), "UTC", {
    weekday: "short", day: "2-digit", month: "2-digit",
  });
  return `${p["weekday"]} ${p["day"]}/${p["month"]}`;
}

function partsOf(
  d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).formatToParts(d)) {
    out[part.type] = part.value;
  }
  return out;
}

/* ------------------------------------------------------------------- gating */

export type MenuLike = {
  serviceDate: string;
  status: string;
  orderCutoffAt: string;
};

/**
 * Why ordering is shut, in the bot's vocabulary.
 *
 * The decision must agree with orderDisabledReason() in gating.ts case for
 * case; only the wording differs, because a chat message has no surrounding
 * screen to say which day it is talking about. test/telegram.test.ts asserts
 * the agreement over the whole matrix, so a rule changed in one place fails
 * the build rather than drifting.
 */
export function orderingClosedReason(args: {
  menu: MenuLike | null;
  now: Date;
  timeZone: string;
}): string | null {
  const { menu } = args;
  if (menu === null) return "There's no menu for that day yet.";
  const day = formatServiceDate(menu.serviceDate);
  if (menu.status === "cancelled") return `Lunch on ${day} is cancelled.`;
  // No admin exemption here either. This mirrors `orderDisabledReason` on the
  // web and the trigger under both: an admin ordering their own lunch is an
  // ordinary eater, and only a write that says `source = 'admin'` is outside
  // the window. The test that pins these two together is what keeps the bot
  // from quietly offering what the database will refuse.
  if (menu.status === "locked") {
    return `Orders for ${day} are closed and have gone to the caterer.`;
  }
  if (args.now.getTime() >= Date.parse(menu.orderCutoffAt)) {
    return `Ordering for ${day} closed at ${formatCutoffIn(menu.orderCutoffAt, args.timeZone)}.`;
  }
  return null;
}

/**
 * Which menu a command that named no menu is about.
 *
 * The single answer for every such command, /order and /cancel alike. Asking
 * this question in two places is what let a member order for tomorrow and then
 * be told, by a /cancel that had looked at today, that they had nothing to
 * cancel.
 *
 * Same intent as defaultSelectedDay() in gating.ts: the soonest day still open,
 * else the soonest day with a menu at all, so a member who asks after the
 * cutoff is told what closed rather than shown nothing.
 */
export function targetMenu<T extends MenuLike>(
  menus: T[],
  args: { today: string; now: Date; timeZone: string },
): { menu: T; closedReason: string | null } | null {
  const upcoming = menus
    .filter((m) => m.serviceDate >= args.today)
    .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));

  for (const menu of upcoming) {
    if (orderingClosedReason({ ...args, menu }) === null) return { menu, closedReason: null };
  }
  const first = upcoming[0];
  if (first === undefined) return null;
  return { menu: first, closedReason: orderingClosedReason({ ...args, menu: first }) };
}

/* --------------------------------------------------------- a dish at random */

export type DishLike = { id: number; name: string };

/**
 * The dish "Surprise me" orders: the twin of pickDish() in
 * src/web/components/boardModel.ts, arithmetic included.
 *
 * A twin rather than a call, because that module is the board's and this file
 * must stay import-free (see the header), so the Edge Function cannot reach it.
 * test/telegram.test.ts rolls both over the same menus with the same random()
 * and asserts they land on the same dish, the way orderingClosedReason is
 * pinned to gating.ts: a rule changed in one place fails the build rather than
 * letting the board and the bot disagree about what random means.
 *
 * Not repeating the dish somebody already has is the whole of the rule --
 * tapping the dice again should move you, not hand back what you were holding.
 * Falling back to the full list is what makes a menu of one dish re-offer it
 * rather than go blank.
 */
export function randomDish<T extends DishLike>(
  dishes: T[],
  options: { excludeId?: number | null; random?: () => number } = {},
): T | null {
  const without = dishes.filter((d) => d.id !== options.excludeId);
  const pool = without.length > 0 ? without : dishes;
  if (pool.length === 0) return null;
  const roll = (options.random ?? Math.random)();
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[index] ?? null;
}

/* ------------------------------------------------------- prices in messages */

/**
 * What the bot writes where a price would go when the caterer has not given
 * one.
 *
 * The same words as PRICE_PENDING in src/shared/money.ts, lower case because
 * here they always sit inside a sentence. Spelled out rather than imported
 * because this file must stay import-free (see the header), and the test file
 * asserts the two surfaces keep the one vocabulary so they cannot drift.
 */
export const PRICE_TO_COME = "price to come";

/** Renders a known amount. Injected, so this file imports no money module. */
export type Money = (minor: number) => string;

/**
 * An amount, or the words for one nobody has yet.
 *
 * Never `money(minor ?? 0)`: zero is a real price, and in a chat message
 * "0 ₫" is a promise of a free lunch that nobody made.
 */
export function priceText(minor: number | null, money: Money): string {
  return minor === null ? PRICE_TO_COME : money(minor);
}

/**
 * How many of the reader's meals are still waiting on a price, in words.
 *
 * Null when none are. A statement that quietly left them out would read as the
 * final word on the week, and the member would budget for a number that is
 * about to grow.
 */
export function unpricedMealsNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "One meal is still waiting on the caterer's price, so it is not counted here. " +
      "It goes on your bill once the price arrives."
    : `${n} meals are still waiting on the caterer's price, so they are not counted here. ` +
      "They go on your bill once the price arrives.";
}

/* -------------------------------------------------------------- the messages */

/**
 * The bot's messages are built here, not in the Edge Function, for the same
 * reason orderingClosedReason() is: Deno code is unreachable from vitest, and
 * every one of these can meet a price the caterer has not set. Keeping them
 * pure puts each sentence under test. Only the keyboards stay with the
 * function, because a keyboard is plumbing rather than words.
 *
 * Everything goes out as parse_mode HTML, so each value that came from a person
 * or a caterer is escaped on the way in.
 */

/** `<b>Office</b>` and a newline, or nothing for a member with one office. */
export function orgHeading(orgName: string | null): string {
  return orgName === null ? "" : `<b>${escapeHtml(orgName)}</b>\n`;
}

export type DayMessage = {
  /** The office's name, for a member who belongs to more than one. */
  orgName: string | null;
  serviceDate: string;
  /** Why ordering is shut, or null when it is open. */
  closedReason: string | null;
  orderCutoffAt: string;
  timeZone: string;
  dishes: Array<{ name: string; priceMinor: number | null }>;
  /** Null when this member has nothing on the day. */
  order: {
    status: string;
    /** The dish as it was snapshotted; null when they are down but undecided. */
    dishName: string | null;
    /** Null when the dish carried no price at the moment they chose it. */
    amountMinor: number | null;
  } | null;
  /** Null when the meal is still this member's own. */
  handover: Handover | null;
};

/**
 * This member's meal on its way to somebody else.
 *
 * `pending` is an offer nobody has answered, and the meal is still theirs and
 * still on their bill until it is answered. `accepted` is the meal gone.
 * `toName` is null when the colleague cannot be named, the same absence
 * renderOfferText copes with from the other side.
 */
export type Handover = { status: "pending" | "accepted"; toName: string | null };

/** The day's menu, and where this member stands on it. */
export function renderDayText(m: DayMessage, money: Money): string {
  const lines = [`${orgHeading(m.orgName)}<b>${formatServiceDate(m.serviceDate)}</b>`];
  lines.push(
    m.closedReason !== null
      ? escapeHtml(m.closedReason)
      : `Orders close ${formatCutoffIn(m.orderCutoffAt, m.timeZone)}.`,
  );
  lines.push("");

  if (m.dishes.length === 0) {
    lines.push("No dishes on this menu.");
  } else {
    for (const d of m.dishes) {
      lines.push(`- ${escapeHtml(d.name)}  ${escapeHtml(priceText(d.priceMinor, money))}`);
    }
  }

  lines.push("");
  const order = m.order;
  if (order === null || order.status === "cancelled") {
    lines.push("You're <b>not</b> down as eating.");
  } else if (order.dishName === null) {
    lines.push("You're down as eating, but haven't picked a dish yet.");
  } else {
    lines.push(
      `You: <b>${escapeHtml(order.dishName)}</b> ` +
      `(${escapeHtml(priceText(order.amountMinor, money))})`,
    );
    // Answered where the question is asked. On its own the bracket says what
    // the bot does not know and nothing about what the member will owe.
    if (order.amountMinor === null) {
      lines.push("It goes on your bill once the caterer prices it.");
    }
  }

  // Under the meal it is about, and only where there is a meal: a line saying
  // somebody is taking a lunch the member is not down for reads as a mistake.
  // It also stands in for the button, which is not offered twice on one meal.
  if (m.handover !== null && order !== null && order.status !== "cancelled") {
    lines.push(
      m.handover.status === "pending"
        ? `You've offered it to <b>${escapeHtml(m.handover.toName ?? "a colleague")}</b>. ` +
          "It stays yours, and on your bill, until they accept."
        : `<b>${escapeHtml(m.handover.toName ?? "A colleague")}</b> took this meal, ` +
          "so it is on their bill rather than yours.",
    );
  }

  return lines.join("\n");
}

export type OfferMessage = {
  /** The colleague handing the meal over, null when they cannot be named. */
  fromName: string | null;
  serviceDate: string;
  dishName: string | null;
  amountMinor: number | null;
};

/** A colleague's meal, offered to this member. */
export function renderOfferText(o: OfferMessage, money: Money): string {
  const who = escapeHtml(o.fromName ?? "A colleague");
  const what = o.dishName === null
    ? "their lunch"
    : `${escapeHtml(o.dishName)} (${escapeHtml(priceText(o.amountMinor, money))})`;
  const consequence = o.dishName !== null && o.amountMinor === null
    ? "If you accept, it goes on your bill once the caterer prices it."
    : "If you accept, the cost moves to your bill.";
  return `${who} is offering you ${what} on <b>${formatServiceDate(o.serviceDate)}</b>.\n` +
    consequence;
}

/* ------------------------------------------------------ passing a meal on */

/**
 * Handing a meal over from the chat, which until now could only be done from
 * the board.
 *
 * Two taps and no typing: the day, then the colleague. Nothing here decides
 * whether the pass is allowed. enforce_transfer_rules refuses a meal on a
 * closed bill and a lunch that is already over, in sentences written for
 * people, and the bot shows those rather than guessing at them first.
 */
export type HandoverMessage = {
  /** The office's name, for a member who belongs to more than one. */
  orgName: string | null;
  serviceDate: string;
  /** The dish they are giving away; null when they are down but undecided. */
  dishName: string | null;
  amountMinor: number | null;
};

/** The dish as this member's meal, named where naming it is the point. */
function theirMeal(m: HandoverMessage, money: Money): string {
  return m.dishName === null
    ? "your lunch"
    : `your <b>${escapeHtml(m.dishName)}</b> (${escapeHtml(priceText(m.amountMinor, money))})`;
}

/** Step two: the question the list of colleagues is the answer to. */
export function renderHandoverPickText(m: HandoverMessage, money: Money): string {
  return [
    `${orgHeading(m.orgName)}<b>${formatServiceDate(m.serviceDate)}</b>`,
    "",
    `Who gets ${theirMeal(m, money)}?`,
    "",
    // Said before the tap, because the tap charges a colleague money and the
    // only thing that stops it is their own answer. How they hear about it is
    // stated as what is certain rather than as a message they may or may not
    // get: the board shows a pending offer and so does /order.
    "They'll see it on the board, and the next time they ask me for the menu. " +
    "Nothing moves until they accept, and until then the meal is still yours.",
  ].join("\n");
}

/** Offered, and what that does and does not mean yet. */
export function renderHandoverOfferedText(
  m: HandoverMessage & { toName: string | null }, money: Money,
): string {
  return [
    `${orgHeading(m.orgName)}<b>Offered to ${escapeHtml(m.toName ?? "a colleague")}.</b>`,
    "",
    `They can take ${theirMeal(m, money)} on <b>${formatServiceDate(m.serviceDate)}</b>.`,
    "",
    "It stays yours, and on your bill, until they accept.",
  ].join("\n");
}

/**
 * The board's own reason, in a sentence.
 *
 * passOnReason() in boardModel.ts greys the control out with "There is no meal
 * here to pass on"; this is the same claim where there is no control to grey,
 * so both surfaces say the same thing about the same emptiness.
 */
export const NOTHING_TO_PASS_ON = "There is no meal here to pass on.";

/** An office of one. Rare, and the one case with nothing to put on a keyboard. */
export const NOBODY_TO_PASS_IT_TO =
  "There's nobody else in this office to pass it to.";

export type AccountMessage = {
  /**
   * `v_account_balance.balance_minor` unclamped: positive is a debt, negative
   * is credit, which is what a top-up looks like once it is on the books.
   */
  balanceMinor: number;
  chargedMinor: number;
  creditedMinor: number;
  /** Billed weeks with something still outstanding. */
  weeksBehind: number;
  /**
   * The person's own reference, which carries no week number and so is the
   * same string to type every time.
   */
  paymentRef: string;
  /**
   * Meals of this member's that run_billing() could not cost, so they are in
   * no line and in no total below.
   */
  unpricedMeals: number;
};

/**
 * The one sentence every message that hands out a reference has to carry.
 *
 * A constant so a second such message cannot be written without it, and so it
 * stays the claim the Bill screen makes in its own words.
 */
export const PAYMENT_REF_REQUIRED =
  "It is required: only transfers carrying it reach the lunch app, so one sent " +
  "without it leaves your bill unpaid with nothing for an admin to find.";

/**
 * What the member owes, and what is not in that number yet.
 *
 * The account, not the newest week. A week is a charge, a payment is a credit,
 * and the difference is the one number anybody can act on. Answering with the
 * newest statement asked somebody three weeks behind for the newest week
 * alone, and had no way at all to say that money was in hand.
 *
 * The reference and the QR appear only where something is owed, as on the Bill
 * screen: handing somebody the means to pay what they do not owe is an
 * instruction to overpay.
 */
export function renderAccountText(
  a: AccountMessage, money: Money, qrUrl: string | null,
): string {
  const owed = Math.max(a.balanceMinor, 0);
  const credit = Math.max(-a.balanceMinor, 0);
  const lines: string[] = [];

  if (credit > 0) {
    lines.push(`<b>You are ${escapeHtml(money(credit))} in credit.</b>`);
    lines.push(
      "You have paid ahead. This comes off your next lunches, and there is " +
      "nothing to transfer.",
    );
  } else if (owed === 0) {
    lines.push("<b>Nothing to pay.</b>");
    lines.push(
      a.chargedMinor === 0
        ? "Nothing has been billed to you yet."
        : `${escapeHtml(money(a.chargedMinor))} billed, all of it paid.`,
    );
  } else {
    lines.push(`<b>You owe ${escapeHtml(money(owed))}.</b>`);
    // The arithmetic behind the figure, and the span it covers where that is
    // more than one week: unlike the Bill screen there is no table of weeks
    // under this to show it. Nothing received means there is no arithmetic,
    // and "0 d received" is not information.
    const sum =
      a.creditedMinor > 0
        ? `${escapeHtml(money(a.chargedMinor))} billed, ` +
          `${escapeHtml(money(a.creditedMinor))} received.`
        : null;
    if (a.weeksBehind > 1) {
      lines.push(sum === null ? `Across ${a.weeksBehind} weeks.` : `Across ${a.weeksBehind} weeks. ${sum}`);
    } else if (sum !== null) {
      lines.push(sum);
    }
  }

  // Directly under the number it qualifies, so the two are never read apart.
  const waiting = unpricedMealsNote(a.unpricedMeals);
  if (waiting !== null) lines.push(waiting);

  if (owed === 0) return lines.join("\n");

  lines.push("");
  // Stated as required, not as a courtesy. SePay syncs only transactions whose
  // memo carries LUNCH, so a transfer sent without the reference never arrives
  // here at all: no admin sees it, and nobody can chase what nobody can see.
  lines.push(
    `Put <code>${escapeHtml(a.paymentRef)}</code> in the transfer message, the same ` +
    `one every week. ${PAYMENT_REF_REQUIRED}`,
  );
  if (qrUrl !== null) {
    lines.push(`<a href="${escapeHtml(qrUrl)}">Pay by QR</a> fills it in for you.`);
  }

  return lines.join("\n");
}

/* ----------------------------------------------- leaving and disconnecting */

/**
 * The two ways out, and why they are worded as carefully as anything here.
 *
 * A member who joined through Telegram has no browser session anywhere -- these
 * two commands are the whole of their Settings screen. So each message says
 * what stops AND what stays, and each names the way back in, which is the
 * office's join code and nothing else: signing in with Google would mint a
 * different account with no membership at all.
 */
export type ExitMessage = {
  /** The office's name, for a member who belongs to more than one. */
  orgName: string | null;
  /** The office's join code, or null when the office has none to hand out. */
  joinCode: string | null;
};

export type ExitKind = "leave" | "unlink";

/** The door they came in by, which is the same door back. */
function comeBackLine(joinCode: string | null): string {
  return joinCode === null
    ? "To come back, ask your office for its join code and send it to me."
    : `To come back, send me the join code <code>${escapeHtml(joinCode)}</code>.`;
}

/** What the tap would cost, said before the tap rather than after it. */
export function renderLeaveConfirmText(m: ExitMessage): string {
  return [
    `${orgHeading(m.orgName)}<b>Leave this office?</b>`,
    "",
    "You'd stop ordering lunch here, and I'd stop messaging you about it.",
    "",
    "Nothing is deleted: your orders, your bill and your short code stay as " +
    "they are, so you'd come back to the same membership rather than a new one.",
    "",
    comeBackLine(m.joinCode),
  ].join("\n");
}

/** Left, and still on record: the two halves somebody needs in one message. */
export function renderLeftText(m: ExitMessage): string {
  return [
    `${orgHeading(m.orgName)}<b>You've left this office.</b>`,
    "",
    "Nothing was deleted. Your orders and your bill stay on record, and the " +
    "membership is kept for when you come back.",
    "",
    comeBackLine(m.joinCode),
  ].join("\n");
}

export function renderUnlinkConfirmText(m: ExitMessage): string {
  return [
    `${orgHeading(m.orgName)}<b>Disconnect this chat?</b>`,
    "",
    "I'd stop asking what you want for lunch, and stop telling you when the " +
    "menu or your bill changes.",
    "",
    "You'd stay a member either way: your orders and anything you owe are " +
    "untouched. This only stops me talking to you here.",
    "",
    comeBackLine(m.joinCode),
  ].join("\n");
}

export function renderUnlinkedText(m: ExitMessage): string {
  return [
    `${orgHeading(m.orgName)}<b>Disconnected.</b>`,
    "",
    "I won't message you about lunch here any more. You're still a member, " +
    "and your orders and anything you owe are unchanged.",
    "",
    comeBackLine(m.joinCode),
  ].join("\n");
}

/** What is still true after a decision that changed nothing. */
function unchanged(kind: ExitKind): string {
  return kind === "leave"
    ? "Nothing changed, so you're still a member of this office."
    : "Nothing changed, so this chat is still connected.";
}

export function renderExitCancelledText(orgName: string | null, kind: ExitKind): string {
  return orgHeading(orgName) + unchanged(kind);
}

/**
 * leave_office()'s refusal, as it wrote it.
 *
 * "you still owe this office money; settle up before you leave" and "you are
 * the only owner; make somebody else an owner first, or delete the office" are
 * sentences written for people, and both pass through humanError() untouched.
 * Nothing here recases or repunctuates them: a second, prettier copy of a rule
 * is how the bot and the database start disagreeing about what the rule is.
 */
export function renderExitRefusedText(
  orgName: string | null, kind: ExitKind, reason: string,
): string {
  return `${orgHeading(orgName)}${escapeHtml(reason)}\n\n${unchanged(kind)}`;
}

/**
 * `/leave` or `/unlink` from a chat that is connected to nothing.
 *
 * NOT_CONNECTED answers "I don't know who you are yet", which is right for a
 * bare hello and wrong here: it reads as a refusal of what was asked for, when
 * in fact it has already happened. Says so, then names both doors back.
 */
export const NOTHING_TO_LEAVE = [
  "This chat isn't connected to an office, so there's nothing to leave or disconnect.",
  "",
  "To connect it, send me your office's <b>join code</b>. If you use the lunch app, " +
  "you can also open it, go to <b>Preferences</b> and tap <b>Connect Telegram</b>.",
].join("\n");

/* ------------------------------------------------------------------- groups */

/**
 * A group the bot should tell its own chat id to.
 *
 * `added` is the bot arriving in a group; `migrated` is a group Telegram has
 * turned into a supergroup, which gives it a new id and retires the old one.
 */
export type GroupEvent =
  | { kind: "added"; chatId: number }
  | { kind: "migrated"; fromChatId: number; toChatId: number };

/**
 * What groupEvent needs to know that an update does not carry.
 *
 * Both only matter for a service message, so the bot asks Telegram for them
 * only when mayBeServiceMessageAdd() says it has to.
 */
export type GroupEventContext = {
  /** getMe's id, or null when it was not looked up. */
  botId: number | null;
  /**
   * Whether the webhook receives my_chat_member. When it does, that update is
   * the one that announces an add, and the service message for the same add
   * says nothing, so one add is one message.
   */
  myChatMemberSubscribed: boolean;
};

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null ? v as Obj : null;
}

function isGroup(chat: Obj | null): chat is Obj {
  return chat !== null && typeof chat["id"] === "number" &&
    (chat["type"] === "group" || chat["type"] === "supergroup");
}

/**
 * Whether a ChatMember is in the chat. "restricted" is in or out by its
 * is_member flag; "left" and "kicked" are out.
 */
function isIn(member: Obj | null): boolean {
  const status = member?.["status"];
  if (status === "member" || status === "administrator" || status === "creator") return true;
  return status === "restricted" && member?.["is_member"] === true;
}

function groupMessage(update: Obj): Obj | null {
  const message = obj(update["message"]);
  return message !== null && isGroup(obj(message["chat"])) ? message : null;
}

function botsJoining(message: Obj): Obj[] {
  const members = message["new_chat_members"];
  if (!Array.isArray(members)) return [];
  return members.map(obj).filter((u): u is Obj => u?.["is_bot"] === true);
}

/**
 * Whether groupEvent needs a real GroupEventContext for this update, so the
 * bot calls getWebhookInfo and getMe for an add, not for every group message.
 */
export function mayBeServiceMessageAdd(update: unknown): boolean {
  const u = obj(update);
  const message = u === null ? null : groupMessage(u);
  if (message === null) return false;
  return message["group_chat_created"] === true || botsJoining(message).length > 0;
}

/**
 * Whether a webhook's allowed_updates delivers my_chat_member. Telegram leaves
 * the field out, or sends it empty, for the default, which includes it.
 */
export function receivesMyChatMember(allowedUpdates: unknown): boolean {
  if (!Array.isArray(allowedUpdates) || allowedUpdates.length === 0) return true;
  return allowedUpdates.includes("my_chat_member");
}

/**
 * Is this update the bot arriving in a group, or a group becoming a
 * supergroup, and which chat is it about.
 *
 * Only groups and supergroups: my_chat_member also arrives for a private chat
 * blocking or unblocking the bot, and for channels. Being removed, and being
 * promoted inside a chat the bot was already in, are not arrivals.
 *
 * supergroup_chat_created is not looked at: Telegram documents that it never
 * arrives in an update, since a bot cannot be in a supergroup as it is created.
 * A migration is announced from the old group's migrate_to_chat_id message
 * only, not also from the new one's migrate_from_chat_id.
 */
export function groupEvent(update: unknown, ctx: GroupEventContext): GroupEvent | null {
  const u = obj(update);
  if (u === null) return null;

  const change = obj(u["my_chat_member"]);
  if (change !== null) {
    const chat = obj(change["chat"]);
    if (!isGroup(chat)) return null;
    const before = obj(change["old_chat_member"]);
    const after = obj(change["new_chat_member"]);
    const who = obj(after?.["user"]);
    if (who?.["is_bot"] !== true) return null;
    if (ctx.botId !== null && who["id"] !== ctx.botId) return null;
    return !isIn(before) && isIn(after) ? { kind: "added", chatId: chat["id"] as number } : null;
  }

  const message = groupMessage(u);
  if (message === null) return null;
  const chatId = (message["chat"] as Obj)["id"] as number;

  const to = message["migrate_to_chat_id"];
  if (typeof to === "number") return { kind: "migrated", fromChatId: chatId, toChatId: to };

  if (ctx.myChatMemberSubscribed) return null;
  if (message["group_chat_created"] === true) return { kind: "added", chatId };
  if (ctx.botId !== null && botsJoining(message).some((b) => b["id"] === ctx.botId)) {
    return { kind: "added", chatId };
  }
  return null;
}

/**
 * The only thing the bot says to a group it has just arrived in. Anybody can
 * add the bot to any group, so it names no office and nothing else about the
 * app beyond where the number goes.
 */
export function groupChatIdText(event: GroupEvent): string {
  if (event.kind === "added") {
    return `This group's chat ID is <code>${event.chatId}</code>. ` +
      "An admin can paste it in the lunch app under <b>Settings</b> &gt; " +
      "<b>Telegram group chat</b>.";
  }
  return `This group is now a supergroup, and its chat ID changed to <code>${event.toChatId}</code>. ` +
    "The lunch app follows the change by itself; if it stops posting here, an admin " +
    "can paste the new ID under <b>Settings</b> &gt; <b>Telegram group chat</b>.";
}

/* ------------------------------------------------------------------ payment */

/**
 * organizations.payment_config holds non-secret VietQR parameters, and nothing
 * in the schema constrains their spelling, so read both conventions rather
 * than making one office's row the standard by accident.
 *
 * `addInfo` becomes the transfer's memo, so it is the payer's own reference.
 * A statement's reference still carries the week it was issued in, and a memo
 * that changes every Monday is one nobody can save in a banking app.
 */
export function vietQrLink(
  paymentConfig: unknown,
  args: { amountMinor: number; minorUnits: number; addInfo: string },
): string | null {
  if (args.minorUnits !== 0) return null; // VietQR is dong only
  if (paymentConfig === null || typeof paymentConfig !== "object") return null;
  const cfg = paymentConfig as Record<string, unknown>;

  // The Settings screen writes the account nested under `vietqr`, because
  // shared/payment.ts keeps `note` beside the account rather than inside it.
  // Rows written by hand before that screen existed put the same fields at the
  // top level. Look in the nested object first and fall back, or an admin who
  // fills the form in gets a QR on the web bill and none from the bot.
  const nested = cfg["vietqr"];
  const acct =
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)
      : cfg;

  const bank = str(acct, "bank_bin", "bankBin", "bank_code", "bankCode", "bank");
  const account = str(acct, "account_number", "accountNumber", "account");
  if (bank === null || account === null) return null;

  const template = str(acct, "template") ?? str(cfg, "template") ?? "compact2";
  const params = new URLSearchParams();
  if (args.amountMinor > 0) params.set("amount", String(args.amountMinor));
  if (args.addInfo.trim() !== "") params.set("addInfo", args.addInfo.trim());
  const name = str(acct, "account_name", "accountName");
  if (name !== null) params.set("accountName", name);

  return `https://img.vietqr.io/image/${bank}-${account}-${template}.png?${params.toString()}`;
}

function str(cfg: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = cfg[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/* ------------------------------------------------------------------- errors */

/**
 * The bot's copy of humanError() from src/web/api.ts, which cannot be imported
 * here because that module constructs a browser Supabase client on load.
 * Kept identical on purpose and asserted identical in test/telegram.test.ts:
 * the trigger messages are written for people and both surfaces must repeat
 * them unchanged.
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
