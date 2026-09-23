import type { LocalCutoff } from "./cutoff.js";

/**
 * When ordering closes, standing beside the day it closes for.
 *
 * Native `date` and `time` inputs rather than a picker: the value really is a
 * calendar day plus a wall-clock time in the org's zone, which is exactly what
 * these two return, and the browser already localises and validates both.
 *
 * Read-only rather than disabled once the menu is frozen, for the same reason
 * the dish list drops its inputs there: a greyed box invites an edit that
 * cannot happen, while the value in words still answers "when did it close".
 */
export function CutoffFields({
  value,
  label,
  problem,
  readOnlyReason,
  onChange,
}: {
  value: LocalCutoff;
  /** The cutoff in words, spelled as the database's own refusal spells it. */
  label: string;
  /** Null when the value makes sense, otherwise the sentence saying why not. */
  problem: string | null;
  /** Null when the cutoff can be moved, otherwise why it cannot. */
  readOnlyReason: string | null;
  onChange: (next: LocalCutoff) => void;
}) {
  if (readOnlyReason !== null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-subtle">Orders closed</span>
        <p className="pb-3 text-sm tabular text-muted">{label}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="cutoff-date" className="text-xs font-medium text-subtle">
          Orders close
        </label>
        <input
          id="cutoff-date"
          type="date"
          value={value.date}
          // An emptied box is a keystroke on the way to another date, not a
          // request to have no cutoff, and there is no such thing to send.
          onChange={(e) => e.target.value !== "" && onChange({ ...value, date: e.target.value })}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? "cutoff-problem" : undefined}
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-base"
        />
      </div>

      <div className="flex flex-col gap-1">
        {/* Visible "at" so the two boxes read as one sentence; the full name is
            what assistive tech announces, and contains the visible word. */}
        <label htmlFor="cutoff-time" className="text-xs font-medium text-subtle">
          at
        </label>
        <input
          id="cutoff-time"
          type="time"
          aria-label="Orders close at"
          value={value.time}
          onChange={(e) => e.target.value !== "" && onChange({ ...value, time: e.target.value })}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? "cutoff-problem" : undefined}
          className="h-11 rounded-md border border-border bg-surface-raised px-3 text-base tabular"
        />
      </div>

      {problem !== null && (
        <p id="cutoff-problem" className="basis-full text-sm text-danger-subtle-fg">
          {problem}
        </p>
      )}
    </div>
  );
}
