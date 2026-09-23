/**
 * What a SePay delivery means, decided without touching a database.
 *
 * Everything here is pure and import-free, for two reasons. The Edge Function
 * reaches this file by relative path and Deno resolves specifiers literally, so
 * an import of `./types.js` here would be a file that does not exist on disk.
 * And vitest cannot load Deno code at all, so anything worth a test has to live
 * on this side of the line: supabase/functions/sepay/index.ts is the adapter
 * that supplies a request, a clock and a transaction, and nothing else.
 *
 * SePay retries a delivery up to seven times over about 33 minutes until it
 * gets a 200, which is why so much of this file is about answering 200 to
 * things it has deliberately thrown away.
 *
 * Reading a delivery is two steps rather than one on purpose. routeTo() reads
 * the account number, which says whose secret applies; classify() reads the
 * rest, and only runs once that secret has matched.
 */

/* ------------------------------------------------------------------- the payload */

/**
 * The fields SePay's webhook sends, as their docs and their Laravel package
 * describe them. Read defensively rather than declared as a contract: this is
 * somebody else's JSON arriving over the network, and the one thing that must
 * not happen is a shape change turning into a 500 and seven retries.
 */
export type SePayPayload = {
  /** SePay's own transaction id, and the whole of our idempotency key. */
  id?: unknown;
  gateway?: unknown;
  /** "2024-07-02 11:08:33", on the bank's clock. */
  transactionDate?: unknown;
  accountNumber?: unknown;
  /** The transfer memo. `content` is the parsed memo, `description` the whole line. */
  content?: unknown;
  description?: unknown;
  /** "in" or "out". */
  transferType?: unknown;
  transferAmount?: unknown;
  referenceCode?: unknown;
  code?: unknown;
  subAccount?: unknown;
  accumulated?: unknown;
};

/** `payments.amount_minor` is `integer`, and 2.1 billion VND is not a lunch. */
export const AMOUNT_MINOR_MAX = 2_147_483_647;

/**
 * Vietnam keeps UTC+7 all year and SePay serves Vietnamese banks only, so the
 * bank's wall clock converts to an instant without a zone database.
 */
const BANK_OFFSET = "+07:00";

/* --------------------------------------------------------------- authentication */

/**
 * The key out of `Authorization: Bearer Apikey <secret>`.
 *
 * The Bearer prefix is optional because SePay's dashboard will send the Apikey
 * scheme with or without it depending on how the webhook was configured. Which
 * scheme was used decides nothing; the secret still has to match.
 */
export function presentedApiKey(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^\s*(?:Bearer\s+)?Apikey\s+(\S.*?)\s*$/i.exec(header);
  const token = match?.[1];
  return token === undefined || token === "" ? null : token;
}

/**
 * Whether this delivery may write to the office it is addressed to, given that
 * office's secret and a way to compare two secrets without leaking how close
 * the caller got.
 *
 * `expected` is per office, never per deployment. One shared secret and a
 * handler that routes by account number is a forgery hole: every office holding
 * it could address a delivery to any other. See the migration that gives each
 * office its own, 20260930100400_webhook_secret_per_office.sql.
 *
 * `equal` is passed in rather than implemented here: the constant-time compare
 * already exists once, in supabase/functions/_shared/secrets.ts, and a second
 * copy is a second thing to get wrong. Taking it as an argument is also the
 * only way this decision is reachable from vitest at all.
 *
 * An office with no secret stored refuses everybody, and does so before `equal`
 * is called, so there is no shape of comparator that could make an unconfigured
 * office admit anyone.
 */
export async function apiKeyAccepted(
  header: string | null | undefined,
  expected: string | undefined,
  equal: (given: string, expected: string) => Promise<boolean>,
): Promise<boolean> {
  const given = presentedApiKey(header);
  if (given === null || expected === undefined || expected === "") return false;
  return await equal(given, expected);
}

/* ------------------------------------------------------------------- the memo */

/** Every reference the billing run issues starts with this. */
export const REF_PREFIX = "LUNCH";

/**
 * The memo as `trg_payment_apply` will see it: upper case, accents folded, and
 * nothing left but A-Z0-9.
 *
 * The same spelling as `foldMemo` in src/web/components/payments/labels.ts, and
 * test/sepay.test.ts holds the two to each other. The database remains the
 * authority on what matches what; this exists only to decide whether a transfer
 * is addressed to this app at all.
 */
export function foldMemo(memo: string): string {
  return memo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/**
 * Whether this memo is addressed to us at all.
 *
 * Deliberately loose: containment of LUNCH, not the shape of a whole reference.
 * A memo reading LUNCH9NGUY is a lunch payment with a mistyped week, and the
 * point of recording it unmatched is that an admin can then find it. A stricter
 * pattern here would silently drop exactly the payments somebody has to chase.
 *
 * The prefix is what keeps an office that banks through somebody's personal
 * account out of this app: a salary and a private transfer never carry it.
 */
export function carriesLunchRef(memo: string): boolean {
  return foldMemo(memo).includes(REF_PREFIX);
}

/**
 * Which of the two memo fields to record.
 *
 * `content` is the parsed memo and `description` the whole bank line, and the
 * reference can be in either. Whichever one is stored is the one the trigger
 * matches on, so it is the one checked for a reference here: filtering on one
 * field and storing another is how a real payment arrives unmatched.
 *
 * Never trimmed. What the bank sent is what the row should say.
 */
export function chooseMemo(content: unknown, description: unknown): string {
  const first = typeof content === "string" ? content : "";
  const second = typeof description === "string" ? description : "";
  if (carriesLunchRef(first)) return first;
  if (carriesLunchRef(second)) return second;
  return first.trim() !== "" ? first : second;
}

/* ------------------------------------------------------------------ classifying */

/** A delivery we are going to record, with every field a column wants. */
export type IncomingTransfer = {
  providerTxnId: string;
  accountNumber: string;
  amountMinor: number;
  memo: string;
  /** An instant, ISO 8601. */
  receivedAt: string;
  /** The entire payload, because it is the only record of what actually arrived. */
  raw: SePayPayload;
};

export type IgnoreReason =
  | "not_incoming"
  | "amount_not_positive"
  | "amount_out_of_range"
  | "no_lunch_reference"
  | "no_account_number"
  | "unknown_account"
  | "ambiguous_account";

export type Verdict =
  | { kind: "unreadable"; detail: string }
  | { kind: "ignored"; reason: IgnoreReason; detail: string }
  | { kind: "transfer"; transfer: IncomingTransfer };

export type Route =
  | { kind: "unreadable"; detail: string }
  | { kind: "ignored"; reason: IgnoreReason; detail: string }
  | { kind: "account"; accountNumber: string };

/**
 * The one field that has to be read before anybody is authenticated: which
 * office this delivery is addressed to, and therefore whose secret decides
 * whether it is genuine.
 *
 * Kept apart from classify() so the function can do this much, and only this
 * much, unauthenticated. No transfer is read, nothing is recorded, and an
 * account number belonging to no office is answered without a secret being
 * consulted at all.
 */
export function routeTo(raw: unknown): Route {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "unreadable", detail: "body is not a JSON object" };
  }
  const accountNumber = typeof (raw as SePayPayload).accountNumber === "string"
    ? ((raw as SePayPayload).accountNumber as string).trim()
    : "";
  if (accountNumber === "") {
    return {
      kind: "ignored",
      reason: "no_account_number",
      detail: "no accountNumber, so there is no office to credit",
    };
  }
  return { kind: "account", accountNumber };
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Caller-supplied text going into a log line or a response body. */
function clip(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/**
 * Read one delivery and say what it is.
 *
 * `arrivedAt` is only a fallback for `received_at`: the bank's own clock is the
 * better answer and is used whenever it parses.
 */
export function classify(raw: unknown, arrivedAt: Date): Verdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "unreadable", detail: "body is not a JSON object" };
  }
  const payload = raw as SePayPayload;

  // No id, no idempotency key, and a retry of this delivery would credit the
  // money a second time. Refusing is the only safe answer, and a 400 in SePay's
  // delivery log is the only place a payload change would ever show.
  const id = asNumber(payload.id);
  if (id === null || !Number.isInteger(id)) {
    return { kind: "unreadable", detail: "no integer `id` to be idempotent on" };
  }

  // Missing rather than "out" is still not money arriving. Crediting a transfer
  // we cannot prove came in is the one mistake with no way back.
  const direction = typeof payload.transferType === "string"
    ? payload.transferType.trim().toLowerCase()
    : "";
  if (direction !== "in") {
    return {
      kind: "ignored",
      reason: "not_incoming",
      detail: `transferType is ${direction === "" ? "absent" : clip(direction)}, not "in"`,
    };
  }

  const amount = asNumber(payload.transferAmount);
  if (amount === null || !Number.isInteger(amount) || amount <= 0) {
    return {
      kind: "ignored",
      reason: "amount_not_positive",
      detail: "transferAmount is not a positive whole number of minor units",
    };
  }
  // A 500 here would be retried seven times and fail seven times, because
  // amount_minor is an integer column and this number will never fit it.
  if (amount > AMOUNT_MINOR_MAX) {
    return {
      kind: "ignored",
      reason: "amount_out_of_range",
      detail: `transferAmount ${amount} exceeds payments.amount_minor`,
    };
  }

  const memo = chooseMemo(payload.content, payload.description);
  if (!carriesLunchRef(memo)) {
    return {
      kind: "ignored",
      reason: "no_lunch_reference",
      detail: `memo carries no ${REF_PREFIX} reference, so it is not a lunch payment`,
    };
  }

  const accountNumber = typeof payload.accountNumber === "string"
    ? payload.accountNumber.trim()
    : "";
  if (accountNumber === "") {
    return {
      kind: "ignored",
      reason: "no_account_number",
      detail: "no accountNumber, so there is no office to credit",
    };
  }

  return {
    kind: "transfer",
    transfer: {
      providerTxnId: String(id),
      accountNumber,
      amountMinor: amount,
      memo,
      receivedAt: bankInstant(payload.transactionDate, arrivedAt),
      raw: payload,
    },
  };
}

/**
 * The bank's wall clock as an instant, falling back to when the delivery
 * arrived. A payment with an unreadable timestamp is still a payment, and
 * `payments.received_at` is NOT NULL.
 */
export function bankInstant(transactionDate: unknown, arrivedAt: Date): string {
  if (typeof transactionDate === "string") {
    const [, day, time] = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/
      .exec(transactionDate.trim()) ?? [];
    if (day !== undefined && time !== undefined) {
      const at = new Date(`${day}T${time}${BANK_OFFSET}`);
      if (!Number.isNaN(at.getTime())) return at.toISOString();
    }
  }
  return arrivedAt.toISOString();
}

/* ---------------------------------------------------------------------- the row */

/**
 * Exactly what goes into `payments`, named as the columns are.
 *
 * `provider` is not here: the column defaults to 'sepay', which is also what
 * `payments_provider_txn_uk` keys on, and one name in one place cannot drift.
 * `matched_statement_id`, `paid_minor` and the statement's status are all the
 * trigger's business; nothing in this repo computes them twice.
 */
export type PaymentRow = {
  org_id: number;
  provider_txn_id: string;
  amount_minor: number;
  memo: string;
  received_at: string;
  raw: SePayPayload;
};

export function paymentRow(orgId: number, transfer: IncomingTransfer): PaymentRow {
  return {
    org_id: orgId,
    provider_txn_id: transfer.providerTxnId,
    amount_minor: transfer.amountMinor,
    memo: transfer.memo,
    received_at: transfer.receivedAt,
    raw: transfer.raw,
  };
}

/* ------------------------------------------------------------------- the answer */

export type Outcome =
  | { result: "recorded"; paymentId: number; matched: boolean }
  | { result: "duplicate"; providerTxnId: string }
  | { result: "ignored"; reason: IgnoreReason; detail: string }
  | { result: "unauthorized" }
  | { result: "method_not_allowed" }
  | { result: "unreadable"; detail: string }
  | { result: "failed"; detail: string };

/**
 * 200 for everything we handled, including everything we handled by throwing it
 * away. A non-200 is a request to try again, so only a failure of ours earns
 * one; the 400s are for a body that is not a delivery we can identify, which no
 * amount of retrying will change but which should be visible in their log.
 */
export function httpStatus(outcome: Outcome): number {
  switch (outcome.result) {
    case "unauthorized": return 401;
    case "method_not_allowed": return 405;
    case "unreadable": return 400;
    case "failed": return 500;
    default: return 200;
  }
}

/**
 * The body, for a developer reading a delivery log. `success` is what SePay's
 * own examples answer with; everything beside it says which case this was.
 */
export function responseBody(outcome: Outcome): Record<string, unknown> {
  const success = httpStatus(outcome) === 200;
  switch (outcome.result) {
    case "recorded":
      return {
        success,
        result: outcome.result,
        paymentId: outcome.paymentId,
        matched: outcome.matched,
        detail: outcome.matched
          ? "recorded and applied to the statement its reference names"
          : "recorded, matching no statement: an admin reconciles it by hand",
      };
    case "duplicate":
      return {
        success,
        result: outcome.result,
        providerTxnId: outcome.providerTxnId,
        detail: "already recorded by an earlier delivery, credited once",
      };
    case "ignored":
      return { success, result: outcome.result, reason: outcome.reason, detail: outcome.detail };
    case "unauthorized":
      return { success, result: outcome.result, detail: "Authorization does not carry the API key" };
    case "method_not_allowed":
      return { success, result: outcome.result, detail: "POST only" };
    case "unreadable":
    case "failed":
      return { success, result: outcome.result, detail: outcome.detail };
  }
}

/**
 * What an insert that may have hit `payments_provider_txn_uk` means.
 *
 * No row back means `on conflict do nothing` swallowed a redelivery: the row
 * was already there, the AFTER INSERT trigger never fired a second time, and
 * nothing was credited twice. From SePay's side that is a delivery that landed,
 * so it is a 200 and not a 500 that would bring the other six retries.
 */
export function outcomeForInsert(
  providerTxnId: string,
  inserted: { id: number; matchedStatementId: number | null } | null,
): Outcome {
  return inserted === null
    ? { result: "duplicate", providerTxnId }
    : {
      result: "recorded",
      paymentId: inserted.id,
      matched: inserted.matchedStatementId !== null,
    };
}

/** No office banks with this account: not an error, and not ours to record. */
export function unknownAccount(accountNumber: string): Outcome {
  return {
    result: "ignored",
    reason: "unknown_account",
    detail: `no office banks with account ${clip(accountNumber)}`,
  };
}

/**
 * Two offices claiming one account number. Recording it would credit one of
 * them arbitrarily, and there is no way to tell which is right from here.
 */
export function ambiguousAccount(accountNumber: string): Outcome {
  return {
    result: "ignored",
    reason: "ambiguous_account",
    detail: `more than one office banks with account ${clip(accountNumber)}`,
  };
}
