/**
 * The admin's member list and invitations.
 */

import { supabase } from "../supabase.js";

export type Invitation = {
  id: number; email: string; role: string; token: string;
  expiresAt: string; acceptedAt: string | null;
};

export async function fetchInvitations(orgId: number): Promise<Invitation[]> {
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, role, token, expires_at, accepted_at")
    .eq("org_id", orgId)
    .order("id", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, email: r.email, role: r.role, token: r.token,
    expiresAt: r.expires_at, acceptedAt: r.accepted_at,
  }));
}

export async function createInvitation(args: {
  orgId: number; email: string; role: "member" | "admin"; invitedBy: string;
}): Promise<Invitation> {
  const { data, error } = await supabase
    .from("invitations")
    .upsert({
      org_id: args.orgId, email: args.email.trim().toLowerCase(),
      role: args.role, invited_by: args.invitedBy,
    }, { onConflict: "org_id,email" })
    .select("id, email, role, token, expires_at, accepted_at")
    .single();
  if (error) throw error;
  return {
    id: data.id, email: data.email, role: data.role, token: data.token,
    expiresAt: data.expires_at, acceptedAt: data.accepted_at,
  };
}

export async function revokeInvitation(id: number): Promise<void> {
  const { error } = await supabase.from("invitations").delete().eq("id", id);
  if (error) throw error;
}

export type InvitationPreview = {
  orgName: string;
  role: "member" | "admin";
  expiresAt: string;
  state: "valid" | "expired" | "used";
};

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where an invitation leads, before it is accepted, or null when the token
 * matches nothing. A token that is not even shaped like one is null without
 * asking: PostgREST answers a malformed uuid with a 400 naming the parameter,
 * which is a worse answer than "that link is not valid".
 */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await supabase.rpc("invitation_preview", { p_token: token });
  if (error) throw error;
  const row = (data as Array<{
    org_name: string; role: InvitationPreview["role"]; expires_at: string; state: InvitationPreview["state"];
  }> | null)?.[0];
  return row
    ? { orgName: row.org_name, role: row.role, expiresAt: row.expires_at, state: row.state }
    : null;
}

/**
 * The only way a non-member gets into an org. Every check lives in the
 * database function: an invitee is in no org, so no RLS policy could grant
 * them sight of their own invitation row.
 */
export async function acceptInvitation(token: string): Promise<{ slug: string; name: string }> {
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) throw error;
  const row = (data as Array<{ org_slug: string; org_name: string }> | null)?.[0];
  if (!row) throw new Error("That invitation could not be used.");
  return { slug: row.org_slug, name: row.org_name };
}

export type OrgMember = {
  membershipId: number;
  profileId: string;
  /** Empty when there is none. Most members join from Telegram and never have one. */
  email: string;
  name: string;
  shortCode: string;
  role: "member" | "admin" | "owner";
  status: "active" | "inactive";
  /** When the membership row appeared, which is when this person got in. */
  createdAt: string;
  isMe: boolean;
};

export async function fetchOrgMembers(args: {
  orgId: number; meProfileId: string;
}): Promise<OrgMember[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select(`id, profile_id, role, status, short_code, display_name, created_at,
             profiles ( email, full_name )`)
    .eq("org_id", args.orgId);
  if (error) throw error;

  return (data ?? []).map((m) => {
    const prof = m.profiles as unknown as { email: string | null; full_name: string } | null;
    return {
      membershipId: m.id,
      profileId: m.profile_id,
      email: prof?.email ?? "",
      name: m.display_name ?? prof?.full_name ?? m.short_code,
      shortCode: m.short_code,
      role: m.role as OrgMember["role"],
      status: m.status as OrgMember["status"],
      createdAt: m.created_at,
      isMe: m.profile_id === args.meProfileId,
    };
  }).sort((a, b) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1,
  );
}

/* ------------------------------------------------------------------ join code */

export type JoinCode = {
  /** Null when the org has never had one. */
  code: string | null;
  /**
   * When the code was last written. Null for a code set before the column
   * existed, which is not "never" and must never be rendered as a date.
   */
  setAt: string | null;
};

export async function fetchJoinCode(orgId: number): Promise<JoinCode> {
  const { data, error } = await supabase
    .from("organizations")
    .select("telegram_join_code, telegram_join_code_set_at")
    .eq("id", orgId)
    .single();
  if (error) throw error;
  return { code: data.telegram_join_code, setAt: data.telegram_join_code_set_at };
}

/**
 * The alphabet the column's own check constraint allows: A-Z and 2-9 without
 * `I`, `O`, `0` or `1`. The code is read aloud in a group chat and retyped off
 * a phone screen, and those four are the pairs people get wrong.
 */
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Inside the constraint's 6-12, and long enough that guessing is not a plan. */
export const JOIN_CODE_LENGTH = 8;

/**
 * A new code, from the CSPRNG rather than Math.random: this string is the only
 * thing between a group chat and the office headcount.
 *
 * The alphabet is exactly 32 characters and 256 divides by 32, so `byte % 32`
 * is uniform with no rejection loop. Change the alphabet and that stops holding.
 */
export function generateJoinCode(length: number = JOIN_CODE_LENGTH): string {
  const rng = globalThis.crypto;
  if (typeof rng?.getRandomValues !== "function") {
    // Never quietly fall back to Math.random. A guessable join code is worse
    // than a screen that says it could not make one.
    throw new Error(
      "This browser has no secure random generator, so a join code cannot be made here.",
    );
  }
  const bytes = rng.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += JOIN_CODE_ALPHABET[b % JOIN_CODE_ALPHABET.length];
  return out;
}

/**
 * Write the code and stamp when it happened, in one statement.
 *
 * A plain UPDATE rather than an RPC: `authenticated` holds UPDATE on
 * organizations and `organizations_update_admin` already restricts the rows to
 * an admin's own orgs, so a SECURITY DEFINER wrapper would add a second place
 * to get the rule wrong and no guarantee that is not already there.
 *
 * The timestamp comes from the browser, which is what doing this in one
 * client-side statement costs. It is a display value and never a decision
 * input; a skewed clock misreports an age, it cannot grant anybody anything.
 */
export async function setJoinCode(args: { orgId: number; code: string }): Promise<JoinCode> {
  const { data, error } = await supabase
    .from("organizations")
    // The timestamp is not sent: a trigger stamps it from the database clock,
    // and `authenticated` has no grant on that column precisely so a client
    // cannot date a rotation that did not happen. It is read back below.
    .update({ telegram_join_code: args.code })
    .eq("id", args.orgId)
    .select("telegram_join_code, telegram_join_code_set_at")
    .maybeSingle();
  if (error) throw error;
  // RLS refuses an UPDATE by matching no rows, not by raising, so a demoted
  // admin gets a silent success. Say what happened instead of reporting one.
  if (!data) {
    throw new Error("That join code was not saved. You may no longer be an admin of this office.");
  }
  return { code: data.telegram_join_code, setAt: data.telegram_join_code_set_at };
}

/**
 * Change a role or deactivate someone.
 *
 * Invitations deliberately cannot lower a role -- a stale link should not
 * quietly reduce access weeks later -- so demotion needs an explicit act, and
 * this is it. The role-guard trigger still refuses to let anyone change their
 * own role, so an admin cannot lock themselves out or promote themselves.
 */
export async function updateMembership(args: {
  membershipId: number;
  role?: "member" | "admin" | "owner";
  status?: "active" | "inactive";
}): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (args.role) patch["role"] = args.role;
  if (args.status) patch["status"] = args.status;
  const { error } = await supabase
    .from("memberships").update(patch).eq("id", args.membershipId);
  if (error) throw error;
}
