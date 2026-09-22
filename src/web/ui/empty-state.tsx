import type * as React from "react";
import { cn } from "@/ui/cn";

type EmptyStateProps = {
  /** What is not here, as a noun phrase. Never "No data". */
  heading: string;
  /** One sentence saying what to do next. */
  children: React.ReactNode;
  /** The single thing to do. Omitted when there is genuinely nothing to do. */
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
};

/**
 * Every list ships one of these. An empty list with no explanation is
 * indistinguishable from a list that failed to load, and the person cannot
 * tell which they are looking at.
 */
export function EmptyState({ heading, children, action, icon, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface-sunken/60 px-6 py-12 text-center",
        className,
      )}
    >
      {icon && <div className="text-subtle [&_svg]:size-6">{icon}</div>}
      <h3 className="text-lg font-semibold text-text">{heading}</h3>
      {/* max-w-prose is Tailwind's 65ch, inside the spec's 80-character cap. */}
      <p className="max-w-prose text-sm text-muted">{children}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
