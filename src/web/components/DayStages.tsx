import { CheckIcon } from "lucide-react";
import { cn } from "@/ui";
import { dayStage, type DayStage } from "../../shared/gating.js";
import type { Org } from "../../shared/types.js";

/**
 * Where a day has got to, as a line with points on it.
 *
 * The same shape a food delivery app uses, for the same reason: the question
 * is never "what is the status" but "can I still change this, and if not, what
 * happened". A line answers both at once, because the points ahead of the
 * filled one are the things that have not happened yet.
 *
 * Four points, not the five stages the database keeps. `locked` and `closed`
 * are one thing to the person reading this -- the headcount has gone to the
 * caterer and nothing can change -- and they differ only in whether an admin
 * may still reopen, which is an admin's business and not a dot on a line.
 */
const POINTS = [
  { key: "ordering", label: "Ordering", of: ["draft", "open"] },
  { key: "cooking", label: "Cooking", of: ["locked", "closed"] },
  { key: "served", label: "Served", of: ["done"] },
] as const;

/** Which point is lit, or -1 before anything has happened. */
function reached(stage: DayStage): number {
  return POINTS.findIndex((p) => (p.of as readonly string[]).includes(stage));
}

export function DayStages({
  serviceDate,
  status,
  orderCutoffAt,
  org,
  now,
  className,
}: {
  serviceDate: string;
  status: string | null;
  orderCutoffAt: string | null;
  org: Pick<Org, "timezone" | "businessDayStartsAt" | "businessDayEndsAt">;
  now: Date;
  className?: string;
}) {
  const stage = dayStage({ serviceDate, status, orderCutoffAt, org, now });

  // Two states that are not points on the line, because neither is a step
  // along it: one is the line not having started, the other is it stopping.
  if (stage === "no_menu") {
    return (
      <p className={cn("text-sm text-muted", className)}>
        No menu for this day yet.
      </p>
    );
  }
  if (stage === "cancelled") {
    return (
      <p className={cn("text-sm text-danger-subtle-fg", className)}>
        Lunch is cancelled for this day. Every order for it was cancelled too.
      </p>
    );
  }

  const at = reached(stage);

  return (
    <ol
      aria-label="What has happened to this day"
      // A grid of equal columns, so the points are evenly spaced whatever the
      // labels are. The rails are drawn inside each column as two absolute
      // halves that run from the column edge to its centre, which is where the
      // dot is: they meet exactly under the next dot and cannot drift, and
      // being in the same centred row as the dot they cannot sit off its line.
      className={cn("grid grid-cols-3", className)}
    >
      {POINTS.map((p, i) => {
        const done = i < at;
        const here = i === at;
        const filled = done || here;
        return (
          <li
            key={p.key}
            // On the item, not the label: the step is the whole point, and
            // that is what assistive tech is asked to announce as current.
            aria-current={here ? "step" : undefined}
            className="flex flex-col items-center gap-1.5"
          >
            <span className="relative flex h-5 w-full items-center justify-center">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 right-1/2 left-0 h-0.5 -translate-y-1/2",
                    filled ? "bg-accent" : "bg-border",
                  )}
                />
              )}
              {i < POINTS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 right-0 left-1/2 h-0.5 -translate-y-1/2",
                    done ? "bg-accent" : "bg-border",
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-1 flex size-5 items-center justify-center rounded-full border-2",
                  done && "border-accent bg-accent text-accent-fg",
                  here && "border-accent bg-accent-subtle",
                  !filled && "border-border bg-surface-raised",
                )}
              >
                {done && <CheckIcon className="size-3" />}
              </span>
            </span>
            <span
              className={cn(
                "text-xs whitespace-nowrap",
                here ? "font-semibold text-text" : "text-muted",
              )}
            >
              {p.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
