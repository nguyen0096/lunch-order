/**
 * Acting AS a member, rather than acting on their behalf.
 *
 * THE PROBLEM. private.is_service() is true for service_role, and every
 * business-rule trigger in this schema opens with
 * `if private.is_service() then return ...; end if;`. So an Edge Function
 * holding the service-role key that writes an order for a member skips the
 * cutoff, the menu lifecycle check and the transfer consent rules outright.
 * Re-checking those in TypeScript would be a second copy of a rule that
 * already exists in SQL, and the copy would drift.
 *
 * THE FIX. Resolve chat_id -> telegram_links -> memberships -> profile_id with
 * the service-role key, which is a legitimate service concern, then mint a
 * short-lived HS256 access token for that profile and do every domain write
 * through a client carrying it. current_user is then `authenticated`,
 * is_service() is false, auth.uid() is the member, and RLS plus every trigger
 * apply exactly as they do for the browser.
 *
 * WHAT THIS DEPENDS ON. LUNCH_JWT_SECRET must be the project's currently
 * trusted HS256 JWT secret (Settings -> API -> JWT Settings, or the shared
 * secret signing key). Supabase reserves the SUPABASE_ prefix for its own
 * function secrets, which is why this one is not called SUPABASE_JWT_SECRET.
 *
 * HOW IT FAILS. If the project rotates to an asymmetric signing key and
 * revokes the legacy secret, PostgREST stops trusting these tokens and every
 * member-scoped call returns 401. That is loud, total and safe: the bot
 * refuses to write rather than quietly falling back to service_role, which
 * would be the bypass this file exists to prevent. Supabase does not let you
 * extract an asymmetric private key, so the fix at that point is to point
 * LUNCH_JWT_SECRET at a shared-secret signing key, not to sign with the new one.
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Two minutes, because the token lives only for the length of one webhook
 * handler. A leaked copy in a log is then worthless almost immediately.
 */
const TTL_SECONDS = 120;

export async function mintUserToken(args: {
  secret: string;
  profileId: string;
  issuer: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  // Shaped like a GoTrue access token. `sub` is what auth.uid() reads and
  // `role` is what PostgREST uses to SET ROLE, so those two are load-bearing;
  // the rest is there so nothing downstream is surprised by its absence.
  const claims = {
    iss: args.issuer,
    sub: args.profileId,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + TTL_SECONDS,
    app_metadata: {},
    user_metadata: {},
    is_anonymous: false,
  };
  const signingInput =
    `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(args.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** A client that PostgREST sees as the member, not as the bot. */
export async function memberClient(profileId: string): Promise<SupabaseClient> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const secret = Deno.env.get("LUNCH_JWT_SECRET");
  if (!secret) {
    throw new Error(
      "LUNCH_JWT_SECRET is not set, so the bot cannot act as a member. " +
      "It will not fall back to the service role.",
    );
  }
  const token = await mintUserToken({ secret, profileId, issuer: `${url}/auth/v1` });
  return createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
