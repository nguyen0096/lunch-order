/**
 * Telling the owner something is broken, from wherever it broke.
 *
 * The context is attached rather than asked for. Nobody reporting a bug knows
 * their user agent, and the page they were on is exactly the thing they will
 * describe least precisely.
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
import { BUG_REPORT_MAX, bugReportContext, bugReportProblem, sendBugReport } from "../api.js";

export function BugReportDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: number;
  orgName: string;
}) {
  const id = useId();
  const [text, setText] = useState("");

  const send = useAction(sendBugReport, {
    success: "Report sent",
    onSuccess: () => onOpenChange(false),
  });

  const { reset } = send;
  useEffect(() => {
    if (open) {
      setText("");
      reset();
    }
  }, [open, reset]);

  const problem = bugReportProblem(text);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            {`It goes to the owner of ${orgName}. The page you are on, the app version and your browser are attached, so describe only what happened.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            What went wrong
          </label>
          <textarea
            id={id}
            value={text}
            rows={5}
            maxLength={BUG_REPORT_MAX}
            placeholder="I pressed Give Tèo my lunch and nothing happened."
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface p-3 text-base text-text placeholder:text-subtle"
          />
          {send.error !== null && (
            // Inline as well as in the toast, and the text is kept: a report
            // that vanished on a refusal would have to be written twice.
            <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
              {send.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Action
            reason={problem}
            pending={send.pending}
            onClick={() =>
              void send.run({ orgId, description: text, context: bugReportContext() })
            }
          >
            {send.pending ? "Sending" : "Send report"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
