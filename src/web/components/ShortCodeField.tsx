/**
 * The short code somebody picks on the way into an office.
 *
 * Optional: blank is "make one from my name", which is what joining always did.
 * Picking it here is free, and it is the moment to pick it, because after
 * joining a member may change their own code once and then only an admin can.
 */

import { useId } from "react";
import { SHORT_CODE_MAX, shortCodeProblem } from "../api.js";

const INPUT =
  "h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text placeholder:text-subtle";

/** Null when the field can be sent as it is, blank included. */
export function onboardingCodeProblem(code: string): string | null {
  return code.trim() === "" ? null : shortCodeProblem(code);
}

export function ShortCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Your short code <span className="font-normal text-muted">(optional)</span>
      </label>
      <input
        id={id}
        value={value}
        maxLength={SHORT_CODE_MAX}
        autoCapitalize="characters"
        placeholder="From your initials"
        aria-describedby={`${id}-hint`}
        className={`${INPUT} tabular uppercase`}
        // Uppercased as typed: the database stores it that way, and a field
        // showing one spelling while saving another invites a second try.
        onChange={(e) => onChange(e.target.value.toUpperCase())}
      />
      <p id={`${id}-hint`} className="max-w-prose text-xs text-muted">
        {`What goes in the memo when you pay for lunch. Two to ${SHORT_CODE_MAX} letters or digits, and not one that contains a colleague's or sits inside it. Leave it blank and it is made from your initials. You can change it once later; after that an admin can.`}
      </p>
    </div>
  );
}
