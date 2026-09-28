import { useId, useState } from "react";
import { SendIcon } from "lucide-react";
import { Action, cn, useAction } from "@/ui";
import { Section, TextField } from "../settings/Section.js";
import {
  HOURS,
  KIND_COPY,
  hourLabel,
  pendingSentence,
  savedSentence,
  testSentence,
} from "./labels.js";
import {
  saveNotificationSetting,
  sendTestNotification,
  type NotificationSetting,
} from "../../api.js";

/**
 * `org_notifications_minutes_ck`, mirrored so the floor is read before it is
 * hit rather than after. The floor is not taste: the tick runs once an hour and
 * tests a window of this length, so a window shorter than an hour falls between
 * two ticks and the last call is never sent at all.
 */
const MINUTES_MIN = 60;
const MINUTES_MAX = 1440;

function minutesProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "Say how many minutes before the cutoff";
  if (!/^[0-9]+$/.test(text)) return "Minutes are a whole number, like 70";
  const n = Number(text);
  if (n < MINUTES_MIN || n > MINUTES_MAX) {
    return `Between ${MINUTES_MIN} and ${MINUTES_MAX} minutes before the cutoff`;
  }
  return null;
}

/**
 * One of the messages the office sends by itself.
 *
 * Each one is its own card and its own save, because they are unrelated
 * decisions: an office that wants no last call still wants the bill, and a
 * single Save across all of them would make turning one off look like a change
 * to everything. Turning one off is also the only thing on this screen that
 * quietly stops something the office already relies on, so the card says in a
 * sentence what it does now and what saving would change it to.
 *
 * The timing lives where it applies and nowhere else. A menu announcement goes
 * out when a menu is published, so it has no time to set and says so; showing
 * it an empty box would invite somebody to fill one in.
 */
export function AutomaticMessage({
  orgId,
  timezone,
  setting,
}: {
  orgId: number;
  timezone: string;
  setting: NotificationSetting;
}) {
  const copy = KIND_COPY[setting.kind];
  const fieldId = useId();

  // What the database is known to hold, kept here so "Nothing to save" is true
  // the moment a save lands, without waiting for a refetch to come back.
  const [saved, setSaved] = useState(setting);
  const [enabled, setEnabled] = useState(setting.enabled);
  const [minutes, setMinutes] = useState(String(setting.minutesBefore ?? ""));
  const [hour, setHour] = useState(setting.atLocalHour ?? 0);

  // What Save would write, which is also what the sentence below previews.
  const draft = {
    kind: setting.kind,
    enabled,
    minutesBefore: copy.timing === "minutes" ? Number(minutes.trim()) : null,
    atLocalHour: copy.timing === "hour" ? hour : null,
  };

  const save = useAction(async () => saveNotificationSetting({ orgId, ...draft }), {
    // The row the database hands back, not the draft, so the sentence reports
    // what is stored rather than what was typed.
    success: (next) => savedSentence(next),
    onSuccess: (next) => setSaved(next),
  });

  const test = useAction(async () => sendTestNotification({ orgId, kind: setting.kind }), {
    success: (r) => testSentence(r.queued),
  });

  const problem = copy.timing === "minutes" ? minutesProblem(minutes) : null;
  const unchanged =
    enabled === saved.enabled &&
    (copy.timing !== "minutes" || Number(minutes.trim()) === saved.minutesBefore) &&
    (copy.timing !== "hour" || hour === saved.atLocalHour);
  const reason = problem ?? (unchanged ? "Nothing to save" : null);

  return (
    <Section
      title={copy.title}
      description={copy.what}
      aside={
        <Action
          reason={null}
          variant="outline"
          aria-label={copy.toggle}
          aria-pressed={enabled}
          className={cn(
            "min-w-16",
            enabled && "border-accent bg-accent-subtle text-accent-subtle-fg",
          )}
          onClick={() => setEnabled(!enabled)}
        >
          {enabled ? "On" : "Off"}
        </Action>
      }
    >
      {copy.timing === "minutes" && (
        <TextField
          id={`${fieldId}-minutes`}
          label="Minutes before the cutoff"
          hint="70 is what every office has run on. The bot wakes once an hour, so anything under 60 minutes can fall between two of those and never go out."
          value={minutes}
          onChange={setMinutes}
          placeholder="70"
          inputMode="numeric"
          maxLength={4}
          className="max-w-44"
        />
      )}

      {copy.timing === "hour" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-hour`} className="text-sm font-medium">
            Hour of the day
          </label>
          {/* A select rather than a time field: the column holds an hour, and a
              time control invites a 09:30 the database cannot keep. */}
          <select
            id={`${fieldId}-hour`}
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            aria-describedby={`${fieldId}-hour-hint`}
            className="h-11 w-full max-w-44 min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base text-text"
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
          <p id={`${fieldId}-hour-hint`} className="max-w-prose text-xs text-muted">
            {`In ${timezone}, the office's timezone, which is not set on this screen.`}
          </p>
        </div>
      )}

      {copy.timing === "none" && (
        <p className="max-w-prose text-sm text-muted">This one has no time to set.</p>
      )}

      <p className="max-w-prose text-sm text-muted">
        {unchanged || problem !== null ? savedSentence(saved) : pendingSentence(draft)}
      </p>

      <div className="flex flex-wrap gap-2">
        <Action reason={reason} pending={save.pending} onClick={() => void save.run()}>
          {save.pending ? "Saving" : "Save"}
        </Action>
        {/* No confirmation: this reaches you and nobody else, and reading the
            message is the only way to know what the office will read. */}
        <Action
          reason={null}
          pending={test.pending}
          variant="outline"
          aria-label={`Send me a test of ${copy.noun}`}
          onClick={() => void test.run()}
        >
          <SendIcon />
          {test.pending ? "Sending" : "Send me a test"}
        </Action>
      </div>
    </Section>
  );
}
