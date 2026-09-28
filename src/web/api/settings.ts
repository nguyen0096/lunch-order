/**
 * Things set once and forgotten: display name and the Telegram link, plus the
 * org-wide settings an admin sets here -- where the money goes, which group
 * chat the bot posts in, and when ordering closes by default.
 */

import { supabase } from "../supabase.js";
import { parsePaymentConfig, type PaymentConfig } from "../../shared/payment.js";

/* -------------------------------------------------- profile and membership */

/**
 * Display name is per-org: the same person may be "Neil" in one office and
 * their full name in another, so this writes the membership, not the profile.
 */
export async function setDisplayName(args: {
  orgId: number; profileId: string; displayName: string;
}): Promise<void> {
  const trimmed = args.displayName.trim();
  if (trimmed === "") throw new Error("A display name cannot be blank.");
  const { error } = await supabase
    .from("memberships")
    .update({ display_name: trimmed })
    .eq("org_id", args.orgId)
    .eq("profile_id", args.profileId);
  if (error) throw error;
}

/* -------------------------------------------------------------- telegram */

export type TelegramLink = {
  membershipId: number;
  linkToken: string;
  /** True once the member has completed /start from a Telegram chat. */
  linked: boolean;
};

type LinkRow = { membership_id: number; link_token: string; linked: boolean };

function toLink(row: LinkRow): TelegramLink {
  return { membershipId: row.membership_id, linkToken: row.link_token, linked: row.linked };
}

/**
 * This member's bot link in `orgId`, or null if they have never had one.
 *
 * A function, not a table read: `link_token` is the credential that binds a
 * Telegram chat to a membership, and no browser role may select that column.
 * The function answers for the caller's own membership and nobody else's.
 */
export async function fetchTelegramLink(orgId: number): Promise<TelegramLink | null> {
  const { data, error } = await supabase.rpc("my_telegram_link", { p_org_id: orgId });
  if (error) throw error;
  const row = (data as LinkRow[] | null)?.[0];
  return row ? toLink(row) : null;
}

/**
 * Mint the caller's link if there is none, and hand it back either way. Minted
 * on demand rather than on read: a token that exists only because somebody
 * opened Preferences is a credential nobody asked for.
 */
export async function createTelegramLink(orgId: number): Promise<TelegramLink> {
  const { data, error } = await supabase.rpc("create_my_telegram_link", { p_org_id: orgId });
  if (error) throw error;
  const row = (data as LinkRow[] | null)?.[0];
  if (!row) throw new Error("The Telegram link could not be made. Try again.");
  return toLink(row);
}

/**
 * Disconnect the chat, keeping the token so reconnecting is one tap. The bot
 * resolves a chat through chat_id alone, so clearing it is what actually stops
 * it answering.
 */
export async function unlinkTelegram(membershipId: number): Promise<void> {
  const { error } = await supabase
    .from("telegram_links")
    .update({ chat_id: null, linked_at: null })
    .eq("membership_id", membershipId);
  if (error) throw error;
}

/* ------------------------------------------------------------ the office */

export type OrgSettings = {
  payment: PaymentConfig;
  /** Where the bot posts. Null means it has no group to post in. */
  telegramGroupChatId: number | null;
  /** `HH:MM:SS`, the spelling a Postgres `time` column reads back as. */
  defaultCutoffLocalTime: string;
};

/**
 * The org-wide settings the Settings screen edits.
 *
 * Readable by any member -- organizations_select covers the whole row -- but
 * only ever asked for on the admin half of the screen, because a member has
 * nothing to do with the answer.
 */
export async function fetchOrgSettings(orgId: number): Promise<OrgSettings> {
  const { data, error } = await supabase
    .from("organizations")
    .select("payment_config, telegram_group_chat_id, default_cutoff_local_time")
    .eq("id", orgId)
    .single();
  if (error) throw error;
  return {
    payment: parsePaymentConfig(data.payment_config),
    telegramGroupChatId: data.telegram_group_chat_id,
    defaultCutoffLocalTime: data.default_cutoff_local_time,
  };
}

/**
 * An UPDATE that RLS declines to apply is not an error: PostgREST reports it
 * as zero rows affected, and a screen that does not look would report a save
 * that never happened. Every writer below asks for the row back and says so
 * when it does not come.
 */
async function updateOrg(orgId: number, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase
    .from("organizations").update(patch).eq("id", orgId).select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error("That did not save. You need to be an admin of this office.");
  }
}

/**
 * The account behind the QR on every bill.
 *
 * Written in the spelling `parsePaymentConfig` defines, which is also one of
 * the spellings `vietQrLink` in shared/telegram.ts reads, so the bot's QR and
 * the web app's agree without either having to know about the other. Plain
 * UPDATE, no RPC: authenticated holds UPDATE on organizations at table level
 * and organizations_update_admin is what narrows it to an admin's own orgs.
 */
export async function setPaymentConfig(orgId: number, config: PaymentConfig): Promise<void> {
  await updateOrg(orgId, { payment_config: { vietqr: config.vietqr, note: config.note } });
}

/**
 * The group chat id, as a fallback.
 *
 * The bot normally discovers this itself from a message in the group, so this
 * exists for the admin who already knows the number and does not want to wait
 * for that. Null clears it.
 */
export async function setTelegramGroupChatId(
  orgId: number, chatId: number | null,
): Promise<void> {
  await updateOrg(orgId, { telegram_group_chat_id: chatId });
}

/**
 * The time a newly published menu closes at, in the office's own zone.
 *
 * Takes the `HH:MM:SS` the column reads back as, so what goes in and what comes
 * back on the next read are the same string and "Nothing to save" can be
 * decided without waiting for a refetch. The column is NOT NULL: no clearing.
 *
 * Only ever a starting point. `menus.order_cutoff_at` is fixed when a menu is
 * published and is what the ordering trigger enforces, so a menu that is
 * already out is untouched by a change here.
 */
export async function setDefaultCutoffLocalTime(
  orgId: number, localTime: string,
): Promise<void> {
  await updateOrg(orgId, { default_cutoff_local_time: localTime });
}

/* --------------------------------------------------------------- short code */

export const SHORT_CODE_MIN = 2;
export const SHORT_CODE_MAX = 8;

/**
 * `null` when the code can be sent, otherwise the sentence saying what to fix.
 *
 * Mirrors `short_code ~ '^[A-Z0-9]{2,8}$'`, which is a CHECK constraint: it
 * refuses without saying which of the three rules was broken, and a member
 * typing their own initials deserves better than the constraint name. What only
 * the server can answer is uniqueness, and that stays with the server.
 */
export function shortCodeProblem(code: string): string | null {
  const c = code.trim();
  if (c === "") return "A short code cannot be blank";
  if (/[^A-Za-z0-9]/.test(c)) return "A short code is letters and digits only, with no spaces";
  if (c.length < SHORT_CODE_MIN) return `A short code is ${SHORT_CODE_MIN} characters at least`;
  if (c.length > SHORT_CODE_MAX) return `A short code is ${SHORT_CODE_MAX} characters at most`;
  return null;
}

/**
 * The code that appears in the bank memo when this person pays a bill.
 *
 * Per-org like the display name. A member changes their own once after
 * joining, and `enforce_short_code` counts it; an admin may change it any
 * number of times. The database also refuses a code that contains, or sits
 * inside, a colleague's, and says whose, so that sentence is shown as it is.
 * The same statement aimed at a row RLS hides matches nothing rather than
 * erroring, so the zero-row case is checked rather than assumed.
 *
 * Returns the code as stored, uppercased, so the caller can settle "nothing to
 * save" without waiting for a refetch.
 */
export async function setShortCode(args: {
  orgId: number; profileId: string; shortCode: string;
}): Promise<string> {
  const code = args.shortCode.trim().toUpperCase();
  const problem = shortCodeProblem(code);
  if (problem !== null) throw new Error(`${problem}.`);

  const { data, error } = await supabase
    .from("memberships")
    .update({ short_code: code })
    .eq("org_id", args.orgId)
    .eq("profile_id", args.profileId)
    .select("short_code");

  if (error) {
    // memberships_code_uk is the second unique key in this schema somebody types
    // by hand, and RLS can hide the colleague already holding the code, so the
    // clash only ever arrives from the server. humanError would flatten it to
    // "that change conflicts with something else", which does not say what to do.
    if (/memberships_code_uk/i.test(error.message)) {
      throw new Error(`Somebody in this office already uses ${code}. Pick a different one.`);
    }
    throw error;
  }
  if ((data ?? []).length === 0) {
    throw new Error("That did not save. You can only change your own short code.");
  }
  return code;
}

/* ------------------------------------------------- leaving, and deleting */

export type LeaveStanding = {
  /** What this person still owes the office, in minor units. */
  owedMinor: number;
  /** Active owners of the office, which is what the sole-owner rule counts. */
  ownerCount: number;
};

/**
 * The two things `leave_office` will refuse for, asked before the button is
 * pressed. Not the enforcement -- that is the function's, and it is checked
 * again there -- only the difference between a control that fails and one that
 * explains itself.
 */
export async function fetchLeaveStanding(args: {
  orgId: number; profileId: string;
}): Promise<LeaveStanding> {
  const [account, owners] = await Promise.all([
    // The same view `leave_office` refuses on, so the affordance and the rule
    // cannot say different numbers. It used to walk statements and take the
    // newest short week, because carry-forward meant that week contained the
    // older ones. It does not any more, and taking the newest would have told
    // somebody who owes three weeks that they owe the smallest of them.
    supabase
      .from("v_account_balance")
      .select("balance_minor")
      .eq("org_id", args.orgId)
      .eq("profile_id", args.profileId)
      .maybeSingle(),
    supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", args.orgId)
      .eq("role", "owner")
      .eq("status", "active"),
  ]);
  if (account.error) throw account.error;
  if (owners.error) throw owners.error;

  return {
    // Credit is not a debt, so a negative balance owes nothing.
    owedMinor: Math.max(Number(account.data?.balance_minor ?? 0), 0),
    ownerCount: owners.count ?? 0,
  };
}

export type OfficeDebt = {
  /** Owed to the office by everybody in it, in minor units. */
  outstandingMinor: number;
  /** How many people that is spread across. */
  peopleOwing: number;
};

/**
 * What deleting the office would walk away from.
 *
 * One row per person from `v_account_balance`, which is the number they are
 * each shown and the number `leave_office` refuses on. It used to sum each
 * person's newest unsettled week, which was right only while carry-forward
 * folded the older ones into it.
 *
 * A member reads only their own row -- `payments_select_own` and
 * `billing_statements_select_own` see to that -- which is why this is asked
 * for on the owner's half of the screen and nowhere else.
 */
export async function fetchOfficeDebt(orgId: number): Promise<OfficeDebt> {
  const { data, error } = await supabase
    .from("v_account_balance")
    .select("profile_id, balance_minor")
    .eq("org_id", orgId);
  if (error) throw error;

  let outstandingMinor = 0;
  let peopleOwing = 0;
  for (const r of data ?? []) {
    // Somebody in credit offsets nothing: the office does not get to count
    // one person's top-up against another person's debt.
    const owed = Math.max(Number(r.balance_minor), 0);
    if (owed > 0) {
      outstandingMinor += owed;
      peopleOwing += 1;
    }
  }
  return { outstandingMinor, peopleOwing };
}

/**
 * Stop being a member. Deactivation, not deletion: the membership row carries
 * the short code a bank memo names and the statements that point at it, so it
 * stays and `status` goes to 'inactive'. Joining again with the office's join
 * code reactivates the same row.
 *
 * Refuses, in the function and with its own sentence, while you owe money and
 * when you are the only owner. Both are asked about first by
 * `fetchLeaveStanding`; neither rule is reimplemented here.
 */
export async function leaveOffice(orgId: number): Promise<void> {
  const { error } = await supabase.rpc("leave_office", { p_org_id: orgId });
  if (error) throw error;
}

/**
 * End the office for everybody. A soft delete: `organizations.deleted_at` is
 * set, the three `private.my_*_org_ids()` helpers stop returning the org, and
 * every policy in the schema stops matching at once. Nothing is erased, and
 * nothing in this app brings it back.
 *
 * Owner-only, checked inside the function and again by the trigger on
 * organizations, so the screen hiding the control is presentation and not the
 * protection.
 */
export async function deleteOffice(orgId: number): Promise<void> {
  const { error } = await supabase.rpc("delete_office", { p_org_id: orgId });
  if (error) throw error;
}
