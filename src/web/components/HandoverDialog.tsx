import { useState } from "react";
import {
  Action,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type ComboboxOption,
} from "@/ui";
import type { BoardCell, BoardDay, BoardMember, TransferRow } from "../api.js";
import { formatMoney } from "../../shared/money.js";
import { formatDay } from "../../shared/dates.js";
import type { Org } from "../../shared/types.js";

export type HandoverDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: Org;
  day: BoardDay;
  /** Whose cell this is. Never me. */
  member: BoardMember;
  /** Their meal that day, if they have one. */
  theirCell: BoardCell | null;
  /** My own meal that day, which is the one I can give them. */
  myCell: BoardCell | null;
  admin: boolean;
  /** Null when I can give them my meal, otherwise the sentence saying why not. */
  giveReason: string | null;
  /** Null when their meal can go to somebody else, otherwise why not. */
  passReason: string | null;
  /** Everyone their meal could go to: colleagues minus whoever holds it. */
  colleagues: BoardMember[];
  /** A live offer already sitting on their meal. */
  offer: TransferRow | null;
  /** Only the person who made an offer, or an admin, may take it back. */
  mayWithdraw: boolean;
  pending: boolean;
  onGive: () => void;
  onPassOn: (toProfileId: string, toName: string) => void;
  onWithdraw: (transferId: number) => void;
};

/**
 * A colleague's cell, opened.
 *
 * You hand a meal over by tapping the person you are giving it to, so this is
 * where that happens, on a filled cell and on an empty one alike: "I am out,
 * you have mine" is usually said to somebody who was not already eating.
 *
 * Two directions are possible on one cell, and they differ in grammar rather
 * than in appearance, so each is a sentence naming its own direction. Two
 * arrows would need a legend, and a legend is a confession that the icons do
 * not say what they mean.
 */
export function HandoverDialog(props: HandoverDialogProps) {
  const { org, day, member, theirCell, myCell, offer } = props;
  const theirDish = theirCell?.dishName ?? null;
  const myDish = myCell?.dishName ?? null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {member.name}
            <span className="text-muted"> · {formatDay(day.serviceDate)}</span>
          </DialogTitle>
          <DialogDescription>
            {theirCell === null
              ? `${member.name} is not down as eating.`
              : theirCell.transferredToName !== null
                ? `${member.name} passed this meal to ${theirCell.transferredToName}, so they are billed for it.`
                : `${member.name} is eating${theirDish === null ? ", with no dish chosen" : ""}.`}
          </DialogDescription>
        </DialogHeader>

        {theirCell !== null && theirDish !== null && (
          <div className="flex items-baseline justify-between gap-4 rounded-md bg-surface-sunken px-3 py-2">
            <span className="min-w-0 truncate font-medium">{theirDish}</span>
            {theirCell.amountMinor !== null && (
              <span className="shrink-0 text-sm text-muted tabular">
                {formatMoney(theirCell.amountMinor, org.currency)}
              </span>
            )}
          </div>
        )}

        {/* The person who rings the caterer is usually not the person who
            wanted it without the egg, so the note has to be readable here. */}
        {theirCell?.note != null && (
          <p className="text-sm text-muted">
            How they want it: <span className="text-text">{theirCell.note}</span>
          </p>
        )}

        <Action
          reason={props.giveReason}
          pending={props.pending}
          onClick={props.onGive}
          className="w-full"
        >
          {myDish === null ? `Give ${member.name} my lunch` : `Give ${member.name} my ${myDish}`}
        </Action>

        {offer !== null && (
          <section className="flex flex-col items-start gap-2 border-t border-border pt-4">
            <p className="text-sm text-muted">
              {offer.fromName} offered this to <strong className="text-text">{offer.toName}</strong>
              . They are billed once they accept.
            </p>
            {props.mayWithdraw && (
              <Action
                reason={null}
                pending={props.pending}
                variant="outline"
                onClick={() => props.onWithdraw(offer.id)}
              >
                Withdraw
              </Action>
            )}
          </section>
        )}

        {props.admin && theirCell !== null && (
          <PassOnForm {...props} theirDish={theirDish} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one place a recipient still has to be named: an admin recording a swap
 * between two other people, where neither cell on the board is the answer.
 */
function PassOnForm({
  member,
  theirDish,
  colleagues,
  passReason,
  pending,
  onPassOn,
}: HandoverDialogProps & { theirDish: string | null }) {
  // Reset per cell comes from the caller remounting this dialog, not from an
  // effect on the props: the board re-renders on its own clock, and an effect
  // would wipe a half-made choice every thirty seconds.
  const [to, setTo] = useState<string | null>(null);

  const options: ComboboxOption[] = colleagues.map((c) => ({
    value: c.profileId,
    label: c.name,
    keywords: [c.shortCode],
  }));
  const chosen = colleagues.find((c) => c.profileId === to) ?? null;

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">
        {theirDish === null
          ? `Pass ${member.name}'s meal to someone`
          : `Pass ${member.name}'s ${theirDish} to someone`}
      </h3>
      <p className="text-sm text-muted">
        Recording a swap the two of them already agreed. It takes effect immediately, so confirm it
        with both first.
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

          <Action
            reason={passReason ?? (chosen === null ? "Choose who it goes to" : null)}
            pending={pending}
            className="w-fit"
            onClick={() => chosen && onPassOn(chosen.profileId, chosen.name)}
          >
            Pass on
          </Action>
        </>
      )}
    </section>
  );
}
