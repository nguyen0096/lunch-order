import { useCallback, useEffect, useId, useState } from "react";
import {
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableNumericCell,
  TableRow,
} from "@/ui";
import { fetchCatererSummary, humanError, type CatererSummary as Summary } from "../../api.js";
import { formatDay } from "../../../shared/dates.js";
import { formatMoney, type Currency } from "../../../shared/money.js";
import { meals } from "./labels.js";

/**
 * What the office owes the caterer: every meal cooked that week, the admin's
 * own included.
 *
 * Read from `billing_lines` and never from the statements above it.
 * `total_due_minor` is generated as `meals_minor + carried_in_minor`, and the
 * carried part is last week's unpaid remainder rolled forward. Nobody cooked
 * it. Adding the statements up to pay a caterer overcharges by exactly that
 * debt, which is why the two halves of this screen deliberately show different
 * numbers and say which is which.
 *
 * Grouped by dish alone. A transfer changes `payer_profile_id` and so changes
 * who is billed, but the kitchen cooked the same lunch either way.
 */
export function CatererSummary({
  orgId,
  periodId,
  periodTotalMinor,
  currency,
}: {
  orgId: number;
  periodId: number;
  /** `billing_periods.total_minor`, the cross-check rather than the source. */
  periodTotalMinor: number;
  currency: Currency;
}) {
  const headingId = useId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSummary(null);
    try {
      setSummary(await fetchCatererSummary({ orgId, periodId, periodTotalMinor }));
      setLoadError(null);
    } catch (e) {
      // `useAction` owns every write. A read has no toast to fire and nothing
      // to put back, so its failure is a state this panel renders instead.
      setLoadError(humanError(e));
    }
  }, [orgId, periodId, periodTotalMinor]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        What the caterer is owed
      </h2>
      <p className="max-w-prose text-sm text-muted">
        Every meal this week bought, yours included. This will not match what people owe above:
        that total also carries last week's unpaid remainder forward, and nobody cooked a debt.
      </p>

      {loadError !== null ? (
        <EmptyState
          heading="The caterer's week did not load"
          action={
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </EmptyState>
      ) : summary === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : summary.days.length === 0 ? (
        <EmptyState heading="No meals this week">
          Nobody was billed for a lunch, so there is nothing to pay the caterer for.
        </EmptyState>
      ) : (
        <>
          <p className="flex flex-col gap-1">
            <span className="text-sm text-muted">The caterer is owed</span>
            <span className="tabular text-xl font-semibold">
              {formatMoney(summary.totalMinor, currency)}
            </span>
            <span className="text-sm text-muted">
              {`${meals(summary.count)} across ${summary.days.length} ${
                summary.days.length === 1 ? "day" : "days"
              }.`}
            </span>
          </p>

          {summary.totalMinor !== summary.periodTotalMinor && (
            <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
              {/* Both numbers come from the same lines, so a disagreement means
                  one of them is stale. Picking one silently is how somebody
                  pays a caterer a figure nothing in the database agrees with. */}
              {`These do not agree. The meals listed here add up to ${formatMoney(
                summary.totalMinor,
                currency,
              )}, and this week's own recorded total is ${formatMoney(
                summary.periodTotalMinor,
                currency,
              )}. One of them is stale, so check before you pay.`}
            </p>
          )}

          <Table aria-label="What the caterer is owed, by day and dish">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2 md:px-3">Dish</TableHead>
                <TableHead className="px-2 text-right md:px-3">Meals</TableHead>
                <TableHead className="px-2 text-right md:px-3">Amount</TableHead>
              </TableRow>
            </TableHeader>

            {summary.days.map((day) => (
              <TableBody key={day.serviceDate}>
                <TableRow>
                  <TableHead
                    scope="rowgroup"
                    className="static bg-surface-sunken px-2 text-sm text-text md:px-3"
                  >
                    {formatDay(day.serviceDate)}
                  </TableHead>
                  {/* Data cells, not headers: the day is the row's heading and
                      these two are its subtotal. */}
                  <TableNumericCell className="bg-surface-sunken px-2 text-sm font-medium md:px-3">
                    {day.count}
                  </TableNumericCell>
                  <TableNumericCell className="bg-surface-sunken px-2 text-sm font-medium whitespace-nowrap md:px-3">
                    {formatMoney(day.subtotalMinor, currency)}
                  </TableNumericCell>
                </TableRow>

                {day.dishes.map((dish) => (
                  <TableRow key={`${day.serviceDate}:${dish.description}`}>
                    <TableCell className="px-2 break-words md:px-3">
                      {dish.description === "" ? (
                        <span className="text-muted">
                          No dish recorded, so this one was billed without a name
                        </span>
                      ) : (
                        dish.description
                      )}
                    </TableCell>
                    <TableNumericCell className="px-2 md:px-3">{dish.count}</TableNumericCell>
                    <TableNumericCell className="px-2 whitespace-nowrap md:px-3">
                      {formatMoney(dish.amountMinor, currency)}
                    </TableNumericCell>
                  </TableRow>
                ))}
              </TableBody>
            ))}

            <TableFooter>
              <TableRow>
                <TableCell className="px-2 font-medium md:px-3">The whole week</TableCell>
                <TableNumericCell className="px-2 font-medium text-text md:px-3">
                  {summary.count}
                </TableNumericCell>
                <TableNumericCell className="px-2 font-medium whitespace-nowrap text-text md:px-3">
                  {formatMoney(summary.totalMinor, currency)}
                </TableNumericCell>
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </section>
  );
}
