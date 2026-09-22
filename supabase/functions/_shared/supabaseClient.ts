/**
 * The two Supabase clients an Edge Function here is allowed to build.
 *
 * Neither of them touches a member's own data. Domain reads and writes go
 * through _shared/db.ts, as the member, so RLS and the triggers apply; these
 * cover the two jobs that are the system's rather than anybody's.
 *
 * Both key names exist in two generations on this platform. The JSON bags
 * (SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS) are the current form and
 * the bare names are the legacy JWT keys, which are disabled per project
 * whenever an operator decides to. Reading both means that switch is not a
 * deployment.
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } };

function projectUrl(): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url;
}

function key(bagName: string, legacyName: string): string {
  const bag = Deno.env.get(bagName);
  if (bag) {
    const parsed = JSON.parse(bag) as Record<string, string>;
    const value = parsed["default"] ?? Object.values(parsed)[0];
    if (value) return value;
  }
  const legacy = Deno.env.get(legacyName);
  if (!legacy) throw new Error(`Neither ${bagName} nor ${legacyName} is set`);
  return legacy;
}

/** Bypasses RLS entirely. Only for draining the outbox. */
export function serviceClient(): SupabaseClient {
  return createClient(
    projectUrl(),
    key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
    OPTIONS,
  );
}

/**
 * A signed-out client for creating an account, and deliberately a new one per
 * call. signInAnonymously() stores the session on the client it was called on,
 * and an isolate stays warm across invocations, so a shared instance would
 * carry one person's brand-new session into the next person's signup.
 */
export function signedOutClient(): SupabaseClient {
  return createClient(
    projectUrl(),
    key("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
    OPTIONS,
  );
}
