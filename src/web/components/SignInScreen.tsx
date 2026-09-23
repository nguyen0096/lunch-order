import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/ui";
import { CreateOfficeDialog } from "./CreateOfficeDialog.js";
import { JoinOfficeDialog } from "./JoinOfficeDialog.js";
import type { Org } from "../../shared/types.js";

// The texture, not a menu: nothing is readable from the sign-in page before
// there is a session, so these are the dishes this office orders week in, week
// out rather than a claim about today.
const DISHES = ["Cơm gà", "Phở bò", "Bún bò Huế", "Bánh mì", "Cơm tấm", "Mì Quảng"];

/**
 * The one screen with nothing to do, so it carries the identity: full-bleed
 * ochre, the dish names set large, a single button. Everything after it stays
 * quiet and functional. The boldness is spent here and nowhere else.
 *
 * Two compositions rather than one stretched, which is the same rule the shell
 * follows. On a phone the names sit behind the words as a wash. On a monitor
 * they become the second column and run off the bottom edge, so the screen
 * fills its width with the subject instead of leaving the wordmark and the
 * button huddled in the left 250 pixels of a mustard field.
 *
 * The names are set at a measured strength rather than whatever looked right:
 * `accent-fg` over `accent` reaches 4.66:1 at full opacity in light and 8.42:1
 * in dark, so one opacity would read as two different things. The pairs below
 * land the wash near 1.9:1 and the column near 2.5:1 in both schemes: clearly
 * texture, clearly not a rendering fault.
 */
export function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-accent text-accent-fg">
      <div className="mx-auto grid min-h-dvh max-w-[96rem] grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:grid-rows-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
        <div className="flex flex-col gap-10 px-6 pt-10 pb-8 lg:gap-12 lg:px-16 lg:py-16">
          <h1 className="text-xl font-semibold">Lunch</h1>

          <div className="flex max-w-prose flex-col items-start gap-6 lg:flex-1 lg:justify-center">
            <p className="text-2xl font-semibold lg:text-3xl">Order lunch with your office.</p>
            {/* Dark text on the ochre fill, per the contrast rule: ochre is
                never small type on paper, and here it is the page. */}
            <Button variant="outline" size="lg" onClick={onSignIn}>
              Continue with Google
            </Button>
          </div>

          <p className="max-w-prose text-sm">
            New here? You will need a join code from a colleague once you are in.
          </p>
        </div>

        {/* Beside the words on a monitor, beneath them on a phone, and never
            behind them: a wash under a headline makes both harder to read. */}
        <div
          aria-hidden="true"
          className="flex flex-col justify-between overflow-hidden px-6 pb-2 opacity-40 select-none lg:px-0 lg:py-16 lg:opacity-55 dark:opacity-35 lg:dark:opacity-45"
        >
          {DISHES.map((dish) => (
            <span
              key={dish}
              className="block border-b border-accent-fg/15 py-2 text-3xl font-semibold whitespace-nowrap lg:pr-16"
            >
              {dish}
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}

/**
 * Signed in, but a member of nothing. Not an empty app, an explanation.
 *
 * Joining stays the headline because almost everybody here is joining a
 * colleague's office, not founding one. Founding is offered under it, for the
 * person who has nobody to ask -- until this screen said so, that person had
 * nothing to do but sign out.
 */
export function NoOfficeScreen({
  email,
  fullName,
  onSignOut,
  onCreated,
  onJoined,
}: {
  email: string;
  /** Their Google name, offered as the name colleagues will see. */
  fullName: string;
  onSignOut: () => void;
  /** Refetch and go: the new office is the only one this person has. */
  onCreated: (org: Org) => void;
  onJoined: (slug: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-start justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">No office yet</h1>
      <p className="text-muted">
        {/* Somebody who joined from Telegram has no email address at all, and
            naming them "signed in as ," is the worst possible greeting for the
            person this app was most careful to support. */}
        {email === ""
          ? "You're signed in, but you're not a member of an office yet. Ask a colleague for their office's join code and enter it here."
          : `You're signed in as ${email}, but you're not a member of an office yet. Ask a colleague for their office's join code and enter it here.`}
      </p>
      <Button onClick={() => setJoining(true)}>Join with a code</Button>

      <hr className="w-full border-t border-border" />

      <p className="text-sm text-muted">
        Nobody to ask? Create the office yourself and send colleagues the join code.
      </p>
      <Button variant="outline" onClick={() => setCreating(true)}>
        <PlusIcon />
        Create an office
      </Button>

      <Button variant="ghost" onClick={onSignOut}>
        Sign out
      </Button>

      <CreateOfficeDialog open={creating} onOpenChange={setCreating} onCreated={onCreated} />
      <JoinOfficeDialog
        open={joining}
        onOpenChange={setJoining}
        suggestedName={fullName}
        onJoined={onJoined}
      />
    </main>
  );
}
