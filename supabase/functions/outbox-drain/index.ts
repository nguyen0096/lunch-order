/**
 * The sender. notification_outbox has had a queue, a dedupe key, a backoff and
 * five attempts since the first migration, and nothing has ever drained it.
 *
 * Why the service role is the right key here, unlike in the webhook: draining a
 * queue touches no member-scoped rule. claim_outbox and settle_outbox are
 * SECURITY DEFINER and granted to nobody, so service_role is the only caller
 * they have. The rows were rendered and frozen at enqueue time by the hourly
 * tick; this function decides nothing about who owes what, only whether a
 * message reached Telegram.
 *
 * What it does NOT do is reimplement either RPC. claim_outbox owns the
 * `for update skip locked` batch and the attempt counter; settle_outbox owns
 * the 1m/3m/9m/27m/81m backoff and the failed threshold. The one thing it adds
 * is a terminal verdict, because "this chat will never exist" is not something
 * a backoff can express.
 *
 * NOT PUBLICLY INVOKABLE. Every request must carry X-Outbox-Secret matching the
 * OUTBOX_DRAIN_SECRET function secret, compared in constant time, exactly as
 * the webhook checks Telegram's header. pg_cron supplies it from Vault; see
 * supabase/migrations/20260923000000_schedule_outbox_drain.sql. The platform's
 * own JWT gate stays ON for this function, so an anonymous POST never reaches
 * this code at all.
 */
import { serviceClient } from "../_shared/userToken.ts";
import { secretsMatch } from "../_shared/secrets.ts";
import {
  editMessageText, isMessageGone, isNotModified, isPermanent, sendMessage,
  type BotFail, type TgMessage,
} from "../_shared/telegramApi.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const DRAIN_SECRET = Deno.env.get("OUTBOX_DRAIN_SECRET");

const BATCH = 20;
/** Well inside the worker's wall clock, so the finally block always runs. */
const BUDGET_MS = 50_000;
/** Longer than this and the flood wait is better served by settle_outbox's backoff. */
const MAX_INLINE_WAIT_S = 10;

type OutboxRow = {
  id: number;
  chat_id: number;
  body: string;
  parse_mode: string;
  provider_message_id: number | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!await secretsMatch(req.headers.get("X-Outbox-Secret"), DRAIN_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (BOT_TOKEN === "") return json({ error: "TELEGRAM_BOT_TOKEN is not set" }, 500);

  const admin = serviceClient();
  const { data, error } = await admin.rpc("claim_outbox", { p_limit: BATCH });
  if (error) {
    console.error("claim_outbox failed", error);
    return json({ error: "claim_failed", message: error.message }, 500);
  }

  const settle = (id: number, ok: boolean, messageId: number | null, err: string | null) =>
    admin.rpc("settle_outbox", {
      p_id: id, p_ok: ok, p_provider_message_id: messageId, p_error: err,
    });

  const claimed = (data ?? []) as OutboxRow[];
  // Anything claimed is now status='sending', and claim_outbox only ever picks
  // up 'pending'. A row left unsettled is therefore stranded for good, so the
  // queue is drained out of this list and whatever survives is settled in the
  // finally block below.
  const pending = [...claimed];
  const deadline = Date.now() + BUDGET_MS;
  let sent = 0, failed = 0, deferred = 0, flooded = false;

  try {
    while (pending.length > 0 && Date.now() < deadline && !flooded) {
      const row = pending.shift() as OutboxRow;
      const outcome = await deliver(row);

      if (outcome.ok) {
        await settle(row.id, true, outcome.messageId, null);
        sent++;
        continue;
      }

      if (outcome.fail.status === 429) {
        // Telegram's flood limit is per bot, not per chat, so the rest of this
        // batch would only make it worse. Stop and let the backoff carry them.
        flooded = true;
        await settle(row.id, false, null, describe(outcome.fail));
        deferred++;
        continue;
      }

      if (isPermanent(outcome.fail)) {
        // settle_outbox has no vocabulary for "never going to work": it would
        // sit on this row for five attempts and 121 minutes before anyone could
        // see that a member has blocked the bot. Record the error through the
        // RPC, then close it.
        await settle(row.id, false, null, describe(outcome.fail));
        await admin.from("notification_outbox")
          .update({ status: "failed" }).eq("id", row.id);
        failed++;
        continue;
      }

      await settle(row.id, false, null, describe(outcome.fail));
      deferred++;
    }
  } finally {
    for (const row of pending) {
      await settle(row.id, false, null, "drain stopped before this row was attempted");
      deferred++;
    }
  }

  return json({ claimed: claimed.length, sent, failed, deferred, flooded });
});

type Delivery =
  | { ok: true; messageId: number | null }
  | { ok: false; fail: BotFail };

async function deliver(row: OutboxRow): Promise<Delivery> {
  const opts = { parseMode: row.parse_mode };

  // provider_message_id is exactly what the column comment says it is for:
  // delivery is at-least-once, so a retry edits the message the last attempt
  // managed to post rather than posting a second copy of it.
  if (row.provider_message_id !== null) {
    const res = await editMessageText(
      BOT_TOKEN, row.chat_id, row.provider_message_id, row.body, opts,
    );
    if (res.ok) return { ok: true, messageId: idOf(res.result, row.provider_message_id) };
    // Identical text: the reader already sees what we meant to say.
    if (isNotModified(res)) return { ok: true, messageId: row.provider_message_id };
    if (!isMessageGone(res)) return { ok: false, fail: res };
    // Deleted at the other end; fall through and post it again.
  }

  const res = await sendMessage(BOT_TOKEN, row.chat_id, row.body, opts);
  if (res.ok) return { ok: true, messageId: res.result.message_id };

  const wait = res.retryAfterSeconds;
  if (res.status === 429 && wait !== null && wait <= MAX_INLINE_WAIT_S) {
    // Short flood waits are honoured where Telegram asked for them. Anything
    // longer goes back on the queue, whose smallest backoff already exceeds it.
    await new Promise((r) => setTimeout(r, wait * 1000));
    const again = await sendMessage(BOT_TOKEN, row.chat_id, row.body, opts);
    if (again.ok) return { ok: true, messageId: again.result.message_id };
    return { ok: false, fail: again };
  }

  return { ok: false, fail: res };
}

// editMessageText answers `true` rather than a Message when there is nothing
// for the caller to hold on to; the id we already had is still the right one.
function idOf(result: TgMessage | true, fallback: number): number {
  return result === true ? fallback : result.message_id;
}

function describe(f: BotFail): string {
  const wait = f.retryAfterSeconds === null ? "" : ` (retry_after ${f.retryAfterSeconds}s)`;
  return `telegram ${f.status}: ${f.description}${wait}`.slice(0, 500);
}
