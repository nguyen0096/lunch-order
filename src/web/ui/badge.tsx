import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/ui/cn";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      // Tinted rather than solid by default: a badge labels a row, it does not
      // compete with the accent fill that means "ordered" on the board.
      variant: {
        neutral: "bg-surface-sunken text-muted",
        accent: "bg-accent-subtle text-accent-subtle-fg",
        success: "bg-success-subtle text-success-subtle-fg",
        warn: "bg-warn-subtle text-warn-subtle-fg",
        danger: "bg-danger-subtle text-danger-subtle-fg",
        outline: "border-border-strong text-muted",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
