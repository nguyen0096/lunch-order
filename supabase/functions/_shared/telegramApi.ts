/**
 * The Bot API, and the part nobody writes until it hurts: deciding which
 * failures are worth retrying.
 *
 * A network error and a 500 are worth another go. A 429 is the flood limit and
 * carries the wait Telegram wants. "chat not found" and "bot was blocked by
 * the user" never get better, so retrying them five times only delays the
 * moment an admin finds out the member never heard from us.
 */
export type BotOk<T> = { ok: true; result: T };
export type BotFail = {
  ok: false;
  /** 0 when the request never reached Telegram. */
  status: number;
  description: string;
  retryAfterSeconds: number | null;
};
export type BotResult<T> = BotOk<T> | BotFail;

export type TgMessage = { message_id: number; chat: { id: number } };

const TIMEOUT_MS = 15_000;

export async function callBot<T>(
  token: string, method: string, payload: Record<string, unknown>,
): Promise<BotResult<T>> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, description: (e as Error).message, retryAfterSeconds: null };
  }

  const body = await res.json().catch(() => null) as {
    ok?: boolean; result?: T; description?: string;
    parameters?: { retry_after?: number };
  } | null;

  if (res.ok && body?.ok === true) return { ok: true, result: body.result as T };

  return {
    ok: false,
    status: res.status,
    description: body?.description ?? `HTTP ${res.status}`,
    retryAfterSeconds: typeof body?.parameters?.retry_after === "number"
      ? body.parameters.retry_after
      : null,
  };
}

/** Failures that will still be failures in eighty-one minutes. */
export function isPermanent(f: BotFail): boolean {
  if (f.status === 401 || f.status === 403) return true;
  if (f.status !== 400) return false;
  return /chat not found|chat_id is empty|user is deactivated|bot was blocked|bot was kicked|group chat was upgraded|PEER_ID_INVALID|not enough rights/i
    .test(f.description);
}

/** editMessageText on identical text. The reader already sees what we wanted. */
export function isNotModified(f: BotFail): boolean {
  return f.status === 400 && /message is not modified/i.test(f.description);
}

/** The message we meant to edit is gone, so send a fresh one instead. */
export function isMessageGone(f: BotFail): boolean {
  return f.status === 400 &&
    /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(f.description);
}

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export function sendMessage(
  token: string, chatId: number, text: string,
  opts: {
    parseMode?: string | null;
    keyboard?: InlineKeyboard;
    /**
     * Opens the client's reply composer on this message, so the answer comes
     * back carrying reply_to_message. That is the only thing in an update that
     * says which question it answers. It is one reply_markup field, so a forced
     * reply and a keyboard cannot both be sent.
     */
    forceReply?: { placeholder: string };
  } = {},
): Promise<BotResult<TgMessage>> {
  const markup = opts.forceReply
    ? { force_reply: true, input_field_placeholder: opts.forceReply.placeholder }
    : opts.keyboard
    ? { inline_keyboard: opts.keyboard }
    : null;
  return callBot<TgMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...parseModeOf(opts.parseMode),
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });
}

export function editMessageText(
  token: string, chatId: number, messageId: number, text: string,
  opts: { parseMode?: string | null; keyboard?: InlineKeyboard } = {},
): Promise<BotResult<TgMessage | true>> {
  return callBot<TgMessage | true>(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...parseModeOf(opts.parseMode),
    link_preview_options: { is_disabled: true },
    // Always sent, so replacing a message that had buttons with one that
    // should not clears them instead of leaving dead taps behind.
    reply_markup: { inline_keyboard: opts.keyboard ?? [] },
  });
}

/**
 * The client spins until this is answered, whatever the outcome, so every
 * path through a callback handler must reach it.
 */
export function answerCallbackQuery(
  token: string, id: string, text?: string, showAlert = false,
): Promise<BotResult<boolean>> {
  return callBot<boolean>(token, "answerCallbackQuery", {
    callback_query_id: id,
    // Telegram truncates at 200 characters and rejects nothing, so trim rather
    // than risk a database message being cut mid-word by the server.
    ...(text ? { text: text.slice(0, 200) } : {}),
    show_alert: showAlert,
  });
}

// notification_outbox.parse_mode is 'HTML' | 'MarkdownV2' | 'none', and
// Telegram has no 'none': the field is simply absent.
function parseModeOf(mode: string | null | undefined): Record<string, string> {
  return mode && mode !== "none" ? { parse_mode: mode } : {};
}
