import { useCallback, useEffect, useState } from "react";
import { fetchMe } from "./api.js";
import { signIn, signOut, supabase } from "./supabase.js";
import { useHashRoute } from "./useHashRoute.js";
import { OrdersScreen } from "./components/OrdersScreen.js";
import { AdminMenuScreen } from "./components/AdminMenuScreen.js";
import { AdminPeopleScreen } from "./components/AdminPeopleScreen.js";
import { JoinScreen } from "./components/JoinScreen.js";
import { PrefsScreen } from "./components/PrefsScreen.js";
import { TransfersScreen } from "./components/TransfersScreen.js";
import { isAdmin, type Me } from "../shared/types.js";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, go] = useHashRoute();

  const reload = useCallback(() => {
    fetchMe().then(setMe).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    reload();
    const { data } = supabase.auth.onAuthStateChange(() => reload());
    return () => data.subscription.unsubscribe();
  }, [reload]);

  if (me === undefined) return <main className="center"><p>Loading…</p></main>;

  const joinToken = route.page.startsWith("join/") ? route.page.slice(5) : null;

  if (me === null) {
    return (
      <main className="center">
        <h1>Lunch</h1>
        <p className="muted">Order lunch with your office.</p>
        <button className="btn primary" onClick={() => void signIn()}>
          Continue with Google
        </button>
      </main>
    );
  }

  if (joinToken) {
    return <JoinScreen token={joinToken} onJoined={reload} />;
  }

  // Signing in is not the same as belonging anywhere. Say so plainly rather
  // than rendering an empty app.
  if (me.orgs.length === 0) {
    return (
      <main className="center">
        <h1>No office yet</h1>
        <p className="muted">
          You're signed in as {me.email}, but you're not a member of an office yet.
          Ask your admin for an invitation link.
        </p>
        <button className="btn" onClick={() => void signOut()}>Sign out</button>
      </main>
    );
  }

  const active = me.orgs.find((o) => o.org.slug === route.slug) ?? me.orgs[0];
  if (!active) return null;
  if (route.slug !== active.org.slug) {
    go({ slug: active.org.slug, page: "orders" });
    return null;
  }

  return (
    <>
      <header className="bar">
        <strong>{active.org.name}</strong>
        <nav>
          <a href={`#/o/${active.org.slug}/orders`}
             aria-current={route.page === "orders" ? "page" : undefined}>Orders</a>
          <a href={`#/o/${active.org.slug}/transfers`}
             aria-current={route.page === "transfers" ? "page" : undefined}>Transfers</a>
          <a href={`#/o/${active.org.slug}/prefs`}
             aria-current={route.page === "prefs" ? "page" : undefined}>Preferences</a>
          {isAdmin(active.role) && (
            <>
              <a href={`#/o/${active.org.slug}/admin/menu`}
                 aria-current={route.page === "admin/menu" ? "page" : undefined}>Menu</a>
              <a href={`#/o/${active.org.slug}/admin/people`}
                 aria-current={route.page === "admin/people" ? "page" : undefined}>People</a>
            </>
          )}
        </nav>
        <button className="btn ghost" onClick={() => void signOut()}>Sign out</button>
      </header>

      <main>{renderPage(route.page, me, active, reload)}</main>
    </>
  );
}

type ActiveOrg = Me["orgs"][number];

/**
 * Chooses the screen. A separate function taking what it needs, rather than a
 * closure, so the caller's narrowing applies and nothing has to be asserted.
 */
function renderPage(page: string, me: Me, active: ActiveOrg, reload: () => void) {
  const p = page === "today" ? "orders" : page;

  if (p === "orders") {
    return <OrdersScreen me={me} org={active.org} role={active.role} />;
  }
  if (p === "transfers") {
    return <TransfersScreen me={me} org={active.org} role={active.role} />;
  }
  if (p === "prefs") {
    return (
      <PrefsScreen me={me} org={active.org} role={active.role}
                   displayName={active.displayName} onRenamed={reload} />
    );
  }
  if (p.startsWith("admin/")) {
    // The database refuses admin writes regardless of role, but a member who
    // follows an admin link deserves an explanation rather than a dead page.
    if (!isAdmin(active.role)) {
      return (
        <section>
          <h1>Not for you</h1>
          <p className="muted">That page is for admins of {active.org.name}.</p>
          <a className="btn" href={`#/o/${active.org.slug}/orders`}>Back to the board</a>
        </section>
      );
    }
    if (p === "admin/menu") return <AdminMenuScreen me={me} org={active.org} />;
    if (p === "admin/people") return <AdminPeopleScreen me={me} org={active.org} />;
  }

  // Never render an empty main: an unknown route is a wrong link, not a reason
  // to show nothing at all.
  return (
    <section>
      <h1>Nothing here</h1>
      <p className="muted">That link does not go anywhere in {active.org.name}.</p>
      <a className="btn primary" href={`#/o/${active.org.slug}/orders`}>Go to the board</a>
    </section>
  );
}
