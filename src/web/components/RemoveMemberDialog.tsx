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
} from "@/ui";
import { fetchRemovalPreview, humanError, type OrgMember, type RemovalEffect } from "../api.js";
import { formatDay } from "../../shared/dates.js";

/**
 * Remove asks first, because Add back restores nothing it cancelled.
 *
 * What it would cancel is read when the dialog opens, from the same rule the
 * removal runs, so the list names the days the removal will find. Remove waits
 * for that list: confirming a removal whose consequences did not load is not
 * a confirmation.
 */
export function RemoveMemberDialog({
  orgId,
  member,
  pending,
  onOpenChange,
  onConfirm,
}: {
  orgId: number;
  /** The person to remove; null keeps the dialog closed. */
  member: OrgMember | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (member: OrgMember) => void;
}) {
  // null while it loads; a string when it failed.
  const [effects, setEffects] = useState<RemovalEffect[] | string | null>(null);
  const profileId = member?.profileId ?? null;

  useEffect(() => {
    if (profileId === null) return;
    let alive = true;
    setEffects(null);
    void (async () => {
      try {
        const next = await fetchRemovalPreview({ orgId, profileId });
        if (alive) setEffects(next);
      } catch (e) {
        if (alive) setEffects(humanError(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [orgId, profileId]);

  const name = member?.name ?? "";
  const reason =
    effects === null
      ? `Working out what removing ${name} would cancel.`
      : typeof effects === "string"
        ? "What removing would cancel did not load. Close this and try again."
        : null;

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      {/* The list scrolls, the title and the two buttons never do: a removal
          can change many days, and Remove must stay in reach under all of them. */}
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{`Remove ${name}?`}</DialogTitle>
          <DialogDescription>
            {`${name} stops seeing this office at once. A day whose ordering has closed, and their past orders, stay on their bill.`}
          </DialogDescription>
        </DialogHeader>

        {effects === null ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-48" />
          </div>
        ) : typeof effects === "string" ? (
          <p role="alert" className="rounded-md bg-danger-subtle p-3 text-sm text-danger-subtle-fg">
            {`${reason} ${effects}`}
          </p>
        ) : effects.length === 0 ? (
          <p className="text-sm text-muted">
            {`Nothing is cancelled: ${name} has no lunch on a day still open for ordering, and nobody has a meal or an offer with them.`}
          </p>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <p className="shrink-0 text-sm font-medium">Removing changes these, and adding them back does not restore them:</p>
            <ul
              aria-label={`What removing ${name} changes`}
              // Focusable, so the list scrolls from the keyboard too.
              tabIndex={0}
              className="flex min-h-0 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border"
            >
              {effects.map((e, i) => (
                <li key={i} className="flex shrink-0 flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:gap-3">
                  <span className="shrink-0 font-medium tabular sm:w-28">{formatDay(e.serviceDate)}</span>
                  <span className="min-w-0 wrap-break-word text-muted">{effectSentence(e, name)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="shrink-0">
          <DialogClose asChild>
            <Button variant="outline">Keep</Button>
          </DialogClose>
          <Action
            reason={reason}
            pending={pending}
            variant="danger"
            onClick={() => member && onConfirm(member)}
          >
            {pending ? "Removing" : "Remove"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One change, in the words of the person reading the list. */
export function effectSentence(e: RemovalEffect, name: string): string {
  const dish = e.dishes ?? "lunch, no dish chosen yet";
  // The aside about no dish closes with a comma wherever the sentence goes on.
  const dishThen = e.dishes === null ? `${dish},` : dish;
  const other = e.otherName ?? "a colleague";
  switch (e.action) {
    case "cancel":
      return `${name}'s ${dishThen} is cancelled.`;
    case "return":
      return `${other}'s ${dish}, passed to ${name}, goes back to ${other} and onto their bill.`;
    case "cancel_passed":
      return `${other}'s ${dish}, passed to ${name}, is cancelled: ${other} is no longer in the office either.`;
    case "decline":
      return `${other}'s offer of ${dishThen} to ${name} is declined.`;
  }
}
