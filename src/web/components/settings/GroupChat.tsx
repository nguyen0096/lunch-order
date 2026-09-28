import { useState } from "react";
import { Action, Badge, useAction } from "@/ui";
import { Section, TextField } from "./Section.js";
import { setTelegramGroupChatId } from "../../api.js";

const INTEGER = /^-?[0-9]+$/;

/** The typed value as a chat id, or null for "clear it", or false for "not a number". */
function parseChatId(raw: string): number | null | false {
  const text = raw.trim();
  if (text === "") return null;
  if (!INTEGER.test(text)) return false;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : false;
}

/**
 * The group the bot posts in.
 *
 * Labelled as the fallback it is. The id is normally discovered by the bot
 * from the first message it sees in the group, and an admin who is told to
 * come here and type it will mostly not know what to type -- so the field says
 * where the number comes from rather than implying this is the way in.
 */
export function GroupChat({
  orgId,
  initial,
  onSaved,
}: {
  orgId: number;
  initial: number | null;
  onSaved: () => void;
}) {
  const [saved, setSaved] = useState<number | null>(initial);
  const [text, setText] = useState(initial === null ? "" : String(initial));

  const save = useAction(
    async (chatId: number | null) => {
      await setTelegramGroupChatId(orgId, chatId);
      return chatId;
    },
    {
      success: (chatId) => (chatId === null ? "Cleared" : "Saved"),
      onSuccess: (chatId) => {
        setSaved(chatId);
        onSaved();
      },
    },
  );

  const parsed = parseChatId(text);
  const reason =
    parsed === false
      ? "A chat id is a whole number, like -1001234567890"
      : parsed === saved
        ? "Nothing to save"
        : null;

  return (
    <Section
      title="Telegram group chat"
      description="Where the bot posts the day's order and the reminder before the cutoff."
      aside={
        saved === null ? (
          <Badge variant="warn">Not set</Badge>
        ) : (
          <Badge variant="success">Set</Badge>
        )
      }
    >
      {saved === null && (
        <p className="max-w-prose rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
          The bot has no group to post in, so nothing has been posted.
        </p>
      )}

      <TextField
        id="group-chat-id"
        label="Chat id"
        hint="The bot normally fills this in itself, from the first message it sees in your group. Type it here only if you already know the number; it usually starts with -100. Leave it empty to clear."
        value={text}
        onChange={setText}
        placeholder="-1001234567890"
        inputMode="tel"
        maxLength={24}
      />

      <div>
        <Action
          reason={reason}
          pending={save.pending}
          onClick={() => parsed !== false && void save.run(parsed)}
        >
          {save.pending ? "Saving" : "Save"}
        </Action>
      </div>
    </Section>
  );
}
