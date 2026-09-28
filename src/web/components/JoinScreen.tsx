import { useEffect, useState, type ReactNode } from "react";
import { Action, Button, useAction } from "@/ui";
import { acceptInvitation } from "../api.js";

/**
 * Landing page for an invitation link. Deliberately not automatic: joining an
 * org is a consequential action, and clicking a link someone pasted in a chat
 * should not silently enrol you.
 */
export function JoinScreen({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [joined, setJoined] = useState<{ slug: string; name: string } | null>(null);

  const accept = useAction(acceptInvitation, {
    // `accept_invitation` writes its refusals for people -- "This invitation
    // was sent to x. You are signed in as y." -- and useAction shows them
    // unedited, which is the whole reason they are worded that way.
    success: (org) => `Joined ${org.name}`,
    onSuccess: (org) => {
      setJoined(org);
      onJoined();
    },
  });

  useEffect(() => setJoined(null), [token]);

  if (joined !== null) {
    return (
      <Prose heading="You're in">
        <p className="text-muted">Joined {joined.name}.</p>
        {/* By slug, not `#/`, which resolves to whichever office is first in
            the list and is the wrong board for anybody already in one. */}
        <Button asChild>
          <a href={`#/o/${joined.slug}/board`}>Go to the board</a>
        </Button>
      </Prose>
    );
  }

  return (
    <Prose heading="Join an office">
      <p className="text-muted">
        You've been invited to an office lunch board. Accepting adds you to it and lets colleagues
        see what you order.
      </p>
      <Action reason={null} pending={accept.pending} onClick={() => void accept.run(token)}>
        Accept invitation
      </Action>
    </Prose>
  );
}

function Prose({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-start justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">{heading}</h1>
      {children}
    </main>
  );
}
