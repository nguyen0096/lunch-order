import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Action, Badge, Button, EmptyState, Skeleton, useAction } from "@/ui";
import {
  creditMinor,
  fetchPayments,
  fetchPersonPayments,
  humanError,
  movePayment,
  owedMinor,
  recordPayment,
  voidPayment,
  waiveStatement,
  type PaymentsData,
  type PaymentsPeriod,
  type PaymentsPerson,
  type PaymentsStatement,
  type PersonPayment,
  type RecordedPayment,
  type UnmatchedPayment,
} from "../api.js";
import { ApplyDialog } from "./payments/ApplyDialog.js";
import { CatererSummary } from "./payments/CatererSummary.js";
import { PeopleRows, personRows, type PersonRow } from "./payments/PeopleRows.js";
import { RecordDialog } from "./payments/RecordDialog.js";
import { SettleWeek } from "./payments/SettleWeek.js";
import { TopUpDialog } from "./payments/TopUpDialog.js";
import { UnmatchedPayments } from "./payments/UnmatchedPayments.js";
import { meals, people, weekLabel } from "./payments/labels.js";
import type { RecordDraft } from "./payments/RecordFields.js";
import type { ScreenProps } from "./screenProps.js";
import { now as appNow } from "../../shared/clock.js";
import { addDays } from "../../shared/dates.js";
import { formatMoney, type Currency } from "../../shared/money.js";

/**
 * Who has paid, what arrived, and what the caterer is owed.
 *
 * Unmatched payments lead. A list of who has paid can be read off the accounts
 * and nothing goes wrong while nobody looks at it; a payment that matched
 * nobody changes nothing anywhere, tells nobody, and is the only failure this
 * screen exists to catch. So it sits above the week rather than beneath it,
 * and it is org-wide rather than part of any one week, because money that
 * matched nobody belongs to no period.
 *
 * Under that, two questions that are no longer the same one. A week says what
 * the office ate and what it was billed. An account says who is behind, and
 * since `money_belongs_to_a_person` that is a sum over every week somebody has
 * eaten less everything they have paid, which no single week can answer.
 *
 * Every credit is a row in `payments`, a top-up included: the trigger
 * `payments_apply_on_insert` finds the person, decides what their weeks look
 * like and leaves the rest on the account, whether the money came from the
 * bank webhook or from an admin who was handed cash. One arithmetic path, one
 * audit trail, one set of rules. A payment row is never edited: one on the
 * wrong person is moved, one recorded by mistake is voided, and both go
 * through an RPC that writes `payment_corrections`.
 */
export function PaymentsScreen({ me, org }: ScreenProps) {
  const [data, setData] = useState<PaymentsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [moving, setMoving] = useState<{
    payment: UnmatchedPayment;
    from: PaymentsPerson | null;
  } | null>(null);
  const [toppingUp, setToppingUp] = useState(false);
  const [personPayments, setPersonPayments] = useState<PersonPayment[] | null>(null);

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

  // What is on the open person's account, so a mistake can be moved or voided
  // from the same dialog it would have been recorded in.
  const loadPersonPayments = useCallback(async (profileId: string | null) => {
    setPersonPayments(null);
    if (profileId === null) return;
    try {
      setPersonPayments(await fetchPersonPayments({ orgId: org.id, profileId }));
    } catch {
      setPersonPayments([]);
    }
  }, [org.id]);

  useEffect(() => {
    void loadPersonPayments(recordingId);
  }, [recordingId, loadPersonPayments]);

  /* ------------------------------------------------------------- mutations */

  const record = useAction(
    async (a: { person: PaymentsPerson; draft: RecordDraft; topUp: boolean }) => {
      const recorded = await recordPayment({
        orgId: org.id,
        profileId: a.person.profileId,
        amountMinor: a.draft.amountMinor,
        memo: a.draft.memo,
        recordedBy: me.profileId,
        // Typed in now, so it arrived now. The apply flow below is the case
        // where the two differ, and it passes the real arrival instead.
        receivedAt: appNow().toISOString(),
      });
      return { recorded, person: a.person, topUp: a.topUp };
    },
    {
      success: (r) =>
        r.topUp && r.recorded.profileId === r.person.profileId
          ? `Recorded a top-up of ${formatMoney(r.recorded.amountMinor, org.currency)} from ${r.person.name}`
          : recordedLine(r.recorded, r.person, org.currency),
      onSuccess: () => {
        setRecordingId(null);
        setToppingUp(false);
        void load();
      },
    },
  );

  const apply = useAction(
    async (a: { payment: UnmatchedPayment; person: PaymentsPerson; from: PaymentsPerson | null }) => {
      await movePayment({ paymentId: a.payment.id, toProfileId: a.person.profileId });
      return a;
    },
    {
      success: (r) =>
        r.from === null
          ? `Applied ${formatMoney(r.payment.amountMinor, org.currency)} to ${r.person.name}`
          : `Moved ${formatMoney(r.payment.amountMinor, org.currency)} from ${r.from.name} to ${r.person.name}`,
      onSuccess: () => {
        setMoving(null);
        void load();
      },
    },
  );

  const voidOne = useAction(
    async (a: { payment: PersonPayment; reason: string }) => {
      await voidPayment({ paymentId: a.payment.id, reason: a.reason });
      return a;
    },
    {
      success: (a) => `Voided ${formatMoney(a.payment.amountMinor, org.currency)}`,
      onSuccess: () => {
        void load();
        void loadPersonPayments(recordingId);
      },
    },
  );

  const waive = useAction(
    async (row: PersonRow) => {
      if (row.statement === null) throw new Error("There is no statement for that week.");
      await waiveStatement({ statementId: row.statement.id });
      return row;
    },
    {
      success: (r) => `Waived ${r.person.name}'s week`,
      onSuccess: () => {
        setRecordingId(null);
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

  const { periods, statements, people: everybody, unmatched } = data;
  const index = Math.max(
    periods.findIndex((p) => p.periodId === periodId),
    0,
  );
  const period = periods[index] ?? null;
  const week = period === null ? [] : statements.filter((s) => s.periodId === period.periodId);
  const rows = personRows(everybody, week);
  const recording = rows.find((r) => r.person.profileId === recordingId) ?? null;
  const busy = record.pending || waive.pending || voidOne.pending;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Payments</h1>
          <p className="max-w-prose text-sm text-muted">
            Money only ever goes in as a payment, the same way the bank's own arrive, so one rule
            decides where it lands. What somebody owes is their account: every week they have
            eaten, less everything they have paid. A payment is never edited: one on the wrong
            person is moved, one recorded by mistake is voided, and both stay on the record.
          </p>
        </div>
        {/* Outside the week on purpose. Somebody can pay ahead before the
            office has billed a single week, and this is the one control on the
            screen that belongs to nobody's period. */}
        <Action
          reason={
            everybody.some((p) => p.active) ? null : "Nobody has joined this office yet."
          }
          variant="outline"
          onClick={() => setToppingUp(true)}
        >
          Record a top-up
        </Action>
      </header>

      <UnmatchedPayments
        payments={unmatched}
        currency={org.currency}
        timeZone={org.timezone}
        busy={apply.pending}
        onApply={(payment) => setMoving({ payment, from: null })}
      />

      {period === null ? (
        <section className="flex flex-col gap-6">
          <EmptyState heading="No week has been billed yet">
            A week appears here once it has closed and the billing run has priced it. Until then
            there is nothing to collect.
          </EmptyState>
          {/* Nobody can owe before a week has been billed, but somebody can
              have paid ahead, and a top-up that appears nowhere is a top-up
              the admin has to take on trust. */}
          {rows.length > 0 && (
            <PeopleRows
              rows={rows}
              currency={org.currency}
              busy={busy}
              onRecord={(row) => setRecordingId(row.person.profileId)}
            />
          )}
        </section>
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

          <WeekTotals people={everybody} statements={week} currency={org.currency} />

          {/* Both, when both are true: a week nobody has been billed for still
              leaves last week's debt to collect, and the rows under the figure
              are what explain it. */}
          {week.length === 0 && <NotBilled period={period} />}
          {rows.length > 0 && (
            <PeopleRows
              rows={rows}
              currency={org.currency}
              busy={busy}
              onRecord={(row) => setRecordingId(row.person.profileId)}
            />
          )}

          {/* Above the caterer's summary, because it is what makes that
              summary true: an unpriced meal is missing from it entirely, and
              the figure below is worth reading only once the week is priced. */}
          <SettleWeek
            orgId={org.id}
            slug={org.slug}
            period={period}
            currency={org.currency}
            onSettled={() => void load()}
          />

          <CatererSummary
            orgId={org.id}
            periodId={period.periodId}
            periodTotalMinor={period.totalMinor}
            currency={org.currency}
          />
        </section>
      )}

      <RecordDialog
        row={recording}
        period={period}
        currency={org.currency}
        pending={busy}
        onOpenChange={(open) => {
          if (!open) setRecordingId(null);
        }}
        onRecord={(draft) => {
          if (recording !== null) {
            void record.run({ person: recording.person, draft, topUp: false });
          }
        }}
        onWaive={() => {
          if (recording !== null) void waive.run(recording);
        }}
        payments={personPayments}
        timeZone={org.timezone}
        onMove={(payment) => {
          if (recording === null) return;
          setMoving({ payment, from: recording.person });
          setRecordingId(null);
        }}
        onVoid={(payment, reason) => void voidOne.run({ payment, reason })}
      />

      <TopUpDialog
        open={toppingUp}
        people={everybody}
        currency={org.currency}
        pending={record.pending}
        onOpenChange={setToppingUp}
        onRecord={(person, draft) => void record.run({ person, draft, topUp: true })}
      />

      <ApplyDialog
        payment={moving?.payment ?? null}
        from={moving?.from ?? null}
        people={everybody}
        currency={org.currency}
        timeZone={org.timezone}
        pending={apply.pending}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        onApply={(person) => {
          if (moving !== null) void apply.run({ ...moving, person });
        }}
      />
    </div>
  );
}

/**
 * What the database decided, not what was asked for.
 *
 * The insert names the person, but `trg_payment_apply` reads the memo and
 * overrules it, so a memo carrying somebody else's reference moves the money
 * to them. That is silent in the database and it is about money, so it is said
 * here rather than left for an admin to notice on the next screen.
 */
function recordedLine(
  recorded: RecordedPayment,
  person: PaymentsPerson,
  currency: Currency,
): string {
  const amount = formatMoney(recorded.amountMinor, currency);
  return recorded.profileId === person.profileId
    ? `Recorded ${amount} from ${person.name}`
    : `Recorded ${amount}, but the memo did not put it on ${person.name}`;
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

/**
 * The number an admin came for, then the week behind it.
 *
 * The figure is the sum of what people owe on their accounts, not the sum of
 * this week's statements. Those were the same number only while carry-forward
 * rolled every unpaid week into the newest one; now a week is a charge and the
 * debt is what is left after every payment, so the week below explains part of
 * this figure rather than being it.
 */
function WeekTotals({
  people: everybody,
  statements,
  currency,
}: {
  people: PaymentsPerson[];
  statements: PaymentsStatement[];
  currency: Currency;
}) {
  const owed = everybody.reduce((n, p) => n + owedMinor(p.account), 0);
  const owing = everybody.filter((p) => owedMinor(p.account) > 0).length;
  const inCredit = everybody.filter((p) => creditMinor(p.account) > 0);
  const creditMinorTotal = inCredit.reduce((n, p) => n + creditMinor(p.account), 0);

  const billed = statements.reduce((n, s) => n + s.mealsMinor, 0);
  const mealCount = statements.reduce((n, s) => n + s.mealCount, 0);
  const waived = statements.filter((s) => s.status === "waived");
  const waivedMinor = waived.reduce((n, s) => n + s.mealsMinor, 0);

  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-col gap-1">
        <span className="text-sm text-muted">Still to collect</span>
        <span className="tabular text-3xl font-semibold">{formatMoney(owed, currency)}</span>
      </p>
      <p className="text-sm text-muted">
        {owed === 0
          ? "Nobody owes anything."
          : `Across every week, not only this one, from ${people(owing)}.`}
      </p>
      {statements.length > 0 && (
        <p className="text-sm text-muted">
          {`${formatMoney(billed, currency)} billed this week to ${people(
            statements.length,
          )} for ${meals(mealCount)}.`}
        </p>
      )}
      {inCredit.length > 0 && (
        <p className="text-sm text-muted">
          {/* Named, never shown as a zero. Somebody who has paid ahead is not
              somebody who is square, and the money is theirs until they eat. */}
          {`${people(inCredit.length)} paid ahead: ${formatMoney(
            creditMinorTotal,
            currency,
          )} sits as credit and comes off their next lunches.`}
        </p>
      )}
      {waived.length > 0 && (
        <p className="text-sm text-muted">
          {`${waived.length === 1 ? "One person's week is" : `${waived.length} people's weeks are`} waived, so ${formatMoney(
            waivedMinor,
            currency,
          )} of this week is not being asked for.`}
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
