import { useCallback, useEffect, useState } from "react";
import { createTransfer, fetchOrgUpcomingOrders, humanError } from "../api.js";
import { formatMoney } from "../../shared/money.js";
import { formatDay } from "../../shared/dates.js";
import type { Me, Org } from "../../shared/types.js";

type OrgOrder = Awaited<ReturnType<typeof fetchOrgUpcomingOrders>>[number];

/**
 * An admin recording a swap the two people have already agreed between
 * themselves.
 *
 * This is the one path that skips acceptance, and it skips it for a reason
 * rather than as an admin perk: the admin confirming it with both parties IS
 * the consent, so making the recipient re-accept in the app would be friction
 * for nothing. An admin giving away their OWN meal is a different act and goes
 * through the normal pending flow -- the database decides that, keyed on
 * whether the admin is the sender, not on their role.
 */
export function AdminRecordSwap({ me, org, onRecorded }: {
  me: Me; org: Org; onRecorded: () => void;
}) {
  const [orders, setOrders] = useState<OrgOrder[] | null>(null);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [orderId, setOrderId] = useState("");
  const [toProfileId, setToProfileId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(() => {
    fetchOrgUpcomingOrders({ orgId: org.id, fromDate: today })
      .then((rows) => {
        setOrders(rows);
        const seen = new Map<string, string>();
        for (const r of rows) seen.set(r.profileId, r.memberName);
        setMembers([...seen].map(([id, name]) => ({ id, name })));
      })
      .catch((e) => { setError(humanError(e)); setOrders([]); });
  }, [org.id, today]);
  useEffect(load, [load]);

  const chosen = orders?.find((o) => String(o.orderId) === orderId) ?? null;

  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen || !toProfileId) return;
    setBusy(true);
    try {
      await createTransfer({
        orgId: org.id, orderId: chosen.orderId, toProfileId,
        createdBy: me.profileId, reason: reason.trim() || null,
      });
      const to = members.find((m) => m.id === toProfileId)?.name ?? "them";
      setDone(`Recorded: ${chosen.memberName}'s ${formatDay(chosen.serviceDate)} meal now bills to ${to}.`);
      setOrderId(""); setToProfileId(""); setReason("");
      load();
      onRecorded();
      setError(null);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (orders === null) return <p className="muted">Loading…</p>;

  // Own-meal transfers belong in the normal flow above, so exclude them here
  // and say why, rather than silently offering a control that behaves
  // differently from its neighbours.
  const recordable = orders.filter(
    (o) => o.profileId !== me.profileId && o.pendingWith === null,
  );

  return (
    <form className="offer-form" onSubmit={(e) => void record(e)}>
      <h3>Record a swap (admin)</h3>
      <p className="muted">
        For an arrangement two people have already agreed. This takes effect
        immediately, so confirm it with both of them first. To pass on one of
        your own meals, use the section above — the recipient gets to accept.
      </p>

      {error && <p className="notice error" role="alert">{error}</p>}
      {done && <p className="notice success" role="status">{done}</p>}

      <label>
        Whose meal
        <select value={orderId} required
                onChange={(e) => { setOrderId(e.target.value); setToProfileId(""); }}>
          <option value="">Choose an order…</option>
          {recordable.map((o) => (
            <option key={o.orderId} value={o.orderId}>
              {formatDay(o.serviceDate)} — {o.memberName}
              {o.dishName ? ` · ${o.dishName}` : " · dish not chosen"}
              {o.amountMinor !== null ? ` · ${formatMoney(o.amountMinor, org.currency)}` : ""}
            </option>
          ))}
        </select>
      </label>
      {recordable.length === 0 && (
        <p className="muted">
          No other member has an upcoming meal that could be swapped.
        </p>
      )}

      <label>
        Goes to
        <select value={toProfileId} required disabled={!chosen}
                onChange={(e) => setToProfileId(e.target.value)}>
          <option value="">Choose a colleague…</option>
          {members
            .filter((m) => m.id !== chosen?.profileId)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>

      <label>
        Note (optional)
        <input value={reason} maxLength={120} placeholder="agreed in the office"
               onChange={(e) => setReason(e.target.value)} />
      </label>

      <div className="actions">
        <button className="btn primary" type="submit"
                disabled={busy || !chosen || !toProfileId}>
          {busy ? "Recording…" : "Record swap"}
        </button>
      </div>
    </form>
  );
}
