import {
  Action,
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
import { isSettled, outstandingMinor, type PaymentsStatement } from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";

/**
 * Every member's week, and the one control that settles it.
 *
 * A real table, because this is one: seven values per person that have to line
 * up down a column. On a phone four of them fit, so the three that answer "how
 * did we get here" -- meals, billed, received -- drop out and the three that
 * answer "what now" stay. Dropping columns rather than sideways-scrolling
 * them: a horizontal scrollbar hides the column somebody came for, and which
 * one is hidden depends on where they last scrolled.
 */
export function StatementRows({
  statements,
  currency,
  busy,
  onSettle,
}: {
  statements: PaymentsStatement[];
  currency: Currency;
  busy: boolean;
  onSettle: (statement: PaymentsStatement) => void;
}) {
  const totals = statements.reduce(
    (acc, s) => ({
      meals: acc.meals + s.mealCount,
      due: acc.due + s.totalDueMinor,
      paid: acc.paid + s.paidMinor,
      outstanding: acc.outstanding + outstandingMinor(s),
    }),
    { meals: 0, due: 0, paid: 0, outstanding: 0 },
  );

  return (
    <Table aria-label="Statements for this week">
      <TableHeader>
        <TableRow>
          <TableHead className="px-2 md:px-3">Person</TableHead>
          <TableHead className="hidden text-right md:table-cell">Meals</TableHead>
          <TableHead className="hidden text-right md:table-cell">Billed</TableHead>
          <TableHead className="hidden text-right md:table-cell">Received</TableHead>
          <TableHead className="px-2 text-right md:px-3">Still to pay</TableHead>
          <TableHead className="px-2 md:px-3">Status</TableHead>
          <TableHead className="px-2 md:px-3">
            <span className="sr-only">Settle</span>
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {statements.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="px-2 md:px-3">
              <span className="font-medium break-words">{s.name}</span>
              <span className="mt-0.5 block text-xs text-muted tabular break-all">
                {s.carriedInMinor > 0
                  ? `${s.paymentRef} · includes ${formatMoney(s.carriedInMinor, currency)} carried over`
                  : s.paymentRef}
              </span>
            </TableCell>
            <TableNumericCell className="hidden md:table-cell">{s.mealCount}</TableNumericCell>
            <TableNumericCell className="hidden whitespace-nowrap md:table-cell">
              {formatMoney(s.totalDueMinor, currency)}
            </TableNumericCell>
            <TableNumericCell className="hidden whitespace-nowrap md:table-cell">
              {formatMoney(s.paidMinor, currency)}
            </TableNumericCell>
            <TableNumericCell className="px-2 font-medium whitespace-nowrap md:px-3">
              {formatMoney(outstandingMinor(s), currency)}
            </TableNumericCell>
            <TableCell className="px-2 md:px-3">
              <StatusBadge statement={s} />
            </TableCell>
            <TableCell className="px-2 text-right md:px-3">
              <Action
                reason={settleReason(s)}
                pending={busy}
                size="sm"
                variant="outline"
                onClick={() => onSettle(s)}
              >
                Record
              </Action>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>

      <TableFooter>
        <TableRow>
          <TableCell className="px-2 font-medium md:px-3">The week</TableCell>
          <TableNumericCell className="hidden md:table-cell">{totals.meals}</TableNumericCell>
          <TableNumericCell className="hidden whitespace-nowrap md:table-cell">
            {formatMoney(totals.due, currency)}
          </TableNumericCell>
          <TableNumericCell className="hidden whitespace-nowrap md:table-cell">
            {formatMoney(totals.paid, currency)}
          </TableNumericCell>
          <TableNumericCell className="px-2 font-medium whitespace-nowrap text-text md:px-3">
            {formatMoney(totals.outstanding, currency)}
          </TableNumericCell>
          <TableCell className="px-2 md:px-3" />
          <TableCell className="px-2 md:px-3" />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/** The member's own vocabulary, so the two screens name the same thing alike. */
function StatusBadge({ statement }: { statement: PaymentsStatement }) {
  if (statement.status === "waived") return <Badge variant="neutral">Waived</Badge>;
  if (outstandingMinor(statement) === 0) return <Badge variant="success">Paid</Badge>;
  if (statement.paidMinor > 0) return <Badge variant="warn">Part paid</Badge>;
  return <Badge variant="warn">Unpaid</Badge>;
}

/**
 * Why there is nothing to record against this row.
 *
 * A settled week is not a reason to hide the control -- the row would then be
 * the only one without one and read as broken -- but recording against it
 * credits money nobody owes, and nothing can take that back.
 */
function settleReason(s: PaymentsStatement): string | null {
  if (s.status === "waived") {
    return "This week is waived, so nobody is being asked to pay it.";
  }
  if (isSettled(s)) {
    return "This week is settled. Recording more would credit money nobody owes, and a payment cannot be taken back.";
  }
  return null;
}
