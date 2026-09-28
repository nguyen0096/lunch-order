import { rememberRoute, takeOAuthError, takeReturnRoute } from "../src/web/authRedirect.js";

/** Puts the tab at `url` without navigating, which jsdom cannot do. */
function at(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => {
  sessionStorage.clear();
  at("/");
});

describe("the route across a Google sign-in", () => {
  it("keeps an invitation link through the trip, and gives it back once", () => {
    at("/#/join/0b7c9f2e-1111-4222-8333-944455556666");
    rememberRoute();

    // What the provider sends back: the bare origin, route gone.
    at("/");
    expect(takeReturnRoute()).toBe("#/join/0b7c9f2e-1111-4222-8333-944455556666");
    expect(takeReturnRoute()).toBeNull();
  });

  it("keeps a deep link with its query", () => {
    at("/#/o/acme/bill?week=2026-09-21");
    rememberRoute();
    expect(takeReturnRoute()).toBe("#/o/acme/bill?week=2026-09-21");
  });

  it("keeps nothing from the home route, and forgets an older one", () => {
    at("/#/o/acme/board");
    rememberRoute();
    at("/#/");
    rememberRoute();
    expect(takeReturnRoute()).toBeNull();
  });

  it("gives back only a route of this app", () => {
    sessionStorage.setItem("lunch.returnTo", "#access_token=abc");
    expect(takeReturnRoute()).toBeNull();
  });
});

describe("a sign-in that came back refused", () => {
  it("is null when nothing went wrong", () => {
    at("/#/o/acme/board");
    expect(takeOAuthError()).toBeNull();
    expect(window.location.hash).toBe("#/o/acme/board");
  });

  it("names the failure and takes it out of the address", () => {
    at("/#error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user");
    expect(takeOAuthError()).toBe(
      "Signing in with Google did not finish: Database error saving new user. Try again.",
    );
    expect(window.location.hash).toBe("#/");
  });

  it("says a cancelled sign-in was cancelled", () => {
    at("/#error=access_denied&error_description=The+resource+owner+denied+the+request");
    expect(takeOAuthError()).toMatch(/cancelled/);
  });

  it("reads the query too, and keeps the rest of it", () => {
    at("/?now=2026-09-22T08:00&error=server_error&error_description=boom");
    expect(takeOAuthError()).toMatch(/boom/);
    expect(window.location.search).toBe("?now=2026-09-22T08%3A00");
  });

  it("puts back the route the person signed in from, so a retry lands there", () => {
    at("/#/join/0b7c9f2e-1111-4222-8333-944455556666");
    rememberRoute();
    at("/#error=access_denied");

    takeOAuthError();
    expect(window.location.hash).toBe("#/join/0b7c9f2e-1111-4222-8333-944455556666");
  });
});
