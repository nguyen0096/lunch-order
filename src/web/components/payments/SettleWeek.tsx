import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Action, Button, EmptyState, Skeleton, useAction } from "@/ui";
import {
  applyCatererPrices,
  fetchSettlementWeek,
  humanError,
  settlePeriod,
  type PaymentsPeriod,
  type SettlementWeek,
} from "../../api.js";
import { formatDay } from "../../../shared/dates.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import {
  parseSettlement,
  reconcile,
  type ParsedSettlement,
  type Reconciliation,
} from "../../../shared/settlement.js";
import { ReconcileTable } from "./ReconcileTable.js";
import { SettleDialog } from "./SettleDialog.js";
import { planApply, type SettlePlan } from "./settlePlan.js";
import { meals, weekLabel } from "./labels.js";

/**
 * Settling a week: the caterer's weekend message, checked against the board,
 * turned into prices and a bill.
 *
 * The caterer does not price at publish time. One message arrives at the
 * weekend carrying one price per dish for the whole week, often their own
 * count of portions and usually a total, by which point everybody has already
 * eaten. Until it arrives those meals have no price at all -- not a price of
 * zero, which on a bill reads as a free lunch -- so they are held off the bill
 * and the week is held open.
 *
 * The message is read in this browser and nothing is written until the
 * confirmation, which is what makes it safe to paste a half-remembered message
 * and look at what it says.
 */
export function SettleWeek({
  orgId,
  period,
  currency,
  onSettled,
}: {
  orgId: number;
  period: PaymentsPeriod;
  currency: Currency;
  /** Run once the week has been billed, so the screen behind refetches. */
  onSettled: () => void;
}) {
  const headingId = useId();
  const messageId = useId();

  const [week, setWeek] = useState<SettlementWeek | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedSettlement | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setWeek(null);
    try {
      setWeek(
        await fetchSettlementWeek({
          orgId,
          periodId: period.periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        }),
      );
      setLoadError(null);
    } catch (e) {
      // `useAction` owns every write. A read has no toast to fire and nothing
      // to put back, so its failure is a state this panel renders instead.
      setLoadError(humanError(e));
    }
  }, [orgId, period.periodId, period.periodStart, period.periodEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  // A different week is a different message. Leaving the old parse on screen
  // would show one week's dishes beside another week's counts.
  useEffect(() => {
    setParsed(null);
    setConfirming(false);
  }, [period.periodId]);

  const reconciled = useMemo(
    () =>
      parsed === null || week === null
        ? null
        : reconcile(
            parsed,
            week.dishes.map((d) => ({
              name: d.name,
              count: d.ourCount,
              waitingCount: d.waitingCount,
              pricedAtMinor: d.existingPricesMinor,
            })),
          ),
    [parsed, week],
  );

  const plan = useMemo(
    () => (reconciled === null || week === null ? null : planApply(reconciled, week)),
    [reconciled, week],
  );

  const settle = useAction(
    async () => {
      if (plan === null) throw new Error("Read the caterer's message first.");
      const applied = await applyCatererPrices({ orgId, prices: plan.prices });
      // Only now does the money move. Pricing the menu changes what a dish
      // costs; billing is what turns that into what somebody is asked to pay.
      const settled = await settlePeriod(period.periodId);
      return { applied, settled };
    },
    {
      success: (r) =>
        `Settled ${weekLabel(period.periodStart, period.periodEnd)}: ${
          r.applied.dishes > 0
            ? `priced ${r.applied.dishes} ${r.applied.dishes === 1 ? "dish" : "dishes"} onto ${meals(
                r.applied.orderItems,
              )}, and `
            : ""
        }billed ${meals(r.settled.lines)} into ${r.settled.statements} ${
          r.settled.statements === 1 ? "statement" : "statements"
        }, ${formatMoney(r.settled.totalMinor, currency)}.`,
      onSuccess: () => {
        setConfirming(false);
        void load();
        onSettled();
      },
    },
  );

  if (loadError !== null) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          Settle the week
        </h2>
        <EmptyState
          heading="This week's dishes did not load"
          action={
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </EmptyState>
      </section>
    );
  }


  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Settle the week
        </h2>
        <p className="max-w-prose text-sm text-muted">
          Paste the caterer&rsquo;s weekend message. It is read here, checked against what the
          board recorded, and nothing is written until you confirm.
        </p>
      </div>

      {week === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <>
          {week.unpricedOrders > 0 && (
            <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
              {`${meals(week.unpricedOrders)} this week are still waiting on a price. They are held off the bill rather than billed at nothing, and the week cannot close until they have one.`}
            </p>
          )}

          <div className="flex flex-col gap-3">
            <label htmlFor={messageId} className="text-sm font-semibold">
              The caterer&rsquo;s message
            </label>
            <textarea
              id={messageId}
              value={text}
              rows={4}
              placeholder={"cơm tấm 50k, tuần rồi em ăn 5 phần, bún bò 60k, tổng cộng là 550k"}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-raised p-3 text-base"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Action
                reason={text.trim() === "" ? "Paste the caterer's message first." : null}
                variant="outline"
                onClick={() => setParsed(parseSettlement(text))}
              >
                Read the message
              </Action>
              <p className="text-xs text-subtle">
                Reading happens in this browser and writes nothing.
              </p>
            </div>
          </div>

          {week.dishes.length === 0 && (
            <EmptyState heading="No dishes on this week">
              No menu was published between {formatDay(period.periodStart)} and{" "}
              {formatDay(period.periodEnd)}, so there is nothing for the caterer to have priced.
            </EmptyState>
          )}

          {parsed !== null && reconciled !== null && plan !== null && (
            <div className="flex flex-col gap-4">
              {parsed.dishes.length === 0 ? (
                <EmptyState heading="No dish was found in that message">
                  Nothing in it reads as a dish with a price. Check it reads like &ldquo;cơm tấm
                  50k&rdquo;, then read it again.
                </EmptyState>
              ) : (
                <ReconcileTable reconciled={reconciled} currency={currency} />
              )}

              <Totals reconciled={reconciled} plan={plan} currency={currency} />

              {parsed.unparsed.length > 0 && (
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">Not read</h3>
                  <ul className="flex flex-col gap-0.5 text-sm text-muted">
                    {parsed.unparsed.map((u) => (
                      <li key={`${u.line}:${u.raw}`} className="break-words">
                        {u.raw}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-subtle">
                    Nothing in these lines was read as a dish and a price. If one of them is a
                    dish, correct the message and read it again.
                  </p>
                </div>
              )}

              <Action
                reason={settleReason(period, plan, parsed)}
                className="self-start"
                onClick={() => setConfirming(true)}
              >
                Settle the week
              </Action>
            </div>
          )}

          {plan !== null && reconciled !== null && (
            <SettleDialog
              open={confirming}
              plan={plan}
              reconciled={reconciled}
              periodStart={period.periodStart}
              periodEnd={period.periodEnd}
              currency={currency}
              pending={settle.pending}
              onOpenChange={setConfirming}
              onConfirm={() => void settle.run()}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * The three totals, never collapsed into one.
 *
 * Their price at their count is the caterer's own arithmetic. Their price at
 * our count is what the office will actually be billed. The total they wrote
 * at the bottom of the message is a third number that agrees with neither
 * often enough to be worth showing. Picking one of them and calling it "the
 * total" is exactly the mistake this screen exists to prevent.
 */
function Totals({
  reconciled,
  plan,
  currency,
}: {
  reconciled: Reconciliation;
  plan: SettlePlan;
  currency: Currency;
}) {
  const stated = reconciled.statedTotalMinor;
  // These are the same number until something the caterer priced cannot take
  // the price -- a dish the board already settled differently. Showing both
  // only then keeps the ordinary week to three figures instead of four.
  const billDiffers = plan.totalMinor !== reconciled.ourTotalMinor;
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-muted">Their prices at their counts</dt>
          <dd className="tabular font-medium">
            {reconciled.theirTotalComplete
              ? formatMoney(reconciled.theirTotalMinor, currency)
              : `${formatMoney(reconciled.theirTotalMinor, currency)} of the dishes they counted`}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-muted">Their prices at our counts</dt>
          <dd className={billDiffers ? "tabular font-medium" : "tabular font-semibold"}>
            {formatMoney(reconciled.ourTotalMinor, currency)}
          </dd>
        </div>
        {stated !== null && (
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-muted">The total they stated</dt>
            <dd className="tabular font-medium">{formatMoney(stated, currency)}</dd>
          </div>
        )}
        {billDiffers && (
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-muted">What this week will bill</dt>
            <dd className="tabular font-semibold">{formatMoney(plan.totalMinor, currency)}</dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-subtle">
        The week is billed at our counts. The caterer&rsquo;s own count is here to be checked
        against, not to be billed from.
      </p>
      {billDiffers && (
        <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
          {`The two differ because ${contradictionNames(plan)} already ${
            plan.contradicted.length === 1 ? "carries a price" : "carry prices"
          } the board agreed, and a price already set cannot be changed once the menu locks. Those meals go on billing what they were priced at.`}
        </p>
      )}
      {stated !== null && reconciled.theirTotalComplete && stated !== reconciled.theirTotalMinor && (
        <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
          {`The caterer's own prices and counts come to ${formatMoney(
            reconciled.theirTotalMinor,
            currency,
          )}, and the total at the end of their message says ${formatMoney(
            stated,
            currency,
          )}. Their message disagrees with itself, so ask them before you pay either.`}
        </p>
      )}
    </div>
  );
}

function contradictionNames(plan: SettlePlan): string {
  return plan.contradicted.map((c) => c.name).join(", ");
}

/** Why the week cannot be settled, in the person's words rather than the database's. */
function settleReason(
  period: PaymentsPeriod,
  plan: SettlePlan,
  parsed: ParsedSettlement,
): string | null {
  if (period.periodStatus === "closed") {
    return "This week is closed. Billing it again needs a force this screen deliberately does not have.";
  }
  if (plan.prices.length > 0) return null;
  // Nothing to write is not the same as nothing to do: a week whose prices are
  // all in still has to be billed, and that is what this button then does.
  if (plan.unchanged.length > 0 || plan.contradicted.length > 0) return null;
  if (parsed.dishes.length === 0) {
    return "Nothing in that message was read as a dish with a price.";
  }
  return "None of the dishes in that message are on this week's menus, so there is no price to write.";
}
