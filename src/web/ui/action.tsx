import * as React from "react";
import { Button, type buttonVariants } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/ui/cn";
import type { VariantProps } from "class-variance-authority";

type ActionProps = Omit<React.ComponentProps<"button">, "disabled"> &
  VariantProps<typeof buttonVariants> & {
    /**
     * `null` means the control is available. Otherwise it is the sentence
     * saying why it is not, written for the person, not the log.
     */
    reason: string | null;
    /** Swaps the label for a busy state; pair with `useAction().pending`. */
    pending?: boolean;
  };

/**
 * Every control that can be unavailable. The reason travels with the control
 * rather than living in the head of whoever wrote the screen: the People page
 * looked broken for a week while working exactly as designed, because a row of
 * grey buttons says "this app is broken" and never says "the bill is closed".
 *
 * Unavailable is `aria-disabled`, not `disabled`. A `disabled` button leaves
 * the tab order and stops emitting pointer events, so neither a keyboard user
 * nor a hovering mouse can ever reach the explanation. This one stays
 * focusable and hoverable, refuses the click itself, and carries the sentence
 * twice over: a tooltip for the pointer and for a tap, and a description that
 * assistive tech reads out with the label whether or not the tooltip opens.
 */
export function Action({
  reason,
  pending = false,
  className,
  children,
  onClick,
  onKeyDown,
  type = "button",
  ...props
}: ActionProps) {
  const describedBy = React.useId();
  const unavailable = reason !== null;
  const blocked = unavailable || pending;
  const [showReason, setShowReason] = React.useState(false);
  React.useEffect(() => {
    if (!unavailable) setShowReason(false);
  }, [unavailable]);

  const button = (
    <Button
      {...props}
      type={type}
      aria-disabled={blocked || undefined}
      // Appended, not replaced: a caller's own description is theirs to keep.
      aria-describedby={
        [props["aria-describedby"], unavailable ? describedBy : null].filter(Boolean).join(" ") ||
        undefined
      }
      data-unavailable={unavailable || undefined}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          e.stopPropagation();
          // A touch screen never hovers, and Radix opens a tooltip on hover
          // and focus only, so a tap is the one way a phone asks "why not".
          // `preventDefault` is also what stops the trigger closing it again.
          if (unavailable) setShowReason(true);
          return;
        }
        onClick?.(e);
      }}
      onKeyDown={(e) => {
        // aria-disabled does not stop the browser activating a button, so the
        // two activation keys have to be refused here as well as on click.
        if (blocked && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          return;
        }
        onKeyDown?.(e);
      }}
      className={cn(
        // Not the usual washed-out grey: the label stays legible and the
        // dashed edge is what says "not now", so the control reads as
        // deliberate rather than dead.
        blocked && "cursor-not-allowed",
        unavailable &&
          "border border-dashed border-border-strong bg-transparent text-muted hover:bg-transparent hover:text-muted",
        className,
      )}
    >
      {children}
    </Button>
  );

  if (!unavailable) return button;

  return (
    <>
      <Tooltip open={showReason} onOpenChange={setShowReason}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      {/* Rendered unconditionally rather than relying on the tooltip's own
          aria-describedby, which exists only while the tooltip is open. */}
      <span id={describedBy} className="sr-only">
        {reason}
      </span>
    </>
  );
}
