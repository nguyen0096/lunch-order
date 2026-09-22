import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/ui/cn";

const buttonVariants = cva(
  // Focus comes from the global :focus-visible outline so every control in the
  // app rings identically, including the ones nobody remembered to style.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent/90",
        danger: "bg-danger text-danger-fg hover:bg-danger/90",
        outline:
          "border border-border bg-surface-raised text-text hover:bg-surface-sunken hover:border-border-strong",
        secondary: "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/70",
        ghost: "text-muted hover:bg-surface-sunken hover:text-text",
        // Ochre measures 3.98:1 on paper, below AA for small text, so a link
        // is full-contrast text with the accent carried by the underline.
        link: "text-text underline underline-offset-4 decoration-2 decoration-accent hover:decoration-accent/70",
      },
      size: {
        // 44px: this is the control people use one-handed, once a day.
        default: "h-11 px-4 has-[>svg]:px-3.5",
        sm: "h-9 gap-1.5 px-3",
        lg: "h-12 px-6 text-base",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
