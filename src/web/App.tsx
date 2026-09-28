import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, Skeleton } from "@/ui";
import { fetchMe, humanError } from "./api.js";
import { signIn, signOut, supabase } from "./supabase.js";
import { takeReturnRoute } from "./authRedirect.js";
import { replaceHash, useHashRoute } from "./useHashRoute.js";
import { AppShell } from "./components/AppShell.js";
import { BillScreen } from "./components/BillScreen.js";
import { BoardScreen } from "./components/BoardScreen.js";
import { BugReportsScreen } from "./components/BugReportsScreen.js";
import { ComingSoon } from "./components/ComingSoon.js";
import { CorrectionsScreen } from "./components/CorrectionsScreen.js";
import { MenuScreen } from "./components/MenuScreen.js";
import { MessagesScreen } from "./components/MessagesScreen.js";
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

export function App({ oauthError = null }: { oauthError?: string | null }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [route, go] = useHashRoute();

  // Awaited by the callers that need `me` to be current before they navigate,
  // which is why it returns rather than fires and forgets.
  const reload = useCallback(async () => {
    try {
      const next = await fetchMe();
      // Restored before `me` lands, so the first signed-in render is already
      // the invitation or the deep link the person signed in from.
      if (next !== null) {
        const back = takeReturnRoute();
        if (back !== null) replaceHash(back);
      }
      setMe(next);
      setLoadError(null);
    } catch (e) {
      // `me` stays as it was. A failed first read is an error with a retry,
      // never the sign-in page, and a failed refresh keeps the app on screen.
      setLoadError(humanError(e));
    }
  }, []);

  /**
   * `me` follows the signed-in user, not the auth event stream. supabase-js
   * emits SIGNED_IN whenever the tab regains focus and TOKEN_REFRESHED every
   * hour, and refetching on each would rebuild every screen's props under
   * whatever somebody is halfway through typing.
   */
  const userId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    void reload();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const id = session?.user.id ?? null;
      const known = userId.current;
      userId.current = id;
      // INITIAL_SESSION is the session the load above is already reading.
      if (event === "INITIAL_SESSION" || id === known) return;
      // Deferred: supabase-js holds its auth lock while this callback runs,
      // and `fetchMe` calls back into the client.
      setTimeout(() => void reload(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [reload]);

  const joinToken = route.page.startsWith("join/") ? route.page.slice(5) : null;
  const active = me ? (me.orgs.find((o) => o.org.slug === route.slug) ?? me.orgs[0]) : undefined;
  const redirectTo =
    active && joinToken === null && route.slug !== active.org.slug ? active.org.slug : null;

  // Replaced, not pushed: a pushed entry is one that Back lands on and bounces off.
  useEffect(() => {
    if (redirectTo !== null) go({ slug: redirectTo, page: "board" }, { replace: true });
  }, [redirectTo, go]);

  /**
   * A new office exists in the database and nowhere in this tab. Refetching
   * before navigating is the whole point: routing to a slug `me` has not heard
   * of sends the redirect below straight back to the old office.
   */
  async function enter(org: Org) {
    await enterSlug(org.slug);
  }

  // Refetch before routing, always. `me` is what App resolves a slug against,
  // and an office it has never heard of sends you back to your first one --
  // so joining and then navigating would bounce you straight home, looking as
  // though nothing had happened.
  async function enterSlug(slug: string) {
    await reload();
    go({ slug, page: "board" });
  }

  if (me === undefined) {
    if (loadError !== null) {
      return (
        <main className="mx-auto flex min-h-dvh max-w-prose flex-col justify-center px-6">
          <EmptyState
            heading="Lunch did not load"
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setLoadError(null);
                  void reload();
                }}
              >
                Try again
              </Button>
            }
          >
            {loadError}
          </EmptyState>
        </main>
      );
    }
    return (
      <main className="mx-auto flex min-h-dvh max-w-prose flex-col justify-center gap-3 px-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </main>
    );
  }

  if (me === null) return <SignInScreen notice={oauthError} onSignIn={() => void signIn()} />;
  if (joinToken) return <JoinScreen token={joinToken} onJoined={reload} />;

  // Signing in is not the same as belonging anywhere. Say so plainly rather
  // than rendering an empty app.
  if (me.orgs.length === 0) {
    return (
      <NoOfficeScreen
        email={me.email}
        fullName={me.fullName}
        removedFrom={me.removedFrom}
        mayFoundOffice={me.mayFoundOffice}
        onSignOut={() => void signOut()}
        onCreated={(org) => void enter(org)}
        onJoined={(slug) => void enterSlug(slug)}
      />
    );
  }

  if (!active || redirectTo !== null) return null;

  const page = RENAMED[route.page] ?? route.page;

  return (
    <AppShell
      org={active.org}
      role={active.role}
      offices={me.orgs}
      page={page}
      displayName={active.displayName}
      email={me.email}
      mayFoundOffice={me.mayFoundOffice}
      onSignOut={() => void signOut()}
      onCreated={(org) => void enter(org)}
      onJoined={(slug) => void enterSlug(slug)}
    >
      {/* Keyed by office: each screen holds its office's week, filters and
          half-typed drafts in its own state, and none of that belongs to the
          next office. */}
      <Fragment key={active.org.id}>{renderPage(page, me, active)}</Fragment>
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

  if (page === "bug-reports") {
    // RLS gives anybody but an owner an empty list, which would read as
    // "nobody has reported anything".
    if (active.role !== "owner") {
      return (
        <ComingSoon heading="That page is for the owner">
          {`Bug reports from ${active.org.name} go to its owner. You can still send one from your account menu.`}
        </ComingSoon>
      );
    }
    return <BugReportsScreen {...props} />;
  }

  if (
    page === "menu" ||
    page === "people" ||
    page === "payments" ||
    page === "messages" ||
    // Reached from Payments rather than from the nav: correcting a finished
    // day is a weekend job, not part of the daily furniture.
    page === "corrections"
  ) {
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
    if (page === "messages") return <MessagesScreen {...props} />;
    if (page === "corrections") return <CorrectionsScreen {...props} />;
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
