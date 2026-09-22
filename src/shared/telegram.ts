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

/* -------------------------------------------------------- callback payloads */

export type CallbackAction =
  | { kind: "pick"; menuId: number; itemId: number }
  | { kind: "clear"; menuId: number }
  | { kind: "transfer"; transferId: number; decision: "accepted" | "declined" };

/**
 * Telegram caps callback_data at 64 bytes and returns it to us verbatim, so it
 * is a routing key and never a fact: every id decoded here is re-checked
 * against RLS before anything is written.
 */
export function encodeCallback(a: CallbackAction): string {
  switch (a.kind) {
    case "pick": return `p:${a.menuId}:${a.itemId}`;
    case "clear": return `c:${a.menuId}`;
    case "transfer": return `t:${a.transferId}:${a.decision === "accepted" ? "a" : "d"}`;
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
  if (tag === "c" && parts.length === 2) {
    const menuId = toId(parts[1]);
    return menuId === null ? null : { kind: "clear", menuId };
  }
  if (tag === "t" && parts.length === 3) {
    const transferId = toId(parts[1]);
    if (transferId === null) return null;
    if (parts[2] === "a") return { kind: "transfer", transferId, decision: "accepted" };
    if (parts[2] === "d") return { kind: "transfer", transferId, decision: "declined" };
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
  isAdmin: boolean;
  now: Date;
  timeZone: string;
}): string | null {
  const { menu } = args;
  if (menu === null) return "There's no menu for that day yet.";
  const day = formatServiceDate(menu.serviceDate);
  if (menu.status === "cancelled") return `Lunch on ${day} is cancelled.`;
  if (args.isAdmin) return null;
  if (menu.status === "draft") return `The menu for ${day} isn't published yet.`;
  if (menu.status === "locked") {
    return `Orders for ${day} are closed and have gone to the caterer.`;
  }
  if (args.now.getTime() >= Date.parse(menu.orderCutoffAt)) {
    return `Ordering for ${day} closed at ${formatCutoffIn(menu.orderCutoffAt, args.timeZone)}.`;
  }
  return null;
}

/**
 * Which day /today should talk about.
 *
 * Same intent as defaultSelectedDay() in gating.ts: the soonest day still open,
 * else the soonest day with a menu at all, so a member who asks after the
 * cutoff is told what closed rather than shown nothing.
 */
export function nextOrderableDay<T extends MenuLike>(
  menus: T[],
  args: { today: string; isAdmin: boolean; now: Date; timeZone: string },
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

/* ------------------------------------------------------------------ payment */

/**
 * organizations.payment_config holds non-secret VietQR parameters, and nothing
 * in the schema constrains their spelling, so read both conventions rather
 * than making one office's row the standard by accident.
 */
export function vietQrLink(
  paymentConfig: unknown,
  args: { amountMinor: number; minorUnits: number; addInfo: string },
): string | null {
  if (args.minorUnits !== 0) return null; // VietQR is dong only
  if (paymentConfig === null || typeof paymentConfig !== "object") return null;
  const cfg = paymentConfig as Record<string, unknown>;

  const bank = str(cfg, "bank_bin", "bankBin", "bank_code", "bankCode", "bank");
  const account = str(cfg, "account_number", "accountNumber", "account");
  if (bank === null || account === null) return null;

  const template = str(cfg, "template") ?? "compact2";
  const params = new URLSearchParams();
  if (args.amountMinor > 0) params.set("amount", String(args.amountMinor));
  if (args.addInfo.trim() !== "") params.set("addInfo", args.addInfo.trim());
  const name = str(cfg, "account_name", "accountName");
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
