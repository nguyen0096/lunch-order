import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Skeleton } from "@/ui";
import { AutomaticMessage } from "./messages/AutomaticMessage.js";
import { Announcement } from "./messages/Announcement.js";
import { WhatTelegramNeeds } from "./messages/WhatTelegramNeeds.js";
import type { ScreenProps } from "./screenProps.js";
import {
  fetchAnnouncementAudience,
  fetchJoinCode,
  fetchNotificationSettings,
  fetchOrgSettings,
  humanError,
  type AnnouncementPerson,
  type NotificationSetting,
} from "../api.js";

type Loaded = {
  settings: NotificationSetting[];
  people: AnnouncementPerson[];
  /** Null when the bot has no group to post in. */
  groupChatId: number | null;
  joinCode: string | null;
};

/**
 * Everything the office says through Telegram, in one place.
 *
 * Until now the three automatic messages were timed inside
 * `private.run_hourly_tick` and nowhere else, and an admin who wanted to tell
 * the office that Friday was off had to type it into the group chat themselves
 * -- which reaches the room and not the people who read the bot instead. So
 * this screen answers two questions that had no home: what goes out by itself,
 * and how do I say something now.
 *
 * It is in the nav, unlike Corrections. Correcting a finished day is a rare
 * weekend job reached from the screen where it is noticed; deciding what the
 * office hears is something an admin comes back to.
 *
 * The order is what an admin came for first. The automatic messages are the
 * setting; the announcement is the errand; what Telegram needs is last because
 * it is the explanation for a screen that appears to do nothing, and an
 * explanation read before the thing it explains is just a warning.
 */
export function MessagesScreen({ me, org }: ScreenProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [settings, people, office, code] = await Promise.all([
        fetchNotificationSettings(org.id),
        fetchAnnouncementAudience({ orgId: org.id, meProfileId: me.profileId }),
        fetchOrgSettings(org.id),
        fetchJoinCode(org.id),
      ]);
      setData({
        settings,
        people,
        groupChatId: office.telegramGroupChatId,
        joinCode: code.code,
      });
      setLoadError(null);
    } catch (e) {
      // `useAction` owns every write. A read has no toast to fire and nothing
      // to put back, so its failure is a state this screen renders instead.
      setLoadError(humanError(e));
    }
  }, [org.id, me.profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const heading = (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">Messages</h1>
      <p className="max-w-prose text-sm text-muted">
        {`What ${org.name} sends through Telegram by itself, and what you send by hand.`}
      </p>
    </header>
  );

  if (loadError !== null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {heading}
        <EmptyState
          heading="Messages did not load"
          action={
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </EmptyState>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {heading}
        <MessagesSkeleton />
      </div>
    );
  }

  const untouched = data.settings.every((s) => !s.stored);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      {heading}

      <section aria-labelledby="automatic" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="automatic" className="text-xs font-semibold text-subtle">
            Sent by itself
          </h2>
          <p className="max-w-prose text-sm text-muted">
            {untouched
              ? "Nothing here has ever been changed, so these are the timings this office has run on all along."
              : "Each one is saved on its own. Turning one off leaves the others alone."}
          </p>
        </div>

        {data.settings.map((setting) => (
          <AutomaticMessage
            key={setting.kind}
            orgId={org.id}
            timezone={org.timezone}
            setting={setting}
          />
        ))}
      </section>

      <Announcement orgId={org.id} people={data.people} onSent={() => void load()} />

      <WhatTelegramNeeds
        slug={org.slug}
        groupChatId={data.groupChatId}
        joinCode={data.joinCode}
        people={data.people}
      />
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-surface-raised p-4 md:p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-full max-w-prose" />
          <Skeleton className="mt-4 h-11 w-full" />
        </div>
      ))}
    </div>
  );
}
