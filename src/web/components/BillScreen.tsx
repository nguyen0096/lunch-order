import { useCallback, useEffect, useState } from "react";
import { Action, Badge, Button, EmptyState, Skeleton, useAction } from "@/ui";
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
import { PaymentDetails } from "./bill/PaymentDetails.js";
import { PayAhead } from "./bill/PayAhead.js";
import type { ScreenProps } from "./screenProps.js";
import { formatMoney, plainAmount, type Currency } from "../../shared/money.js";
import { addDays } from "../../shared/dates.js";
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
  const credit = creditMinor(bill.account);
  const ref = me.orgs.find((o) => o.org.id === org.id)?.paymentRef ?? "";

  if (billed.length === 0 && owed === 0 && credit === 0) {
    return (
      <section className="flex max-w-2xl flex-col gap-4">
        <EmptyState heading="Nothing owed yet">
          {openWeek
            ? `This week closes ${weekdayName(addDays(openWeek.periodEnd, 1))}.`
            : "Nothing has been billed to you yet. Your first bill arrives at the end of a week you eat in."}
        </EmptyState>
        {/* Otherwise "nothing owed" reads as "you ate nothing", and somebody
            who ate all week is told the opposite of the truth. */}
        <WaitingNote waiting={waiting} error={waitingError} nothingBilled />
      </section>
    );
  }

  return (
    <section className="flex max-w-2xl flex-col gap-8">
      {/* The account, not a week. One number settles up, one code pays it, and
          the weeks below are the history behind it. Leading with a week meant
          paying that week: somebody three weeks behind saw the newest number
          and paid it, which is exactly what carry-forward was invented to
          paper over. */}
      <article className="flex flex-col gap-6 rounded-lg border border-border bg-surface-raised p-5 sm:p-6">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-lg font-semibold">Your account</h1>
          <AccountBadge account={bill.account} />
        </header>

        <AccountAmount account={bill.account} currency={org.currency} weeks={billed} />

        {/* The count is not repeated here: every billed week below carries its
            own note against the week the meal was eaten in, which is the
            question somebody actually has. A failure to check at all belongs
            up here, because it undermines this number rather than one week's. */}
        <WaitingNote waiting={[]} error={waitingError} />

        {owed > 0 ? (
          <PaymentDetails
            paymentRef={ref}
            amountMinor={owed}
            currency={org.currency}
            payment={bill.payment}
          />
        ) : (
          // Nothing is owed, so there is no sum to put in a code. The option
          // to send one anyway is still worth offering, and it is the only
          // way a member tops themselves up without asking an admin.
          <PayAhead paymentRef={ref} payment={bill.payment} />
        )}

      </article>

      {openWeek && (
        <p className="text-sm text-muted">
          {`This week is still open. It closes ${weekdayName(addDays(openWeek.periodEnd, 1))}.`}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your weeks</h2>
        {billed.length === 0 ? (
          <EmptyState heading="No weeks yet">
            A week appears here once it has been billed.
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
 * Three states, and the third is new: owing, settled, and in credit. A credit
 * is what a top-up looks like once it is on the books, and it used to be
 * arithmetically impossible -- `greatest(due - paid, 0)` turned every
 * overpayment into a zero and the money disappeared.
 */
function AccountAmount({
  account,
  currency,
  weeks,
}: {
  account: Account;
  currency: Currency;
  weeks: BillWeek[];
}) {
  const owed = owedMinor(account);
  const credit = creditMinor(account);
  const meals = weeks.reduce((n, w) => n + (w.statement?.mealCount ?? 0), 0);
  const behind = weeks.filter(
    (w) => w.statement !== null && outstandingMinor(w.statement) > 0,
  ).length;

  if (credit > 0) {
    return (
      <div className="flex flex-col gap-1">
        <Headline
          label="In credit"
          amount={formatMoney(credit, currency)}
          copy={plainAmount(credit, currency)}
        />
        <p className="text-sm text-muted">
          You have paid ahead. This comes off your next lunches, and there is
          nothing to transfer.
        </p>
      </div>
    );
  }

  if (owed === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Headline label="Nothing to pay" amount={formatMoney(0, currency)} />
        <p className="text-sm text-muted">
          {meals === 0
            ? "Nothing has been billed to you yet."
            : `${meals} ${meals === 1 ? "meal" : "meals"}, all settled.`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Headline
        label="You owe"
        amount={formatMoney(owed, currency)}
        copy={plainAmount(owed, currency)}
      />
      <p className="text-sm text-muted">
        {behind <= 1
          ? `${meals} ${meals === 1 ? "meal" : "meals"} billed, ${formatMoney(
              account.creditedMinor,
              currency,
            )} received.`
          : `Across ${behind} weeks. ${formatMoney(
              account.chargedMinor,
              currency,
            )} billed, ${formatMoney(account.creditedMinor, currency)} received.`}
      </p>
    </div>
  );
}

/** Owing, settled, or in credit. */
function AccountBadge({ account }: { account: Account }) {
  if (creditMinor(account) > 0) return <Badge variant="success">In credit</Badge>;
  if (owedMinor(account) === 0) return <Badge variant="success">Settled</Badge>;
  return <Badge variant="warn">Unpaid</Badge>;
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

/**
 * One sentence, two sizes. The label and the number are a single paragraph so
 * that a screen reader says "you owe 180.000 ₫" rather than reading a stray
 * figure with no idea what it is.
 */

function Headline({
  label,
  amount,
  copy,
}: {
  label: string;
  amount: string;
  /** Digits only, for a banking app's amount field. Omitted when nothing is due. */
  copy?: string;
}) {
  // Still one paragraph, and the wrapper is a span: a button is phrasing
  // content and may sit inside a <p>, a div may not.
  return (
    <p className="flex flex-col gap-1">
      <span className="text-sm text-muted">{label}</span>
      <span className="flex flex-wrap items-center gap-3">
        <span className="tabular text-3xl font-semibold">{amount}</span>
        {copy !== undefined && <CopyAmount amount={copy} />}
      </span>
    </p>
  );
}

/**
 * Copies the number without the currency glyph.
 *
 * The reference has its own button because it is typed into the memo; this one
 * exists because the amount is typed into a different field, and a person
 * paying is moving two values from this screen into their bank. Pasting
 * `45.000 ₫` into an amount field fails on every bank we have tried.
 */
function CopyAmount({ amount }: { amount: string }) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const copy = useAction(
    async () => {
      await clipboard?.writeText(amount);
    },
    { success: "Amount copied" },
  );

  return (
    <Action
      variant="outline"
      size="sm"
      reason={
        clipboard
          ? null
          : "Your browser will not let the page copy. Select the amount and copy it by hand."
      }
      pending={copy.pending}
      aria-label={`Copy the amount, ${amount}`}
      onClick={() => void copy.run()}
    >
      Copy
    </Action>
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
        <Skeleton className="h-8 w-40" />
        <Skeleton className="size-42" />
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
  return week.periodStart.slice(0, 7) === week.periodEnd.slice(0, 7)
    ? `${dayOnly.format(start)}–${dayMonth.format(end)}`
    : `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
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
