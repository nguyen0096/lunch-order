import { useCallback, useEffect, useState } from "react";
import {
  createTransfer, decideTransfer, fetchTransfers, humanError,
  type GiveableOrder, type TransferRow,
} from "../api.js";
import { formatMoney } from "../../shared/money.js";
import { now as appNow } from "../../shared/clock.js";
import { formatDay, todayIn } from "../../shared/dates.js";
import { isAdmin, type Me, type Org, type Role } from "../../shared/types.js";
import { AdminRecordSwap } from "./AdminRecordSwap.js";

/**
 * Handing a registered meal to someone else.
 *
 * The recipient pays, which is why an offer starts pending and becomes a
 * charge only once they accept: recording a transfer moves money onto another
 * person's bill, and that should not be unilateral. An admin recording one has
 * already confirmed it with both parties, so theirs lands accepted -- the
 * database decides that, not this screen.
 */
export function TransfersScreen({ me, org, role }: { me: Me; org: Org; role: Role }) {
  const today = todayIn(org.timezone, appNow());
  const [data, setData] = useState<{
    incoming: TransferRow[]; outgoing: TransferRow[]; giveable: GiveableOrder[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offering, setOffering] = useState<GiveableOrder | null>(null);
  const [toProfileId, setToProfileId] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    fetchTransfers({ orgId: org.id, meProfileId: me.profileId, fromDate: today })
      .then(setData)
      .catch((e) => { setError(humanError(e)); setData({ incoming: [], outgoing: [], giveable: [] }); });
  }, [org.id, me.profileId, today]);
  useEffect(load, [load]);

  async function offer(e: React.FormEvent) {
    e.preventDefault();
    if (!offering || !toProfileId) return;
    setBusy(true);
    try {
      await createTransfer({
        orgId: org.id, orderId: offering.orderId, toProfileId,
        createdBy: me.profileId, reason: reason.trim() || null,
      });
      setOffering(null); setToProfileId(""); setReason("");
      load();
      setError(null);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: number, status: "accepted" | "declined" | "cancelled") {
    setBusy(true);
    try {
      await decideTransfer(id, status);
      load();
      setError(null);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p>Loading…</p>;

  return (
    <section>
      <h1>Passing on a meal</h1>
      {error && <p className="notice error" role="alert">{error}</p>}

      <p className="muted">
        Whoever eats the meal pays for it. An offer becomes a charge only once
        they accept.
      </p>

      {data.incoming.length > 0 && (
        <>
          <h2>Offered to you</h2>
          <ul className="transfer-list">
            {data.incoming.map((t) => (
              <li key={t.id} className="is-incoming">
                <div className="what">
                  <strong>{t.fromName}</strong> is offering you{" "}
                  {t.dishName ?? "their lunch"} on {formatDay(t.serviceDate)}
                  {t.amountMinor !== null && (
                    <> — you would be billed {formatMoney(t.amountMinor, org.currency)}</>
                  )}
                  {t.reason && <div className="muted">“{t.reason}”</div>}
                </div>
                <div className="actions">
                  <button className="btn primary" disabled={busy}
                          onClick={() => void decide(t.id, "accepted")}>Accept</button>
                  <button className="btn" disabled={busy}
                          onClick={() => void decide(t.id, "declined")}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Give one of yours away</h2>
      {data.giveable.length === 0 ? (
        <p className="muted">
          You have no upcoming meals to pass on. Order one on the board first.
        </p>
      ) : (
        <ul className="transfer-list">
          {data.giveable.map((o) => (
            <li key={o.orderId}>
              <div className="what">
                <strong>{formatDay(o.serviceDate)}</strong>
                {" — "}{o.dishName ?? "dish not chosen yet"}
                {o.amountMinor !== null && <> · {formatMoney(o.amountMinor, org.currency)}</>}
                {o.pendingWith && (
                  <div className="muted">Already offered to {o.pendingWith}</div>
                )}
              </div>
              <div className="actions">
                <button className="btn" disabled={busy || o.pendingWith !== null}
                        onClick={() => { setOffering(o); setToProfileId(""); setReason(""); }}>
                  Pass on
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {offering && (
        <form className="offer-form" onSubmit={(e) => void offer(e)}>
          <h3>Pass on {formatDay(offering.serviceDate)}</h3>
          <label>
            To
            <MemberPicker orgId={org.id} excludeProfileId={me.profileId}
                          value={toProfileId} onChange={setToProfileId} />
          </label>
          <label>
            Why (optional)
            <input value={reason} maxLength={120}
                   placeholder="out at a client meeting"
                   onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy || !toProfileId}>
              Send offer
            </button>
            <button className="btn ghost" type="button" onClick={() => setOffering(null)}>
              Cancel
            </button>
          </div>
          <p className="muted">
            They will see it here and can accept or decline. Being an admin does
            not skip that — you are the one giving the meal away, so they still
            get a say in being billed for it.
          </p>
        </form>
      )}

      {isAdmin(role) && <AdminRecordSwap me={me} org={org} onRecorded={load} />}

      {data.outgoing.length > 0 && (
        <>
          <h2>Yours</h2>
          <ul className="transfer-list">
            {data.outgoing.map((t) => (
              <li key={t.id}>
                <div className="what">
                  {formatDay(t.serviceDate)} → <strong>{t.toName}</strong>
                  <span className={`pill is-${t.status}`}>{t.status}</span>
                </div>
                {t.status === "pending" && (
                  <div className="actions">
                    <button className="btn ghost" disabled={busy}
                            onClick={() => void decide(t.id, "cancelled")}>
                      Withdraw
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Colleague picker. Reads memberships directly rather than taking a prop,
 * because the list is only needed on this screen and RLS already scopes it to
 * the org.
 */
function MemberPicker({ orgId, excludeProfileId, value, onChange }: {
  orgId: number; excludeProfileId: string;
  value: string; onChange: (v: string) => void;
}) {
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let live = true;
    import("../supabase.js").then(({ supabase }) =>
      supabase.from("memberships")
        .select("profile_id, short_code, display_name, profiles ( full_name )")
        .eq("org_id", orgId).eq("status", "active")
        .then(({ data }) => {
          if (!live) return;
          setPeople((data ?? [])
            .filter((m) => m.profile_id !== excludeProfileId)
            .map((m) => {
              const prof = m.profiles as unknown as { full_name: string } | null;
              return { id: m.profile_id, name: m.display_name ?? prof?.full_name ?? m.short_code };
            })
            .sort((a, b) => a.name.localeCompare(b.name)));
        }));
    return () => { live = false; };
  }, [orgId, excludeProfileId]);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Choose a colleague…</option>
      {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}
