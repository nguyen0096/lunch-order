import {
  Action,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
  /** Null when I can give them my meal, otherwise the sentence saying why not. */
  giveReason: string | null;
  /** A live offer already sitting on their meal. */
  offer: TransferRow | null;
  /** Their meal went to me, which the sentence says as "you". */
  passedToMe: boolean;
  /** Only the person who made an offer may take it back. */
  mayWithdraw: boolean;
  pending: boolean;
  onGive: () => void;
  onWithdraw: (transferId: number) => void;
};

/**
 * A colleague's cell, opened.
 *
 * You hand a meal over by tapping the person you are giving it to, so this is
 * where that happens, on a filled cell and on an empty one alike: "I am out,
 * you have mine" is usually said to somebody who was not already eating.
 *
 * One direction, and one for everybody: you give away a meal of your own.
 * Moving a meal between two other people is a correction of what was recorded
 * rather than an arrangement, and this board does not do it for anybody.
 */
export function HandoverDialog(props: HandoverDialogProps) {
  const { org, day, member, theirCell, myCell, offer } = props;
  const theirDish = theirCell?.dishName ?? null;
  const myDish = myCell?.dishName ?? null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto wrap-anywhere">
        <DialogHeader>
          <DialogTitle>
            {member.name}
            <span className="text-muted"> · {formatDay(day.serviceDate)}</span>
          </DialogTitle>
          <DialogDescription>
            {theirCell === null
              ? `${member.name} is not down as eating.`
              : theirCell.transferredToName !== null
                ? props.passedToMe
                  ? `${member.name} passed this meal to you, so you are billed for it.`
                  : `${member.name} passed this meal to ${theirCell.transferredToName}, so they are billed for it.`
                : `${member.name} is eating${theirDish === null ? ", with no dish chosen" : ""}.`}
          </DialogDescription>
        </DialogHeader>

        {theirCell !== null && theirDish !== null && (
          <div className="flex items-baseline justify-between gap-4 rounded-md bg-surface-sunken px-3 py-2">
            <span className="min-w-0 font-medium">{theirDish}</span>
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
          className="h-auto min-h-11 w-full py-2 whitespace-normal"
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
      </DialogContent>
    </Dialog>
  );
}
