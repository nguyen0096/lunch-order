import { useId, useState } from "react";
import { SendIcon } from "lucide-react";
import {
  Action,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useAction,
} from "@/ui";
import { Section } from "../settings/Section.js";
import { AUDIENCES, audienceQuestion, reachSentence, sentSentence } from "./labels.js";
import { sendAnnouncement, type AnnouncementPerson, type Audience } from "../../api.js";

/** Telegram takes 4096 characters; an announcement that long is a document. */
const TEXT_MAX = 1000;

/** Who an audience actually comes down to, which is what the counts are of. */
export function audienceOf(
  people: ReadonlyArray<AnnouncementPerson>,
  audience: Audience,
  profileId: string | null,
): AnnouncementPerson[] {
  switch (audience) {
    case "office":
      return [...people];
    case "unpaid":
      return people.filter((p) => p.owedMinor > 0);
    case "person":
      return people.filter((p) => p.profileId === profileId);
  }
}

/**
 * A message from the admin to the office, sent now.
 *
 * The count comes before the send and both counts come after it, because the
 * two questions are different: "who is about to hear this" is the one the
 * admin is deciding on, and "who did not" is the one they will be asked on
 * Monday. A bare "Sent" answers neither.
 *
 * The person picker appears only for the audience that needs one. A disabled
 * picker beside two audiences it has nothing to do with is a control that says
 * the screen is broken, which is the lesson the People screen already paid for.
 */
export function Announcement({
  orgId,
  people,
  onSent,
}: {
  orgId: number;
  people: ReadonlyArray<AnnouncementPerson>;
  /** Refetch: a send changes nothing here, but a colleague may have connected. */
  onSent: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [audience, setAudience] = useState<Audience>("office");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const chosen = audienceOf(people, audience, profileId);
  const person = audience === "person" ? chosen[0] ?? null : null;

  const send = useAction(
    async () => sendAnnouncement({ orgId, audience, text, profileId: person?.profileId ?? null }),
    {
      success: (r) => sentSentence(r),
      onSuccess: () => {
        setConfirming(false);
        setText("");
        onSent();
      },
    },
  );

  const reason =
    text.trim() === ""
      ? "Type the message first"
      : audience === "person" && person === null
        ? "Choose who it goes to"
        : chosen.length === 0
          ? "Nobody is in this audience"
          : chosen.every((p) => !p.connected)
            ? "Nobody in this audience has connected Telegram"
            : null;

  return (
    <Section
      title="Send an announcement"
      description="Your own message, through the bot, to the office or to one person. It goes out as soon as you send it."
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-text`} className="text-sm font-medium">
          The message
        </label>
        <textarea
          id={`${id}-text`}
          value={text}
          rows={4}
          maxLength={TEXT_MAX}
          placeholder="No lunch on Friday, the caterer is closed."
          onChange={(e) => setText(e.target.value)}
          className="w-full min-w-0 rounded-md border border-border bg-surface-raised p-3 text-base text-text placeholder:text-subtle"
        />
        <p className="max-w-prose text-xs text-muted">
          Plain text, arriving as a message from the bot. Your name and the office are added at the
          end, so nobody has to guess who it is from.
        </p>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Who hears it</legend>
        {AUDIENCES.map((a) => (
          <label
            key={a.value}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 text-sm"
          >
            <input
              type="radio"
              name={`${id}-audience`}
              value={a.value}
              checked={audience === a.value}
              onChange={() => setAudience(a.value)}
              className="size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">{a.label}</span>
          </label>
        ))}
      </fieldset>

      {audience === "person" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-person`} className="text-sm font-medium">
            Who
          </label>
          <Combobox
            id={`${id}-person`}
            aria-label="Who"
            value={profileId}
            onChange={setProfileId}
            options={people.map((p) => ({
              value: p.profileId,
              label: p.connected ? p.name : `${p.name} · not on Telegram`,
            }))}
            placeholder="Choose a colleague"
            searchPlaceholder="Search people"
            emptyMessage="Nobody here goes by that."
            className="max-w-80"
          />
        </div>
      )}

      <p className="max-w-prose text-sm text-muted">{reachSentence(chosen)}</p>

      <div>
        <Action
          reason={reason}
          pending={send.pending}
          onClick={() => {
            send.reset();
            setConfirming(true);
          }}
        >
          <SendIcon />
          Send
        </Action>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{audienceQuestion(audience, person?.name ?? null)}</DialogTitle>
            <DialogDescription>{reachSentence(chosen)}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <p className="rounded-md bg-surface-sunken px-3 py-2 break-words whitespace-pre-wrap">
              {text}
            </p>
            <p className="text-muted">Nothing has gone out yet. This is the send.</p>
            {send.error !== null && (
              <p className="rounded-md bg-danger-subtle px-3 py-2 text-danger-subtle-fg">
                {send.error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Action reason={null} pending={send.pending} onClick={() => void send.run()}>
              {send.pending ? "Sending" : "Send"}
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
