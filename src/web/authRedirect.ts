/**
 * What survives the round trip to Google and back.
 *
 * The OAuth redirect lands on the bare origin, because that is the address the
 * provider is configured to allow. Everything after `#` is gone by then, and
 * the hash is the whole route here: an invitation link or a deep link out of a
 * chat message arrived at the sign-in page and left it for the board. So the
 * route is parked in sessionStorage, which lives as long as the tab does and
 * so outlasts the trip, and put back once somebody is signed in.
 */

const RETURN_KEY = "lunch.returnTo";

/** A route of this app, and nothing else: no tokens, no other document. */
const ROUTE = /^#\/\S+$/;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Called on the way out to Google. The bare home route is not worth keeping. */
export function rememberRoute(loc: Location = window.location): void {
  const store = storage();
  try {
    if (ROUTE.test(loc.hash) && loc.hash !== "#/home") store?.setItem(RETURN_KEY, loc.hash);
    else store?.removeItem(RETURN_KEY);
  } catch {
    // Storage refused: the person lands on their board, as before.
  }
}

/** The parked route, once. Taking it clears it, so a later reload cannot replay it. */
export function takeReturnRoute(): string | null {
  const store = storage();
  try {
    const hash = store?.getItem(RETURN_KEY) ?? null;
    store?.removeItem(RETURN_KEY);
    return hash !== null && ROUTE.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

const ERROR_KEYS = ["error", "error_code", "error_description"];

/**
 * The sentence for a sign-in that came back refused, or null when it did not.
 *
 * Supabase reports a failed OAuth round trip as `#error=...&error_description=...`
 * (or in the query, for the PKCE flow). Left in place, the router reads it as a
 * page name and the person sees a sign-in screen with no hint that anything
 * went wrong. This strips it and puts back the route they were on, so that
 * pressing the button again returns them to the same place.
 */
export function takeOAuthError(
  loc: Location = window.location,
  history: History = window.history,
): string | null {
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const query = new URLSearchParams(loc.search);
  const params = hash.has("error") ? hash : query.has("error") ? query : null;
  if (params === null) return null;

  const detail = (params.get("error_description") ?? params.get("error") ?? "").trim();
  for (const k of ERROR_KEYS) query.delete(k);
  const search = query.toString();
  const back = takeReturnRoute();
  history.replaceState(
    history.state,
    "",
    `${loc.pathname}${search === "" ? "" : `?${search}`}${back ?? "#/"}`,
  );

  if (params.get("error") === "access_denied") {
    return "Signing in with Google was cancelled. Press the button to try again.";
  }
  return detail === ""
    ? "Signing in with Google did not finish. Try again."
    : `Signing in with Google did not finish: ${detail}. Try again.`;
}
