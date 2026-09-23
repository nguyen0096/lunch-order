import { useState } from "react";
import { Action, useAction } from "@/ui";
import { Section, TimeField } from "./Section.js";
import { setDefaultCutoffLocalTime } from "../../api.js";

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * The cutoff every new menu starts from.
 *
 * Deliberately says twice over that it is a default: this writes
 * organizations.default_cutoff_local_time, which is read when a menu is
 * published and copied into menus.order_cutoff_at, and it is that copy the
 * ordering trigger enforces. So an admin who changes this expecting tomorrow's
 * published menu to move is about to be surprised, and the sentence that says
 * so is on the card, not in a release note.
 *
 * The office's timezone is what makes a time of day mean anything, and it is
 * not settable here -- so it is named in the hint rather than left implied.
 */
export function OrderCutoff({
  orgId,
  timezone,
  initial,
  onSaved,
}: {
  orgId: number;
  timezone: string;
  /** `HH:MM:SS`, as the `time` column reads back. */
  initial: string;
  onSaved: () => void;
}) {
  // What the database is known to hold, kept here so "Nothing to save" is true
  // the moment a save lands, without waiting for the refetch to come back.
  const [saved, setSaved] = useState(() => initial.slice(0, 5));
  const [time, setTime] = useState(saved);

  const save = useAction(
    async (hhmm: string) => {
      // Seconds written explicitly, so what goes in matches what comes back.
      await setDefaultCutoffLocalTime(orgId, `${hhmm}:00`);
      return hhmm;
    },
    {
      success: "Saved",
      // App's copy of the org is only refetched on an auth change, so the Menu
      // screen's suggested cutoff catches up on the next full load.
      onSuccess: (hhmm) => {
        setSaved(hhmm);
        onSaved();
      },
    },
  );

  const reason =
    time === ""
      ? "A cutoff cannot be blank"
      : !HHMM.test(time)
        ? "A cutoff is a time of day, like 21:00"
        : time === saved
          ? "Nothing to save"
          : null;

  return (
    <Section
      title="When ordering closes"
      description="The cutoff a menu is published with, unless you change it for that day. Ordering for a day closes the evening before, which is why this is an evening time."
    >
      <TimeField
        id="default-cutoff"
        label="Default cutoff"
        hint={`In ${timezone}, the office's timezone, which is not set on this screen.`}
        value={time}
        onChange={setTime}
      />

      <p className="max-w-prose text-sm text-muted">
        {HHMM.test(time) ? (
          <>
            For example, a menu for Tuesday will close at{" "}
            <strong className="text-text">{time} on Monday</strong>.
          </>
        ) : (
          "Every menu closes at some point, so this cannot be left empty."
        )}
      </p>

      {/* The one thing people get wrong, in the reading order rather than as a
          hint beside the field: this moves nothing that is already out. */}
      <p className="max-w-prose rounded-md bg-surface-sunken px-3 py-2 text-sm text-muted">
        This is the default for menus published from now on. It does not move a menu that is
        already published. To change when a published day closes, set that day&apos;s cutoff on the
        Menu screen.
      </p>

      <div>
        <Action reason={reason} pending={save.pending} onClick={() => void save.run(time)}>
          {save.pending ? "Saving" : "Save"}
        </Action>
      </div>
    </Section>
  );
}
