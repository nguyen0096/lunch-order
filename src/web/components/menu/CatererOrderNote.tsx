import { useCallback, useEffect, useState } from "react";
import { Action, Button, useAction } from "@/ui";
import { fetchCatererOrder, fetchCatererTemplate, humanError } from "../../api.js";
import {
  catererMessage,
  catererTotal,
  nobodyOrdered,
  type CatererOrder,
} from "../../../shared/catererOrder.js";
import { CatererTemplateDialog } from "./CatererTemplateDialog.js";

/**
 * The order, written out for whoever is cooking it.
 *
 * An admin reads this down the phone or pastes it into a chat, and until now
 * they assembled it themselves from the board: count the cells, remember the
 * notes, hope nobody changed their mind in the last ten minutes. This is that
 * job done from the same rows the bill is built from, so the food ordered and
 * the food billed cannot disagree.
 *
 * The office's template gives the starting text and the admin edits it for the
 * day, typically working in the notes listed underneath. The edit lives only in
 * the box: it is copied straight away, so nothing keeps it.
 *
 * Offered before the cutoff as well as after. An admin often sends a heads-up
 * early, and refusing to show a provisional count does not stop them, it just
 * makes them count by hand. The heading says which it is.
 */
export function CatererOrderNote({
  orgId,
  companyName,
  menuId,
  serviceDate,
  items,
  final,
}: {
  orgId: number;
  companyName: string;
  menuId: number;
  serviceDate: string;
  items: Array<{ id: number; name: string }>;
  /** True once ordering has closed, so the count cannot move under them. */
  final: boolean;
}) {
  const [order, setOrder] = useState<CatererOrder | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);

  // Also what Reset does: the orders are read again, because regenerating from
  // a count that moved since the page opened would send the old number.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, t] = await Promise.all([
        fetchCatererOrder({ orgId, menuId, serviceDate, items }),
        fetchCatererTemplate(orgId),
      ]);
      setOrder(o);
      setTemplate(t);
      setDraft(catererMessage(o, { companyName, template: t }));
      setLoadError(null);
    } catch (e) {
      setLoadError(humanError(e));
    } finally {
      setLoading(false);
    }
    // `items` is rebuilt on every render of the parent, so it is spread into
    // the dependency list by identity rather than compared by value.
  }, [orgId, companyName, menuId, serviceDate, JSON.stringify(items)]);

  useEffect(() => {
    void load();
  }, [load]);

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const copy = useAction(
    async (text: string) => {
      await clipboard?.writeText(text);
    },
    { success: "Copied. Paste it to the caterer." },
  );

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">The order for the caterer</h2>
        <p className="text-sm text-danger-subtle-fg">{loadError}</p>
        <div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  if (order === null) return null;

  if (nobodyOrdered(order)) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">The order for the caterer</h2>
        <p className="max-w-prose text-sm text-muted">
          Nobody has ordered for this day, so there is nothing to send the caterer.
        </p>
      </section>
    );
  }

  const total = catererTotal(order);
  const notes = order.lines.flatMap((l) => l.notes.map((n) => ({ ...n, dish: l.name })));
  const copyReason = !clipboard
    ? "Your browser will not let the page copy. Select the message and copy it by hand."
    : draft.trim() === ""
      ? "The message is empty. Reset fills it in again."
      : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="text-lg font-semibold">The order for the caterer</h2>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Edit template
        </Button>
      </div>

      <p className="max-w-prose text-sm text-muted">
        {final
          ? "Ordering has closed, so this is the final count. "
          : "Ordering is still open, so this can still change. "}
        Edit it for today before you copy it. Reset goes back to the template with the latest
        orders.
      </p>

      {/* The text exactly as it will be pasted, so a textarea and not a
          rendered list: what is in the box is what lands in the chat. */}
      <label htmlFor="caterer-order" className="sr-only">
        The message to the caterer
      </label>
      <textarea
        id="caterer-order"
        value={draft}
        rows={Math.min(Math.max(draft.split("\n").length + 1, 5), 16)}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded-lg border border-border bg-surface-raised p-3 font-mono text-sm text-text"
      />

      <div className="flex flex-wrap gap-2">
        <Action reason={copyReason} pending={copy.pending} onClick={() => void copy.run(draft)}>
          Copy the message
        </Action>
        <Action
          variant="outline"
          reason={null}
          pending={loading}
          onClick={() => void load()}
        >
          Reset
        </Action>
      </div>

      {notes.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">
            {notes.length === 1 ? "1 note" : `${notes.length} notes`}, not in the message until you
            add them
          </h3>
          <ul className="flex flex-col gap-1 text-sm wrap-anywhere">
            {notes.map((n, i) => (
              <li key={i}>
                <span className="font-medium">{n.dish}</span>
                <span className="text-muted"> · {n.who}: </span>
                {n.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {order.unchosen > 0 && (
        <p className="max-w-prose rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
          {`${order.unchosen} ${
            order.unchosen === 1 ? "person is" : "people are"
          } down as eating without a dish, so ${
            order.unchosen === 1 ? "that meal is" : "those meals are"
          } not counted in the ${total} portions. Pick for them on the board, or tell the caterer in the message.`}
        </p>
      )}

      {editing && (
        <CatererTemplateDialog
          open
          onOpenChange={setEditing}
          orgId={orgId}
          companyName={companyName}
          order={order}
          template={template}
          onSaved={(t) => {
            setTemplate(t);
            setDraft(catererMessage(order, { companyName, template: t }));
          }}
        />
      )}
    </section>
  );
}
