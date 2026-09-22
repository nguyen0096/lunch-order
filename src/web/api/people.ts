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
  email: string;
  name: string;
  role: "member" | "admin" | "owner";
  status: "active" | "inactive";
  isMe: boolean;
};

export async function fetchOrgMembers(args: {
  orgId: number; meProfileId: string;
}): Promise<OrgMember[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select(`id, profile_id, role, status, short_code, display_name,
             profiles ( email, full_name )`)
    .eq("org_id", args.orgId);
  if (error) throw error;

  return (data ?? []).map((m) => {
    const prof = m.profiles as unknown as { email: string; full_name: string } | null;
    return {
      membershipId: m.id,
      profileId: m.profile_id,
      email: prof?.email ?? "",
      name: m.display_name ?? prof?.full_name ?? m.short_code,
      role: m.role as OrgMember["role"],
      status: m.status as OrgMember["status"],
      isMe: m.profile_id === args.meProfileId,
    };
  }).sort((a, b) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1,
  );
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
