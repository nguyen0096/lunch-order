import { useCallback, useEffect, useState } from "react";
import {
  createInvitation, fetchInvitations, fetchOrgMembers, humanError,
  revokeInvitation, updateMembership,
  type Invitation, type OrgMember,
} from "../api.js";
import type { Me, Org } from "../../shared/types.js";

export function AdminPeopleScreen({ me, org }: { me: Me; org: Org }) {
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [invites, setInvites] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    fetchInvitations(org.id).then(setInvites)
      .catch((e) => { setError(humanError(e)); setInvites([]); });
    fetchOrgMembers({ orgId: org.id, meProfileId: me.profileId }).then(setMembers)
      .catch((e) => { setError(humanError(e)); setMembers([]); });
  }, [org.id, me.profileId]);
  useEffect(load, [load]);

  const linkFor = (t: string) => `${window.location.origin}/#/join/${t}`;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createInvitation({ orgId: org.id, email, role, invitedBy: me.profileId });
      setEmail("");
      load();
      setError(null);
    } catch (err) {
      setError(humanError(err));
    }
  }

  async function copy(inv: Invitation) {
    const link = linkFor(inv.token);
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // iOS Safari refuses clipboard writes outside some gestures; a prompt is
      // ugly but always works, and an admin needs the link either way.
      window.prompt("Copy this invitation link", link);
    }
    setCopied(inv.id);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <section>
      <h1>People</h1>
      {error && <p className="notice error" role="alert">{error}</p>}

      <h2>Members</h2>
      {members === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="invite-list">
          {members.map((m) => (
            <li key={m.membershipId} className={m.status === "inactive" ? "is-inactive" : ""}>
              <span className="who">
                {m.name}{m.isMe && <span className="muted"> (you)</span>}
                <div className="muted">{m.email}</div>
              </span>
              {/* Nobody may change their own role -- the database refuses it,
                  so the control is disabled rather than failing on click. */}
              <select aria-label={`Role for ${m.name}`} value={m.role}
                      disabled={m.isMe || m.role === "owner"}
                      onChange={(e) => void updateMembership({
                        membershipId: m.membershipId,
                        role: e.target.value as OrgMember["role"],
                      }).then(load).catch((err) => setError(humanError(err)))}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                {m.role === "owner" && <option value="owner">Owner</option>}
              </select>
              {!m.isMe && m.role !== "owner" && (
                <button className="btn ghost"
                        onClick={() => void updateMembership({
                          membershipId: m.membershipId,
                          status: m.status === "active" ? "inactive" : "active",
                        }).then(load).catch((err) => setError(humanError(err)))}>
                  {m.status === "active" ? "Deactivate" : "Reactivate"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        Deactivating keeps their past orders and bills intact — it only stops
        new ones. Their history is part of the billing record, so nobody who has
        ever ordered can be deleted outright.
      </p>

      <h2>Invite someone</h2>
      {/* Any address works, personal ones included. The invitation is bound to
          the address, so a forwarded link does not become an open door. */}
      <p className="muted">
        Send them the link. They sign in with that email address — personal
        addresses are fine — and join {org.name}. Inviting an existing member
        again restores their access and can raise their role, but never lowers
        it: use the Role control above to demote someone.
      </p>
      <form className="invite-form" onSubmit={(e) => void invite(e)}>
        <input type="email" required placeholder="name@example.com"
               aria-label="Email address"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label="Role" value={role}
                onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button className="btn primary" type="submit">Create link</button>
      </form>

      <h2>Invitations</h2>
      {invites === null ? (
        <p className="muted">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="invite-list">
          {invites.map((inv) => {
            const expired = new Date(inv.expiresAt) < new Date();
            return (
              <li key={inv.id}>
                <span className="who">{inv.email}</span>
                <span className="muted">{inv.role}</span>
                <span className="muted">
                  {inv.acceptedAt ? "joined" : expired ? "expired" : "pending"}
                </span>
                {!inv.acceptedAt && !expired && (
                  <button className="btn ghost" onClick={() => void copy(inv)}>
                    {copied === inv.id ? "Copied" : "Copy link"}
                  </button>
                )}
                <button className="btn ghost" aria-label={`Revoke invitation for ${inv.email}`}
                        onClick={() => void revokeInvitation(inv.id).then(load)}>✕</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
