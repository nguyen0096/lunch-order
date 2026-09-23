import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Action, Badge, Button, EmptyState, Skeleton, useAction } from "@/ui";
import {
  fetchPayments,
  humanError,
  outstandingMinor,
  recordPayment,
  waiveStatement,
  type PaymentsData,
  type PaymentsPeriod,
  type PaymentsStatement,
  type UnmatchedPayment,
} from "../api.js";
import { ApplyDialog } from "./payments/ApplyDialog.js";
import { CatererSummary } from "./payments/CatererSummary.js";
import { RecordDialog, type RecordDraft } from "./payments/RecordDialog.js";
import { StatementRows } from "./payments/StatementRows.js";
import { UnmatchedPayments } from "./payments/UnmatchedPayments.js";
import { meals, people, weekLabel } from "./payments/labels.js";
import type { ScreenProps } from "./screenProps.js";
import { now as appNow } from "../../shared/clock.js";
import { addDays } from "../../shared/dates.js";
import { formatMoney, type Currency } from "../../shared/money.js";

/**
 * Who has paid, what arrived, and what the caterer is owed.
 *
 * Unmatched payments lead. A list of who has paid can be read off the
 * statements and nothing goes wrong while nobody looks at it; a payment that
 * matched nobody changes nothing anywhere, tells nobody, and is the only
 * failure this screen exists to catch. So it sits above the week rather than
 * beneath it, and it is org-wide rather than part of any one week, because
 * money that matched nothing belongs to no period.
 *
 * Every credit is a row in `payments`, including "mark as paid": the trigger
 * `payments_apply_on_insert` does the arithmetic and decides the status
 * whether the money came from the bank webhook or from an admin who was handed
 * cash. One arithmetic path, one audit trail, one set of rules -- and the
 * price of that is that a payment cannot be undone, which every confirmation
 * on this screen says out loud rather than leaving somebody to discover.
 */
export function PaymentsScreen({ me, org }: ScreenProps) {
  const [data, setData] = useState<PaymentsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [settlingId, setSettlingId] = useState<number | null>(null);
  const [applyingId, setApplyingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchPayments({ orgId: org.id }));
      setLoadError(null);
    } catch (e) {
      // `useAction` owns every write. A read has no toast to fire and nothing
      // to put back, so its failure is a state the screen renders instead.
      setLoadError(humanError(e));
    }
  }, [org.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------------------------------------- mutations */

  const record = useAction(
    async (a: { statement: PaymentsStatement; draft: RecordDraft }) => {
      const recorded = await recordPayment({
        orgId: org.id,
        amountMinor: a.draft.amountMinor,
        memo: a.draft.memo,
        recordedBy: me.profileId,
        // Typed in now, so it arrived now. The apply flow below is the case
        // where the two differ, and it passes the real arrival instead.
        receivedAt: appNow().toISOString(),
      });
      return { ...recorded, name: a.statement.name };
    },
    {
      success: (r) =>
        r.matchedStatementId === null
          ? "Recorded, but the memo matched nobody"
          : `Recorded ${formatMoney(r.amountMinor, org.currency)} from ${r.name}`,
      onSuccess: () => {
        setSettlingId(null);
        void load();
      },
    },
  );

  const apply = useAction(
    async (a: { payment: UnmatchedPayment; statement: PaymentsStatement }) => {
      const recorded = await recordPayment({
        orgId: org.id,
        amountMinor: a.payment.amountMinor,
        memo: a.statement.paymentRef,
        recordedBy: me.profileId,
        // The money arrived when the bank says it did, not when an admin
        // worked out whose it was.
        receivedAt: a.payment.receivedAt,
        resolvesPaymentId: a.payment.id,
      });
      return { ...recorded, name: a.statement.name };
    },
    {
      success: (r) =>
        r.matchedStatementId === null
          ? "Recorded, but the memo matched nobody"
          : `Recorded ${formatMoney(r.amountMinor, org.currency)} from ${r.name}`,
      onSuccess: () => {
        setApplyingId(null);
        void load();
      },
    },
  );

  const waive = useAction(
    async (statement: PaymentsStatement) => {
      await waiveStatement({
        orgId: org.id,
        statementId: statement.id,
        waivedBy: me.profileId,
      });
      return statement;
    },
    {
      success: (s) => `Waived ${s.name}'s week`,
      onSuccess: () => {
        setSettlingId(null);
        void load();
      },
    },
  );

  /* ------------------------------------------------------------- rendering */

  if (loadError !== null) {
    return (
      <EmptyState
        heading="Payments did not load"
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

  if (data === null) return <PaymentsSkeleton />;

  const { periods, statements, unmatched } = data;
  const index = Math.max(
    periods.findIndex((p) => p.periodId === periodId),
    0,
  );
  const period = periods[index] ?? null;
  const week = period === null ? [] : statements.filter((s) => s.periodId === period.periodId);
  const settling = week.find((s) => s.id === settlingId) ?? null;
  const applying = unmatched.find((p) => p.id === applyingId) ?? null;
  const busy = record.pending || waive.pending;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Payments</h1>
        <p className="max-w-prose text-sm text-muted">
          Money only ever goes in as a payment, the same way the bank's own arrive, so one rule
          decides what is settled. That is also why nothing here can be taken back.
        </p>
      </header>

      <UnmatchedPayments
        payments={unmatched}
        currency={org.currency}
        timeZone={org.timezone}
        busy={apply.pending}
        onApply={(payment) => setApplyingId(payment.id)}
      />

      {period === null ? (
        <EmptyState heading="No week has been billed yet">
          A week appears here once it has closed and the billing run has priced it. Until then
          there is nothing to collect.
        </EmptyState>
      ) : (
        <section className="flex flex-col gap-6">
          <WeekNav
            period={period}
            newest={index === 0}
            oldest={index >= periods.length - 1}
            depth={periods.length}
            onOlder={() => setPeriodId(periods[index + 1]?.periodId ?? period.periodId)}
            onNewer={() => setPeriodId(periods[index - 1]?.periodId ?? period.periodId)}
            onNewest={() => setPeriodId(periods[0]?.periodId ?? null)}
          />

          {week.length === 0 ? (
            <NotBilled period={period} />
          ) : (
            <>
              <WeekTotals statements={week} currency={org.currency} />
              <StatementRows
                statements={week}
                currency={org.currency}
                busy={busy}
                onSettle={(s) => setSettlingId(s.id)}
              />
            </>
          )}

          <CatererSummary
            orgId={org.id}
            periodId={period.periodId}
            periodTotalMinor={period.totalMinor}
            currency={org.currency}
          />
        </section>
      )}

      <RecordDialog
        statement={settling}
        period={period}
        currency={org.currency}
        pending={busy}
        onOpenChange={(open) => {
          if (!open) setSettlingId(null);
        }}
        onRecord={(draft) => {
          if (settling !== null) void record.run({ statement: settling, draft });
        }}
        onWaive={() => {
          if (settling !== null) void waive.run(settling);
        }}
      />

      <ApplyDialog
        payment={applying}
        statements={statements}
        periods={periods}
        currency={org.currency}
        timeZone={org.timezone}
        pending={apply.pending}
        onOpenChange={(open) => {
          if (!open) setApplyingId(null);
        }}
        onApply={(statement) => {
          if (applying !== null) void apply.run({ payment: applying, statement });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * One control for the week, the way the board does it. "This week" appears
 * only once you have left it, because a reset to where you already are is a
 * control that does nothing.
 */
function WeekNav({
  period,
  newest,
  oldest,
  depth,
  onOlder,
  onNewer,
  onNewest,
}: {
  period: PaymentsPeriod;
  newest: boolean;
  oldest: boolean;
  depth: number;
  onOlder: () => void;
  onNewer: () => void;
  onNewest: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Action
        reason={oldest ? `This screen reaches back ${depth} weeks, and this is the oldest.` : null}
        variant="ghost"
        size="icon"
        aria-label="Earlier week"
        onClick={onOlder}
      >
        <ChevronLeftIcon />
      </Action>
      <h2 className="min-w-36 text-center text-lg font-semibold tabular">
        {weekLabel(period.periodStart, period.periodEnd)}
      </h2>
      <Action
        reason={newest ? "This is the newest week." : null}
        variant="ghost"
        size="icon"
        aria-label="Later week"
        onClick={onNewer}
      >
        <ChevronRightIcon />
      </Action>
      <PeriodBadge status={period.periodStatus} />
      {!newest && (
        <Button variant="link" className="ml-1" onClick={onNewest}>
          Newest week
        </Button>
      )}
    </div>
  );
}

function PeriodBadge({ status }: { status: PaymentsPeriod["periodStatus"] }) {
  if (status === "open") return <Badge variant="accent">Still running</Badge>;
  if (status === "computing") return <Badge variant="warn">Being priced</Badge>;
  return <Badge variant="neutral">Closed</Badge>;
}

/** The number an admin came for, then the arithmetic behind it. */
function WeekTotals({
  statements,
  currency,
}: {
  statements: PaymentsStatement[];
  currency: Currency;
}) {
  const due = statements.reduce((n, s) => n + s.totalDueMinor, 0);
  const paid = statements.reduce((n, s) => n + s.paidMinor, 0);
  const outstanding = statements.reduce((n, s) => n + outstandingMinor(s), 0);
  const mealCount = statements.reduce((n, s) => n + s.mealCount, 0);
  const waived = statements.filter((s) => s.status === "waived");
  const waivedMinor = waived.reduce((n, s) => n + s.totalDueMinor, 0);

  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-col gap-1">
        <span className="text-sm text-muted">Still to collect</span>
        <span className="tabular text-3xl font-semibold">{formatMoney(outstanding, currency)}</span>
      </p>
      <p className="text-sm text-muted">
        {`${formatMoney(paid, currency)} received of ${formatMoney(due, currency)} billed to ${people(
          statements.length,
        )} for ${meals(mealCount)}.`}
      </p>
      {waived.length > 0 && (
        <p className="text-sm text-muted">
          {`${waived.length === 1 ? "One week is" : `${waived.length} weeks are`} waived, so ${formatMoney(
            waivedMinor,
            currency,
          )} of that is not being asked for.`}
        </p>
      )}
    </div>
  );
}

/**
 * A week with no statements. Which of the two sentences it is depends on the
 * period's own status, and neither of them is an error: a week that is still
 * running has simply not been priced yet.
 */
function NotBilled({ period }: { period: PaymentsPeriod }) {
  if (period.periodStatus === "open" || period.periodStatus === "computing") {
    return (
      <EmptyState heading="This week has not been billed yet">
        {`It is priced once the week ends on ${weekdayName(addDays(period.periodEnd, 1))}, and everybody's statement appears then. Nothing is owed before that.`}
      </EmptyState>
    );
  }
  return (
    <EmptyState heading="Nobody ate this week">
      The week closed with no meals on it, so there is nobody to collect from.
    </EmptyState>
  );
}

function weekdayName(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)),
  );
}

/** Shaped like the screen, so the figures do not jump when the data lands. */
function PaymentsSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 w-full" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
