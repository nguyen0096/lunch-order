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
 * caterer and nothing can change -- and what separates them is bookkeeping,
 * not a dot on a line.
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

  // Where the filled rail stops, as a fraction of the span between the first
  // dot's centre and the last one's. `at` is the index of the point reached.
  const progress = at <= 0 ? 0 : at / (POINTS.length - 1);

  return (
    <ol
      aria-label="What has happened to this day"
      // `justify-between` puts the first dot ON the container's left edge and
      // the last on its right, so the line starts where the heading and the
      // dishes start. It was a grid of three equal columns with the dot
      // centred in each, which put the first dot at one sixth of the width:
      // measured, 65px inside the panel's content rail, with 65px of dead box
      // at the other end. It was the only thing in the panel not on the rail,
      // which is what made it read as dropped in rather than placed.
      className={cn("relative flex justify-between", className)}
    >
      {/* One rail behind all three dots rather than a segment per gap, so the
          joins cannot show. Inset by the dot's radius at each end so it runs
          centre to centre. */}
      <span
        aria-hidden="true"
        className="absolute top-[9px] right-2.5 left-2.5 h-0.5 bg-border"
      />
      <span
        aria-hidden="true"
        className="absolute top-[9px] left-2.5 h-0.5 bg-accent"
        style={{ width: `calc((100% - 1.25rem) * ${progress})` }}
      />

      {POINTS.map((p, i) => {
        const done = i < at;
        const here = i === at;
        const filled = done || here;
        return (
          <li
            key={p.key}
            aria-current={here ? "step" : undefined}
            // The end labels are aligned to their own end rather than centred,
            // or "Ordering" would hang off the left of the rail its dot sits on.
            className={cn(
              "relative flex min-w-0 flex-col gap-1.5",
              i === 0 && "items-start",
              i === POINTS.length - 1 && "items-end",
              i > 0 && i < POINTS.length - 1 && "items-center",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                done && "border-accent bg-accent text-accent-fg",
                here && "border-accent bg-accent-subtle",
                !filled && "border-border bg-surface-raised",
              )}
            >
              {done && <CheckIcon className="size-3" />}
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
