import { useState } from "react";
import {
  Action,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useAction,
  type ActionHandle,
} from "@/ui";
import { cutoffLabel, longDay, peopleHave, weekdayName } from "./labels.js";
import { setMenuStatus } from "../../api.js";
import { now as appNow } from "../../../shared/clock.js";
import { todayIn } from "../../../shared/dates.js";
import type { MenuStatus } from "../../../shared/types.js";

/**
 * The status changes the screen never offered, standing beside the status they
 * change.
 *
 * `enforce_menu_lifecycle` has permitted every one of these since the first
 * migration and nothing here re-implements it: each control sends a status and
 * lets the trigger answer.
 *
 * Reopening is what an admin reaches for when the cutoff closed a day by
 * mistake, so it is offered only while the day is still ahead: there is nothing
 * to order for a lunch that has already been eaten.
 *
 * Un-publishing used to sit here and no longer does. A published menu is
 * editable in place, so the only thing un-publishing added was hiding a day
 * from members -- and a day that is hidden but still being cooked is a state
 * with no meaning to anybody. Calling lunch off is Cancel, which says so.
 *
 * Cancelling is the only one behind a typed confirmation: no transition leaves
 * `cancelled`, so nothing in this app takes it back, and the day strip above
 * makes it one tap to be looking at a date you did not mean.
 *
 * It is offered only while ordering is still open. The cutoff is when the
 * headcount goes to the caterer, so before it calling lunch off costs nothing
 * and after it the food is being made: "cancelled" would be a claim about the
 * world that is not true, and the database refuses it for the same reason.
 * Cancelling now takes the day's orders with it, which is what the word means
 * and what it did not used to do.
 */
export function StatusActions({
  status,
  menuId,
  serviceDate,
  orders,
  cutoffAt,
  timeZone,
  onSettled,
}: {
  status: MenuStatus;
  menuId: number;
  serviceDate: string;
  /** Orders already on this menu, from `fetchPublishImpact`; null until it lands. */
  orders: number | null;
  /** The menu's STORED cutoff, not the one being edited: this is about the day as it is. */
  cutoffAt: string;
  timeZone: string;
  /** The status the database accepted, or null when it refused. Either way, reload. */
  onSettled: (applied: MenuStatus | null) => void;
}) {
  const [reopening, setReopening] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [typed, setTyped] = useState("");

  const reopen = useAction(async () => setMenuStatus({ menuId, status: "published" }), {
    success: "Reopened · people can order again",
    onSuccess: () => setReopening(false),
  });

  const cancel = useAction(async () => setMenuStatus({ menuId, status: "cancelled" }), {
    success: "Cancelled · lunch is off for this day",
    onSuccess: () => openCancel(false),
  });

  // Every attempt reports back, refused ones included: a refusal here almost
  // always means the day is no longer what this screen thinks it is, and the
  // screen is the last place that should go on insisting otherwise.
  async function apply(action: ActionHandle<[], void>, next: MenuStatus) {
    const result = await action.run();
    onSettled(result.ok ? next : null);
  }

  function openCancel(next: boolean) {
    setCancelling(next);
    // A half-typed day left behind is a confirmation already half passed.
    if (!next) setTyped("");
  }

  const day = weekdayName(serviceDate);
  // Exact, not case-folded: typing the day is the whole confirmation, and its
  // job is to prove you know which day, not that you can reach the keyboard.
  const confirmed = typed === day;

  // A locked menu got there from the hourly check, so this is all but always
  // true; it is asked rather than assumed because the answer changes the sentence.
  const cutoffPassed = Date.parse(cutoffAt) <= appNow().getTime();

  // The office's day, not the reader's: an admin on a trip must see the same
  // day the kitchen is cooking for.
  const dayHasPassed = serviceDate < todayIn(timeZone, appNow());

  return (
    <>
      {status === "locked" && !dayHasPassed && (
        <Action
          reason={null}
          pending={reopen.pending}
          variant="outline"
          size="sm"
          onClick={() => setReopening(true)}
        >
          Reopen ordering
        </Action>
      )}

      {/* Outline, not danger. The loud red belongs on the button that does it,
          inside the dialog; out here it made calling lunch off the most
          prominent thing on a screen whose job is publishing a menu. */}
      {status === "published" && !cutoffPassed && (
        <Action
          reason={null}
          pending={cancel.pending}
          variant="outline"
          size="sm"
          className="text-danger hover:text-danger"
          onClick={() => openCancel(true)}
        >
          Cancel lunch
        </Action>
      )}

      <Dialog open={reopening} onOpenChange={setReopening}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{`Reopen ordering for ${longDay(serviceDate)}?`}</DialogTitle>
            <DialogDescription>
              This day goes back to published, and everybody can order from it again.
            </DialogDescription>
          </DialogHeader>

          {cutoffPassed ? (
            <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
              {`Orders closed ${cutoffLabel(
                cutoffAt,
                timeZone,
              )}. The hourly check locks every published day whose cutoff has gone, so move the cutoff later once this reopens, or it closes itself again within the hour.`}
            </p>
          ) : (
            <p className="text-sm text-muted">
              {`Anybody with a standing ${day} and no order yet is ordered for again.`}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Leave it closed</Button>
            </DialogClose>
            <Action
              reason={null}
              pending={reopen.pending}
              onClick={() => void apply(reopen, "published")}
            >
              {reopen.pending ? "Reopening…" : "Reopen ordering"}
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelling} onOpenChange={openCancel}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{`Cancel lunch on ${longDay(serviceDate)}?`}</DialogTitle>
            <DialogDescription>
              Every order for this day is cancelled with it, and nothing here takes it back:
              no status leaves cancelled.
            </DialogDescription>
          </DialogHeader>

          {orders !== null && (
            <p
              className={
                orders > 0
                  ? "rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg"
                  : "text-sm text-muted"
              }
            >
              {orders > 0
                ? `${peopleHave(
                    orders,
                  )} already ordered. Their orders are cancelled too, and nothing for this day reaches anybody's bill. Tell them, because the app will not: they chose a lunch and there will not be one.`
                : "Nobody has ordered for this day yet."}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-cancel-day" className="text-sm font-medium">
              {`Type ${day} to confirm`}
            </label>
            <input
              id="confirm-cancel-day"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={day}
              maxLength={20}
              autoComplete="off"
              className="h-11 rounded-md border border-border bg-surface-raised px-3 text-base"
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep lunch on</Button>
            </DialogClose>
            <Action
              reason={confirmed ? null : `Type ${day} exactly to confirm`}
              pending={cancel.pending}
              variant="danger"
              onClick={() => void apply(cancel, "cancelled")}
            >
              {cancel.pending ? "Cancelling…" : "Cancel lunch"}
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
