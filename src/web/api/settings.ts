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

/**
 * This member's bot link, or null if they have never had one.
 *
 * The profile_id filter is mandatory, not defensive: telegram_links_admin lets
 * an org admin read every row in the org, so an unfiltered query hands an admin
 * a colleague's link_token -- the single credential that binds a Telegram chat
 * to a membership. That is exactly why this table is separate from memberships.
 */
export async function fetchTelegramLink(
  orgId: number, profileId: string,
): Promise<TelegramLink | null> {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("membership_id, link_token, chat_id, memberships!inner ( profile_id )")
    .eq("org_id", orgId)
    .eq("memberships.profile_id", profileId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    membershipId: data.membership_id,
    linkToken: data.link_token,
    linked: data.chat_id !== null,
  };
}

/**
 * Mint the row on demand rather than on read: a token that exists only because
 * somebody opened Preferences is a credential nobody asked for.
 */
export async function createTelegramLink(
  orgId: number, profileId: string,
): Promise<TelegramLink> {
  const membership = await supabase
    .from("memberships").select("id")
    .eq("org_id", orgId).eq("profile_id", profileId).single();
  if (membership.error) throw membership.error;

  const { data, error } = await supabase
    .from("telegram_links")
    .upsert({ membership_id: membership.data.id, org_id: orgId }, { onConflict: "membership_id" })
    .select("membership_id, link_token, chat_id")
    .single();
  if (error) throw error;
  return {
    membershipId: data.membership_id,
    linkToken: data.link_token,
    linked: data.chat_id !== null,
  };
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
