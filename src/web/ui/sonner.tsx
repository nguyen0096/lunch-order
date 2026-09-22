import { CircleAlertIcon, CircleCheckIcon, InfoIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * The one toast surface, mounted once in main.tsx. `theme="system"` rather
 * than a theme provider: the tokens already follow `prefers-color-scheme`, so
 * a second source of truth for "is it dark" could only ever disagree.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <CircleAlertIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "!bg-surface-raised !text-text !border !border-border !rounded-lg !shadow-lg !font-sans",
          description: "!text-muted",
          success: "!text-success-subtle-fg !bg-success-subtle !border-success/30",
          error: "!text-danger-subtle-fg !bg-danger-subtle !border-danger/30",
          warning: "!text-warn-subtle-fg !bg-warn-subtle !border-warn/30",
          actionButton: "!bg-accent !text-accent-fg",
          cancelButton: "!bg-surface-sunken !text-muted",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
