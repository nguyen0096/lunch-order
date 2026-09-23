import { useCallback, useEffect, useState } from "react";
import {
  Action,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableNumericCell,
} from "@/ui";
import { fetchBillLines, humanError, type BillLine, type UnpricedMeal } from "../../api.js";
import { formatMoney, formatPrice } from "../../../shared/money.js";
import { formatDay } from "../../../shared/dates.js";
import type { Currency } from "../../../shared/money.js";

/**
 * The meals behind a week's total, on demand.
 *
 * Fetched only when opened: most people look at the number, agree with it and
 * pay. Loading twelve weeks of lines to fill a panel nobody opens costs every
 * member a slower screen so that one person can check one week.
 *
 * A meal that moved between people shows the other person's name, because a
 * line reading `Cơm gà 45.000 ₫` on a day you were not in the office is
 * otherwise indistinguishable from a billing error.
 */
export function BillLines({
  orgId,
  periodId,
  profileId,
  currency,
  lineCount,
  waiting = [],
}: {
  orgId: number;
  periodId: number;
  profileId: string;
  currency: Currency;
  /** From the period. Zero means the week billed nothing at all. */
  lineCount: number;
  /**
   * Meals eaten this week that the caterer has not priced. They have no
   * billing line -- that is the point of holding them out -- so they are
   * listed from the orders instead, or the itemisation would contradict the
   * sentence above it.
   */
  waiting?: UnpricedMeal[];
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<BillLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLines(await fetchBillLines({ orgId, periodId, profileId }));
      setError(null);
    } catch (e) {
      setError(humanError(e));
    }
  }, [orgId, periodId, profileId]);

  useEffect(() => {
    if (open && lines === null && error === null) void load();
  }, [open, lines, error, load]);

  return (
    <div className="flex flex-col gap-3">
      <Action
        variant="ghost"
        size="sm"
        className="w-fit px-2 hover:bg-transparent hover:underline"
        aria-expanded={open}
        reason={
          lineCount > 0 || waiting.length > 0
            ? null
            : "This week billed no meals of its own, so there is nothing to itemise."
        }
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide the meals" : "Show the meals"}
      </Action>

      {open && error !== null && (
        <EmptyState
          heading="The meals did not load"
          action={
            // Without this the failure is terminal: the effect below refetches
            // only while both `lines` and `error` are empty, so closing the
            // panel and opening it again would show the same message forever.
            <Button variant="outline" onClick={() => setError(null)}>
              Try again
            </Button>
          }
        >
          {error}
        </EmptyState>
      )}

      {open && error === null && lines === null && (
        <p className="text-sm text-muted">Loading the meals…</p>
      )}

      {open && lines !== null && lines.length === 0 && waiting.length === 0 && (
        <EmptyState heading="No meals on this week">
          Nothing you ordered was billed to this week. If that is wrong, ask an admin to
          run the week again.
        </EmptyState>
      )}

      {open && lines !== null && (lines.length > 0 || waiting.length > 0) && (
        <Table containerClassName="bg-surface-raised">
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Meal</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDay(line.serviceDate)}
                </TableCell>
                <TableCell>
                  <span className={line.mine ? "text-text" : "text-muted line-through"}>
                    {line.description === "" ? "Lunch" : line.description}
                  </span>
                  {line.counterpartName !== null && (
                    <span className="block text-xs text-muted">
                      {line.mine
                        ? `${line.counterpartName} gave you this one`
                        : `You gave this one to ${line.counterpartName}`}
                    </span>
                  )}
                </TableCell>
                <TableNumericCell className={line.mine ? undefined : "text-muted"}>
                  {line.mine
                    ? formatMoney(line.amountMinor, currency)
                    : "Not yours to pay"}
                </TableNumericCell>
              </TableRow>
            ))}

            {/* Beneath the billed meals rather than mixed in with them: these
                are not on the total above, and a row carrying a price would
                claim otherwise. `formatPrice(null, …)` is the one way a
                missing price is written anywhere in the app. */}
            {waiting.map((meal) => (
              <TableRow key={`waiting-${meal.orderId}`}>
                <TableCell className="whitespace-nowrap">
                  {formatDay(meal.serviceDate)}
                </TableCell>
                <TableCell>
                  <span>{meal.description === "" ? "Lunch" : meal.description}</span>
                  <span className="block text-xs text-muted">
                    Waiting on the caterer&rsquo;s price, so it is not on this total
                  </span>
                </TableCell>
                <TableNumericCell className="text-muted">
                  {formatPrice(null, currency)}
                </TableNumericCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
