import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Skeleton } from "@/ui";
import {
  fetchBill,
  fetchUnpricedMeals,
  humanError,
  creditMinor,
  outstandingMinor,
  owedMinor,
  type Account,
  type Bill,
  type BillStatement,
  type BillWeek,
  type UnpricedMeal,
} from "../api.js";
import { BillLines } from "./bill/BillLines.js";
import { Transfer } from "./bill/Transfer.js";
import type { ScreenProps } from "./screenProps.js";
import { formatMoney, type Currency } from "../../shared/money.js";
import { addDays, weekNumberOf } from "../../shared/dates.js";
import { displayPaymentRef } from "../../shared/paymentRef.js";
import type { Org } from "../../shared/types.js";

/**
 * What do I owe, and how do I pay it.
 *
 * One number, large, then the reference, then the code. In that order because
 * that is the order the questions arrive in, and because the reference is the
 * step that goes wrong: the scan fills in the account and the amount, the memo
 * is typed, and a memo without the reference is a payment this app never sees.
 *
 * No week leads. The screen opens on the ACCOUNT: charges minus credits across
 * every week, which is one number and the only one anybody should pay. It used
 * to lead with a week, and carry-forward existed to make that week's total
 * right by rolling every older remainder into it -- at the cost of the same
 * debt sitting on two statements, and of somebody three weeks behind paying
 * the newest number they were shown.
 *
 * The weeks below are history. Each says what it cost and what has been
 * allocated to it, and a week that is short says it is part of the total above
 * rather than claiming to have been carried into its neighbour.
 */
export function BillScreen({ me, org }: ScreenProps) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Meals eaten that the caterer has not priced, so no total includes them. */
  const [waiting, setWaiting] = useState<UnpricedMeal[]>([]);
  /**
   * Said out loud rather than swallowed. A total that leaves meals out is only
   * honest while the screen can say how many, so a failure to find that out is
   * news in its own right -- and it must not blank a bill that loaded fine.
   */
  const [waitingError, setWaitingError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let loaded: Bill;
    try {
      loaded = await fetchBill({ orgId: org.id, profileId: me.profileId });
      setBill(loaded);
      setLoadError(null);
    } catch (e) {
      // `useAction` covers every write. A read has no toast to fire and nothing
      // to revert, so its failure is a state the screen renders instead.
      setLoadError(humanError(e));
      return;
    }

    // One query across every week on screen, bucketed below. A query per week
    // would be a dozen round trips to answer one sentence.
    const from = loaded.weeks.at(-1)?.periodStart;
    const to = loaded.weeks[0]?.periodEnd;
    if (from === undefined || to === undefined) {
      setWaiting([]);
      setWaitingError(null);
      return;
    }
    try {
      setWaiting(await fetchUnpricedMeals({ orgId: org.id, profileId: me.profileId, from, to }));
      setWaitingError(null);
    } catch (e) {
      setWaiting([]);
      setWaitingError(humanError(e));
    }
  }, [org.id, me.profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError !== null) {
    return (
      <EmptyState
        heading="Your bill did not load"
        action={
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {loadError}
      </EmptyState>
    );
  }

  if (bill === null) return <BillSkeleton />;

  const billed = bill.weeks.filter((w) => w.statement !== null);
  const openWeek = bill.weeks.find((w) => w.periodStatus === "open" && w.statement === null);

  const owed = owedMinor(bill.account);

  const membership = me.orgs.find((o) => o.org.id === org.id);
  // One string, in every state: what the office is, and who this is. It names
  // no week, so it can be saved as a repeating transfer, and somebody three
  // weeks behind is not asked which week they are paying for.
  const ref = displayPaymentRef({
    officeCode: org.shortCode ?? "",
    memberCode: membership?.shortCode ?? "",
    paymentRef: membership?.paymentRef ?? "",
  });

  // No early return for an empty account. An office that has never billed, or
  // a member who joined this week, used to get an empty state with no balance
  // and no way to pay ahead at all, which is the one thing a new member needs.
  const nothingBilled = billed.length === 0;

  return (
    <section className="flex max-w-2xl flex-col gap-8">
      {/* The account, not a week. One number settles up, one code pays it, and
          the weeks below are the history behind it. Leading with a week meant
          paying that week: somebody three weeks behind saw the newest number
          and paid it, which is exactly what carry-forward was invented to
          paper over. */}
      <article className="flex flex-col gap-6 rounded-lg border border-border bg-surface-raised p-5 sm:p-6">
        <h1 className="text-lg font-semibold">Your account</h1>

        <AccountAmount account={bill.account} currency={org.currency} />

        {/* The count is not repeated here: every billed week below carries its
            own note against the week the meal was eaten in, which is the
            question somebody actually has. A failure to check at all belongs
            up here, because it undermines this number rather than one week's.
            With nothing billed there is no week below to carry it, and
            "nothing to pay" alone would tell somebody who ate all week the
            opposite of the truth. */}
        <WaitingNote
          waiting={nothingBilled ? waiting : []}
          error={waitingError}
          nothingBilled={nothingBilled}
        />

        {/* One block in all three states. Somebody who owes nothing is not a
            different kind of payer: the amount is simply theirs to choose,
            which is also the only way a member tops up without asking an
            admin. */}
        <Transfer
          paymentRef={ref}
          owedMinor={owed}
          currency={org.currency}
          payment={bill.payment}
        />
      </article>

      {openWeek && (
        <p className="text-sm text-muted">
          {`This week is still open. It closes ${weekdayName(addDays(openWeek.periodEnd, 1))}.`}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your weeks</h2>
        {nothingBilled ? (
          // The sentence the old empty state carried, kept where it answers
          // the question it was answering: when a first bill turns up.
          <EmptyState heading="No weeks yet">
            Your first bill arrives at the end of a week you eat in.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {billed.map((week) => (
              <li key={week.periodId}>
                <PastWeek
                  week={week}
                  org={org}
                  profileId={me.profileId}
                  waiting={waitingIn(week, waiting)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

/* ------------------------------------------------------------------- parts */

/**
 * The one number, and what it is made of.
 *
 * Three states: owing, settled, and in credit. A credit is what a top-up looks
 * like once it is on the books, and it used to be arithmetically impossible --
 * `greatest(due - paid, 0)` turned every overpayment into a zero and the money
 * disappeared.
 *
 * One path, and the figure is always drawn. The label and the figure answer
 * different questions: the label says whether there is anything to do, the
 * figure says how much you have got. Somebody who paid ahead watches that
 * number come down over weeks, and a settled screen that dropped it stopped
 * answering exactly when the answer changed. Same size and same place in every
 * state, so it reads as one number changing rather than three treatments.
 *
 * A fact, not a control. The copy button that used to sit beside it has gone
 * to the Amount row below, which is the figure somebody pays with; copying a
 * credit balance into a bank's amount field would be paying it again.
 */
function AccountAmount({ account, currency }: { account: Account; currency: Currency }) {
  const owed = owedMinor(account);
  const credit = creditMinor(account);

  if (credit > 0) {
    return (
      <Headline label="In credit" amount={formatMoney(credit, currency)}>
        This comes off your next lunches.
      </Headline>
    );
  }

  if (owed === 0) {
    return (
      <Headline label="Nothing to pay" amount={formatMoney(0, currency)}>
        {account.chargedMinor === 0
          ? "Nothing has been billed to you yet."
          : `${formatMoney(account.chargedMinor, currency)} billed, all of it paid.`}
      </Headline>
    );
  }

  return (
    <Headline label="You owe" amount={formatMoney(owed, currency)}>
      {/* Only the arithmetic behind the figure. A meal count is a different
          question, asked of the weeks below, and counting meals here left the
          one line under the balance saying nothing about the money. With
          nothing received there is no arithmetic to show, and "0 d received"
          is not information, it is an accusation. */}
      {account.creditedMinor > 0
        ? `${formatMoney(account.chargedMinor, currency)} billed, ` +
          `${formatMoney(account.creditedMinor, currency)} received.`
        : null}
    </Headline>
  );
}

function WaitingNote({
  waiting,
  error,
  nothingBilled = false,
}: {
  waiting: UnpricedMeal[];
  /** Set when we could not find out. Said rather than treated as "none". */
  error: string | null;
  /** True where nothing has been billed at all, which changes the sentence. */
  nothingBilled?: boolean;
}) {
  if (error !== null) {
    return (
      <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
        {`We could not check whether any of your meals are still waiting on a price, so this total may be missing some. ${error}`}
      </p>
    );
  }
  if (waiting.length === 0) return null;

  const count = `${waiting.length} ${waiting.length === 1 ? "meal" : "meals"}`;
  return (
    <p className="rounded-md bg-warn-subtle px-3 py-2 text-sm text-warn-subtle-fg">
      {nothingBilled
        ? `${count} you ate ${waiting.length === 1 ? "is" : "are"} waiting on the caterer's price, so ${waiting.length === 1 ? "it is" : "they are"} not billed yet. Nothing is owed for ${waiting.length === 1 ? "it" : "them"} until the price arrives.`
        : `${count} ${waiting.length === 1 ? "is" : "are"} waiting on the caterer's price and ${waiting.length === 1 ? "is" : "are"} not in this total. ${waiting.length === 1 ? "It arrives" : "They arrive"} on a later bill once the caterer says what ${waiting.length === 1 ? "it" : "they"} cost.`}
    </p>
  );
}

/** The waiting meals that fall inside one week. A service date is a local day. */
function waitingIn(week: BillWeek, waiting: UnpricedMeal[]): UnpricedMeal[] {
  return waiting.filter(
    (m) => m.serviceDate >= week.periodStart && m.serviceDate <= week.periodEnd,
  );
}

function Headline({
  label,
  amount,
  children,
}: {
  label: string;
  /** Always printed, including the zero: it is the standing, not a call to act. */
  amount: string;
  /** What the figure is made of, in one sentence, where there is one. */
  children?: React.ReactNode;
}) {
  // One paragraph for the label and the figure, so a screen reader says "you
  // owe 180.000 ₫" rather than reading a stray number with no idea what it is.
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-col gap-1">
        <span className="text-sm text-muted">{label}</span>
        <span className="tabular text-3xl font-semibold">{amount}</span>
      </p>
      {children != null && <p className="max-w-prose text-sm text-muted">{children}</p>}
    </div>
  );
}

function StatusBadge({ statement }: { statement: BillStatement }) {
  if (statement.status === "waived") return <Badge variant="neutral">Waived</Badge>;
  if (outstandingMinor(statement) === 0) return <Badge variant="success">Paid</Badge>;
  if (statement.paidMinor > 0) return <Badge variant="warn">Part paid</Badge>;
  return <Badge variant="warn">Unpaid</Badge>;
}

function PastWeek({
  week,
  org,
  profileId,
  waiting,
}: {
  week: BillWeek;
  org: Org;
  profileId: string;
  waiting: UnpricedMeal[];
}) {
  const statement = week.statement;
  if (statement === null) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-medium">{weekLabel(week)}</h3>
        <div className="flex items-center gap-3">
          <span className="tabular text-sm text-muted">
            {formatMoney(statement.totalDueMinor, org.currency)}
          </span>
          <StatusBadge statement={statement} />
        </div>
      </div>
      {/* No longer "carried into the week above": nothing is carried anywhere.
          A week that is short is short, and the account at the top adds every
          such week up once. */}
      {outstandingMinor(statement) > 0 && (
        <p className="text-sm text-muted">
          {`${formatMoney(
            outstandingMinor(statement),
            org.currency,
          )} of this week is still in what you owe above.`}
        </p>
      )}
      {statement.paidAt !== null && outstandingMinor(statement) === 0 && (
        <p className="text-sm text-muted">
          {`Settled ${dayAndMonth(statement.paidAt, org.timezone)}.`}
        </p>
      )}
      <WaitingNote waiting={waiting} error={null} />
      <BillLines
        orgId={org.id}
        periodId={week.periodId}
        profileId={profileId}
        currency={org.currency}
        lineCount={week.lineCount}
        waiting={waiting}
      />
    </div>
  );
}

/** Shaped like the card, so the amount does not jump when the data lands. */
function BillSkeleton() {
  return (
    <section className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-6 rounded-lg border border-border bg-surface-raised p-5 sm:p-6">
        <Skeleton className="h-6 w-44" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-52" />
          <Skeleton className="h-4 w-36" />
        </div>
        {/* The code, then the four fields it encodes: the same two columns the
            block lands in, so nothing moves sideways when it does. */}
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          <Skeleton className="size-48 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <Skeleton className="h-11 w-full max-w-56" />
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-6 w-28" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- dates */

/**
 * A service date is a local calendar day, never an instant, so it is formatted
 * in UTC: parsing "2026-09-22" in the reader's zone and then printing it in
 * theirs is how a week silently becomes 21–27 for anyone west of Greenwich.
 */
function utcDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function weekLabel(week: BillWeek): string {
  const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
  const dayMonth = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const start = utcDate(week.periodStart);
  const end = utcDate(week.periodEnd);
  // The ISO week leads, because it is what a person reads on a bank statement
  // and in the caterer's messages; the dates say which days that was.
  const days =
    week.periodStart.slice(0, 7) === week.periodEnd.slice(0, 7)
      ? `${dayOnly.format(start)}–${dayMonth.format(end)}`
      : `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
  return `Week ${weekNumberOf(week.periodStart)}, ${days}`;
}

function weekdayName(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    utcDate(isoDate),
  );
}

/** `paid_at` IS an instant, so it is read in the office's zone, not the reader's. */
function dayAndMonth(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone,
  }).format(new Date(instant));
}
