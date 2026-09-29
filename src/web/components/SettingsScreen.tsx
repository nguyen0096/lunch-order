import { useCallback, useEffect, useState } from "react";
import { CopyIcon, SendIcon } from "lucide-react";
import { Action, Badge, Button, EmptyState, Skeleton, cn, useAction } from "@/ui";
import { Section, TextField } from "./settings/Section.js";
import { PaymentAccount } from "./settings/PaymentAccount.js";
import { GroupChat } from "./settings/GroupChat.js";
import { OrderCutoff } from "./settings/OrderCutoff.js";
import { LeaveAndDelete } from "./settings/LeaveAndDelete.js";
import type { ScreenProps } from "./screenProps.js";
import {
  createTelegramLink,
  fetchOrgSettings,
  fetchStandingOrders,
  fetchTelegramLink,
  fetchUpcomingSkips,
  humanError,
  setDisplayName,
  setShortCode,
  setStandingOrder,
  shortCodeProblem,
  unlinkTelegram,
  SHORT_CODE_MAX,
  type OrgSettings,
  type TelegramLink,
} from "../api.js";
import { botDeepLink } from "../../shared/telegram.js";
import { isAdmin } from "../../shared/types.js";
import { formatDay, isoWeekday, todayIn, weekStart } from "../../shared/dates.js";
import { now as appNow } from "../../shared/clock.js";

/** ISO weekday, as standing_orders stores it: 1 = Monday .. 7 = Sunday. */
const WEEKDAYS: ReadonlyArray<{ iso: number; short: string; long: string }> = [
  { iso: 1, short: "Mon", long: "Monday" },
  { iso: 2, short: "Tue", long: "Tuesday" },
  { iso: 3, short: "Wed", long: "Wednesday" },
  { iso: 4, short: "Thu", long: "Thursday" },
  { iso: 5, short: "Fri", long: "Friday" },
  { iso: 6, short: "Sat", long: "Saturday" },
  { iso: 7, short: "Sun", long: "Sunday" },
];

type Loaded = {
  standing: Set<number>;
  /** My skips after today, soonest first. */
  skips: string[];
  link: TelegramLink | null;
  /** Null for a member: there is nothing on the office half for them to see. */
  office: OrgSettings | null;
};

export type SettingsScreenProps = ScreenProps & {
  /**
   * What happens once this office stops being yours. Overridden only by a test:
   * App hands this screen the three `ScreenProps` and nothing else.
   */
  onGone?: () => void;
};

/**
 * Where you stand after leaving or deleting: back at the top, reloaded.
 *
 * A reload rather than a route change, because `me` is fetched once in App and
 * still holds the office that has just gone. Navigating with it in memory lands
 * on a board whose every query now returns nothing, which is the failure this
 * has to avoid. Reloading re-asks the database who I am, and App's own redirect
 * then picks the next office or the screen for belonging nowhere. A page load
 * is not a cost anybody notices once, on the way out.
 */
function startOver() {
  window.location.hash = "#/";
  window.location.reload();
}

/**
 * Two audiences on one page.
 *
 * Yours is everything a member sets once and forgets: which days they eat by
 * default, how the bot reaches them, what the office calls them. Your office is
 * the admin's org-wide settings, and a member does not see it at all --
 * rather than seeing it greyed out, which is what made the People screen look
 * broken while it was working correctly. An absent section with a sentence
 * naming who does set it beats a row of controls nobody can explain.
 *
 * The bank account is the exception inside the exception: an admin sees it and
 * an owner alone can change it, so PaymentAccount takes the role rather than
 * the admin flag. An admin who reads bills needs to know the account; they do
 * not need a form the database will refuse.
 *
 * The theme is deliberately not here. It lives in the account menu beside sign
 * out, because it is the one preference somebody changes on a whim and wants to
 * see take effect in the same breath.
 *
 * Leaving and deleting are last, behind a rule: terminal actions do not belong
 * above the setting somebody actually came for.
 */
export function SettingsScreen({ me, org, role, onGone = startOver }: SettingsScreenProps) {
  const admin = isAdmin(role);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [standing, skips, link, office] = await Promise.all([
        fetchStandingOrders(org.id, me.profileId),
        fetchUpcomingSkips({
          orgId: org.id,
          profileId: me.profileId,
          after: todayIn(org.timezone, appNow()),
        }),
        fetchTelegramLink(org.id),
        admin ? fetchOrgSettings(org.id) : Promise.resolve(null),
      ]);
      setData({ standing, skips, link, office });
      setLoadError(null);
    } catch (e) {
      // useAction covers every write. A read has no toast to fire and nothing
      // to revert, so its failure is a state this screen renders instead.
      setLoadError(humanError(e));
    }
  }, [admin, org.id, org.timezone, me.profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const heading = (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="max-w-prose text-sm text-muted">
        {`Things you set once and forget, for ${org.name}.`}
      </p>
    </header>
  );

  if (loadError !== null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {heading}
        <EmptyState
          heading="Settings did not load"
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
        <SettingsSkeleton count={admin ? 7 : 4} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      {heading}

      <section aria-labelledby="yours" className="flex flex-col gap-4">
        <h2 id="yours" className="text-xs font-semibold text-subtle">
          Yours
        </h2>
        <StandingDays
          orgId={org.id}
          orgSlug={org.slug}
          weekStartsOn={org.billingWeekStartsOn}
          profileId={me.profileId}
          enabled={data.standing}
          skips={data.skips}
          onChange={(next) => setData((d) => (d ? { ...d, standing: next } : d))}
        />
        <Telegram
          orgId={org.id}
          link={data.link}
          onChange={(link) => setData((d) => (d ? { ...d, link } : d))}
        />
        <DisplayName
          orgId={org.id}
          profileId={me.profileId}
          initial={me.orgs.find((o) => o.org.id === org.id)?.displayName ?? me.fullName}
        />
        <ShortCode
          orgId={org.id}
          profileId={me.profileId}
          initial={me.orgs.find((o) => o.org.id === org.id)?.shortCode ?? ""}
          admin={admin}
          changesLeft={me.orgs.find((o) => o.org.id === org.id)?.shortCodeChangesLeft ?? 1}
        />
      </section>

      {admin && data.office !== null ? (
        <section aria-labelledby="office" className="flex flex-col gap-4">
          <h2 id="office" className="text-xs font-semibold text-subtle">
            Your office
          </h2>
          <OrderCutoff
            orgId={org.id}
            timezone={org.timezone}
            initial={data.office.defaultCutoffLocalTime}
            onSaved={() => void load()}
          />
          <PaymentAccount
            orgId={org.id}
            owner={role === "owner"}
            initial={data.office.payment}
            onSaved={() => void load()}
          />
          <GroupChat
            orgId={org.id}
            initial={data.office.telegramGroupChatId}
            onSaved={() => void load()}
          />
        </section>
      ) : (
        <p className="max-w-prose text-sm text-muted">
          {`The time ordering closes and the group chat the bot posts in are set by an admin of ${org.name}, and the bank account bills are paid into is set by an owner.`}
        </p>
      )}

      <LeaveAndDelete org={org} profileId={me.profileId} role={role} onGone={onGone} />
    </div>
  );
}

/* ------------------------------------------------------------ standing days */

function StandingDays({
  orgId,
  orgSlug,
  weekStartsOn,
  profileId,
  enabled,
  skips,
  onChange,
}: {
  orgId: number;
  orgSlug: string;
  weekStartsOn: number;
  profileId: string;
  enabled: Set<number>;
  skips: string[];
  onChange: (next: Set<number>) => void;
}) {
  // A skip on a weekday no longer in the rule skips nothing, so it is not
  // counted, though it is kept in case the weekday comes back.
  const skipped = skips.filter((d) => enabled.has(isoWeekday(d)));
  const first = skipped[0] ?? null;
  const toggle = useAction(
    async (a: { weekday: number; enabled: boolean; long: string }) => {
      await setStandingOrder({ orgId, profileId, weekday: a.weekday, enabled: a.enabled });
      return a;
    },
    {
      success: (a) => (a.enabled ? `${a.long} added` : `${a.long} removed`),
      onSuccess: (a) => {
        const next = new Set(enabled);
        if (a.enabled) next.add(a.weekday);
        else next.delete(a.weekday);
        onChange(next);
      },
    },
  );

  return (
    <Section
      title="Standing days"
      description="The days you go on the order by yourself, as soon as a menu is published. You can still change any day on the board."
    >
      <div className="flex flex-wrap gap-2">
        {WEEKDAYS.map((d) => {
          const on = enabled.has(d.iso);
          return (
            <Action
              key={d.iso}
              // One write at a time, and the control says which. A second tap
              // dropped in silence would look exactly like a day that saved.
              reason={toggle.pending ? "Saving your last change" : null}
              variant="outline"
              aria-label={d.long}
              aria-pressed={on}
              className={cn(
                "min-w-16",
                on && "border-accent bg-accent-subtle text-accent-subtle-fg",
              )}
              onClick={() => void toggle.run({ weekday: d.iso, enabled: !on, long: d.long })}
            >
              {d.short}
            </Action>
          );
        })}
      </div>
      <p className="max-w-prose text-sm text-muted">
        {enabled.size === 0
          ? "No standing days. Tap a day above, or keep ordering day by day on the board."
          : "A published menu is what puts you on the board, and the cutoff still applies."}
      </p>
      <p className="max-w-prose text-sm text-muted">
        Skip single days by tapping them on the Board.
        {first !== null && (
          <>
            {" "}
            <a
              className="font-medium text-text underline underline-offset-4"
              href={`#/o/${orgSlug}/board?week=${weekStart(first, weekStartsOn)}`}
              title={`The week of ${formatDay(first)}`}
            >
              {skipped.length === 1 ? "1 upcoming day skipped" : `${skipped.length} upcoming days skipped`}
            </a>
          </>
        )}
      </p>
    </Section>
  );
}

/* ---------------------------------------------------------------- telegram */

function Telegram({
  orgId,
  link,
  onChange,
}: {
  orgId: number;
  link: TelegramLink | null;
  onChange: (next: TelegramLink | null) => void;
}) {
  // Read at render, not at module load, so a build that ships without a bot
  // username and one that ships with it take the same path through here.
  const bot = (import.meta.env.VITE_TELEGRAM_BOT ?? "").trim();
  const deepLink = link === null ? null : botDeepLink(bot, link.linkToken);
  const command = link === null ? "" : `/start ${link.linkToken}`;

  // Also the "check again" control: create_my_telegram_link is idempotent and hands back the
  // row's current chat_id, so asking for the link a second time is how a member
  // finds out the bot has answered.
  const connect = useAction(async () => createTelegramLink(orgId), {
    success: (next) => (next.linked ? "Connected" : "Link ready"),
    onSuccess: (next) => onChange(next),
  });

  const disconnect = useAction(
    async (membershipId: number) => {
      await unlinkTelegram(membershipId);
      return membershipId;
    },
    {
      success: "Disconnected",
      onSuccess: () => onChange(link === null ? null : { ...link, linked: false }),
    },
  );

  const copy = useAction(
    async (text: string) => {
      if (!navigator.clipboard) {
        throw new Error("This browser will not let the page copy. Select the text and copy it.");
      }
      await navigator.clipboard.writeText(text);
    },
    { success: "Copied" },
  );

  return (
    <Section
      title="Telegram"
      description="Order from a chat instead of this page, and get a nudge before the cutoff."
      aside={
        link?.linked ? (
          <Badge variant="success">Connected</Badge>
        ) : (
          <Badge variant="neutral">Not connected</Badge>
        )
      }
    >
      {link === null ? (
        <>
          <p className="max-w-prose text-sm text-muted">
            Nothing set up yet. Connecting mints a private code that ties one Telegram chat to you,
            so it is made when you ask for it and not before.
          </p>
          <div>
            <Action reason={null} pending={connect.pending} onClick={() => void connect.run()}>
              <SendIcon />
              {connect.pending ? "Connecting" : "Connect Telegram"}
            </Action>
          </div>
        </>
      ) : link.linked ? (
        <>
          <p className="max-w-prose text-sm text-muted">
            The bot can reach you. Disconnecting stops it; your code is kept, so coming back is one
            tap.
          </p>
          <div>
            <Action
              reason={null}
              pending={disconnect.pending}
              variant="outline"
              onClick={() => void disconnect.run(link.membershipId)}
            >
              {disconnect.pending ? "Disconnecting" : "Disconnect"}
            </Action>
          </div>
        </>
      ) : deepLink !== null ? (
        <>
          <p className="max-w-prose text-sm text-muted">
            Open the bot and it connects itself. Come back here afterwards and check.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={deepLink} target="_blank" rel="noreferrer">
                <SendIcon />
                Open Telegram
              </a>
            </Button>
            <Action
              reason={null}
              pending={connect.pending}
              variant="outline"
              onClick={() => void connect.run()}
            >
              Check again
            </Action>
          </div>
        </>
      ) : (
        <>
          <p className="max-w-prose text-sm text-muted">
            This app was built with no bot username, so there is no link to tap. Send this to your
            office&apos;s lunch bot and it connects the same way.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm">
              {command}
            </code>
            <Action
              reason={null}
              pending={copy.pending}
              variant="outline"
              onClick={() => void copy.run(command)}
            >
              <CopyIcon />
              Copy
            </Action>
          </div>
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------ display name */

function DisplayName({
  orgId,
  profileId,
  initial,
}: {
  orgId: number;
  profileId: string;
  initial: string;
}) {
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial);

  const save = useAction(
    async (next: string) => {
      await setDisplayName({ orgId, profileId, displayName: next });
      return next.trim();
    },
    {
      success: "Saved",
      // The sidebar's copy of this name comes from App's `me`, which is only
      // refetched on an auth change, so it catches up on the next full load.
      onSuccess: (next) => setSaved(next),
    },
  );

  const trimmed = name.trim();
  const reason =
    trimmed === ""
      ? "A display name cannot be blank"
      : trimmed === saved.trim()
        ? "Nothing to save"
        : null;

  return (
    <Section
      title="Display name"
      description="What colleagues see next to your lunch on the board. It is per office, so you can be Neyu here and your full name somewhere else."
    >
      <TextField
        id="display-name"
        label="Display name"
        value={name}
        onChange={setName}
        placeholder="Neyu"
        maxLength={80}
      />
      <div>
        <Action reason={reason} pending={save.pending} onClick={() => void save.run(name)}>
          {save.pending ? "Saving" : "Save"}
        </Action>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- short code */

/**
 * The code that goes in a bank memo, next to the name that goes on the board.
 *
 * It is generated from the first four characters of a full name, which is fine
 * for "Chi Nguyen" and lands "Quy Tu Nguyen" on QUYT. Vietnamese names produce
 * the occasional word nobody wants to send to a colleague, and this is the
 * field that fixes it.
 *
 * Uppercased as it is typed, because the CHECK is `^[A-Z0-9]{2,8}$` and a
 * lowercase code is refused for a reason the person cannot see. Whether it is
 * too close to a colleague's is only ever a server answer, and the server's
 * sentence names the colleague's code, so it is shown as it comes.
 *
 * A member changes their own once after joining; the database counts it, and
 * this only says so before they try. An admin is never out of changes.
 */
function ShortCode({
  orgId,
  profileId,
  initial,
  admin,
  changesLeft,
}: {
  orgId: number;
  profileId: string;
  initial: string;
  admin: boolean;
  changesLeft: number;
}) {
  const [saved, setSaved] = useState(initial);
  const [code, setCode] = useState(initial);
  const [left, setLeft] = useState(changesLeft);

  const save = useAction(
    async (next: string) => setShortCode({ orgId, profileId, shortCode: next }),
    {
      success: "Saved",
      onSuccess: (stored) => {
        setSaved(stored);
        if (!admin) setLeft((n) => Math.max(n - 1, 0));
      },
    },
  );

  const reason =
    !admin && left === 0
      ? "You have used your one change. An admin can change it for you."
      : (shortCodeProblem(code) ?? (code === saved ? "Nothing to save" : null));

  const allowance = admin
    ? "As an admin you can change it whenever you need to."
    : left > 0
      ? "You can change it once. After that, an admin can change it for you."
      : "You have used your one change. An admin can change it for you.";

  return (
    <Section
      title="Short code"
      description="What appears in the memo of a bank transfer when you pay a bill, and beside your name on the People screen. Short and uppercase because somebody types it into a banking app."
    >
      <TextField
        id="short-code"
        label="Short code"
        hint={`Two to ${SHORT_CODE_MAX} letters or digits, and not one that contains a colleague's or sits inside it. ${allowance}`}
        value={code}
        // Uppercased here rather than on save, so the field shows what will be
        // stored instead of correcting it after the fact.
        onChange={(next) => setCode(next.toUpperCase())}
        placeholder="QUYT"
        maxLength={SHORT_CODE_MAX}
        className="max-w-44"
        disabled={!admin && left === 0}
      />
      <p className="max-w-prose text-sm text-muted">
        Changing it does not rewrite a bill you already have. The reference on each week&apos;s
        statement is written when that week is billed, so a transfer you have already sent still
        matches; the new code is used from the next billing run on.
      </p>
      <div>
        <Action reason={reason} pending={save.pending} onClick={() => void save.run(code)}>
          {save.pending ? "Saving" : "Save"}
        </Action>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ loading */

function SettingsSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-border bg-surface-raised p-4 md:p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-full max-w-prose" />
          <Skeleton className="mt-4 h-11 w-full" />
        </div>
      ))}
    </div>
  );
}
