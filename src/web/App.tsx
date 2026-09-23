import { useCallback, useEffect, useState } from "react";
import { Button, Skeleton } from "@/ui";
import { fetchMe } from "./api.js";
import { signIn, signOut, supabase } from "./supabase.js";
import { useHashRoute } from "./useHashRoute.js";
import { AppShell } from "./components/AppShell.js";
import { BillScreen } from "./components/BillScreen.js";
import { BoardScreen } from "./components/BoardScreen.js";
import { ComingSoon } from "./components/ComingSoon.js";
import { MenuScreen } from "./components/MenuScreen.js";
import { PaymentsScreen } from "./components/PaymentsScreen.js";
import { PeopleScreen } from "./components/PeopleScreen.js";
import { SettingsScreen } from "./components/SettingsScreen.js";
import { JoinScreen } from "./components/JoinScreen.js";
import { NoOfficeScreen, SignInScreen } from "./components/SignInScreen.js";
import { isAdmin, type Me, type Org } from "../shared/types.js";

/**
 * Pinned chat links and bookmarks outlive a rename, so the pages the old
 * five-tab app used still resolve. Transfers has no destination to go to: its
 * job is now an action on the board cell it concerns.
 */
const RENAMED: Record<string, string> = {
  orders: "board",
  today: "board",
  transfers: "board",
  prefs: "settings",
  "admin/menu": "menu",
  "admin/people": "people",
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route, go] = useHashRoute();

  // Awaited by the callers that need `me` to be current before they navigate,
  // which is why it returns rather than fires and forgets.
  const reload = useCallback(async () => {
    try {
      setMe(await fetchMe());
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    const { data } = supabase.auth.onAuthStateChange(() => void reload());
    return () => data.subscription.unsubscribe();
  }, [reload]);

  /**
   * A new office exists in the database and nowhere in this tab. Refetching
   * before navigating is the whole point: routing to a slug `me` has not heard
   * of sends the redirect below straight back to the old office.
   */
  async function enter(org: Org) {
    await reload();
    go({ slug: org.slug, page: "board" });
  }

  if (me === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-prose flex-col justify-center gap-3 px-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </main>
    );
  }

  const joinToken = route.page.startsWith("join/") ? route.page.slice(5) : null;

  if (me === null) return <SignInScreen onSignIn={() => void signIn()} />;
  if (joinToken) return <JoinScreen token={joinToken} onJoined={reload} />;

  // Signing in is not the same as belonging anywhere. Say so plainly rather
  // than rendering an empty app.
  if (me.orgs.length === 0) {
    return (
      <NoOfficeScreen
        email={me.email}
        onSignOut={() => void signOut()}
        onCreated={(org) => void enter(org)}
      />
    );
  }

  const active = me.orgs.find((o) => o.org.slug === route.slug) ?? me.orgs[0];
  if (!active) return null;
  if (route.slug !== active.org.slug) {
    go({ slug: active.org.slug, page: "board" });
    return null;
  }

  const page = RENAMED[route.page] ?? route.page;

  return (
    <AppShell
      org={active.org}
      role={active.role}
      offices={me.orgs}
      page={page}
      displayName={active.displayName}
      email={me.email}
      onSignOut={() => void signOut()}
      onCreated={(org) => void enter(org)}
    >
      {renderPage(page, me, active)}
    </AppShell>
  );
}

type ActiveOrg = Me["orgs"][number];

/**
 * Chooses the screen. A separate function taking what it needs, rather than a
 * closure, so the caller's narrowing applies and nothing has to be asserted.
 */
function renderPage(page: string, me: Me, active: ActiveOrg) {
  const props = { me, org: active.org, role: active.role };

  if (page === "board") return <BoardScreen {...props} />;
  if (page === "bill") return <BillScreen {...props} />;
  if (page === "settings") return <SettingsScreen {...props} />;

  if (page === "menu" || page === "people" || page === "payments") {
    // The database refuses admin writes regardless of role, but a member who
    // follows an admin link deserves an explanation rather than a dead page.
    if (!isAdmin(active.role)) {
      return (
        <ComingSoon heading="That page is for admins">
          {`Ask an admin of ${active.org.name} if you need a menu published or somebody added.`}
        </ComingSoon>
      );
    }
    if (page === "menu") return <MenuScreen {...props} />;
    if (page === "payments") return <PaymentsScreen {...props} />;
    return <PeopleScreen {...props} />;
  }

  // Never render an empty main: an unknown route is a wrong link, not a reason
  // to show nothing at all.
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-xl font-semibold">Nothing here</h1>
      <p className="text-muted">{`That link does not go anywhere in ${active.org.name}.`}</p>
      <Button asChild>
        <a href={`#/o/${active.org.slug}/board`}>Go to the board</a>
      </Button>
    </div>
  );
}
