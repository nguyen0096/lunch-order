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
import {
  creditMinor,
  owedMinor,
  type PaymentsPerson,
  type PaymentsStatement,
} from "../../api.js";
import { formatMoney, type Currency } from "../../../shared/money.js";

/** One person, their account, and the week on screen if they ate in it. */
export type PersonRow = { person: PaymentsPerson; statement: PaymentsStatement | null };

/**
 * Everybody the office has money with, and what the week billed them.
 *
 * Two questions, two halves. The week answers "what did we buy", which is the
 * caterer's question and belongs to the period. The account answers "who is
 * behind", which is nobody's week: since `money_belongs_to_a_person` a debt is
 * the sum of every week somebody has eaten less everything they have paid, so
 * reading it off one week was only ever right while carry-forward was rolling
 * the arrears into the newest statement.
 *
 * That is why somebody who did not eat this week still has a row when their
 * account is not square: the figure at the top of the screen has to be
 * explainable by the rows under it.
 *
 * On a phone the two week columns drop out and the account stays, because the
 * account is what an admin came for. Dropping columns rather than
 * sideways-scrolling them: a horizontal scrollbar hides the column somebody
 * wanted and which one is hidden depends on where they last scrolled.
 */
export function PeopleRows({
  rows,
  currency,
  busy,
  onRecord,
}: {
  rows: PersonRow[];
  currency: Currency;
  busy: boolean;
  onRecord: (row: PersonRow) => void;
}) {
  const totals = rows.reduce(
    (acc, r) => ({
      meals: acc.meals + (r.statement?.mealCount ?? 0),
      billed: acc.billed + (r.statement?.mealsMinor ?? 0),
    }),
    { meals: 0, billed: 0 },
  );

  return (
    <Table aria-label="People, this week and what they owe">
      <TableHeader>
        <TableRow>
          <TableHead className="px-2 md:px-3">Person</TableHead>
          <TableHead className="hidden text-right md:table-cell">Meals</TableHead>
          <TableHead className="hidden text-right md:table-cell">Billed this week</TableHead>
          <TableHead className="px-2 text-right md:px-3">Account</TableHead>
          <TableHead className="px-2 md:px-3">Status</TableHead>
          <TableHead className="px-2 md:px-3">
            <span className="sr-only">Record</span>
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.person.profileId}>
            <TableCell className="px-2 md:px-3">
              <span className="font-medium break-words">{row.person.name}</span>
              {/* The person's own reference, not the statement's. A memo is
                  typed against a person now and the same string works every
                  week, which is what makes a saved transfer possible. */}
              <span className="mt-0.5 block text-xs text-muted tabular break-all">
                {row.person.paymentRef}
              </span>
            </TableCell>
            <TableNumericCell className="hidden md:table-cell">
              {row.statement?.mealCount ?? 0}
            </TableNumericCell>
            <TableNumericCell className="hidden whitespace-nowrap md:table-cell">
              {formatMoney(row.statement?.mealsMinor ?? 0, currency)}
            </TableNumericCell>
            <TableNumericCell className="px-2 font-medium whitespace-nowrap md:px-3">
              {formatMoney(accountFigure(row), currency)}
              {creditMinor(row.person.account) > 0 && (
                <span className="mt-0.5 block text-xs font-normal text-muted">in credit</span>
              )}
            </TableNumericCell>
            <TableCell className="px-2 md:px-3">
              <span className="flex flex-wrap items-center gap-1">
                <AccountBadge row={row} />
                {row.statement?.status === "waived" && <Badge variant="neutral">Week waived</Badge>}
              </span>
            </TableCell>
            <TableCell className="px-2 text-right md:px-3">
              {/* Never unavailable. Money from somebody who owes nothing used
                  to be a mistake worth refusing; it is a top-up now. */}
              <Action
                reason={null}
                pending={busy}
                size="sm"
                variant="outline"
                onClick={() => onRecord(row)}
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
            {formatMoney(totals.billed, currency)}
          </TableNumericCell>
          {/* No total under the account column: adding a debt to a credit
              answers no question anybody has. The two figures are above. */}
          <TableCell className="px-2 md:px-3" />
          <TableCell className="px-2 md:px-3" />
          <TableCell className="px-2 md:px-3" />
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/**
 * The week's statements and the people who are not square, as one list.
 *
 * Exported because the screen resolves the open dialog through it: keeping the
 * dialog's subject as an id and looking it up again is what lets a refetch
 * refresh what the dialog is showing.
 */
export function personRows(
  people: PaymentsPerson[],
  statements: PaymentsStatement[],
): PersonRow[] {
  const byProfile = new Map(people.map((p) => [p.profileId, p]));
  const rows: PersonRow[] = [];
  const shown = new Set<string>();

  for (const statement of statements) {
    rows.push({ person: byProfile.get(statement.profileId) ?? fromStatement(statement), statement });
    shown.add(statement.profileId);
  }
  for (const person of people) {
    if (shown.has(person.profileId)) continue;
    // Square and not in this week: there is nothing to say about them and a
    // row that says nothing buries the ones that do.
    if (person.account.balanceMinor === 0) continue;
    rows.push({ person, statement: null });
  }

  return rows.sort((a, b) => a.person.name.localeCompare(b.person.name, "vi"));
}

/**
 * A statement whose membership we cannot read. It should not happen, because
 * leaving deactivates a membership rather than deleting it, but the week's
 * money has to stay visible if it ever does. The account is taken from this
 * week alone, which is all there is to go on.
 */
function fromStatement(s: PaymentsStatement): PaymentsPerson {
  return {
    profileId: s.profileId,
    name: s.name,
    shortCode: s.shortCode,
    paymentRef: s.paymentRef,
    active: false,
    account: {
      chargedMinor: s.mealsMinor,
      creditedMinor: s.paidMinor,
      balanceMinor: s.mealsMinor - s.paidMinor,
    },
  };
}

/** Always a positive figure. Which one it is, the badge beside it says. */
function accountFigure(row: PersonRow): number {
  const owed = owedMinor(row.person.account);
  return owed > 0 ? owed : creditMinor(row.person.account);
}

/** The member's own vocabulary, so the two screens name the same thing alike. */
function AccountBadge({ row }: { row: PersonRow }) {
  if (creditMinor(row.person.account) > 0) return <Badge variant="success">In credit</Badge>;
  if (owedMinor(row.person.account) > 0) return <Badge variant="warn">Unpaid</Badge>;
  return <Badge variant="success">Settled</Badge>;
}
