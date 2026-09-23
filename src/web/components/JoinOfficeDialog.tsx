/**
 * Joining an office with the code a colleague gave you.
 *
 * Its own file for the reason CreateOfficeDialog has one: two unrelated screens
 * open it, the sign-in screen for somebody who belongs nowhere and the office
 * switcher for somebody adding a second.
 */

import { useEffect, useId, useState } from "react";
import {
  Action,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useAction,
} from "@/ui";
import { joinCodeProblem, joinWithCode } from "../api.js";

/* One spelling of a text input, matching the other dialogs so two cannot be
   two heights. 16px minimum, or iOS Safari zooms the page on focus. */
const INPUT =
  "h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text placeholder:text-subtle";

export function JoinOfficeDialog({
  open,
  onOpenChange,
  suggestedName,
  onJoined,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Their Google name, which is almost always the answer. */
  suggestedName: string;
  onJoined: (slug: string) => void;
}) {
  const codeId = useId();
  const nameId = useId();
  const [code, setCode] = useState("");
  const [name, setName] = useState(suggestedName);

  // Reopening should not show the last attempt's typing, and the suggested
  // name only arrives once `me` has loaded, which can be after first render.
  useEffect(() => {
    if (open) {
      setCode("");
      setName(suggestedName);
    }
  }, [open, suggestedName]);

  const join = useAction(joinWithCode, {
    success: (r) => `Joined ${r.name}`,
    onSuccess: (r) => {
      onOpenChange(false);
      onJoined(r.slug);
    },
  });

  // The name matters more than it looks: join_with_code writes it to the
  // profile *before* allocating the short code, and that code is what appears
  // in a bank transfer memo.
  const problem =
    joinCodeProblem(code) ?? (name.trim() === "" ? "Tell them what to call you" : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Join an office</DialogTitle>
          <DialogDescription>
            Ask a colleague for the join code. It is the same code the lunch bot takes, so
            it works whether you use Telegram or not.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={codeId} className="text-sm font-medium">
              Join code
            </label>
            <input
              id={codeId}
              value={code}
              autoCapitalize="characters"
              placeholder="KGSD4582"
              className={`${INPUT} tabular tracking-widest uppercase`}
              // Uppercased as typed: join_with_code folds the code before
              // comparing, so a lowercase entry would match -- but showing it
              // in a different case than the office prints it invites the
              // reader to think they have typed the wrong thing.
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">
              Your name
            </label>
            <input
              id={nameId}
              value={name}
              className={INPUT}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-sm text-muted">
              What colleagues see beside your lunch on the board.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Action
            reason={problem}
            pending={join.pending}
            onClick={() => void join.run({ code, displayName: name })}
          >
            Join
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
