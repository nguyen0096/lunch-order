/**
 * Acting AS a member, rather than acting on their behalf.
 *
 * THE PROBLEM. private.is_service() is true for service_role, and every
 * business-rule trigger in this schema opens with
 * `if private.is_service() then return ...; end if;`. A bot holding the service
 * key that writes an order for somebody therefore skips the cutoff, the menu
 * lifecycle check and the transfer consent rules outright. Re-checking those in
 * TypeScript would be a second copy of a rule that already exists in SQL, and
 * the copy would drift.
 *
 * THE FIX. Connect to Postgres directly and become the member inside a
 * transaction: `set local role authenticated`, plus the JWT claims PostgREST
 * would have set. current_user is then `authenticated`, which has no BYPASSRLS
 * and does not own the tables, is_service() is false, auth.uid() is the member,
 * and RLS and every trigger apply exactly as they do for the browser.
 *
 * WHY NOT A SIGNED TOKEN. This project signs with an ECC key whose private half
 * Supabase will not export, so nothing outside GoTrue can produce an access
 * token PostgREST trusts. And the role switch cannot be hidden inside a
 * SECURITY DEFINER function either: Postgres raises 42501, `cannot set
 * parameter "role" within security-definer function`. Top level of a
 * transaction, over a connection we hold ourselves, is the only place it works.
 *
 * WHY A CALLBACK AND NOTHING ELSE. `set local role` and set_config(..., true)
 * revert at TRANSACTION end, not at statement end. Leave a member's identity in
 * force on a pooled connection and the next query on it runs as them. So the
 * connection is module-private and asMember() is the only way to reach it as
 * somebody: there is no exported handle to forget to wrap.
 */
import postgres from "npm:postgres@3.4.9";

/**
 * SUPABASE_DB_URL is injected into every Edge Function with no configuration,
 * and on this platform it is the DIRECT connection: db.<ref>.supabase.co:5432,
 * one real Postgres backend per socket, not Supavisor. Supabase documents it as
 * "use it to connect directly to your database" and injects no pooler string at
 * all. That is survivable here only because of `max: 1` below; the moment this
 * bot is busy enough to keep many isolates warm, set LUNCH_DB_POOL_URL to the
 * transaction-mode pooler URI (port 6543) from the dashboard's Connect dialog
 * and this file needs no other change. The name cannot start with SUPABASE_:
 * the platform reserves that prefix and rejects the secret.
 */
const DB_URL = Deno.env.get("LUNCH_DB_POOL_URL") ?? Deno.env.get("SUPABASE_DB_URL");

let pool: postgres.Sql | undefined;

function db(): postgres.Sql {
  if (pool !== undefined) return pool;
  if (!DB_URL) {
    throw new Error(
      "Neither LUNCH_DB_POOL_URL nor SUPABASE_DB_URL is set, so the bot cannot " +
      "act as a member. It will not fall back to the service role.",
    );
  }
  // Host and port only, and once per isolate: enough to tell at a glance which
  // of the two endpoints this deployment actually got, and nothing more. The
  // string carries the postgres password.
  try {
    console.log("db endpoint", new URL(DB_URL).host);
  } catch { /* an unparseable URL will fail loudly on the first query anyway */ }

  pool = postgres(DB_URL, {
    // One connection per warm isolate. postgres.js defaults to 10, and the
    // number of warm isolates is not something this code controls, so the
    // default is how a webhook exhausts the database's connection slots.
    max: 1,
    // Required by transaction-mode Supavisor, which reuses a server connection
    // between statements and so cannot keep a named prepared statement alive.
    // Harmless on the direct connection, which is why it is set unconditionally.
    prepare: false,
    // Not `prefer`: that silently sends the password in plaintext if TLS fails.
    // `require` rather than `verify-full` because the direct endpoint presents
    // Supabase's own CA, which is not in Deno's trust store.
    ssl: "require",
    // A frozen isolate leaves dead sockets behind; drop them before the next
    // invocation tries to reuse one and hangs.
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      // int8 arrives as a string by default, because bigint does not fit a JS
      // number in general. Here it does: every int8 in this schema is an
      // identity id, a Telegram chat id or an amount in minor units, none of
      // which come near 2^53. Parsing them once here keeps an id from being a
      // string on one path and a number on another.
      bigint: {
        to: 20,
        from: [20],
        serialize: (n: number) => String(n),
        parse: (s: string) => Number(s),
      },
    },
  });
  return pool;
}

export type Tx = postgres.TransactionSql<Record<string, never>>;

/**
 * Run `work` as `profileId`, inside one transaction, and never outside one.
 *
 * Everything the member does in a single command belongs in a single call:
 * their identity is only in force between BEGIN and COMMIT, and splitting a
 * read and the write it decided across two calls also splits them across two
 * snapshots.
 */
export function asMember<T>(profileId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: profileId, role: "authenticated" });
  return db().begin(async (tx) => {
    await tx`set local role authenticated`;
    // auth.uid() reads request.jwt.claim.sub FIRST and only then falls back to
    // the claims object, so a stale singular key on a pooled connection would
    // outrank everything set here. Blanking it costs nothing and closes that.
    await tx`select set_config('request.jwt.claims', ${claims}, true),
                    set_config('request.jwt.claim.sub', '', true),
                    set_config('request.jwt.claim.role', '', true)`;
    return await work(tx);
  }) as unknown as Promise<T>;
}

/**
 * Run `work` as the connection's own role, which bypasses RLS.
 *
 * For work that is genuinely the system's and could not be scoped to anybody:
 * resolving a chat_id to a member, or redeeming a link token held by someone
 * who is not yet anyone. Never for a member's own action.
 */
export function asSystem<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return db().begin((tx) => work(tx)) as unknown as Promise<T>;
}

/**
 * A refusal from Postgres, as opposed to a socket that never reached it.
 *
 * The difference matters at the point where an error becomes a chat message:
 * the trigger messages are written for people and are shown verbatim, whereas
 * "connection refused" names our infrastructure at somebody who asked for lunch.
 */
export function isDatabaseError(e: unknown): e is { message: string; code: string } {
  return e instanceof postgres.PostgresError;
}
