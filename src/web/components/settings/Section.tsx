import type { ReactNode } from "react";
import { cn } from "@/ui";

/**
 * One setting, in a card that says what it is for before it says what to type.
 *
 * Settings is a page of unrelated things, so each one carries its own heading
 * and its own sentence; without them the screen is a column of inputs and the
 * reader has to infer what each will change.
 */
export function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  /** One sentence, from the member's point of view. */
  description: ReactNode;
  /** A badge or status that belongs beside the heading, not under it. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        {aside}
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted">{description}</p>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/* One spelling of a text input, so five fields on one page cannot be five
   different heights. 16px minimum, or iOS Safari zooms the page on focus. */
const INPUT =
  "h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base text-text placeholder:text-subtle";

/**
 * A time of day, in the browser's own time control.
 *
 * Native rather than three selects: it is already localised, already has a
 * keyboard story, and on a phone it opens the OS time wheel. Its value is
 * always `HH:MM` or empty -- a half-typed time never reaches the caller -- so
 * the only state to handle beyond a valid time is blank.
 */
export function TimeField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  /** `HH:MM`, or "" for unset. */
  value: string;
  onChange: (next: string) => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hintId}
        // Capped rather than full width: a field that accepts five characters
        // and stretches to 1440px reads as an unfinished layout.
        className={cn(INPUT, "max-w-44")}
      />
      {hint && (
        <p id={hintId} className="max-w-prose text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
  inputMode,
  className,
}: {
  id: string;
  label: string;
  /** What to type, or what the field means. Always visible, never a tooltip. */
  hint?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
  inputMode?: "text" | "numeric" | "tel";
  className?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        inputMode={inputMode}
        aria-describedby={hintId}
        className={INPUT}
      />
      {hint && (
        <p id={hintId} className="max-w-prose text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
