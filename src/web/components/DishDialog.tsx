import { useState } from "react";
import { DicesIcon, UtensilsCrossedIcon } from "lucide-react";
import {
  Action,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@/ui";
import type { BoardCell, BoardDay, TransferRow } from "../api.js";
import { cutoffLabel } from "./boardModel.js";
import { formatPrice } from "../../shared/money.js";
import { formatDay } from "../../shared/dates.js";
import type { Org } from "../../shared/types.js";

/** What the check constraint on `order_items.note` accepts, trimmed. */
const NOTE_MAX = 120;

export type DishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: Org;
  day: BoardDay;
  cell: BoardCell | null;
  /** Null when the order can be changed, otherwise the sentence saying why not. */
  orderReason: string | null;
  /** My live offer of this meal, if there is one. */
  offer: TransferRow | null;
  pending: boolean;
  onPick: (itemId: number, note: string | null) => void;
  onSurprise: (note: string | null) => void;
  onSaveNote: (note: string | null) => void;
  onNotEating: () => void;
  onWithdraw: (transferId: number) => void;
};

/**
 * My own cell, opened: which dish, and how I want it.
 *
 * Reached from the `+` on a day with a choice to make, and from a cell that
 * already holds a meal. Never from the dice, and never from a day with a
 * single dish on it: there is nothing to choose, so choosing is not offered.
 *
 * Handing a meal to somebody is not here. You do that by tapping the cell of
 * the person you are giving it to, because the board is already a grid of
 * people, and asking for one back in a dropdown asks you to re-enter what the
 * screen is showing you.
 */
export function DishDialog(props: DishDialogProps) {
  const { day, cell, org, orderReason, offer, pending } = props;
  const ownDish = cell?.dishName ?? null;

  const [note, setNote] = useState(cell?.note ?? "");
  const trimmed = note.trim();
  const clean = trimmed === "" ? null : trimmed;
  const noteReason =
    orderReason ??
    (cell === null
      ? "Choose a dish first, the note goes with it"
      : clean === (cell.note ?? null)
        ? "Nothing to save"
        : null);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{formatDay(day.serviceDate)}</DialogTitle>
          <DialogDescription>{describe({ day, org, orderReason, ownDish, cell })}</DialogDescription>
        </DialogHeader>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-subtle">On the menu</h3>
          {day.dishes.map((dish) => {
            const picked = ownDish === dish.name;
            return (
              <Action
                key={dish.id}
                reason={orderReason}
                pending={pending}
                variant="outline"
                aria-pressed={picked}
                className={cn(
                  "h-auto w-full justify-between px-3 py-3 text-left",
                  picked && "border-accent bg-accent-subtle text-accent-subtle-fg",
                )}
                onClick={() => props.onPick(dish.id, clean)}
              >
                <span className="truncate font-medium">{dish.name}</span>
                <span className="tabular text-sm text-muted">
                  {formatPrice(dish.priceMinor, org.currency)}
                </span>
              </Action>
            );
          })}

          {/* Under the dish because it qualifies the dish: it gets read out
              beside a name and a price when somebody rings the caterer. */}
          <label className="mt-1 flex flex-col gap-1.5 text-sm font-medium">
            How you want it
            <span className="flex gap-2">
              <input
                value={note}
                maxLength={NOTE_MAX}
                placeholder="ít cơm, không trứng"
                onChange={(e) => setNote(e.target.value)}
                className="h-11 min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 text-base font-normal text-text placeholder:text-subtle"
              />
              <Action
                reason={noteReason}
                pending={pending}
                variant="outline"
                onClick={() => props.onSaveNote(clean)}
              >
                Save note
              </Action>
            </span>
          </label>

          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            {/* Primary, not a fallback: most days nobody minds which of three
                similar dishes arrives, and saying so is faster than choosing. */}
            <Action
              reason={orderReason}
              pending={pending}
              className="flex-1"
              onClick={() => props.onSurprise(clean)}
            >
              <DicesIcon />
              Surprise me
            </Action>
            <Action
              reason={cell !== null ? orderReason : "You are not down as eating this day"}
              pending={pending}
              variant="outline"
              className="flex-1"
              onClick={props.onNotEating}
            >
              <UtensilsCrossedIcon />
              Not eating
            </Action>
          </div>
        </section>

        {cell?.transferredToName != null ? (
          <p className="border-t border-border pt-4 text-sm text-muted">
            You passed this meal to <strong className="text-text">{cell.transferredToName}</strong>,
            so they are billed for it.
          </p>
        ) : offer !== null ? (
          <section className="flex flex-col items-start gap-2 border-t border-border pt-4">
            <p className="text-sm text-muted">
              Offered to <strong className="text-text">{offer.toName}</strong>. They are billed once
              they accept.
            </p>
            <Action
              reason={null}
              pending={pending}
              variant="outline"
              onClick={() => props.onWithdraw(offer.id)}
            >
              Withdraw
            </Action>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The one line under the title: what I have, and how long it can change. */
function describe({
  day,
  org,
  orderReason,
  ownDish,
  cell,
}: {
  day: BoardDay;
  org: Org;
  orderReason: string | null;
  ownDish: string | null;
  cell: BoardCell | null;
}): string {
  if (orderReason !== null) return orderReason;
  const have =
    cell !== null
      ? ownDish !== null
        ? `You have ${ownDish}.`
        : "You are down as eating, with no dish chosen."
      : "You are not down as eating.";
  const until =
    day.orderCutoffAt !== null
      ? `Change this until ${cutoffLabel(day.orderCutoffAt, org.timezone)}.`
      : "";
  return `${have} ${until}`.trim();
}
