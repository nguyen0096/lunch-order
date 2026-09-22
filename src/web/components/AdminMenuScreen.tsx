import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assistParse, fetchMenuCalendar, fetchMenuForEdit, humanError, publishMenu,
  type AssistedMenu, type DraftDish, type PublishResult,
} from "../api.js";
import { DayStrip, type DayStatus } from "./DayStrip.js";
import { parseMenu, type ItemWarning } from "../../shared/menuParser.js";
import { formatAmount, parseVietnamesePrice } from "../../shared/money.js";
import { now as appNow } from "../../shared/clock.js";
import { addDays, formatDay, todayIn, zonedTimeToInstant } from "../../shared/dates.js";
import { publishDisabledReason } from "../../shared/gating.js";
import type { Me, Org } from "../../shared/types.js";

const WARNING_TEXT: Record<ItemWarning, string> = {
  price_inferred_thousands: "Read as thousands — check this",
  price_ambiguous_decimal: "Comma read as a decimal point",
  price_out_of_range: "Unusual price for a lunch",
  duplicate_name: "Same dish appeared twice",
};

/** A row the admin can edit, seeded from the parse but independent of it. */
type Row = { key: string; name: string; price: string; warnings: ItemWarning[] };

export function AdminMenuScreen({ me, org }: { me: Me; org: Org }) {
  const today = todayIn(org.timezone, appNow());
  const [serviceDate, setServiceDate] = useState(() => addDays(today, 1));
  const [cutoffTime, setCutoffTime] = useState(org.defaultCutoffLocalTime.slice(0, 5));
  // The evening before, by default. Follows the service date unless the admin
  // has deliberately moved it, so the common case needs no edits at all.
  const [cutoffDate, setCutoffDate] = useState(() => addDays(addDays(today, 1), -1));
  const [cutoffPinned, setCutoffPinned] = useState(false);
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AssistedMenu | null>(null);
  const [reading, setReading] = useState(false);
  const [calendar, setCalendar] = useState<Map<string, DayStatus>>(new Map());
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [stripStart, setStripStart] = useState(() => addDays(today, -1));

  // Load whatever already exists for this date, so editing is the same screen
  // as creating and the admin never wonders which they are doing.
  useEffect(() => { setPublished(null); }, [serviceDate, raw, rows]);

  useEffect(() => {
    let live = true;
    fetchMenuForEdit(org.id, serviceDate)
      .then((m) => {
        if (!live) return;
        setStatus(m?.status ?? null);
        if (m) {
          type I = { id: number; name: string; price_minor: number; position: number };
          const items = ((m.menu_items ?? []) as unknown as I[])
            .sort((a, b) => a.position - b.position);
          setRows(items.map((i) => ({
            key: `db${i.id}`, name: i.name,
            price: formatAmount(i.price_minor, org.currency), warnings: [],
          })));
          setRaw(m.source_text ?? "");
        } else {
          setRows(null);
          setRaw("");
        }
        setError(null);
      })
      .catch((e) => live && setError(humanError(e)));
    return () => { live = false; };
  }, [org.id, org.currency, serviceDate]);

  useEffect(() => {
    if (!cutoffPinned) setCutoffDate(addDays(serviceDate, -1));
  }, [serviceDate, cutoffPinned]);

  const stripDays = Array.from({ length: 14 }, (_, i) => addDays(stripStart, i));

  const loadCalendar = useCallback(() => {
    fetchMenuCalendar({
      orgId: org.id,
      from: stripStart,
      to: addDays(stripStart, 13),
    }).then(setCalendar).catch(() => { /* the strip is a convenience, not a gate */ });
  }, [org.id, stripStart]);

  useEffect(loadCalendar, [loadCalendar]);

  async function readWithAi() {
    setReading(true);
    setPreview(null);
    try {
      setPreview(await assistParse({ orgId: org.id, text: raw, today }));
      setError(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setReading(false);
    }
  }

  /** Move a preview into the editable rows. Nothing is saved until Publish. */
  function applyPreview() {
    if (!preview) return;
    setRows(preview.items.map((i, n) => ({
      key: `ai${n}`, name: i.name,
      price: formatAmount(i.priceMinor, org.currency), warnings: [],
    })));
    if (preview.serviceDate) setServiceDate(preview.serviceDate);
    setPreview(null);
  }

  const parsed = useMemo(
    () => (raw.trim() === "" ? null : parseMenu(raw, { today })),
    [raw, today],
  );

  function applyParse() {
    if (!parsed) return;
    setRows(parsed.items.map((i) => ({
      key: i.id, name: i.name,
      price: formatAmount(i.priceMinor, org.currency), warnings: i.warnings,
    })));
    if (parsed.serviceDateGuess) setServiceDate(parsed.serviceDateGuess);
  }

  const dishes: DraftDish[] = (rows ?? []).map((r) => ({
    name: r.name.trim(),
    priceMinor: parseVietnamesePrice(r.price)?.minor ?? Number.NaN,
  }));
  const isPast = serviceDate < today;
  const blocked = isPast && status === null
    ? "That day has already passed"
    : publishDisabledReason(dishes, rows === null ? null : serviceDate);

  async function onPublish() {
    setBusy(true);
    try {
      const cutoffAt = zonedTimeToInstant(cutoffDate, cutoffTime, org.timezone).toISOString();
      const result = await publishMenu({
        orgId: org.id, profileId: me.profileId, serviceDate, cutoffAt, dishes,
        sourceText: raw,
        parseMeta: parsed
          ? { parser: "vi-VN/1", unparsed: parsed.unparsed.length, notes: parsed.notes.length }
          : { parser: "manual" },
      });
      setStatus("published");
      setPublished(result);
      loadCalendar();
      setError(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Menu</h1>

      {/* Any future day can take a menu. The strip makes that visible instead
          of leaving it to be discovered in a date field. */}
      <div className="strip-nav">
        <button className="btn ghost" onClick={() => setStripStart(addDays(stripStart, -14))}>
          ←
        </button>
        <DayStrip days={stripDays} statuses={calendar} selected={serviceDate}
                  today={today} onSelect={setServiceDate} />
        <button className="btn ghost" onClick={() => setStripStart(addDays(stripStart, 14))}>
          →
        </button>
      </div>

      <div className="field-row">
        <label>
          Service date
          {/* The database refuses a past service date; the picker should not
              offer one in the first place. */}
          <input type="date" value={serviceDate} min={today}
                 onChange={(e) => setServiceDate(e.target.value)} />
        </label>
        <label>
          Orders close
          <input type="date" value={cutoffDate}
                 onChange={(e) => { setCutoffPinned(true); setCutoffDate(e.target.value); }} />
        </label>
        <label>
          at
          <input type="time" value={cutoffTime}
                 onChange={(e) => { setCutoffPinned(true); setCutoffTime(e.target.value); }} />
        </label>
      </div>
      <p className="muted">
        {formatDay(serviceDate)}
        {status ? ` — currently ${status}` : " — no menu yet"}
      </p>

      {isPast && (
        <p className="notice info">
          {status
            ? "This day has passed. You can still correct dishes and prices for billing, but the day itself cannot be changed."
            : "This day has passed, so a menu can no longer be created for it."}
        </p>
      )}

      {error && <p className="notice error" role="alert">{error}</p>}

      <div className="editor-layout">
        <div>
      <h2>Paste the caterer's message</h2>
      <textarea
        className="paste" rows={8} value={raw}
        placeholder={"THỰC ĐƠN THỨ 2\n1. Cơm gà xối mỡ - 45k\n2. Bún bò Huế 40.000đ"}
        onChange={(e) => setRaw(e.target.value)}
      />

      <div className="parse-summary">
        <button className="btn primary" disabled={raw.trim() === "" || reading}
                onClick={() => void readWithAi()}>
          {reading ? "Reading…" : "Read with AI"}
        </button>
        {parsed && (
          <button className="btn" onClick={applyParse}>
            Quick parse ({parsed.items.length})
          </button>
        )}
        {parsed && parsed.unparsed.length > 0 && (
          <span className="muted">
            quick parse did not understand {parsed.unparsed.length} line(s)
          </span>
        )}
      </div>

      {preview && (
        <div className="preview">
          <h3>Preview</h3>
          {preview.items.length === 0 ? (
            <p className="notice warn">
              No dishes found in that message. Check it is the right one, or type the
              dishes by hand below.
            </p>
          ) : (
            <>
              <table className="preview-table">
                <thead><tr><th>Dish</th><th>Price</th></tr></thead>
                <tbody>
                  {preview.items.map((i, n) => (
                    <tr key={n}>
                      <td>{i.name}{i.note && <span className="muted"> — {i.note}</span>}</td>
                      <td className="num">{formatAmount(i.priceMinor, org.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.serviceDate && (
                <p className="muted">Reads as for {formatDay(preview.serviceDate)}</p>
              )}
              {preview.notes.length > 0 && (
                <details>
                  <summary className="muted">
                    {preview.notes.length} line(s) treated as notes
                  </summary>
                  <ul className="muted">
                    {preview.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </details>
              )}
              <div className="actions">
                <button className="btn primary" onClick={applyPreview}>
                  Apply these {preview.items.length} dishes
                </button>
                <button className="btn ghost" onClick={() => setPreview(null)}>Discard</button>
              </div>
              <p className="muted">
                Read by {preview.model}. Check the prices — everything stays editable
                below, and nothing is saved until you publish.
              </p>
            </>
          )}
        </div>
      )}

      {parsed && parsed.unparsed.length > 0 && (
        <ul className="unparsed">
          {parsed.unparsed.map((u) => (
            <li key={u.line}>
              <code>{u.raw}</code>
              <button className="btn ghost" onClick={() =>
                setRows([...(rows ?? []), {
                  key: `m${Date.now()}${u.line}`, name: u.raw, price: "", warnings: [],
                }])}>
                Add as dish
              </button>
            </li>
          ))}
        </ul>
      )}

        </div>
        <div>
      {rows !== null && (
        <>
          <h2>Dishes</h2>
          {/* Everything is editable. A parser miss must be an annoyance, never
              a blocker: the admin can clear the box and type the day by hand. */}
          <ul className="edit-rows">
            {rows.map((r, i) => (
              <li key={r.key}>
                <input
                  aria-label="Dish name" value={r.name} placeholder="Dish name"
                  onChange={(e) => setRows(rows.map((x, j) =>
                    j === i ? { ...x, name: e.target.value } : x))}
                />
                <input
                  aria-label="Price" className="price" value={r.price} placeholder="45k"
                  onChange={(e) => setRows(rows.map((x, j) =>
                    j === i ? { ...x, price: e.target.value } : x))}
                />
                <button className="btn ghost" aria-label="Remove dish"
                        onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
                {r.warnings.map((w) => (
                  <span key={w} className="chip" title={WARNING_TEXT[w]}>!</span>
                ))}
              </li>
            ))}
          </ul>
          <button className="btn ghost" onClick={() =>
            setRows([...rows, { key: `m${Date.now()}`, name: "", price: "", warnings: [] }])}>
            + Add dish
          </button>

          <div className="actions">
            <button className="btn primary" disabled={blocked !== null || busy}
                    onClick={() => void onPublish()}>
              {busy ? "Publishing…" : status === "published" ? "Update and republish" : "Publish"}
            </button>
            {blocked && <span className="muted">{blocked}</span>}
          </div>

          {/* Publishing used to change a button label and nothing else, which
              gave an admin no way to know it worked. Report what happened, and
              in particular the standing-order count -- the one consequence
              they have no other way to see. */}
          {published && (
            <p className="notice success" role="status">
              <strong>{published.wasUpdate ? "Menu updated" : "Menu published"}</strong>
              {" — "}{published.dishes} dish{published.dishes === 1 ? "" : "es"} for{" "}
              {formatDay(serviceDate)}.{" "}
              {published.standingOrders > 0
                ? `${published.standingOrders} ${published.standingOrders === 1 ? "person was" : "people were"} added from their weekday preferences.`
                : "Nobody has a weekday preference for this day, so no orders were created automatically."}
              {" "}
              <a href={`#/o/${org.slug}/orders`}>See the board</a>
            </p>
          )}
          <p className="muted">
            Publishing creates orders for anyone whose weekday preference covers{" "}
            {formatDay(serviceDate)}.
          </p>
        </>
      )}
        </div>
      </div>
    </section>
  );
}
