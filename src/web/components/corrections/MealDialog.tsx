import { useState } from "react";
import {
  Action,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui";
import type { BoardDay, RecordedMeal } from "../../api.js";
import {
  PRICE_PENDING,
  formatMoney,
  parseVietnamesePrice,
  type Currency,
} from "../../../shared/money.js";
import { longDay } from "../menu/labels.js";
import { ReasonField } from "./ReasonField.js";
import { mealPreview, removalPreview } from "./model.js";

/** What one person had that day, as the admin is about to record it. */
export type MealCorrection = {
  /** Null when the dish was never on the menu and arrives with its own price. */
  menuItemId: number | null;
  dishName: string;
  /** Only read when `menuItemId` is null. */
  priceMinor: number | null;
  quantity: number;
  note: string | null;
  reason: string | null;
};

/** The option that turns the picker into a dish nobody published. */
const OFF_MENU = "off-menu";

const NOTE_MAX = 120;
const MAX_PORTIONS = 20;

/**
 * One person, one day, one save.
 *
 * The dialog is the confirmation: what it would do to that person's money is
 * on screen in figures, directly above the button that does it. There is no
 * second overlay and no way to gather two people's corrections into one press,
 * because a rarely used tool that moves money should make every change a
 * separate deliberate act.
 *
 * Recording a dish that was never on the menu is the same flow one step
 * further, not a mode: it is an option in the same picker, and choosing it
 * asks for the two things a published dish would already have.
 */
export function MealDialog({
  open,
  serviceDate,
  person,
  meal,
  dishes,
  currency,
  pending,
  error,
  onOpenChange,
  onSave,
  onRemove,
}: {
  open: boolean;
  serviceDate: string;
  person: { name: string; balanceMinor: number };
  /** Null when nothing is recorded for this person on this day. */
  meal: RecordedMeal | null;
  dishes: BoardDay["dishes"];
  currency: Currency;
  pending: boolean;
  /** The database's own refusal, kept on screen while the dialog stays open. */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (correction: MealCorrection) => void;
  onRemove: (reason: string | null) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [picked, setPicked] = useState<string | null>(
    meal === null || meal.menuItemId === null ? null : String(meal.menuItemId),
  );
  const [offMenuName, setOffMenuName] = useState("");
  const [offMenuPrice, setOffMenuPrice] = useState("");
  const [quantity, setQuantity] = useState(meal === null || meal.quantity < 1 ? 1 : meal.quantity);
  const [note, setNote] = useState(meal?.note ?? "");
  const [reason, setReason] = useState("");

  const offMenu = picked === OFF_MENU;
  const dish = dishes.find((d) => String(d.id) === picked) ?? null;
  const read = parseVietnamesePrice(offMenuPrice);
  const unitMinor = offMenu ? read?.minor ?? null : dish?.priceMinor ?? null;
  // An emptied number box reads as NaN, which is neither above 20 nor below 1.
  // Left to reach the arithmetic it would take the preview with it, so it is
  // the same kind of "not said yet" as a missing dish.
  const countable = Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_PORTIONS;
  const afterMinor = unitMinor === null || !countable ? null : unitMinor * quantity;

  const options = [
    ...dishes.map((d) => ({
      value: String(d.id),
      label: `${d.name} · ${d.priceMinor === null ? PRICE_PENDING : formatMoney(d.priceMinor, currency)}`,
      keywords: [d.name],
    })),
    { value: OFF_MENU, label: "A dish that was not on the menu" },
  ];

  const problem =
    picked === null
      ? "Pick what they had first"
      : offMenu && offMenuName.trim() === ""
        ? "Give the dish a name"
        : offMenu && read === null
          ? "Say what the dish cost"
          : !countable
            ? `A meal is between 1 and ${MAX_PORTIONS} portions`
            : null;

  function save() {
    if (problem !== null) return;
    onSave({
      menuItemId: offMenu ? null : dish?.id ?? null,
      dishName: offMenu ? offMenuName.trim() : dish?.name ?? "",
      priceMinor: offMenu ? read?.minor ?? null : null,
      quantity,
      note: note.trim() === "" ? null : note.trim(),
      reason: reason.trim() === "" ? null : reason.trim(),
    });
  }

  if (!open) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {removing
              ? `Remove ${person.name}'s meal`
              : meal === null
                ? `Add a meal for ${person.name}`
                : `Change what ${person.name} had`}
          </DialogTitle>
          <DialogDescription>{longDay(serviceDate)}</DialogDescription>
        </DialogHeader>

        {removing && meal !== null ? (
          <div className="flex flex-col gap-4 text-sm">
            <p>
              {`The record says ${meal.dishName ?? "eating, with no dish named"}${
                meal.quantity > 1 ? ` × ${meal.quantity}` : ""
              }.`}
            </p>
            <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
              {removalPreview({
                name: person.name,
                meal,
                balanceMinor: person.balanceMinor,
                currency,
              })}
            </p>

            <ReasonField value={reason} onChange={setReason} />

            {error !== null && <p className="text-danger-subtle-fg">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="correction-dish" className="text-xs font-medium text-subtle">
                What they had
              </label>
              <Combobox
                id="correction-dish"
                aria-label="What they had"
                options={options}
                value={picked}
                placeholder="Pick a dish"
                searchPlaceholder="Search the day's dishes"
                emptyMessage="No dish on this day matches that."
                onChange={setPicked}
              />
            </div>

            {offMenu && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="off-menu-name" className="text-xs font-medium text-subtle">
                    Dish
                  </label>
                  <input
                    id="off-menu-name"
                    value={offMenuName}
                    onChange={(e) => setOffMenuName(e.target.value)}
                    className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="off-menu-price" className="text-xs font-medium text-subtle">
                    What it cost
                  </label>
                  <input
                    id="off-menu-price"
                    value={offMenuPrice}
                    inputMode="numeric"
                    onChange={(e) => setOffMenuPrice(e.target.value)}
                    className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base tabular"
                  />
                  {/* The reading, shown as the parser took it, the way the menu
                      editor shows it: 45k and 45.000 are the same keystrokes
                      read two ways and the person has to see which we took. */}
                  {read !== null && (
                    <p className="tabular text-xs text-muted">{formatMoney(read.minor, currency)}</p>
                  )}
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="correction-quantity" className="text-xs font-medium text-subtle">
                  Portions
                </label>
                <input
                  id="correction-quantity"
                  type="number"
                  min={1}
                  max={MAX_PORTIONS}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base tabular"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="correction-note" className="text-xs font-medium text-subtle">
                  Note for the caterer
                </label>
                <input
                  id="correction-note"
                  value={note}
                  maxLength={NOTE_MAX}
                  onChange={(e) => setNote(e.target.value)}
                  className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base"
                />
              </div>
            </div>

            <ReasonField value={reason} onChange={setReason} />

            {/* Above the button that does it, and never where a figure the
                screen worked out itself could be read as the ledger's. */}
            {picked !== null && countable && (
              <p className="rounded-md bg-surface-sunken px-3 py-2 text-muted">
                {mealPreview({
                  name: person.name,
                  beforeMinor: meal?.amountMinor ?? null,
                  hadMeal: meal !== null,
                  afterMinor,
                  balanceMinor: person.balanceMinor,
                  currency,
                })}
              </p>
            )}

            {error !== null && <p className="text-danger-subtle-fg">{error}</p>}

            {meal !== null && (
              <div>
                <Button
                  variant="link"
                  className="h-auto px-0"
                  onClick={() => setRemoving(true)}
                >
                  This meal did not happen
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => (removing ? setRemoving(false) : onOpenChange(false))}
          >
            {removing ? "Back" : "Cancel"}
          </Button>
          {removing ? (
            <Action
              reason={null}
              pending={pending}
              variant="danger"
              onClick={() => onRemove(reason.trim() === "" ? null : reason.trim())}
            >
              {pending ? "Removing…" : "Remove the meal"}
            </Action>
          ) : (
            <Action reason={problem} pending={pending} onClick={save}>
              {pending ? "Saving…" : "Save the correction"}
            </Action>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
