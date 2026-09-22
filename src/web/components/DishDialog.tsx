import { useState } from "react";
import { DicesIcon, UtensilsCrossedIcon } from "lucide-react";
import {
  Action,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
  type ComboboxOption,
} from "@/ui";
import type { BoardCell, BoardDay, BoardMember, TransferRow } from "../api.js";
import { cutoffLabel } from "./boardModel.js";
import { formatMoney } from "../../shared/money.js";
import { formatDay } from "../../shared/dates.js";
import type { Org } from "../../shared/types.js";

export type DishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: Org;
  day: BoardDay;
  member: BoardMember;
  cell: BoardCell | null;
  /** Null when the order can be changed, otherwise the sentence saying why not. */
  orderReason: string | null;
  /** Null when the meal can be handed on, otherwise why not. */
  passReason: string | null;
  /** Everyone the meal could go to: colleagues minus whoever holds it. */
  colleagues: BoardMember[];
  /** My live offer of this meal, if there is one. */
  offer: TransferRow | null;
  /** True when I am recording somebody else's swap, which lands accepted. */
  recording: boolean;
  pending: boolean;
  onPick: (itemId: number) => void;
  onSurprise: () => void;
  onNotEating: () => void;
  onPassOn: (toProfileId: string, toName: string, note: string | null) => void;
  onWithdraw: (transferId: number) => void;
};

/**
 * One cell, opened.
 *
 * Reached only by tapping a cell that already holds a meal, or one whose
 * ordering window has closed but whose billing week has not. The first tap on
 * an empty cell orders outright and never comes here: the dialog is for the
 * minority who care which of three similar dishes arrives.
 */
export function DishDialog(props: DishDialogProps) {
  const { day, member, cell, org, orderReason, offer } = props;
  const eating = cell?.status === "placed";
  const ownDish = eating ? cell.dishName : null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {formatDay(day.serviceDate)}
            {!member.isMe && <span className="text-muted"> · {member.name}</span>}
          </DialogTitle>
          <DialogDescription>
            {describe({ day, org, orderReason, eating, ownDish, member })}
          </DialogDescription>
        </DialogHeader>

        {member.isMe && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-subtle">
              On the menu
            </h3>
            {day.dishes.map((dish) => {
              const picked = ownDish === dish.name;
              return (
                <Action
                  key={dish.id}
                  reason={orderReason}
                  pending={props.pending}
                  variant="outline"
                  aria-pressed={picked}
                  className={cn(
                    "h-auto w-full justify-between px-3 py-3 text-left",
                    picked && "border-accent bg-accent-subtle text-accent-subtle-fg",
                  )}
                  onClick={() => props.onPick(dish.id)}
                >
                  <span className="truncate font-medium">{dish.name}</span>
                  <span className="tabular text-sm text-muted">
                    {formatMoney(dish.priceMinor, org.currency)}
                  </span>
                </Action>
              );
            })}

            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              {/* Primary, not a fallback: most days nobody minds which of three
                  similar dishes arrives, and saying so is faster than choosing. */}
              <Action
                reason={orderReason}
                pending={props.pending}
                className="flex-1"
                onClick={props.onSurprise}
              >
                <DicesIcon />
                Surprise me
              </Action>
              <Action
                reason={eating ? orderReason : "You are not down as eating this day"}
                pending={props.pending}
                variant="outline"
                className="flex-1"
                onClick={props.onNotEating}
              >
                <UtensilsCrossedIcon />
                Not eating
              </Action>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-xs font-semibold text-subtle">
            Pass this meal on
          </h3>

          {cell?.transferredToName != null ? (
            <p className="text-sm text-muted">
              {member.isMe ? "You passed" : `${member.name} passed`} this meal to{" "}
              <strong className="text-text">{cell.transferredToName}</strong>, so they are billed
              for it.
            </p>
          ) : offer !== null ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted">
                Offered to <strong className="text-text">{offer.toName}</strong>. They are billed
                once they accept.
              </p>
              <Action
                reason={null}
                pending={props.pending}
                variant="outline"
                className="w-fit"
                onClick={() => props.onWithdraw(offer.id)}
              >
                Withdraw
              </Action>
            </div>
          ) : (
            <PassOnForm {...props} />
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function PassOnForm({
  colleagues,
  passReason,
  pending,
  recording,
  onPassOn,
}: Pick<DishDialogProps, "colleagues" | "passReason" | "pending" | "recording" | "onPassOn">) {
  // Reset per cell comes from the caller remounting this dialog, not from an
  // effect on the props: the board re-renders on its own clock, and an effect
  // would wipe a half-typed note every thirty seconds.
  const [to, setTo] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const options: ComboboxOption[] = colleagues.map((c) => ({
    value: c.profileId,
    label: c.name,
    keywords: [c.shortCode],
  }));
  const chosen = colleagues.find((c) => c.profileId === to) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        {recording
          ? "Recording a swap the two of them already agreed. It takes effect immediately, so confirm it with both first."
          : "Whoever eats it pays for it, so the offer becomes a charge only once they accept."}
      </p>

      {colleagues.length === 0 ? (
        <p className="text-sm text-muted">
          There is nobody else in this office yet. Add a colleague from People first.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Goes to
            <Combobox
              options={options}
              value={to}
              onChange={setTo}
              placeholder="Pass to…"
              searchPlaceholder="Type a name"
              emptyMessage="Nobody by that name is in this office."
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Note, if it helps
            <input
              value={note}
              maxLength={120}
              placeholder="out at a client meeting"
              onChange={(e) => setNote(e.target.value)}
              className="h-11 rounded-md border border-border bg-surface-raised px-3 text-base font-normal text-text placeholder:text-subtle"
            />
          </label>

          <Action
            reason={passReason ?? (chosen === null ? "Choose who it goes to" : null)}
            pending={pending}
            className="w-fit"
            onClick={() => chosen && onPassOn(chosen.profileId, chosen.name, note.trim() || null)}
          >
            Pass on
          </Action>
        </>
      )}
    </div>
  );
}

/** The one line under the title: who has what, and how long it can change. */
function describe({
  day,
  org,
  orderReason,
  eating,
  ownDish,
  member,
}: {
  day: BoardDay;
  org: Org;
  orderReason: string | null;
  eating: boolean;
  ownDish: string | null;
  member: BoardMember;
}): string {
  if (orderReason !== null) return orderReason;
  const who = member.isMe ? "You" : member.name;
  const has = member.isMe ? "have" : "has";
  const down = member.isMe ? "You are" : `${member.name} is`;
  const have = eating
    ? ownDish !== null
      ? `${who} ${has} ${ownDish}.`
      : `${down} down as eating, with no dish chosen.`
    : `${down} not down as eating.`;
  const until =
    member.isMe && day.orderCutoffAt !== null
      ? `Change this until ${cutoffLabel(day.orderCutoffAt, org.timezone)}.`
      : "";
  return `${have} ${until}`.trim();
}
