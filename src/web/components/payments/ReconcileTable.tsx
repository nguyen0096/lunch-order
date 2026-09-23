import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableNumericCell,
  TableRow,
} from "@/ui";
import { cn } from "@/ui/cn";
import { formatPrice, PRICE_PENDING, type Currency } from "../../../shared/money.js";
import type {
  Reconciliation,
  ReconciledDish,
  SettlementWarning,
} from "../../../shared/settlement.js";

/**
 * The caterer's message beside the board, dish by dish.
 *
 * This is the whole reason settling is a screen and not a text box. The
 * caterer says five portions of cơm tấm; the board recorded four. Nobody can
 * see that by reading a chat message, and paying the difference every week is
 * how an office quietly funds somebody's arithmetic.
 *
 * So both counts are always shown, both columns are named for whose they are,
 * and neither is preferred. A row where they disagree is tinted and carries
 * the sentence spelling out which number came from where, because a column of
 * numbers with one of them subtly different is exactly the thing an eye slides
 * over.
 */
export function ReconcileTable({
  reconciled,
  currency,
}: {
  reconciled: Reconciliation;
  currency: Currency;
}) {
  return (
    <Table aria-label="The caterer's message checked against the board">
      <TableHeader>
        <TableRow>
          <TableHead className="px-2 md:px-3">Dish</TableHead>
          <TableHead className="hidden px-2 text-right md:table-cell md:px-3">
            Their price
          </TableHead>
          <TableHead className="px-2 text-right md:px-3">Their count</TableHead>
          <TableHead className="px-2 text-right md:px-3">Our count</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {reconciled.dishes.map((dish) => (
          <TableRow
            key={dish.key}
            // Tinting the row rather than badging the cell: the disagreement is
            // between two columns, so it belongs to the row, not to either
            // number.
            className={cn(dish.issue === "counts_differ" && "bg-warn-subtle hover:bg-warn-subtle")}
          >
            <TableCell className="px-2 break-words md:px-3">
              <span className="font-medium">{dish.name}</span>
              <span className="mt-0.5 block text-xs tabular text-muted md:hidden">
                {formatPrice(dish.priceMinor, currency)}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <IssueBadge dish={dish} />
                <span className="text-xs text-muted">{issueSentence(dish)}</span>
              </span>
              {/* A second line, not a replacement: a dish can be miscounted
                  and re-quoted in the same sentence, and the price one is
                  about money already agreed. */}
              {dish.contradictsMinor.length > 0 && dish.priceMinor !== null && (
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge variant="warn">Price already set</Badge>
                  <span className="text-xs text-muted">
                    {`The board already charges ${dish.contradictsMinor
                      .map((m) => formatPrice(m, currency))
                      .join(" and ")} for this. A price already agreed cannot be changed now, so ${
                      dish.waitingCount > 0
                        ? `only the ${dish.waitingCount} still waiting would take ${formatPrice(
                            dish.priceMinor,
                            currency,
                          )}.`
                        : "nothing here changes."
                    }`}
                  </span>
                </span>
              )}
              {dish.warnings.map((w) => (
                <span key={w} className="mt-0.5 block text-xs text-muted">
                  {warningSentence(w, dish, currency)}
                </span>
              ))}
            </TableCell>

            <TableNumericCell className="hidden px-2 whitespace-nowrap md:table-cell md:px-3">
              {formatPrice(dish.priceMinor, currency)}
            </TableNumericCell>

            <TableNumericCell className="px-2 md:px-3">
              {dish.theirCount === null ? <NotSaid>They did not say</NotSaid> : dish.theirCount}
            </TableNumericCell>

            <TableNumericCell
              className={cn("px-2 md:px-3", dish.issue === "counts_differ" && "font-semibold")}
            >
              {dish.ourCount === null ? <NotSaid>Never served</NotSaid> : dish.ourCount}
            </TableNumericCell>
          </TableRow>
        ))}
      </TableBody>

      <TableFooter>
        <TableRow>
          <TableCell className="px-2 font-medium md:px-3">The whole week</TableCell>
          <TableCell className="hidden md:table-cell" />
          <TableNumericCell className="px-2 font-medium text-text md:px-3">
            {reconciled.dishes.reduce((n, d) => n + (d.theirCount ?? 0), 0)}
          </TableNumericCell>
          <TableNumericCell className="px-2 font-medium text-text md:px-3">
            {reconciled.dishes.reduce((n, d) => n + (d.ourCount ?? 0), 0)}
          </TableNumericCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function NotSaid({ children }: { children: string }) {
  return <span className="text-xs font-normal text-muted">{children}</span>;
}

function IssueBadge({ dish }: { dish: ReconciledDish }) {
  switch (dish.issue) {
    case "counts_differ":
      return <Badge variant="warn">Counts differ</Badge>;
    case "not_on_our_board":
      return <Badge variant="warn">Not on our board</Badge>;
    case "not_in_message":
      if (dish.ourCount === 0) return <Badge variant="neutral">Nobody ate it</Badge>;
      // Absent from the message only matters while it has no price. Once it
      // has one there is nothing for the caterer to tell us.
      return dish.waitingCount === 0 ? (
        <Badge variant="neutral">Priced already</Badge>
      ) : (
        <Badge variant="warn">Not in their message</Badge>
      );
    case "no_count":
      return <Badge variant="neutral">No count</Badge>;
    case "agreed":
      return <Badge variant="success">Agrees</Badge>;
  }
}

/** Always names whose number is whose. Never "mismatch". */
function issueSentence(dish: ReconciledDish): string {
  switch (dish.issue) {
    case "counts_differ":
      return `The caterer counted ${dish.theirCount}, the board recorded ${dish.ourCount}. Check before you pay.`;
    case "not_on_our_board":
      return "The caterer priced this and it was on no menu this week, so there is nothing here to price.";
    case "not_in_message":
      if (dish.ourCount === 0) {
        return "It was on a menu and nobody ordered it, so there was nothing for them to charge.";
      }
      return dish.waitingCount === 0
        ? "The caterer's message does not mention it, and it does not need them to: it is priced already."
        : "The board recorded these and the caterer's message does not mention the dish, so it has no price to apply.";
    case "no_count":
      return "The caterer priced this without saying how many, so only our count is known.";
    case "agreed":
      return "Both counts are the same.";
  }
}

function warningSentence(
  warning: SettlementWarning,
  dish: ReconciledDish,
  currency: Currency,
): string {
  const price = dish.priceMinor === null ? PRICE_PENDING : formatPrice(dish.priceMinor, currency);
  switch (warning) {
    case "price_inferred_thousands":
      return `Their message wrote this in thousands, so it was read as ${price}.`;
    case "price_ambiguous_decimal":
      return `A comma was read as a decimal point, giving ${price}.`;
    case "price_out_of_range":
      return `${price} is outside what a lunch here usually costs. Check it.`;
    case "duplicate_name":
      return `Their message prices this dish more than once. The first price, ${price}, is the one used.`;
  }
}
