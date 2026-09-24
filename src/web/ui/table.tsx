import type * as React from "react";
import { cn } from "@/ui/cn";

/**
 * The board is a table semantically and visually, so this stays a real
 * `<table>`. The wrapper scrolls horizontally because a week of dates by a
 * roomful of people is wide by nature, and a pinned name column is what tells
 * you whose row you are ticking.
 */
function Table({ className, containerClassName, ...props }: React.ComponentProps<"table"> & {
  containerClassName?: string;
}) {
  return (
    <div
      data-slot="table-container"
      className={cn(
        "relative w-full overflow-x-auto rounded-lg border border-border [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full border-separate border-spacing-0 text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn(className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("[&_td]:border-t [&_td]:border-border [&_th]:border-t [&_th]:border-border [&_td]:text-muted [&_th]:text-muted", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      // No zebra. Every cell already carries a hairline rule, so the stripe
      // separated nothing that was not separated; what it did do was put a
      // second, meaningless background into a grid where background means
      // "ordered". Hover and selected stay, because both are state.
      className={cn(
        "transition-colors hover:bg-accent-subtle/50 data-[selected=true]:bg-accent-subtle",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "sticky top-0 z-2 border-b border-border bg-surface-raised px-3 py-2 text-left align-middle text-xs font-semibold text-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("border-b border-border px-3 py-2 align-middle", className)}
      {...props}
    />
  );
}

/** Numbers belong in their own right-aligned column, per the layout rules. */
function TableNumericCell({ className, ...props }: React.ComponentProps<"td">) {
  return <TableCell className={cn("text-right", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-3 text-sm text-muted", className)} {...props} />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableNumericCell,
  TableRow,
};
