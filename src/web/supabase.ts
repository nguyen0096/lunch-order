import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * Non-null when the app cannot start. Returned rather than thrown: a throw
 * during module evaluation means React never mounts and the user gets a blank
 * page with the reason only in the console. main.tsx renders this instead.
 */
export const configError: string | null =
  !url || !key
    ? "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. " +
      "Copy .env.example to .env in the repo root, then restart the dev server " +
      "(Vite only reads .env at startup)."
    : null;

// Only the publishable key ever reaches the browser. Every read and write is
// governed by org-scoped RLS; there is no service-role key in this bundle and
// there must never be one -- Vite inlines any VITE_* variable into the output.
export const supabase = createClient(url ?? "http://invalid.local", key ?? "invalid");

export function signIn(): Promise<unknown> {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
}

export function signOut(): Promise<unknown> {
  return supabase.auth.signOut();
}
