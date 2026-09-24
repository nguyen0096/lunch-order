import { useCallback, useEffect, useState } from "react";
import { Action, Button, useAction } from "@/ui";
import { fetchCatererOrder, humanError } from "../../api.js";
import { catererMessage, type CatererOrder } from "../../../shared/catererOrder.js";

/**
 * The order, written out for whoever is cooking it.
 *
 * An admin reads this down the phone or pastes it into a chat, and until now
 * they assembled it themselves from the board: count the cells, remember the
 * notes, hope nobody changed their mind in the last ten minutes. This is that
 * job done from the same rows the bill is built from, so the food ordered and
 * the food billed cannot disagree.
 *
 * Offered before the cutoff as well as after. An admin often sends a heads-up
 * early, and refusing to show a provisional count does not stop them, it just
 * makes them count by hand. The heading says which it is.
 */
export function CatererOrderNote({
  orgId,
  menuId,
  serviceDate,
  items,
  final,
}: {
  orgId: number;
  menuId: number;
  serviceDate: string;
  items: Array<{ id: number; name: string }>;
  /** True once ordering has closed, so the count cannot move under them. */
  final: boolean;
}) {
  const [order, setOrder] = useState<CatererOrder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrder(await fetchCatererOrder({ orgId, menuId, serviceDate, items }));
      setLoadError(null);
    } catch (e) {
      setLoadError(humanError(e));
    }
    // `items` is rebuilt on every render of the parent, so it is spread into
    // the dependency list by identity rather than compared by value.
  }, [orgId, menuId, serviceDate, JSON.stringify(items)]);

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

  const text = catererMessage(order);
  const total = order.lines.reduce((n, l) => n + l.count, 0);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">The order for the caterer</h2>
        <Action
          variant="outline"
          size="sm"
          reason={
            clipboard
              ? null
              : "Your browser will not let the page copy. Select the message and copy it by hand."
          }
          pending={copy.pending}
          onClick={() => void copy.run(text)}
        >
          Copy the message
        </Action>
      </div>

      <p className="max-w-prose text-sm text-muted">
        {final
          ? "Ordering has closed, so this is the final count. It is in Vietnamese, because the caterer is the one reading it."
          : "Ordering is still open, so this can still change. It is in Vietnamese, because the caterer is the one reading it."}
      </p>

      {/* The text exactly as it will be pasted. A rendered list would look
          tidier and would not be what lands in the chat. */}
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-sm whitespace-pre-wrap text-text">
        {text}
      </pre>

      {order.unchosen > 0 && (
        <p className="max-w-prose rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
          {`${order.unchosen} ${
            order.unchosen === 1 ? "person is" : "people are"
          } down as eating without a dish, so ${
            order.unchosen === 1 ? "that meal is" : "those meals are"
          } not in the ${total} above. Pick for them on the board, or leave the sentence in and tell the caterer later.`}
        </p>
      )}
    </section>
  );
}
