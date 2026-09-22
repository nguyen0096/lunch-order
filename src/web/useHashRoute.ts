import { useEffect, useState } from "react";

/**
 * Routes are `#/o/<slug>/<page>`, with an optional `?query` inside the hash.
 *
 * A hash router rather than a library because the screens are flat, and
 * because hash routes never reach the server, so the static host needs no
 * rewrite rule for deep links out of a chat message.
 *
 * The hash may carry its own query string: pasting
 * `#/o/acme/orders?now=2026-09-10` is the natural thing to type, and without
 * splitting it off the page name becomes "orders?now=2026-09-10" and matches
 * nothing.
 */
export type Route = { slug: string | null; page: string; query: URLSearchParams };

function read(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const q = hash.indexOf("?");
  const path = q === -1 ? hash : hash.slice(0, q);
  const query = new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));

  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "o" && parts[1]) {
    return { slug: parts[1], page: parts.slice(2).join("/") || "board", query };
  }
  return { slug: null, page: parts.join("/") || "home", query };
}

export function useHashRoute(): [Route, (r: { slug: string | null; page: string }) => void] {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (r: { slug: string | null; page: string }) => {
    window.location.hash = r.slug ? `#/o/${r.slug}/${r.page}` : `#/${r.page}`;
  };
  return [route, go];
}

/**
 * Everything after `?`, whether it sits before or inside the hash. Both forms
 * occur in practice: `/?now=X#/o/a/orders` is what a purist writes,
 * `#/o/a/orders?now=X` is what anyone actually types.
 */
export function allParams(loc: Location = window.location): URLSearchParams {
  const out = new URLSearchParams(loc.search);
  const hash = loc.hash;
  const q = hash.indexOf("?");
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(hash.slice(q + 1))) out.set(k, v);
  }
  return out;
}
