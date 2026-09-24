import { useState } from "react";
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
import type { RecordedMeal } from "../../api.js";
import { formatMoney, parseVietnamesePrice, type Currency } from "../../../shared/money.js";
import { longDay } from "../menu/labels.js";
import { ReasonField } from "./ReasonField.js";
import { peopleWord, portions, repriceImpact } from "./model.js";

/**
 * The caterer charged something other than the menu said.
 *
 * That is a fact about the dish and not about each person who ate it, so it is
 * corrected once. It is also the only control on this screen that moves
 * several people's money in one press, which is why the confirmation counts
 * the people, counts the portions, and states the money going onto bills and
 * the money coming off them separately: one net figure would hide a day where
 * half the office is charged more and half less.
 */
export function RepriceDialog({
  open,
  serviceDate,
  dish,
  meals,
  currency,
  pending,
  error,
  onOpenChange,
  onReprice,
}: {
  open: boolean;
  serviceDate: string;
  dish: { id: number; name: string; priceMinor: number | null };
  /** Every meal recorded on the day, so the impact is counted off the record. */
  meals: RecordedMeal[];
  currency: Currency;
  pending: boolean;
  /** The database's own refusal, kept on screen while the dialog stays open. */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onReprice: (priceMinor: number, reason: string | null) => void;
}) {
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");

  const read = parseVietnamesePrice(price);
  const impact =
    read === null
      ? null
      : repriceImpact({ meals, menuItemId: dish.id, priceMinor: read.minor });

  const problem =
    read === null
      ? "Say what the caterer charged"
      : read.minor === dish.priceMinor
        ? "That is the price it already carries"
        : null;

  if (!open) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Reprice ${dish.name}`}</DialogTitle>
          <DialogDescription>
            {`${longDay(serviceDate)} only. Every meal on this dish that day takes the new price at once.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <p>
            {dish.priceMinor === null
              ? "The menu carries no price for this dish yet."
              : `The menu says ${formatMoney(dish.priceMinor, currency)}.`}
          </p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="reprice-price" className="text-xs font-medium text-subtle">
              What the caterer charged
            </label>
            <input
              id="reprice-price"
              value={price}
              inputMode="numeric"
              onChange={(e) => setPrice(e.target.value)}
              className="h-11 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-base tabular"
            />
            {read !== null && (
              <p className="tabular text-xs text-muted">{formatMoney(read.minor, currency)}</p>
            )}
          </div>

          <ReasonField value={reason} onChange={setReason} />

          {impact !== null && read !== null && (
            <div className="flex flex-col gap-2 rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
              {impact.people === 0 ? (
                <p>
                  Nobody has this dish on that day, so this changes the menu price and moves no
                  money.
                </p>
              ) : (
                <>
                  <p>
                    {`${peopleWord(impact.people)} had it, ${portions(impact.portions)} in all.`}
                  </p>
                  <p>
                    {impact.ontoMinor > 0 && impact.offMinor > 0
                      ? `${formatMoney(impact.ontoMinor, currency)} goes onto bills and ${formatMoney(
                          impact.offMinor,
                          currency,
                        )} comes off them.`
                      : impact.ontoMinor > 0
                        ? `${formatMoney(impact.ontoMinor, currency)} goes onto their bills.`
                        : impact.offMinor > 0
                          ? `${formatMoney(impact.offMinor, currency)} comes off their bills.`
                          : "No money moves: every portion already bills at that price."}
                  </p>
                  {impact.waitingPortions > 0 && (
                    <p>
                      {`${portions(impact.waitingPortions)} of those carried no price at all, so they take the whole ${formatMoney(
                        read.minor,
                        currency,
                      )}.`}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {error !== null && <p className="text-danger-subtle-fg">{error}</p>}

          <p className="text-muted">
            The figures above are what this would do. What each person is charged is decided as it
            is written.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Action
            reason={problem}
            pending={pending}
            onClick={() => {
              if (read === null || problem !== null) return;
              onReprice(read.minor, reason.trim() === "" ? null : reason.trim());
            }}
          >
            {pending ? "Repricing…" : "Reprice for this day"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
