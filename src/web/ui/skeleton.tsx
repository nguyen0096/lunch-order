import type * as React from "react";
import { cn } from "@/ui/cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // Announced as busy rather than as an empty region, so a screen reader
      // says "loading" instead of reading nothing at all.
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("animate-pulse rounded-md bg-surface-sunken", className)}
      {...props}
    />
  );
}

export { Skeleton };
