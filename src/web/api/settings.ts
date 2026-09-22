/**
 * Things set once and forgotten: display name and the Telegram link.
 */

import { supabase } from "../supabase.js";

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
