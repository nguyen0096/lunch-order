import {
  Action,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui";
import { changeSummary, type SavedDish } from "./DishRows.js";
import {
  cutoffLabel,
  dishesHave,
  longDay,
  people,
  peopleHave,
  weekdayName,
} from "./labels.js";
import type { PublishImpact } from "../../api.js";
import type { MenuStatus, Org } from "../../../shared/types.js";

/**
 * The one confirmation in the app, because publishing is the one action that
 * commits somebody else.
 *
 * `trg_menu_published_materialize` turns a publish into real orders for
 * everyone with a standing day on that weekday, and those people are then told
 * lunch is on. An admin who has only ever published an empty week has no way to
 * know that from the button, so the count is named here before it happens
 * rather than reported afterwards.
 */
export function PublishDialog({
  open,
  onOpenChange,
  org,
  serviceDate,
  status,
  changes,
  unpriced,
  impact,
  cutoffAt,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: Org;
  serviceDate: string;
  /** The menu's status now, null when the date has no menu yet. */
  status: MenuStatus | null;
  /** What publishing does to the saved dishes, from `dishChanges`. */
  changes: { updated: number; added: number; removed: SavedDish[] };
  /** How many of those the caterer has not priced. Normal, and consequential. */
  unpriced: number;
  impact: PublishImpact | null;
  cutoffAt: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const standing = impact?.standing ?? 0;
  const orders = impact?.orders ?? 0;
  const chosen = impact?.chosen ?? 0;
  const republish = status === "published";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Publish the menu for ${longDay(serviceDate)}?`}</DialogTitle>
          <DialogDescription>
            {`${changeSummary({ ...changes, removed: changes.removed.length })}, orders close ${cutoffLabel(cutoffAt, org.timezone)}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {changes.removed.length > 0 && (
            <p>{`Removed: ${changes.removed.map((d) => d.name).join(", ")}.`}</p>
          )}

          {republish ? (
            <p>
              {`This menu is already published, so nobody new is ordered for. Changing a price sets what the next person pays; the ${people(
                orders,
              )} already on it keep the price they ordered at.`}
            </p>
          ) : standing > 0 ? (
            <p className="rounded-md bg-accent-subtle px-3 py-2 text-accent-subtle-fg">
              {`This orders lunch for ${people(standing)} with a standing ${weekdayName(
                serviceDate,
              )}, and tells them it is on.`}
            </p>
          ) : (
            <p>
              {`Nobody has a standing ${weekdayName(
                serviceDate,
              )}, so this notifies nobody. Colleagues order for themselves from the board.`}
            </p>
          )}

          {chosen > 0 && (
            <p className="text-muted">
              {`${peopleHave(chosen)} already chosen a dish. Removing a dish somebody chose will be refused.`}
            </p>
          )}

          {/* Not styled as a warning: a caterer who prices at the weekend is an
              ordinary Saturday. It is here because not billing somebody for a
              meal they ate is a real consequence of this button, and the admin
              is the only person who can see it coming. */}
          {unpriced > 0 && (
            <p className="text-muted">
              {`${dishesHave(unpriced)} no price yet. People can order as usual, but a meal with no price is not billed until you set one, and the week stays open until then.`}
            </p>
          )}

          <p className="text-muted">
            Nothing has been written yet. This is the write.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Action reason={null} pending={pending} onClick={onConfirm}>
            {pending ? "Publishing…" : "Publish"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
