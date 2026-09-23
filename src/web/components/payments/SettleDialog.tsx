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
import { formatMoney, type Currency } from "../../../shared/money.js";
import type { Reconciliation } from "../../../shared/settlement.js";
import type { SettlePlan } from "./settlePlan.js";
import { meals, weekLabel } from "./labels.js";

/**
 * The last thing read before what people owe changes.
 *
 * Applying a price is not reversible from this screen in any useful sense: the
 * prices go onto the menu, the snapshot copies them onto meals already eaten,
 * and billing turns them into statements somebody is then asked to pay. So the
 * confirmation names the size of it -- dishes, menu rows, portions, and the
 * figure the week lands on -- rather than asking "are you sure".
 */
export function SettleDialog({
  open,
  plan,
  reconciled,
  periodStart,
  periodEnd,
  currency,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  plan: SettlePlan;
  reconciled: Reconciliation;
  periodStart: string;
  periodEnd: string;
  currency: Currency;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  const week = weekLabel(periodStart, periodEnd);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Settle ${week}`}</DialogTitle>
          <DialogDescription>
            {plan.prices.length === 0
              ? "No price on this week changes. This runs the billing and nothing else."
              : `${dishes(plan.prices.length)} get a price, across ${rows(plan.menuItems)}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {plan.prices.length > 0 && (
            <>
              <ul className="flex flex-col gap-1">
                {plan.prices.map((p) => (
                  <li key={p.name} className="flex justify-between gap-4">
                    <span className="break-words">{p.name}</span>
                    <span className="tabular whitespace-nowrap">
                      {formatMoney(p.priceMinor, currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-base">
                {`The price is copied onto ${meals(plan.portions)} already eaten, so this changes what people owe.`}
              </p>
            </>
          )}

          <p>
            {`At the board's own counts, the week comes to ${formatMoney(
              plan.totalMinor,
              currency,
            )} of food.`}
            {reconciled.statedTotalMinor !== null &&
              reconciled.statedTotalMinor !== plan.totalMinor &&
              ` The caterer's message states ${formatMoney(
                reconciled.statedTotalMinor,
                currency,
              )}.`}
          </p>

          {reconciled.disagreements > 0 && (
            <p className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg">
              {`${dishes(reconciled.disagreements)} still count differently on the two sides. Billing uses the board's count, not the caterer's, so a disagreement you meant to settle with them will be billed the board's way.`}
            </p>
          )}

          {plan.contradicted.map((c) => (
            <p
              key={c.name}
              className="rounded-md bg-warn-subtle px-3 py-2 text-warn-subtle-fg"
            >
              {`The board already prices ${c.name} at ${c.boardMinor
                .map((m) => formatMoney(m, currency))
                .join(" and ")}, and the caterer's message says ${formatMoney(
                c.theirMinor,
                currency,
              )}. A price already agreed cannot be changed once the menu locks, so those meals go on billing what they were priced at. ${
                c.waitingCount > 0
                  ? `Only the ${meals(c.waitingCount)} still waiting take ${formatMoney(
                      c.theirMinor,
                      currency,
                    )}.`
                  : "Nothing is written for this dish."
              }`}
            </p>
          ))}

          {plan.cancelled.length > 0 && (
            <p className="text-muted">
              {`${plan.cancelled.join(", ")} also appears on a cancelled day, which takes no price at all. Nothing is written there.`}
            </p>
          )}

          {plan.unknown.length > 0 && (
            <p className="text-muted">
              {`The caterer also priced ${plan.unknown.join(", ")}, which was on no menu this week. Nothing is written for those.`}
            </p>
          )}

          {plan.unchanged.length > 0 && (
            <p className="text-muted">
              {`${plan.unchanged.join(", ")} already carries the price in their message, so nothing changes there.`}
            </p>
          )}

          <p className="text-muted">
            Billing then rewrites this week&rsquo;s statements, and closes the week if it has
            ended. A meal still waiting on a price is left off rather than billed at nothing, and
            a week carrying one of those refuses to close until it has a price.
          </p>
          <p className="text-muted">Nothing has been written yet. This is the write.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Action reason={null} pending={pending} onClick={onConfirm}>
            {pending ? "Settling…" : "Settle the week"}
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function dishes(n: number): string {
  return `${n} ${n === 1 ? "dish" : "dishes"}`;
}

function rows(n: number): string {
  return `${n} ${n === 1 ? "menu row" : "menu rows"}`;
}
