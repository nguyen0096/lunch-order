import { useEffect, useState } from "react";
import {
  Action,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  useAction,
} from "@/ui";
import { Section, TextField } from "./Section.js";
import {
  deleteOffice,
  fetchOfficeDebt,
  fetchOwedAfterLeaving,
  fetchOwnerCount,
  humanError,
  leaveOffice,
  type OfficeDebt,
} from "../../api.js";
import { formatMoney } from "../../../shared/money.js";
import type { Org, Role } from "../../../shared/types.js";

type Standing = {
  ownerCount: number;
  /** Only an owner can read the office's books, and only an owner needs to. */
  debt: OfficeDebt | null;
};

/**
 * The two things you do once and never again, at the bottom and behind a rule.
 *
 * They are last because they are terminal, and separated because a person
 * scanning Settings for their standing days should not have to read past a
 * control that ends the office. Both rules live in the database --
 * `leave_office` refuses while you owe and for a sole owner, `delete_office` is
 * owner-only -- and both are asked about here first, because a control that is
 * certain to fail is worse than one that says why before it is pressed.
 *
 * It loads its own facts rather than joining the screen's `load()`. A billing
 * read that fails should cost you the Leave button and its reason, not turn
 * Settings into an error page with your display name behind it. What you would
 * still owe is asked only once the dialog opens: working it out takes the
 * locks leaving takes, which every visit to Settings has no business holding.
 */
export function LeaveAndDelete({
  org,
  profileId,
  role,
  onGone,
}: {
  org: Org;
  profileId: string;
  role: Role;
  /** Run after this office stops being yours, by either route. */
  onGone: () => void;
}) {
  const owner = role === "owner";
  const [standing, setStanding] = useState<Standing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [ownerCount, debt] = await Promise.all([
          fetchOwnerCount(org.id),
          owner ? fetchOfficeDebt(org.id) : Promise.resolve(null),
        ]);
        if (!alive) return;
        setStanding({ ownerCount, debt });
        setLoadError(null);
      } catch (e) {
        if (!alive) return;
        setLoadError(humanError(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [org.id, profileId, owner]);

  return (
    <section
      aria-labelledby="ending"
      className="flex flex-col gap-4 border-t border-border pt-8"
    >
      <h2 id="ending" className="text-xs font-semibold text-subtle">
        {owner ? "Leaving and deleting" : "Leaving"}
      </h2>
      <LeaveOffice
        org={org}
        owner={owner}
        standing={standing}
        loadError={loadError}
        onGone={onGone}
      />
      {owner && (
        <DeleteOffice org={org} debt={standing?.debt ?? null} loadError={loadError} onGone={onGone} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ leaving */

function LeaveOffice({
  org,
  owner,
  standing,
  loadError,
  onGone,
}: {
  org: Org;
  owner: boolean;
  standing: Standing | null;
  loadError: string | null;
  onGone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // null while it loads; a string when it failed.
  const [owed, setOwed] = useState<number | string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    let alive = true;
    setOwed(null);
    void (async () => {
      try {
        const minor = await fetchOwedAfterLeaving(org.id);
        if (alive) setOwed(minor);
      } catch (e) {
        if (alive) setOwed(humanError(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [confirming, org.id]);

  const leave = useAction(async () => leaveOffice(org.id), {
    success: `Left ${org.name}`,
    onSuccess: () => {
      setConfirming(false);
      onGone();
    },
  });

  const soleOwner = owner && standing !== null && standing.ownerCount <= 1;

  const reason =
    loadError !== null
      ? "This did not load, so it cannot say yet whether you can leave. Reload the page."
      : soleOwner
        ? "You are the only owner. Make somebody else an owner first, or delete the office."
        : null;

  const confirmReason =
    owed === null
      ? "Working out what you would still owe."
      : typeof owed === "string"
        ? "Your bill did not load, so this cannot say yet whether you can leave. Close this and try again."
        : owed > 0
          ? `You would still owe ${formatMoney(owed, org.currency)}. Settle up before you leave.`
          : null;

  return (
    <Section
      title="Leave this office"
      description={`You stop appearing on the board of ${org.name}, and the bot stops asking you what you want for lunch.`}
    >
      <p className="max-w-prose text-sm text-muted">
        Lunch you ordered for a day still open for ordering is cancelled and comes off your bill.
        A day whose ordering has closed stays ordered and billed, because the caterer may already
        have the count. Your past orders and anything you owe stay on the office&apos;s books:
        leaving settles no bill and erases none.
      </p>
      <p className="max-w-prose text-sm text-muted">
        {`You can come back. Joining again with ${org.name}'s join code puts you back on the same membership, with the same short code and the same history behind it.`}
      </p>

      {soleOwner && (
        <div className="flex flex-col gap-3 rounded-md bg-surface-sunken p-3">
          <p className="max-w-prose text-sm text-muted">
            An office with no owner is one nobody can ever administer again, which is why this is
            refused rather than warned about. There are two ways out: hand the office to somebody
            else, or end it below.
          </p>
          <div>
            <Button variant="outline" asChild>
              <a href={`#/o/${org.slug}/people`}>Make somebody an owner</a>
            </Button>
          </div>
        </div>
      )}

      {standing === null && loadError === null ? (
        <Skeleton className="h-11 w-28" />
      ) : (
        <div>
          <Action reason={reason} variant="danger" onClick={() => setConfirming(true)}>
            Leave
          </Action>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Leave ${org.name}?`}</DialogTitle>
            <DialogDescription>
              {`You come off the board straight away. Lunch on a day still open for ordering is cancelled; a day whose ordering has closed stays ordered, and anything owed stays owed.`}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted">
            {`Joining again with ${org.name}'s join code brings you back to the same membership.`}
          </p>
          {owed === null ? (
            <Skeleton className="h-5 w-64" />
          ) : (
            confirmReason !== null && (
              <p role="status" className="rounded-md bg-warn-subtle p-3 text-sm text-warn-subtle-fg">
                {confirmReason}
              </p>
            )
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Stay</Button>
            </DialogClose>
            <Action
              reason={confirmReason}
              pending={leave.pending}
              variant="danger"
              onClick={() => void leave.run()}
            >
              {leave.pending ? "Leaving" : "Leave"}
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/* ----------------------------------------------------------------- deleting */

/**
 * Owner-only, and absent rather than greyed for everybody else. A member has no
 * use for the sentence "only an owner can delete an office" on a control they
 * were never going to press.
 */
function DeleteOffice({
  org,
  debt,
  loadError,
  onGone,
}: {
  org: Org;
  debt: OfficeDebt | null;
  loadError: string | null;
  onGone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const remove = useAction(async () => deleteOffice(org.id), {
    success: `Deleted ${org.name}`,
    onSuccess: () => {
      setConfirming(false);
      onGone();
    },
  });

  function open(next: boolean) {
    setConfirming(next);
    // A half-typed name left behind is a confirmation already half passed.
    if (!next) setTyped("");
  }

  const owed = debt !== null && debt.outstandingMinor > 0 ? debt : null;
  const owedSentence =
    owed === null
      ? null
      : `${formatMoney(owed.outstandingMinor, org.currency)} is still owed to ${org.name}, across ${
          owed.peopleOwing === 1 ? "one person" : `${owed.peopleOwing} people`
        }. Deleting does not collect it and does not write it off.`;

  // Exact, not case-folded and not trimmed into a match: typing the name is the
  // whole confirmation, and a near miss accepted is no confirmation at all.
  const matches = typed === org.name;

  return (
    <Section
      title="Delete this office"
      description={`Ends ${org.name} for everybody in it. The board, every bill and the member list disappear at the same moment.`}
    >
      <p className="max-w-prose text-sm text-muted">
        Nothing is erased. Every order, statement and payment stays in the database, and somebody
        with access to it can bring the office back. You cannot bring it back from here, and
        neither can anybody else in this app.
      </p>
      <p className="max-w-prose text-sm text-muted">
        Everybody loses access straight away, including anyone who still owes money.
      </p>
      {owedSentence !== null && (
        <p className="max-w-prose rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
          {owedSentence}
        </p>
      )}

      {debt === null && loadError === null ? (
        <Skeleton className="h-11 w-40" />
      ) : (
        <div>
          <Action reason={null} variant="danger" onClick={() => open(true)}>
            Delete this office
          </Action>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Delete ${org.name}?`}</DialogTitle>
            <DialogDescription>
              {`Everybody in ${org.name} loses it at once: the board, every bill and the member list.`}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted">
            It is recoverable in the database and not from here. Nothing is erased, and nothing in
            this app will bring it back.
          </p>
          <p
            className={
              owedSentence === null
                ? "text-sm text-muted"
                : "rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
            }
          >
            {owedSentence ?? `Nobody owes ${org.name} anything, so nothing is left hanging.`}
          </p>
          <TextField
            id="confirm-office-name"
            label={`Type ${org.name} to confirm`}
            value={typed}
            onChange={setTyped}
            placeholder={org.name}
            maxLength={120}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep the office</Button>
            </DialogClose>
            <Action
              reason={matches ? null : `Type ${org.name} exactly to confirm`}
              pending={remove.pending}
              variant="danger"
              onClick={() => void remove.run()}
            >
              {remove.pending ? "Deleting" : "Delete"}
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
