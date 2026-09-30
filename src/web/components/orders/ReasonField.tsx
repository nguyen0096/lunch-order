import { useId } from "react";
import { REASON_MAX } from "../../api.js";

/**
 * Why this change was made, if there is anything to say.
 *
 * Optional, and never nagged at. A correction made on a Saturday with the
 * caterer still on the phone is worth recording whether or not there was time
 * to type the story, so nothing here blocks the save. The limit is the
 * column's own, so a long explanation is cut where it is typed rather than
 * lost to a refusal after the fact.
 */
export function ReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-subtle">
        Why (optional)
      </label>
      <input
        id={id}
        value={value}
        maxLength={REASON_MAX}
        placeholder="caterer delivered 1 extra, verbal order from Tèo"
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base"
      />
      <p className="text-xs text-subtle">Kept with the change, for whoever reads the day later.</p>
    </div>
  );
}
