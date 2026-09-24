import { useCallback, useEffect, useState } from "react";
import { Action, Badge, Button, EmptyState, Skeleton, useAction } from "@/ui";
import {
  fetchBill,
  fetchUnpricedMeals,
  humanError,
  isSettled,
  outstandingMinor,
  type Bill,
  type BillStatement,
  type BillWeek,
  type UnpricedMeal,
} from "../api.js";
import { BillLines } from "./bill/BillLines.js";
import { PaymentDetails } from "./bill/PaymentDetails.js";
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
 * The week the screen leads with is the oldest thing still unsettled rather
 * than simply the newest week. Carry-forward rolls an unpaid remainder into the
 * next statement, so the newest *unsettled* statement is the whole debt --
 * adding the weeks together would charge an unpaid week twice over.
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
  // The newest unsettled week already carries every older remainder with it.
  const lead = billed.find((w) => w.statement !== null && !isSettled(w.statement)) ?? billed[0];
  // The week in progress, which normally has no statement yet. That absence is
  // "nothing owed yet", not a missing row.
  const openWeek = bill.weeks.find((w) => w.periodStatus === "open" && w.statement === null);
  const past = billed.filter((w) => w !== lead);

  if (lead === undefined || lead.statement === null) {
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

  const statement = lead.statement;
  const outstanding = outstandingMinor(statement);
  const leadWaiting = waitingIn(lead, waiting);

  return (
    <section className="flex max-w-2xl flex-col gap-8">
      <article className="flex flex-col gap-6 rounded-lg border border-border bg-surface-raised p-5 sm:p-6">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-lg font-semibold">{weekLabel(lead)}</h1>
          <StatusBadge statement={statement} />
        </header>

        <Amount statement={statement} currency={org.currency} timeZone={org.timezone} />

        <WaitingNote waiting={leadWaiting} error={waitingError} />

        {outstanding > 0 && (
          <PaymentDetails
            paymentRef={statement.paymentRef}
            amountMinor={outstanding}
            currency={org.currency}
            payment={bill.payment}
          />
        )}

        <BillLines
          orgId={org.id}
          periodId={lead.periodId}
          profileId={me.profileId}
          currency={org.currency}
          lineCount={lead.lineCount}
          waiting={leadWaiting}
        />
      </article>

      {/* Said even when the lead week is settled: "you owe nothing" and "this
          week is still running" are two different pieces of news, and somebody
          reading a receipt still wants to know when the next one lands. */}
      {openWeek && openWeek !== lead && (
        <p className="text-sm text-muted">
          {`This week is still open. It closes ${weekdayName(addDays(openWeek.periodEnd, 1))}.`}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Past weeks</h2>
        {past.length === 0 ? (
          <EmptyState heading="No earlier weeks">
            A week appears here once it has been billed and the next one has started.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {past.map((week) => (
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

function Amount({
  statement,
  currency,
  timeZone,
}: {
  statement: BillStatement;
  currency: Currency;
  timeZone: string;
}) {
  const outstanding = outstandingMinor(statement);
  const meals = `${statement.mealCount} ${statement.mealCount === 1 ? "meal" : "meals"}`;

  if (statement.status === "waived") {
    return (
      <div className="flex flex-col gap-1">
        {/* The label never repeats the badge beside it: two identical words,
            one large and one small, read as a rendering mistake. */}
        <Headline label="Nothing to pay" amount={formatMoney(0, currency)} />
        <p className="text-sm text-muted">
          {`An admin waived this week, so ${meals} cost you nothing.`}
        </p>
      </div>
    );
  }

  if (outstanding === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Headline label="Paid in full" amount={formatMoney(statement.totalDueMinor, currency)} />
        <p className="text-sm text-muted">
          {statement.paidAt === null
            ? `${meals}, settled in full.`
            : `${meals}, received ${dayAndMonth(statement.paidAt, timeZone)}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Headline
        label={statement.paidMinor > 0 ? "Still to pay" : "You owe"}
        amount={formatMoney(outstanding, currency)}
        copy={plainAmount(outstanding, currency)}
      />
      <p className="text-sm text-muted">
        {`${meals}, ${formatMoney(statement.mealsMinor, currency)}.`}
      </p>
      {statement.carriedInMinor > 0 && (
        <p className="text-sm text-muted">
          {`Includes ${formatMoney(statement.carriedInMinor, currency)} carried over from the week before.`}
        </p>
      )}
      {statement.paidMinor > 0 && (
        <p className="text-sm text-muted">
          {`Received so far: ${formatMoney(statement.paidMinor, currency)} of ${formatMoney(
            statement.totalDueMinor,
            currency,
          )}.`}
        </p>
      )}
    </div>
  );
}

/**
 * The meals this total leaves out, and why.
 *
 * The caterer prices the week at the weekend, so a meal eaten on Tuesday can
 * still have no price on Friday. `run_billing` holds those orders off the bill
 * entirely rather than billing them at zero, because zero is a real price and
 * on a bill it reads as a free lunch. That is the right arithmetic and the
 * wrong silence: a total quietly missing three meals is a total somebody
 * checks against their own memory and disbelieves.
 *
 * So the number is explained rather than merely correct. Saying how many are
 * coming is also the only way somebody can tell an incomplete bill from a
 * cheap week.
 */
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
      {outstandingMinor(statement) > 0 && (
        <p className="text-sm text-muted">
          {`${formatMoney(outstandingMinor(statement), org.currency)} of this is still to pay, and it is carried into the week above.`}
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
