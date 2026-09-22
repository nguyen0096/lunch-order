import { Button } from "@/ui";

// The texture, not a menu: nothing is readable from the sign-in page before
// there is a session, so these are the dishes this office orders week in, week
// out rather than a claim about today.
const DISHES = ["Cơm gà", "Phở bò", "Bún bò Huế", "Bánh mì", "Cơm tấm", "Mì Quảng"];

/**
 * The one screen with nothing to do, so it carries the identity: full-bleed
 * ochre, dish names set large as texture, a single button. Everything after it
 * stays quiet and functional. The boldness is spent here and nowhere else.
 */
export function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="relative flex min-h-dvh flex-col justify-between overflow-hidden bg-accent px-6 py-10 text-accent-fg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col justify-center gap-2 overflow-hidden px-6 opacity-20 select-none"
      >
        {DISHES.map((dish) => (
          <span key={dish} className="block text-3xl font-semibold whitespace-nowrap">
            {dish}
          </span>
        ))}
      </div>

      <h1 className="relative text-2xl font-semibold">Lunch</h1>

      <div className="relative flex flex-col items-start gap-4">
        <p className="max-w-prose text-lg font-medium">Order lunch with your office.</p>
        {/* Dark text on the ochre fill, per the contrast rule: ochre is never
            small type on paper, and here it is the page. */}
        <Button variant="outline" size="lg" onClick={onSignIn}>
          Continue with Google
        </Button>
      </div>
    </main>
  );
}

/** Signed in, but a member of nothing. Not an empty app, an explanation. */
export function NoOfficeScreen({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-start justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">No office yet</h1>
      <p className="text-muted">
        You're signed in as {email}, but you're not a member of an office yet. Ask a colleague for
        the join code, or for an invitation link.
      </p>
      <Button variant="outline" onClick={onSignOut}>
        Sign out
      </Button>
    </main>
  );
}
