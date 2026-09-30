import type { ReactNode } from "react";
import { Badge, Button } from "@/ui";
import { Section } from "../settings/Section.js";
import { peopleWord } from "../orders/model.js";
import type { AnnouncementPerson } from "../../api.js";

/**
 * Why nothing sends, for an admin who has just found this screen.
 *
 * Everything above it is a control that does nothing until the bot has a group
 * to post in and colleagues who have connected, and neither of those is set
 * here. So this states where each one stands and links to the screen that owns
 * it: a second copy of the group chat field would be two places to change one
 * setting, and they would disagree the first time somebody used the other.
 */
export function WhatTelegramNeeds({
  slug,
  groupChatId,
  joinCode,
  people,
}: {
  slug: string;
  /** Null when the bot has no group to post in. */
  groupChatId: number | null;
  /** Null when the office has never had a join code. */
  joinCode: string | null;
  people: ReadonlyArray<AnnouncementPerson>;
}) {
  const connected = people.filter((p) => p.connected).length;

  return (
    <Section
      title="What Telegram needs to work"
      description="Nothing on this screen reaches anybody until the bot has somewhere to post and somebody to post to."
    >
      <ul className="flex flex-col">
        <Fact
          title="The group chat"
          badge={
            groupChatId === null ? (
              <Badge variant="warn">Not set</Badge>
            ) : (
              <Badge variant="success">Set</Badge>
            )
          }
          link={{ href: `#/o/${slug}/settings`, label: "Set it in Settings" }}
        >
          {groupChatId === null
            ? "The bot has no group to post in, so the menu and the last call go to people one by one and to no room at all."
            : "The menu and the last call are posted in your group, as well as to each person who has connected."}
        </Fact>

        <Fact
          title="The office join code"
          badge={
            joinCode === null ? (
              <Badge variant="warn">None yet</Badge>
            ) : (
              <Badge variant="success">Set</Badge>
            )
          }
          link={{ href: `#/o/${slug}/people`, label: "See it on People" }}
        >
          {joinCode === null
            ? "Without a code nobody can join this office from Telegram, which is how most people arrive."
            : "Somebody with the code can join this office from Telegram, and is connected the moment they do."}
        </Fact>

        <Fact
          title="Who the bot can reach"
          badge={
            connected === 0 ? (
              <Badge variant="warn">Nobody</Badge>
            ) : (
              <Badge variant="neutral">{`${connected} of ${people.length}`}</Badge>
            )
          }
        >
          {`${connected} of ${peopleWord(people.length)} in this office ${
            connected === 1 ? "has" : "have"
          } connected Telegram. The rest hear nothing until they do, which each of them does on their own Settings screen.`}
        </Fact>
      </ul>
    </Section>
  );
}

function Fact({
  title,
  badge,
  link,
  children,
}: {
  title: string;
  badge: ReactNode;
  /** Absent where there is nothing for an admin to go and change. */
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
      <span className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm font-medium break-words">{title}</span>
        {badge}
      </span>
      <p className="max-w-prose text-sm text-muted">{children}</p>
      {link && (
        <Button asChild variant="link" size="sm" className="h-auto self-start px-0">
          <a href={link.href}>{link.label}</a>
        </Button>
      )}
    </li>
  );
}
