import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelOrder, cellKey, fetchBoard, humanError, setOrder,
  type Board, type BoardCell, type BoardDay,
} from "../api.js";
import { formatMoney } from "../../shared/money.js";
import { now as appNow } from "../../shared/clock.js";
import { addDays, todayIn, weekStart } from "../../shared/dates.js";
import { defaultSelectedDay } from "../../shared/gating.js";
import { isAdmin, type Me, type Org, type Role } from "../../shared/types.js";

/** Null when this member may tick this day; otherwise why not. */
function dayLockedReason(day: BoardDay, isAdminHere: boolean, now: Date): string | null {
  if (day.menuId === null) return "No menu for this day";
  if (day.status === "cancelled") return "Lunch cancelled";
  if (isAdminHere) return null;
  if (day.status === "draft") return "Not published yet";
  if (day.status === "locked") return "Closed, sent to the caterer";
  if (day.orderCutoffAt && now.getTime() >= Date.parse(day.orderCutoffAt)) {
    return "Ordering closed";
  }
  return null;
}

export function OrdersScreen({ me, org, role }: { me: Me; org: Org; role: Role }) {
  const admin = isAdmin(role);
  const today = todayIn(org.timezone, appNow());
  const [weekOf, setWeekOf] = useState(() => weekStart(today, org.billingWeekStartsOn));
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => appNow());

  // The cutoff is a wall-clock event, so cells have to lock themselves without
  // a reload for anyone leaving the tab open.
  useEffect(() => {
    const t = setInterval(() => setNow(appNow()), 30_000);
    return () => clearInterval(t);
  }, []);

  const from = weekOf;
  const to = addDays(weekOf, 6);

  // Paging to another week must drop the manual pick: keeping a date that is
  // no longer on screen leaves the panel describing an invisible day.
  useEffect(() => { setSelected(null); }, [weekOf]);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard({
        orgId: org.id, from, to, meProfileId: me.profileId, today,
      }));
      setError(null);
    } catch (e) {
      setError(humanError(e));
    }
  }, [org.id, from, to, me.profileId, today]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    if (!board) return { perDay: new Map<string, number>(), mine: 0 };
    const perDay = new Map<string, number>();
    let mine = 0;
    for (const [key, cell] of board.cells) {
      if (cell.status !== "placed") continue;
      const date = key.split("|")[1]!;
      perDay.set(date, (perDay.get(date) ?? 0) + 1);
      if (key.startsWith(me.profileId) && cell.transferredToName === null) {
        mine += cell.amountMinor ?? 0;
      }
    }
    return { perDay, mine };
  }, [board, me.profileId]);

  async function toggle(day: BoardDay) {
    if (day.menuId === null || busy) return;
    const key = cellKey(me.profileId, day.serviceDate);
    const existing = board?.cells.get(key) ?? null;
    const isOn = existing?.status === "placed";
    setBusy(key);
    try {
      if (isOn) {
        await cancelOrder(existing!.orderId);
      } else {
        // With one dish on the menu -- the normal case -- ticking orders it
        // outright. With several, the tick records that you are eating and the
        // dish picker below resolves which.
        const only = day.dishes.length === 1 ? day.dishes[0]!.id : null;
        await setOrder({
          orgId: org.id, menuId: day.menuId, serviceDate: day.serviceDate,
          profileId: me.profileId, itemId: only,
          existing: existing
            ? { id: existing.orderId, status: existing.status, source: existing.source,
                itemId: null, itemName: existing.dishName, unitPriceMinor: null }
            : null,
        });
      }
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }

  /** Choose or change the dish for a day, ticking it in if not already on. */
  async function pickDish(day: BoardDay, itemId: number) {
    if (day.menuId === null || busy) return;
    const key = cellKey(me.profileId, day.serviceDate);
    const existing = board?.cells.get(key) ?? null;
    // Tapping the dish you already have is a de-select: back to "eating, dish
    // to follow" rather than a no-op, so one control does both directions.
    const same = existing?.status === "placed" &&
      existing.dishName === day.dishes.find((d) => d.id === itemId)?.name;
    setBusy(key);
    try {
      await setOrder({
        orgId: org.id, menuId: day.menuId, serviceDate: day.serviceDate,
        profileId: me.profileId, itemId: same ? null : itemId,
        existing: existing
          ? { id: existing.orderId, status: existing.status, source: existing.source,
              itemId: null, itemName: existing.dishName, unitPriceMinor: null }
          : null,
      });
      await load();
      setError(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!board) return <p>Loading…</p>;

  const selectedDate = selected ?? defaultSelectedDay({
    days: board.days,
    today,
    isOpen: (d: string) => {
      const day = board.days.find((x) => x.serviceDate === d);
      return day?.status === "published"
        && day.orderCutoffAt !== null
        && now.getTime() < Date.parse(day.orderCutoffAt);
    },
  });
  const day = board.days.find((d) => d.serviceDate === selectedDate) ?? null;

  return (
    <section>
      <div className="week-nav">
        <button className="btn ghost" onClick={() => setWeekOf(addDays(weekOf, -7))}>← Prev</button>
        <strong>{shortRange(from, to)}</strong>
        <button className="btn ghost" onClick={() => setWeekOf(addDays(weekOf, 7))}>Next →</button>
        {weekOf !== weekStart(today, org.billingWeekStartsOn) && (
          <>
            <span className="spacer" />
            <button className="btn ghost"
                    onClick={() => setWeekOf(weekStart(today, org.billingWeekStartsOn))}>
              Jump to this week
            </button>
          </>
        )}
      </div>

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="orders-layout">
        <div className="board-col">
          {/* Wide by nature: dates across, people down. Horizontal scroll with
              a sticky name column is the only thing that works on a phone. */}
          <div className="board-scroll">
        <table className="board">
          <thead>
            <tr>
              <th className="sticky-col">Who</th>
              {board.days.map((d) => {
                const cls = [
                  d.serviceDate === today ? "is-today" : "",
                  d.serviceDate === selectedDate ? "is-selected" : "",
                ].filter(Boolean).join(" ");
                return (
                  <th key={d.serviceDate} className={cls}>
                    <button className="day-head" onClick={() => setSelected(d.serviceDate)}
                            aria-pressed={d.serviceDate === selectedDate}>
                      <span className="dow">{dow(d.serviceDate)}</span>
                      <span className="dom">{d.serviceDate.slice(8)}</span>
                      {d.menuId === null
                        ? <span className="no-menu">no menu</span>
                        : <span className="no-menu">{d.dishes.length} dish{d.dishes.length === 1 ? "" : "es"}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {board.members.map((m) => (
              <tr key={m.profileId} className={m.isMe ? "is-me" : ""}>
                <th className="sticky-col" scope="row">
                  {m.name}{m.isMe && <span className="you"> (you)</span>}
                </th>
                {board.days.map((d) => {
                  const cell = board.cells.get(cellKey(m.profileId, d.serviceDate));
                  const on = cell?.status === "placed";
                  const locked = dayLockedReason(d, admin, now);
                  const mineToEdit = m.isMe && locked === null;
                  // No row yet, but my weekday rule covers it: show it as
                  // coming rather than absent, so a future week reflects the
                  // preference the member actually set.
                  const willBe = m.isMe && !cell && board.projected.has(d.serviceDate);
                  const title = [
                    cell?.dishName ?? (on ? "Eating, dish not chosen" : ""),
                    willBe ? "From your weekday preference — added when the menu is published" : "",
                    cell?.transferredToName ? `→ ${cell.transferredToName}` : "",
                    !m.isMe || locked === null ? "" : locked,
                  ].filter(Boolean).join(" · ");

                  return (
                    <td key={d.serviceDate} className={[
                          d.serviceDate === today ? "is-today" : "",
                          d.serviceDate === selectedDate ? "is-selected" : "",
                        ].filter(Boolean).join(" ")}>
                      {mineToEdit ? (
                        <button
                          className={`tick ${on ? "on" : ""} ${willBe ? "projected" : ""}`}
                          aria-pressed={on}
                          aria-label={`${on ? "Cancel" : "Order"} lunch on ${d.serviceDate}`}
                          title={title || undefined}
                          disabled={busy !== null}
                          onClick={() => void toggle(d)}
                        >
                          {on ? "✓" : willBe ? "✓" : ""}
                        </button>
                      ) : (
                        <span className={`tick static ${on ? "on" : ""} ${willBe ? "projected" : ""}`}
                              title={title || undefined}>
                          {on ? (cell?.transferredToName ? "→" : "✓") : willBe ? "✓" : ""}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="totals">
              <th className="sticky-col" scope="row">Total</th>
              {board.days.map((d) => (
                <td key={d.serviceDate} className={[
                      d.serviceDate === today ? "is-today" : "",
                      d.serviceDate === selectedDate ? "is-selected" : "",
                    ].filter(Boolean).join(" ")}>
                  {totals.perDay.get(d.serviceDate) ?? ""}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

          <div className="board-foot">
            <span className="muted">
              Your total this week: <strong>{formatMoney(totals.mine, org.currency)}</strong>
            </span>
            {board.projected.size > 0 && (
              <span className="muted legend">
                <span className="tick static projected mini">✓</span>
                from your weekday preference, added when the menu is published
              </span>
            )}
            <span className="muted legend">
              <span className="legend-today">{Number(today.slice(8))}</span> today
            </span>
          </div>
        </div>

      {day && <DayPanel
        day={day} org={org} admin={admin} now={now} busy={busy !== null}
        cell={board.cells.get(cellKey(me.profileId, day.serviceDate)) ?? null}
        onPick={(itemId) => void pickDish(day, itemId)}
        onToggle={() => void toggle(day)}
      />}
      </div>
    </section>
  );
}

function dow(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00Z`));
}

function shortRange(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  const fmt = (d: Date, month: boolean) =>
    new Intl.DateTimeFormat("en-GB",
      { day: "2-digit", ...(month ? { month: "short" } : {}), timeZone: "UTC" }).format(d);
  return `${fmt(f, f.getUTCMonth() !== t.getUTCMonth())} – ${fmt(t, true)}`;
}

/**
 * One day, expanded: what is on offer, what you chose, and the controls to
 * change it. Reachable for any day in the week, not just tomorrow -- you can
 * look back at what was served and forward at anything already published.
 * Whether you can *change* it is governed by dayLockedReason, which is the
 * same rule the database trigger enforces.
 */
function DayPanel({ day, org, admin, now, busy, cell, onPick, onToggle }: {
  day: BoardDay;
  org: Org;
  admin: boolean;
  now: Date;
  busy: boolean;
  cell: BoardCell | null;
  onPick: (itemId: number) => void;
  onToggle: () => void;
}) {
  const locked = dayLockedReason(day, admin, now);
  const eating = cell?.status === "placed";

  return (
    <section className="day-panel">
      <h2>
        {new Intl.DateTimeFormat("en-GB",
          { weekday: "long", day: "2-digit", month: "short", timeZone: "UTC" })
          .format(new Date(`${day.serviceDate}T00:00:00Z`))}
      </h2>

      {day.menuId === null ? (
        <p className="muted">No menu for this day.</p>
      ) : (
        <>
          {locked
            ? <p className="notice info">{locked}</p>
            : day.orderCutoffAt && (
                <p className="muted">
                  You can change this until{" "}
                  {new Intl.DateTimeFormat("en-GB", {
                    weekday: "short", hour: "2-digit", minute: "2-digit",
                    hour12: false, timeZone: org.timezone,
                  }).format(new Date(day.orderCutoffAt))}
                </p>
              )}

          {cell?.transferredToName && (
            <p className="notice info">
              You passed this meal to {cell.transferredToName}, so they are billed for it.
            </p>
          )}

          <ul className="dishes">
            {day.dishes.map((dish) => {
              const picked = eating && cell?.dishName === dish.name;
              return (
                <li key={dish.id}>
                  <button
                    className={`dish ${picked ? "picked" : ""}`}
                    aria-pressed={picked}
                    disabled={locked !== null || busy}
                    onClick={() => onPick(dish.id)}
                  >
                    <span className="dish-name">{dish.name}</span>
                    <span className="dish-price">{formatMoney(dish.priceMinor, org.currency)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {eating && cell?.dishName === null && (
            <p className="notice warn">
              You're down as eating but haven't picked a dish. Choose one above.
            </p>
          )}

          <div className="actions">
            <button className="btn" disabled={locked !== null || busy} onClick={onToggle}>
              {eating ? "Not eating this day" : "I'm eating, dish to follow"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
