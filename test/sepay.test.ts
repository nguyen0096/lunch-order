import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ambiguousAccount,
  apiKeyAccepted,
  bankInstant,
  carriesLunchRef,
  chooseMemo,
  classify,
  foldMemo,
  httpStatus,
  outcomeForInsert,
  paymentRow,
  presentedApiKey,
  responseBody,
  routeTo,
  unknownAccount,
  REF_PREFIX,
  type SePayPayload,
} from "../src/shared/sepay.js";
import { foldMemo as webFoldMemo } from "../src/web/components/payments/labels.js";

/**
 * The SePay webhook, as far as vitest can reach it.
 *
 * Deno code is unreachable from here, so everything that decides anything lives
 * in src/shared/sepay.ts and is exercised directly. The three things that can
 * only happen inside the Edge Function -- the constant-time comparison, the
 * unique constraint and the platform's JWT gate -- are pinned at the end by
 * reading the files that carry them, the way test/migrations.test.ts reads the
 * SQL it cannot run. A string assertion is weaker than an execution, and it is
 * what there is.
 */

const ROOT = join(import.meta.dirname, "..");
const ARRIVED = new Date("2026-09-22T09:00:00.000Z");

/** One real delivery, in the shape SePay's own docs print. */
function delivery(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 92704,
    gateway: "Vietcombank",
    transactionDate: "2026-09-22 11:08:33",
    accountNumber: "0123456789",
    content: "CT DEN:LUNCH39NGUY thanh toan com trua",
    description: "BankAPINotify CT DEN:LUNCH39NGUY thanh toan com trua",
    transferType: "in",
    transferAmount: 350_000,
    referenceCode: "FT26265012345",
    code: null,
    subAccount: null,
    accumulated: 12_345_678,
    ...over,
  };
}

function transferOf(payload: Record<string, unknown>) {
  const verdict = classify(payload, ARRIVED);
  if (verdict.kind !== "transfer") {
    throw new Error(`expected a transfer, got ${verdict.kind}`);
  }
  return verdict.transfer;
}

describe("a transfer that is ours", () => {
  it("reads every field the payments row needs", () => {
    const transfer = transferOf(delivery());

    expect(transfer).toMatchObject({
      providerTxnId: "92704",
      accountNumber: "0123456789",
      amountMinor: 350_000,
      memo: "CT DEN:LUNCH39NGUY thanh toan com trua",
      // 11:08:33 on the bank's clock, which is UTC+7 all year.
      receivedAt: "2026-09-22T04:08:33.000Z",
    });
  });

  it("the amount and the memo reach the row exactly as they arrived", () => {
    const payload = delivery({
      content: "  LUNCH39NGUY  tra tiền cơm  ",
      transferAmount: 12_345,
    });
    const row = paymentRow(7, transferOf(payload));

    // Not trimmed, not folded, not re-cased: the trigger folds it itself, and
    // the row is meant to say what the bank said.
    expect(row.memo).toBe("  LUNCH39NGUY  tra tiền cơm  ");
    expect(row.amount_minor).toBe(12_345);
    expect(row.org_id).toBe(7);
    expect(row.provider_txn_id).toBe("92704");
  });

  it("stores the whole payload as `raw`, because nothing else records what arrived", () => {
    const payload = delivery();
    expect(paymentRow(7, transferOf(payload)).raw).toBe(payload as SePayPayload);
  });

  it("falls back to the arrival instant when the bank's clock is unreadable", () => {
    expect(bankInstant("not a date", ARRIVED)).toBe(ARRIVED.toISOString());
    expect(bankInstant(undefined, ARRIVED)).toBe(ARRIVED.toISOString());
    expect(bankInstant("2026-09-22 11:08:33", ARRIVED)).toBe("2026-09-22T04:08:33.000Z");
  });

  it("records a reference that resolves to nobody, and says so", () => {
    // A mistyped reference is a lunch payment whose owner has to be found by
    // hand. Recording it unmatched is how the Payments screen shows it at all.
    const transfer = transferOf(delivery({ content: "LUNCH39ZZZZ" }));
    expect(transfer.memo).toBe("LUNCH39ZZZZ");

    const outcome = outcomeForInsert(transfer.providerTxnId, { id: 51, matchedStatementId: null });

    expect(outcome).toEqual({ result: "recorded", paymentId: 51, matched: false });
    expect(httpStatus(outcome)).toBe(200);
    expect(responseBody(outcome)["detail"]).toMatch(/matching no statement/);
  });

  it("says when the trigger did match one", () => {
    const outcome = outcomeForInsert("92704", { id: 51, matchedStatementId: 9 });
    expect(outcome).toEqual({ result: "recorded", paymentId: 51, matched: true });
    expect(httpStatus(outcome)).toBe(200);
  });
});

describe("a delivery that is not ours", () => {
  const ignored = (over: Record<string, unknown>) => {
    const verdict = classify(delivery(over), ARRIVED);
    if (verdict.kind !== "ignored") throw new Error(`expected ignored, got ${verdict.kind}`);
    return verdict;
  };

  it("money leaving the account is not a payment", () => {
    expect(ignored({ transferType: "out" }).reason).toBe("not_incoming");
  });

  it("a missing direction is treated as money leaving, not as money arriving", () => {
    expect(ignored({ transferType: undefined }).reason).toBe("not_incoming");
  });

  it("a non-positive amount is not a payment", () => {
    expect(ignored({ transferAmount: 0 }).reason).toBe("amount_not_positive");
    expect(ignored({ transferAmount: -5_000 }).reason).toBe("amount_not_positive");
  });

  it("an amount no integer column could hold is refused rather than retried", () => {
    expect(ignored({ transferAmount: 2_147_483_648 }).reason).toBe("amount_out_of_range");
  });

  it("a memo with no LUNCH reference is recorded nowhere at all", () => {
    // The whole point of the prefix: this is somebody's salary arriving in the
    // personal account the office also banks through.
    const verdict = ignored({
      content: "LUONG THANG 9 NGUYEN VAN A",
      description: "BankAPINotify LUONG THANG 9 NGUYEN VAN A",
    });
    expect(verdict.reason).toBe("no_lunch_reference");
  });

  it("all of these still answer 200, because SePay retries anything else", () => {
    for (const over of [
      { transferType: "out" },
      { transferAmount: 0 },
      { content: "LUONG THANG 9", description: "LUONG THANG 9" },
    ]) {
      const verdict = ignored(over);
      const outcome = { result: "ignored", reason: verdict.reason, detail: verdict.detail } as const;
      expect(httpStatus(outcome)).toBe(200);
      expect(responseBody(outcome)["success"]).toBe(true);
    }
  });

  it("an account number no office banks with is ignored, not refused", () => {
    const outcome = unknownAccount("9999999999");
    expect(outcome).toMatchObject({ result: "ignored", reason: "unknown_account" });
    expect(httpStatus(outcome)).toBe(200);
    expect(responseBody(outcome)["detail"]).toContain("9999999999");
  });

  it("an account two offices claim credits neither of them", () => {
    const outcome = ambiguousAccount("0123456789");
    expect(outcome).toMatchObject({ result: "ignored", reason: "ambiguous_account" });
    expect(httpStatus(outcome)).toBe(200);
  });

  it("a body that is not a delivery cannot be made into one by retrying", () => {
    expect(classify("not json at all", ARRIVED)).toMatchObject({ kind: "unreadable" });
    expect(classify(null, ARRIVED)).toMatchObject({ kind: "unreadable" });
    // No id means no idempotency key, and a retry would credit the money twice.
    expect(classify(delivery({ id: undefined }), ARRIVED)).toMatchObject({ kind: "unreadable" });
    expect(httpStatus({ result: "unreadable", detail: "x" })).toBe(400);
  });
});

describe("a redelivery", () => {
  it("is a 200 with nothing credited a second time", () => {
    // `on conflict do nothing` returns no row, and no row means the AFTER
    // INSERT trigger never ran, so there is nothing to un-credit.
    const outcome = outcomeForInsert("92704", null);

    expect(outcome).toEqual({ result: "duplicate", providerTxnId: "92704" });
    expect(httpStatus(outcome)).toBe(200);
    expect(responseBody(outcome)).toMatchObject({ success: true, result: "duplicate" });
  });
});

describe("the office's API key", () => {
  const SECRET = "d4f1c0b3a29e8765f0a1b2c3d4e5f6a7";
  const header = (value: string) => `Bearer Apikey ${value}`;
  /** Stands in for _shared/secrets.ts, whose comparison is the constant-time one. */
  const equal = () => vi.fn((a: string, b: string) => Promise.resolve(a === b));

  it("accepts the shape SePay's own package sends", async () => {
    expect(await apiKeyAccepted(header(SECRET), SECRET, equal())).toBe(true);
    // The dashboard will send the scheme without the Bearer prefix.
    expect(await apiKeyAccepted(`Apikey ${SECRET}`, SECRET, equal())).toBe(true);
  });

  it("refuses a wrong key", async () => {
    expect(await apiKeyAccepted(header("not-the-key"), SECRET, equal())).toBe(false);
  });

  it("refuses everybody when the office has no secret stored", async () => {
    // The left join hands null through as undefined: an office nobody has set
    // up yet is an office nobody may post payments into.
    const compare = equal();
    expect(await apiKeyAccepted(header(SECRET), undefined, compare)).toBe(false);
    expect(await apiKeyAccepted(header(SECRET), "", compare)).toBe(false);
    // Never even asked, so no comparator could be argued into a yes.
    expect(compare).not.toHaveBeenCalled();
  });

  it("checks the key of the office the delivery named, not a shared one", async () => {
    // The forgery this design exists to stop: office A's own secret must not
    // authenticate a delivery addressed to office B's account number.
    const officeA = "a".repeat(40);
    const officeB = "b".repeat(40);
    expect(await apiKeyAccepted(header(officeA), officeB, equal())).toBe(false);
    expect(await apiKeyAccepted(header(officeB), officeB, equal())).toBe(true);
  });

  it("refuses a missing or malformed Authorization header", async () => {
    for (const value of [null, undefined, "", "Bearer " + SECRET, "Apikey", "Apikey "]) {
      expect(await apiKeyAccepted(value, SECRET, equal())).toBe(false);
    }
  });

  it("takes the key and nothing else out of the header", () => {
    expect(presentedApiKey(`  Bearer Apikey ${SECRET}  `)).toBe(SECRET);
    expect(presentedApiKey(`apikey ${SECRET}`)).toBe(SECRET);
    expect(presentedApiKey(null)).toBeNull();
  });

  it("is a 401, and says nothing about how close the caller got", () => {
    const outcome = { result: "unauthorized" } as const;
    expect(httpStatus(outcome)).toBe(401);
    expect(JSON.stringify(responseBody(outcome))).not.toContain("Apikey");
  });
});

describe("folding the memo the way the database does", () => {
  /**
   * `unaccent_fallback` is a `translate()` of two hand-written strings. Reading
   * them out of the migration is the only way to assert agreement without a
   * database, and it fails loudly if either half is ever edited.
   */
  const tenancy = readFileSync(
    join(ROOT, "supabase", "migrations", "20260911100200_tenancy.sql"),
    "utf8",
  );
  const args = /translate\(p,\s*'([^']*)'\s*\|\|\s*'([^']*)',\s*'([^']*)'\s*\|\|\s*'([^']*)'\)/
    .exec(tenancy);

  it("reads the two translate() halves, so this suite cannot pass vacuously", () => {
    expect(args).not.toBeNull();
    expect((args?.[1] ?? "").length).toBeGreaterThan(50);
  });

  it("maps every character the database maps, to the same letter", () => {
    const from = `${args?.[1] ?? ""}${args?.[2] ?? ""}`;
    const to = `${args?.[3] ?? ""}${args?.[4] ?? ""}`;
    expect(from.length).toBe(to.length);

    const disagreements = [...from]
      .map((ch, i) => ({ ch, ours: foldMemo(ch), theirs: (to[i] ?? "").toUpperCase() }))
      .filter((r) => r.ours !== r.theirs);
    expect(disagreements).toEqual([]);
  });

  it("drops everything that is not a letter or a digit, and upper-cases the rest", () => {
    expect(foldMemo("CT DEN:LUNCH39NGUY - Nguyễn Văn A")).toBe("CTDENLUNCH39NGUYNGUYENVANA");
    expect(foldMemo("lunch39đức")).toBe("LUNCH39DUC");
  });

  it("is the same fold the Payments screen warns with", () => {
    for (const memo of [
      "CT DEN:LUNCH39NGUY",
      "lunch39đức",
      "Nguyễn Văn A - LUNCH40NGUY",
      "LUONG THANG 9",
      "",
    ]) {
      expect(foldMemo(memo)).toBe(webFoldMemo(memo));
    }
  });

  it("matches on containment, loosely, because a mistyped reference is the case that matters", () => {
    expect(carriesLunchRef("CT DEN:LUNCH39NGUY thanh toan")).toBe(true);
    expect(carriesLunchRef("lunch 39 nguy")).toBe(true);
    expect(carriesLunchRef("LUONG THANG 9 NGUYEN VAN A")).toBe(false);
  });

  it("records the reference the billing run actually issues", () => {
    const migration = readFileSync(
      join(ROOT, "supabase", "migrations", "20260930100300_payment_reference_starts_with_lunch.sql"),
      "utf8",
    );
    expect(migration).toContain(`'${REF_PREFIX}' || to_char(`);
  });

  it("stores whichever memo field carries the reference, so the trigger sees it too", () => {
    // Filtering on `description` and storing `content` is how a real payment
    // arrives unmatched.
    expect(chooseMemo("CHUYEN TIEN", "BankAPINotify CT DEN LUNCH39NGUY")).toBe(
      "BankAPINotify CT DEN LUNCH39NGUY",
    );
    expect(chooseMemo("LUNCH39NGUY", "BankAPINotify LUNCH39NGUY")).toBe("LUNCH39NGUY");
    expect(chooseMemo("", "only this one")).toBe("only this one");
    expect(chooseMemo(null, undefined)).toBe("");
  });
});


describe("routing, which is all that happens before a caller is authenticated", () => {
  it("reads the account number and nothing else", () => {
    expect(routeTo(delivery())).toEqual({ kind: "account", accountNumber: "0123456789" });
    // Whitespace around a pasted account number is not a different account.
    expect(routeTo(delivery({ accountNumber: " 0123456789 " })))
      .toEqual({ kind: "account", accountNumber: "0123456789" });
  });

  it("answers a body that is not a delivery without consulting anything", () => {
    expect(routeTo("nonsense")).toMatchObject({ kind: "unreadable" });
    expect(routeTo(null)).toMatchObject({ kind: "unreadable" });
  });

  it("a payload with no account number names no office to credit", () => {
    expect(routeTo(delivery({ accountNumber: undefined })))
      .toMatchObject({ kind: "ignored", reason: "no_account_number" });
  });

  it("an unknown account is a 200 that says nothing about any secret", () => {
    const outcome = unknownAccount("9999999999");
    expect(httpStatus(outcome)).toBe(200);
    const body = JSON.stringify(responseBody(outcome));
    expect(body).not.toMatch(/secret|key|unauthori/i);
  });
});

describe("what only the deployed function can carry", () => {
  const config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
  const migration = readFileSync(
    join(ROOT, "supabase", "migrations", "20260930100400_webhook_secret_per_office.sql"),
    "utf8",
  );
  // Comments stripped first, exactly as test/migrations.test.ts strips them
  // from SQL: this file's own prose discusses asMember and paid_minor, and an
  // assertion that a word is absent has to look at the code, not the argument.
  const fn = readFileSync(join(ROOT, "supabase", "functions", "sepay", "index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("is exempt from the platform's JWT gate, on purpose and in config.toml", () => {
    expect(config).toMatch(/\[functions\.sepay\]\s*\nverify_jwt = false/);
  });

  it("compares the key with the constant-time helper and never with ===", () => {
    expect(fn).toMatch(/apiKeyAccepted\([\s\S]*?secretsMatch\)/);
    expect(fn).not.toMatch(/secret\s*===|===\s*[\w.]*secret/i);
  });

  it("takes the secret from the office's row, not from the environment", () => {
    expect(fn).toContain("public.org_webhook_secrets");
    // A single shared secret is the forgery this endpoint cannot have.
    expect(fn).not.toContain("Deno.env");
  });

  // The import list names all of these too, so order is read inside the
  // handler's own body rather than across the whole file.
  const handler = fn.slice(
    fn.indexOf("async function handle("),
    fn.indexOf("async function insert("),
  );

  it("resolves the office before it authenticates anybody", () => {
    expect(handler).not.toBe("");
    expect(handler.indexOf("org_webhook_secrets")).toBeLessThan(handler.indexOf("apiKeyAccepted"));
    expect(handler.indexOf("unknownAccount(")).toBeLessThan(handler.indexOf("apiKeyAccepted"));
  });

  it("reads nothing of the transfer until the office has authenticated it", () => {
    expect(handler.indexOf("apiKeyAccepted")).toBeLessThan(handler.indexOf("classify("));
    expect(handler.indexOf("apiKeyAccepted")).toBeLessThan(handler.indexOf("insert(tx"));
  });

  it("leans on payments_provider_txn_uk for idempotency rather than a look-first check", () => {
    expect(fn).toContain("on conflict on constraint payments_provider_txn_uk do nothing");
  });

  it("does no billing arithmetic of its own", () => {
    // paid_minor, the statement status and matched_statement_id are all
    // trg_payment_apply's. A second implementation here would drift from it.
    expect(fn).not.toMatch(/paid_minor|update public\.billing_statements/);
  });

  it("acts as the system, because a webhook is nobody", () => {
    expect(fn).toContain("asSystem");
    expect(fn).not.toContain("asMember");
  });

  it("routes by the same account number the bill's QR is built from", () => {
    expect(fn).toContain("payment_config -> 'vietqr' ->> 'accountNumber'");
  });

  it("keeps the secrets table out of reach of every client", () => {
    const sql = migration.replace(/--[^\n]*/g, "");
    expect(sql).toMatch(/alter table public\.org_webhook_secrets enable row level security/);
    // RLS with no policy is the point. A policy here would be the bug.
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on public\.org_webhook_secrets from anon, authenticated/);
  });

  it("is measured, not just asserted, by the isolation probes", () => {
    const isolation = readFileSync(join(ROOT, "supabase", "tests", "isolation.sql"), "utf8");
    expect(isolation).toContain("org_webhook_secrets");
  });
});
