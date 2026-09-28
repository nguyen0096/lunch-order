/**
 * What the office sends through Telegram: the three messages the hourly tick
 * sends by itself, and the two an admin sends by hand.
 *
 * The timings used to be written into `private.run_hourly_tick` and nowhere
 * else, so `NOTIFICATION_DEFAULTS` below is that function's behaviour written
 * down. It is not a fallback for a failed read: `org_notifications` holds a row
 * only once somebody has saved one, which is no office at all today, and a
 * screen that rendered a missing row as "off" or as an empty box would be
 * describing something the office has never done.
 *
 * Sending is two RPCs, which own the outbox rows and the refusals. Neither is
 * reimplemented here, and every sentence they refuse with is written for a
 * person and reaches one unedited.
 */

import { supabase } from "../supabase.js";
import { fetchOrgMembers } from "./people.js";

export const NOTIFICATION_KINDS = ["menu_published", "cutoff_warning", "weekly_bill"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationSetting = {
  kind: NotificationKind;
  enabled: boolean;
  /** Minutes before a day's cutoff. Only `cutoff_warning` carries one. */
  minutesBefore: number | null;
  /** Hour of the day in the office's own zone. Only `weekly_bill` carries one. */
  atLocalHour: number | null;
  /**
   * False while the office has no row for this kind, which is every office
   * until an admin saves one. The values are then the tick's own.
   */
  stored: boolean;
};

type Timings = Pick<NotificationSetting, "enabled" | "minutesBefore" | "atLocalHour">;

/** What the tick has always done: 70 minutes before a cutoff, the bill at 09:00. */
export const NOTIFICATION_DEFAULTS: Record<NotificationKind, Timings> = {
  menu_published: { enabled: true, minutesBefore: null, atLocalHour: null },
  cutoff_warning: { enabled: true, minutesBefore: 70, atLocalHour: null },
  weekly_bill: { enabled: true, minutesBefore: null, atLocalHour: 9 },
};

type SettingRow = {
  kind: string;
  enabled: boolean;
  minutes_before: number | null;
  at_local_hour: number | null;
};

/**
 * All three kinds, always, in the order the screen lists them.
 *
 * A kind is given back the number it means and nothing else: a stored
 * `minutes_before` on the weekly bill is a column that means nothing there, and
 * reading it would put a figure on screen that changes nothing when saved.
 */
export async function fetchNotificationSettings(orgId: number): Promise<NotificationSetting[]> {
  const { data, error } = await supabase
    .from("org_notifications")
    .select("kind, enabled, minutes_before, at_local_hour")
    .eq("org_id", orgId);
  if (error) throw error;

  const rows = new Map((data ?? []).map((r) => [(r as SettingRow).kind, r as SettingRow]));

  return NOTIFICATION_KINDS.map((kind) => {
    const fallback = NOTIFICATION_DEFAULTS[kind];
    const row = rows.get(kind);
    if (row === undefined) return { kind, ...fallback, stored: false };
    return {
      kind,
      enabled: row.enabled,
      // A row saved before this kind carried a number, or saved with the
      // column left null, still has to show the timing it runs on.
      minutesBefore: kind === "cutoff_warning" ? row.minutes_before ?? fallback.minutesBefore : null,
      atLocalHour: kind === "weekly_bill" ? row.at_local_hour ?? fallback.atLocalHour : null,
      stored: true,
    };
  });
}

/**
 * One kind, one row, one save. Upsert rather than update: the first save for an
 * office is an insert, and asking the screen to know which is which would make
 * the very first change the one that fails.
 */
export async function saveNotificationSetting(args: {
  orgId: number;
  kind: NotificationKind;
  enabled: boolean;
  minutesBefore: number | null;
  atLocalHour: number | null;
}): Promise<NotificationSetting> {
  const { data, error } = await supabase
    .from("org_notifications")
    .upsert(
      {
        org_id: args.orgId,
        kind: args.kind,
        enabled: args.enabled,
        minutes_before: args.kind === "cutoff_warning" ? args.minutesBefore : null,
        at_local_hour: args.kind === "weekly_bill" ? args.atLocalHour : null,
      },
      { onConflict: "org_id,kind" },
    )
    .select("kind, enabled, minutes_before, at_local_hour")
    .maybeSingle();
  if (error) throw error;
  // RLS declines a write by matching no rows rather than by raising, and a
  // screen that does not look would report a save that never happened.
  if (!data) {
    throw new Error("That did not save. You need to be an admin of this office.");
  }

  const row = data as SettingRow;
  return {
    kind: args.kind,
    enabled: row.enabled,
    minutesBefore: args.kind === "cutoff_warning" ? row.minutes_before : null,
    atLocalHour: args.kind === "weekly_bill" ? row.at_local_hour : null,
    stored: true,
  };
}

/* ------------------------------------------------------------------ sending */

/**
 * `returns table (...)` reaches PostgREST as an array and a composite as an
 * object. Which one these are is the migration's business, not the screen's.
 */
function onlyRow<T>(data: unknown): T | null {
  return ((Array.isArray(data) ? data[0] : data) ?? null) as T | null;
}

export type Audience = "office" | "person" | "unpaid";

export type AnnouncementResult = {
  /** Messages the bot has been handed, which is people it will reach. */
  queued: number;
  /** People in the audience with no Telegram chat, so nothing was queued. */
  unreachable: number;
};

/**
 * A message from an admin to people, now.
 *
 * Both numbers are reported to the admin rather than only the first: "sent to
 * 9" hides four colleagues who heard nothing and will be surprised on Monday.
 */
export async function sendAnnouncement(args: {
  orgId: number;
  audience: Audience;
  text: string;
  /** The one person, for the 'person' audience. Null for the other two. */
  profileId: string | null;
}): Promise<AnnouncementResult> {
  const { data, error } = await supabase.rpc("send_announcement", {
    p_org_id: args.orgId,
    p_audience: args.audience,
    p_text: args.text.trim(),
    p_profile_id: args.profileId,
  });
  if (error) throw error;

  const row = onlyRow<{ queued: number | string; unreachable: number | string }>(data);
  if (row === null) {
    throw new Error("The announcement did not come back. Check Telegram before sending it again.");
  }
  return { queued: Number(row.queued), unreachable: Number(row.unreachable) };
}

/** One of the automatic messages, to the admin asking for it and nobody else. */
export async function sendTestNotification(args: {
  orgId: number;
  kind: NotificationKind;
}): Promise<{ queued: number }> {
  const { data, error } = await supabase.rpc("send_test_notification", {
    p_org_id: args.orgId,
    p_kind: args.kind,
  });
  if (error) throw error;

  const row = onlyRow<{ queued: number | string }>(data);
  if (row === null) {
    throw new Error("The test did not come back. Check Telegram before asking for another.");
  }
  return { queued: Number(row.queued) };
}

/* ---------------------------------------------------------------- who hears */

export type AnnouncementPerson = {
  profileId: string;
  name: string;
  /** True when the bot has a chat to send to. False means it reaches nobody. */
  connected: boolean;
  /** Positive is a debt. Credit is not a debt, so it is not owing money. */
  owedMinor: number;
};

/**
 * Everybody an announcement could go to, and whether it would arrive.
 *
 * The audience sizes are worked out here rather than asked of the database,
 * because the admin needs the count before the send rather than after it. The
 * numbers the RPC returns afterwards are still what the screen reports as fact.
 *
 * `chat_id` and nothing else from `telegram_links`. An admin may read every row
 * in the org but not `link_token`, the credential binding a Telegram chat to a
 * membership: the column is closed to every browser role, so naming it here, or
 * asking for `*`, is refused outright.
 */
export async function fetchAnnouncementAudience(args: {
  orgId: number;
  meProfileId: string;
}): Promise<AnnouncementPerson[]> {
  const members = await fetchOrgMembers(args);

  const [linksRes, balancesRes] = await Promise.all([
    supabase.from("telegram_links").select("membership_id, chat_id").eq("org_id", args.orgId),
    supabase.from("v_account_balance").select("profile_id, balance_minor").eq("org_id", args.orgId),
  ]);
  if (linksRes.error) throw linksRes.error;
  if (balancesRes.error) throw balancesRes.error;

  const chatOf = new Map(
    (linksRes.data ?? []).map((r) => [r.membership_id as number, r.chat_id as number | null]),
  );
  const owedOf = new Map(
    // `sum(bigint)` is numeric, and PostgREST sends numeric as a string once it
    // outgrows a JSON number. Left as one it would compare as text.
    (balancesRes.data ?? []).map((r) => [r.profile_id as string, Number(r.balance_minor ?? 0)]),
  );

  return members
    .filter((m) => m.status === "active")
    .map((m) => ({
      profileId: m.profileId,
      name: m.name,
      connected: (chatOf.get(m.membershipId) ?? null) !== null,
      owedMinor: Math.max(owedOf.get(m.profileId) ?? 0, 0),
    }));
}
