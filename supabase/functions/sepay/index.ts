/**
 * The SePay webhook: a bank transfer becoming a recorded payment.
 *
 * NOT BEHIND THE PLATFORM'S JWT GATE. SePay holds no Supabase key and has
 * nowhere to put one, so supabase/config.toml sets verify_jwt = false for this
 * function. The `Authorization: Bearer Apikey <secret>` check below is
 * therefore the only thing standing in front of an endpoint that writes money
 * into the database, which is why it is compared in constant time and why an
 * office with no secret stored refuses every delivery addressed to it.
 *
 * THE SECRET BELONGS TO THE OFFICE, NOT TO THIS FUNCTION. One secret in the
 * environment would be a forgery hole: this endpoint routes by the
 * accountNumber in the payload, so whoever held that one secret could address a
 * delivery to ANY office, with a provider_txn_id they invented, and
 * trg_payment_apply would credit a statement in books they cannot otherwise
 * touch. So the delivery is routed first and then checked against the secret
 * belonging to the office it was addressed to. See
 * supabase/migrations/20260930100400_webhook_secret_per_office.sql.
 *
 * The cost of that ordering, stated rather than hidden: an unauthenticated
 * caller can tell a known account number (401) from an unknown one (200), and
 * an unauthenticated POST reaches one indexed SELECT. Nothing is written and no
 * secret is consulted before the account resolves, and the alternative --
 * checking one shared secret first -- is the hole above.
 *
 * IT ACTS AS THE SYSTEM, not as a person. A webhook is nobody: there is no
 * member whose RLS or triggers should apply, and the three things it does --
 * finding an office by its bank account, reading that office's secret, and
 * recording money that arrived -- belong to no one member. asSystem, not
 * asMember. The secrets table has RLS on and no policy at all, so the owner
 * connection asSystem holds is the only thing in this system that can read it.
 *
 * IT DOES NO BILLING ARITHMETIC. `trg_payment_apply` fires AFTER INSERT on
 * payments, finds the statement whose payment_ref the memo contains, credits it
 * and recomputes the status. This function inserts a row and reads back what
 * the trigger decided. The database is the authority on what matched what, here
 * exactly as it is for a payment an admin records by hand.
 *
 * EVERY DELIVERY IT UNDERSTOOD GETS A 200, including the ones it deliberately
 * threw away, because SePay retries up to seven times over about 33 minutes
 * until it sees one. A non-200 is a request for those retries and nothing else.
 *
 * The decisions all live in src/shared/sepay.ts, imported by path rather than
 * through a _shared pointer because this is the only file that needs them.
 * Deno resolves specifiers literally, which is why that import ends in .ts.
 */
import { asSystem, isDatabaseError, type Tx } from "../_shared/db.ts";
import { secretsMatch } from "../_shared/secrets.ts";
import {
  ambiguousAccount,
  apiKeyAccepted,
  classify,
  httpStatus,
  outcomeForInsert,
  paymentRow,
  responseBody,
  routeTo,
  unknownAccount,
  type IncomingTransfer,
  type Outcome,
} from "../../../src/shared/sepay.ts";

function reply(outcome: Outcome): Response {
  return new Response(JSON.stringify(responseBody(outcome)), {
    status: httpStatus(outcome),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ result: "method_not_allowed" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return reply({ result: "unreadable", detail: "body is not JSON" });
  }

  // Only the account number is read before anybody is authenticated, because
  // which secret applies is a function of it.
  const route = routeTo(raw);
  if (route.kind === "unreadable") {
    console.error("sepay delivery unreadable:", route.detail);
    return reply({ result: "unreadable", detail: route.detail });
  }
  if (route.kind === "ignored") {
    console.log("sepay ignored:", route.reason, "-", route.detail);
    return reply({ result: "ignored", reason: route.reason, detail: route.detail });
  }

  try {
    return reply(await handle(route.accountNumber, req.headers.get("Authorization"), raw));
  } catch (e) {
    // Ours, not theirs: the database was unreachable or refused the write. This
    // is the one case where a retry is worth having, so it is the one case that
    // answers 500.
    console.error("sepay could not record a transfer", e);
    const detail = isDatabaseError(e) ? `database refused the write: ${e.code}` : "could not record";
    return reply({ result: "failed", detail });
  }
});

async function handle(
  accountNumber: string,
  authorization: string | null,
  raw: unknown,
): Promise<Outcome> {
  return await asSystem(async (tx) => {
    // The office's account lives in the same jsonb the bill's QR is built from,
    // so the account a payer scanned is the account that routes their transfer.
    // btrim on both sides because payment_config has no database-side shape and
    // a pasted account number carries whatever the clipboard had.
    const orgs = await tx<Array<{ id: number; secret: string | null }>>`
      select o.id, s.secret
        from public.organizations o
        left join public.org_webhook_secrets s on s.org_id = o.id
       where btrim(o.payment_config -> 'vietqr' ->> 'accountNumber') = ${accountNumber}
       order by o.id
       limit 2`;

    // Money into an account this app does not know is not an error, and a
    // non-200 would only buy six more deliveries of it. No secret exists to
    // check here, so the answer cannot say anything about one either.
    if (orgs.length === 0) return unknownAccount(accountNumber);
    const org = orgs[0];
    if (org === undefined || orgs.length > 1) {
      console.error("sepay: account number claimed by more than one org");
      return ambiguousAccount(accountNumber);
    }

    // A LEFT JOIN, so an office that has never been given a secret arrives here
    // with null and is refused. An unconfigured office has to fail closed: the
    // alternative is an office anybody may post payments into.
    if (!await apiKeyAccepted(authorization, org.secret ?? undefined, secretsMatch)) {
      console.error("sepay: rejected a delivery addressed to org", org.id);
      return { result: "unauthorized" };
    }

    // Everything past this point is on behalf of an authenticated office.
    const verdict = classify(raw, new Date());
    if (verdict.kind === "unreadable") {
      console.error("sepay delivery unreadable:", verdict.detail);
      return { result: "unreadable", detail: verdict.detail };
    }
    if (verdict.kind === "ignored") {
      // Ignored on purpose, and said out loud: a payment that should have
      // landed and did not is otherwise indistinguishable from one that was
      // never sent.
      console.log("sepay ignored:", verdict.reason, "-", verdict.detail);
      return { result: "ignored", reason: verdict.reason, detail: verdict.detail };
    }

    return await insert(tx, org.id, verdict.transfer);
  });
}

async function insert(tx: Tx, orgId: number, transfer: IncomingTransfer): Promise<Outcome> {
  const row = paymentRow(orgId, transfer);

  // `raw` is serialised here rather than through sql.json(): the payload is
  // read as unknown on purpose, and postgres.js's json helper wants a value
  // already proven to be JSON. The cast says what the column is either way.
  //
  // Idempotency is the constraint's job, not a check of ours. A SELECT first
  // would leave a window between the look and the insert, and SePay's retries
  // are exactly the traffic that would find it -- two deliveries in flight at
  // once credit the money twice. ON CONFLICT DO NOTHING closes that inside one
  // statement, and because no row is inserted the AFTER INSERT trigger never
  // runs, so a redelivery cannot credit anything a second time.
  const inserted = await tx<Array<{ id: number }>>`
    insert into public.payments
           (org_id, provider_txn_id, amount_minor, memo, received_at, raw)
    values (${row.org_id}, ${row.provider_txn_id}, ${row.amount_minor},
            ${row.memo}, ${row.received_at}, ${JSON.stringify(row.raw)}::jsonb)
    on conflict on constraint payments_provider_txn_uk do nothing
    returning id`;

  const first = inserted[0];
  if (first === undefined) return outcomeForInsert(row.provider_txn_id, null);

  // Read back rather than RETURNING matched_statement_id: RETURNING is
  // evaluated before AFTER triggers run, so it would say null however the
  // trigger went. Same reason as recordPayment() in src/web/api/billing.ts.
  const applied = await tx<Array<{ matched_statement_id: number | null }>>`
    select p.matched_statement_id from public.payments p where p.id = ${first.id}`;

  // Ids and the amount only. The memo is somebody's transfer.
  console.log("sepay recorded", first.id, "org", orgId, "amount", row.amount_minor);
  return outcomeForInsert(row.provider_txn_id, {
    id: first.id,
    matchedStatementId: applied[0]?.matched_statement_id ?? null,
  });
}
