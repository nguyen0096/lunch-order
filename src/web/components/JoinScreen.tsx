import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Action, Button, Skeleton, useAction } from "@/ui";
import { acceptInvitation, humanError, previewInvitation, type InvitationPreview } from "../api.js";

type Preview =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "loaded"; invitation: InvitationPreview | null };

/**
 * Landing page for an invitation link. Deliberately not automatic: joining an
 * org is a consequential action, and clicking a link someone pasted in a chat
 * should not silently enrol you. So it says where the link leads, and as what,
 * before it offers to accept.
 */
export function JoinScreen({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [joined, setJoined] = useState<{ slug: string; name: string } | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: "loading" });

  const load = useCallback(async (isCurrent: () => boolean) => {
    setPreview({ status: "loading" });
    try {
      const invitation = await previewInvitation(token);
      if (isCurrent()) setPreview({ status: "loaded", invitation });
    } catch (e) {
      if (isCurrent()) setPreview({ status: "failed", reason: humanError(e) });
    }
  }, [token]);

  useEffect(() => {
    let current = true;
    setJoined(null);
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

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

  if (preview.status === "loading") {
    return (
      <Prose heading="Join an office">
        <div aria-label="Loading the invitation" className="flex w-full flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Prose>
    );
  }

  if (preview.status === "failed") {
    return (
      <Prose heading="The invitation did not load">
        <p className="text-muted">{preview.reason}</p>
        <Button variant="outline" onClick={() => void load(() => true)}>
          Try again
        </Button>
      </Prose>
    );
  }

  const invitation = preview.invitation;
  if (invitation === null) {
    return (
      <Prose heading="Invitation not found">
        <p className="text-muted">
          That invitation link is not valid. Check it was copied in full, or ask the admin who sent
          it for a new one.
        </p>
      </Prose>
    );
  }

  if (invitation.state === "expired") {
    return (
      <Prose heading="Invitation expired">
        <p className="text-muted">
          Your invitation to {invitation.orgName} expired on {dateLabel(invitation.expiresAt)}. Ask
          an admin there for a new one.
        </p>
      </Prose>
    );
  }

  if (invitation.state === "used") {
    return (
      <Prose heading="Invitation already used">
        <p className="text-muted">
          This invitation to {invitation.orgName} has already been accepted. If that was you, the
          office is in your list.
        </p>
        <Button variant="outline" asChild>
          <a href="#/">Go to my offices</a>
        </Button>
      </Prose>
    );
  }

  return (
    <Prose heading={`Join ${invitation.orgName}`}>
      <p className="text-muted">
        {`You've been invited to ${invitation.orgName} as ${invitation.role === "admin" ? "an admin" : "a member"}. Accepting adds you to its lunch board and lets colleagues see what you order.`}
      </p>
      <p className="text-sm text-muted">
        This invitation is valid until {dateLabel(invitation.expiresAt)}.
      </p>
      <Action reason={null} pending={accept.pending} onClick={() => void accept.run(token)}>
        Accept invitation
      </Action>
    </Prose>
  );
}

function dateLabel(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "an unknown date";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })
    .format(at);
}

function Prose({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-start justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">{heading}</h1>
      {children}
    </main>
  );
}
