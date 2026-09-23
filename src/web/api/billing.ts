/**
 * What a week cost and what has been paid against it.
 *
 * Read-only from the browser. A member has no write path into billing at all:
 * `billing_lines` are written by `run_billing()` and nothing else, and
 * `billing_statements.paid_minor` moves only through
 * `apply_payment_to_statement()` when a bank payment arrives.
 */

import { supabase } from "../supabase.js";
import { parsePaymentConfig, type PaymentConfig } from "../../shared/payment.js";

export type BillStatementStatus = "unpaid" | "partial" | "paid" | "waived";
export type BillPeriodStatus = "open" | "computing" | "closed" | "void";

export type BillStatement = {
  id: number;
  mealCount: number;
  mealsMinor: number;
  /** The unpaid remainder of the week before, rolled into this one. */
  carriedInMinor: number;
  totalDueMinor: number;
  /**
   * What the office has received against this week. The only trustworthy
   * source: `payments` is admin-only under RLS, so a member querying it gets
   * an empty set rather than an error, and a screen built on it would show
   * every colleague "nothing received" while working perfectly for its author.
   */
  paidMinor: number;
  /** The bank memo. Mistyping it is how a payment goes unmatched. */
  paymentRef: string;
  status: BillStatementStatus;
  paidAt: string | null;
};

export type BillWeek = {
  periodId: number;
  periodStart: string;
  /** Inclusive: the last service date the week covers. */
  periodEnd: string;
  periodStatus: BillPeriodStatus;
  lineCount: number;
  /**
   * Null until the billing run has executed for this week. For the open week
   * that is the normal state, and it means "nothing owed yet", not a failure.
   */
  statement: BillStatement | null;
};

export type Bill = {
  /** Newest week first. */
  weeks: BillWeek[];
  payment: PaymentConfig;
};

/** What is still to pay. Never negative: an overpayment is not a credit here. */
export function outstandingMinor(s: BillStatement): number {
  if (s.status === "waived") return 0;
  return Math.max(s.totalDueMinor - s.paidMinor, 0);
}

/** True when there is nothing left for this person to do about this week. */
export function isSettled(s: BillStatement): boolean {
  return s.status === "paid" || s.status === "waived" || outstandingMinor(s) === 0;
}

type PeriodRow = {
  id: number;
  period_start: string;
  period_end: string;
  status: string;
  line_count: number;
};

type StatementRow = {
  id: number;
  billing_period_id: number;
  meal_count: number;
  meals_minor: number;
  carried_in_minor: number;
  total_due_minor: number;
  paid_minor: number;
  payment_ref: string;
  status: string;
  paid_at: string | null;
};

/**
 * Every week the org has billed, with my statement against each.
 *
 * Periods and statements are fetched separately rather than joined, because
 * they answer different questions: `billing_periods` is readable org-wide and
 * says which weeks exist, while a statement exists only once the run has
 * produced one. Collapsing the two would hide the difference between "this
 * week has not been billed yet" and "I owed nothing that week", and those are
 * two different sentences.
 */
export async function fetchBill(args: {
  orgId: number;
  profileId: string;
  /** How far back the past-weeks list goes. */
  limit?: number;
}): Promise<Bill> {
  const limit = args.limit ?? 12;

  const [periodsRes, statementsRes, orgRes] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("id, period_start, period_end, status, line_count")
      .eq("org_id", args.orgId)
      // A void week is a retracted week. Listing it would ask somebody to
      // reason about a bill that no longer exists.
      .neq("status", "void")
      .order("period_start", { ascending: false })
      .limit(limit),
    supabase
      .from("billing_statements")
      .select(
        `id, billing_period_id, meal_count, meals_minor, carried_in_minor,
         total_due_minor, paid_minor, payment_ref, status, paid_at`,
      )
      .eq("org_id", args.orgId)
      // Mandatory, not defensive. A member is limited to their own row by RLS,
      // but an admin's policy is `for all` over the whole org: without this
      // filter an admin's own bill would be whichever colleague's statement
      // came back first.
      .eq("profile_id", args.profileId),
    supabase.from("organizations").select("payment_config").eq("id", args.orgId).single(),
  ]);

  if (periodsRes.error) throw periodsRes.error;
  if (statementsRes.error) throw statementsRes.error;
  if (orgRes.error) throw orgRes.error;

  const byPeriod = new Map<number, BillStatement>();
  for (const r of (statementsRes.data ?? []) as StatementRow[]) {
    byPeriod.set(r.billing_period_id, {
      id: r.id,
      mealCount: r.meal_count,
      mealsMinor: r.meals_minor,
      carriedInMinor: r.carried_in_minor,
      totalDueMinor: r.total_due_minor,
      paidMinor: r.paid_minor,
      paymentRef: r.payment_ref,
      status: r.status as BillStatementStatus,
      paidAt: r.paid_at,
    });
  }

  return {
    weeks: ((periodsRes.data ?? []) as PeriodRow[]).map((p) => ({
      periodId: p.id,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      periodStatus: p.status as BillPeriodStatus,
      lineCount: p.line_count,
      statement: byPeriod.get(p.id) ?? null,
    })),
    payment: parsePaymentConfig(orgRes.data?.payment_config),
  };
}

export type BillLine = {
  id: number;
  serviceDate: string;
  amountMinor: number;
  /** The dish, as it was named on the day. */
  description: string;
  /** True when this line is on my total. False means I gave the meal away. */
  mine: boolean;
  /** The colleague on the other side, when the meal moved between people. */
  counterpartName: string | null;
};

type LineRow = {
  id: number;
  service_date: string;
  amount_minor: number;
  description: string;
  transfer_id: number | null;
  payer_profile_id: string;
  original_profile_id: string;
};

/**
 * The meals behind one week's total. This is the only place a member can see
 * the itemisation, so it deliberately includes the meals they gave away as
 * well as the ones they are charged for: `billing_lines_select_placer` exists
 * precisely so a meal that moved does not vanish from the giver's view,
 * leaving them unable to check they were not billed for it.
 */
export async function fetchBillLines(args: {
  orgId: number;
  periodId: number;
  profileId: string;
}): Promise<BillLine[]> {
  const [linesRes, membersRes] = await Promise.all([
    supabase
      .from("billing_lines")
      .select(
        `id, service_date, amount_minor, description, transfer_id,
         payer_profile_id, original_profile_id`,
      )
      .eq("org_id", args.orgId)
      .eq("billing_period_id", args.periodId)
      // RLS already limits a member to lines they pay for or placed. An admin
      // reads the whole org, so without this their own itemisation would be
      // the entire office's. `profileId` is a uuid from the auth session, so
      // it cannot carry PostgREST filter syntax.
      .or(`payer_profile_id.eq.${args.profileId},original_profile_id.eq.${args.profileId}`)
      .order("service_date", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("memberships")
      .select("profile_id, short_code, display_name, profiles ( full_name )")
      .eq("org_id", args.orgId),
  ]);

  if (linesRes.error) throw linesRes.error;
  if (membersRes.error) throw membersRes.error;

  const nameOf = new Map<string, string>();
  for (const m of membersRes.data ?? []) {
    const prof = m.profiles as unknown as { full_name: string } | null;
    nameOf.set(m.profile_id, m.display_name ?? prof?.full_name ?? m.short_code);
  }

  return ((linesRes.data ?? []) as LineRow[]).map((l) => {
    const mine = l.payer_profile_id === args.profileId;
    // A transfer has two sides and the line names both. The interesting one is
    // always the other person: who handed it to me, or who I handed it to.
    const counterpart =
      l.transfer_id === null ? null : mine ? l.original_profile_id : l.payer_profile_id;
    return {
      id: l.id,
      serviceDate: l.service_date,
      amountMinor: l.amount_minor,
      description: l.description,
      mine,
      counterpartName:
        counterpart === null || counterpart === args.profileId
          ? null
          : nameOf.get(counterpart) ?? "a colleague",
    };
  });
}

/* ========================================================================= */
/* The admin's side of the same data                                         */
/* ========================================================================= */

/**
 * `billing_statements_admin`, `billing_lines_admin` and `payments_admin` are
 * each `for all` over the org, so an admin legitimately reads every row below.
 * Every query still names `org_id` anyway: the policy is a permission, not a
 * filter, and an admin of two offices would otherwise read both at once.
 */

export type PaymentsStatement = BillStatement & {
  periodId: number;
  profileId: string;
  name: string;
  /** The short code. It is what a bank memo usually carries. */
  shortCode: string;
};

export type PaymentsPeriod = {
  periodId: number;
  periodStart: string;
  /** Inclusive. */
  periodEnd: string;
  periodStatus: BillPeriodStatus;
  lineCount: number;
  /**
   * `billing_periods.total_minor`, which `run_billing()` sets to the sum of
   * that week's `billing_lines`. It is food and nothing else, which is why it
   * is the right cross-check for the caterer's total and the wrong number for
   * what the office has been asked to pay.
   */
  totalMinor: number;
};

/** Money that arrived and landed on nobody. The failure this screen exists to catch. */
export type UnmatchedPayment = {
  id: number;
  amountMinor: number;
  /** Exactly as the bank sent it, including the null that guarantees no match. */
  memo: string | null;
  receivedAt: string;
  provider: string;
};

export type PaymentsData = {
  /** Newest week first. */
  periods: PaymentsPeriod[];
  /** Every member's statement across those weeks, by name. */
  statements: PaymentsStatement[];
  unmatched: UnmatchedPayment[];
};

type AdminPeriodRow = {
  id: number;
  period_start: string;
  period_end: string;
  status: string;
  line_count: number;
  total_minor: number;
};

type AdminStatementRow = StatementRow & { profile_id: string };

/**
 * Everything the payments screen needs that is not tied to one week.
 *
 * Periods bound the query rather than time does: the screen shows a dozen
 * weeks, so the statements are fetched for exactly those periods. Fetching
 * every statement the org has ever had would grow without limit and answer no
 * question the screen asks.
 */
export async function fetchPayments(args: {
  orgId: number;
  /** How many weeks back the period picker reaches. */
  limit?: number;
}): Promise<PaymentsData> {
  const limit = args.limit ?? 12;

  const [periodsRes, membersRes, unmatchedRes] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("id, period_start, period_end, status, line_count, total_minor")
      .eq("org_id", args.orgId)
      // A void week is a retracted week, as on the member's screen.
      .neq("status", "void")
      .order("period_start", { ascending: false })
      .limit(limit),
    supabase
      .from("memberships")
      .select("profile_id, short_code, display_name, profiles ( full_name )")
      .eq("org_id", args.orgId),
    supabase
      .from("payments")
      .select("id, amount_minor, memo, received_at, provider")
      .eq("org_id", args.orgId)
      .is("matched_statement_id", null)
      .order("received_at", { ascending: false })
      .limit(50),
  ]);

  if (periodsRes.error) throw periodsRes.error;
  if (membersRes.error) throw membersRes.error;
  if (unmatchedRes.error) throw unmatchedRes.error;

  const periods: PaymentsPeriod[] = ((periodsRes.data ?? []) as AdminPeriodRow[]).map((p) => ({
    periodId: p.id,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    periodStatus: p.status as BillPeriodStatus,
    lineCount: p.line_count,
    totalMinor: p.total_minor,
  }));

  const nameOf = new Map<string, string>();
  const codeOf = new Map<string, string>();
  for (const m of membersRes.data ?? []) {
    const prof = m.profiles as unknown as { full_name: string } | null;
    nameOf.set(m.profile_id, m.display_name ?? prof?.full_name ?? m.short_code);
    codeOf.set(m.profile_id, m.short_code);
  }

  let statementRows: AdminStatementRow[] = [];
  if (periods.length > 0) {
    const res = await supabase
      .from("billing_statements")
      .select(
        `id, billing_period_id, profile_id, meal_count, meals_minor, carried_in_minor,
         total_due_minor, paid_minor, payment_ref, status, paid_at`,
      )
      .eq("org_id", args.orgId)
      .in(
        "billing_period_id",
        periods.map((p) => p.periodId),
      );
    if (res.error) throw res.error;
    statementRows = (res.data ?? []) as AdminStatementRow[];
  }

  const statements: PaymentsStatement[] = statementRows
    .map((r) => ({
      id: r.id,
      periodId: r.billing_period_id,
      profileId: r.profile_id,
      // A statement outlives a membership, so somebody who has left still has
      // to be nameable. The reference is the last resort because it is the one
      // string that is always on the row itself.
      name: nameOf.get(r.profile_id) ?? r.payment_ref,
      shortCode: codeOf.get(r.profile_id) ?? "",
      mealCount: r.meal_count,
      mealsMinor: r.meals_minor,
      carriedInMinor: r.carried_in_minor,
      totalDueMinor: r.total_due_minor,
      paidMinor: r.paid_minor,
      paymentRef: r.payment_ref,
      status: r.status as BillStatementStatus,
      paidAt: r.paid_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));

  return {
    periods,
    statements,
    unmatched: (unmatchedRes.data ?? []).map((p) => ({
      id: p.id,
      amountMinor: p.amount_minor,
      memo: p.memo,
      receivedAt: p.received_at,
      provider: p.provider,
    })),
  };
}

/* ------------------------------------------------- what the caterer is owed */

export type CatererLine = {
  serviceDate: string;
  /** The dish as it was named on the day, snapshotted onto the line. */
  description: string;
  amountMinor: number;
};

export type CatererDish = { description: string; count: number; amountMinor: number };

export type CatererDay = {
  serviceDate: string;
  dishes: CatererDish[];
  count: number;
  subtotalMinor: number;
};

export type CatererSummary = {
  /** Oldest day first: this is read down like an order sheet. */
  days: CatererDay[];
  count: number;
  /** The sum of the lines, and the only number the caterer is owed. */
  totalMinor: number;
  /**
   * `billing_periods.total_minor`, kept beside the sum rather than instead of
   * it. The billing run writes both from the same lines, so a disagreement
   * means one of them is stale and the screen has to say so rather than pick.
   */
  periodTotalMinor: number;
};

/**
 * A week of billing lines as a caterer's order sheet: days down, dishes within
 * a day, counted and summed.
 *
 * Grouped by dish alone, deliberately. A transfer moves `payer_profile_id` and
 * changes who is billed, but nobody cooked a different lunch because a meal
 * changed hands, so who pays has no place in this half of the screen.
 */
export function summariseForCaterer(
  lines: CatererLine[],
  periodTotalMinor: number,
): CatererSummary {
  const byDay = new Map<string, Map<string, CatererDish>>();

  for (const line of lines) {
    const dishes = byDay.get(line.serviceDate) ?? new Map<string, CatererDish>();
    byDay.set(line.serviceDate, dishes);
    const dish = dishes.get(line.description) ?? {
      description: line.description,
      count: 0,
      amountMinor: 0,
    };
    dish.count += 1;
    dish.amountMinor += line.amountMinor;
    dishes.set(line.description, dish);
  }

  const days: CatererDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serviceDate, dishes]) => {
      const list = [...dishes.values()].sort(
        // Most ordered first: that is the order somebody reads a list down the
        // phone in, and it puts the number that matters at the top.
        (a, b) => b.count - a.count || a.description.localeCompare(b.description, "vi"),
      );
      return {
        serviceDate,
        dishes: list,
        count: list.reduce((n, d) => n + d.count, 0),
        subtotalMinor: list.reduce((n, d) => n + d.amountMinor, 0),
      };
    });

  return {
    days,
    count: days.reduce((n, d) => n + d.count, 0),
    totalMinor: days.reduce((n, d) => n + d.subtotalMinor, 0),
    periodTotalMinor,
  };
}

/**
 * The food one week bought, for the person who pays the caterer.
 *
 * Read from `billing_lines` and never from `billing_statements`, because
 * `total_due_minor` is generated as `meals_minor + carried_in_minor` and the
 * carried part is last week's debt rolled forward. Nobody cooked it. Paying a
 * caterer the sum of the statements overcharges by exactly that debt.
 */
export async function fetchCatererSummary(args: {
  orgId: number;
  periodId: number;
  /** The period's own recorded total, so the two can be reconciled on screen. */
  periodTotalMinor: number;
}): Promise<CatererSummary> {
  const { data, error } = await supabase
    .from("billing_lines")
    .select("service_date, description, amount_minor")
    .eq("org_id", args.orgId)
    .eq("billing_period_id", args.periodId)
    .order("service_date", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;

  return summariseForCaterer(
    (data ?? []).map((l) => ({
      serviceDate: l.service_date,
      description: l.description,
      amountMinor: l.amount_minor,
    })),
    args.periodTotalMinor,
  );
}

/* ------------------------------------------------------ recording a payment */

/**
 * Not `sepay`. The column defaults to the bank webhook's name, so a payment an
 * admin recorded by hand has to say so or the audit trail claims the bank told
 * us about money it never saw.
 */
export const MANUAL_PROVIDER = "manual";

export type RecordedPayment = {
  id: number;
  amountMinor: number;
  /**
   * Null when the memo matched nobody. Recording a payment whose memo lands on
   * no statement is silent in the database -- it is the normal webhook case --
   * so the caller has to be told, or an admin types a reference wrongly and
   * hears "Recorded".
   */
  matchedStatementId: number | null;
};

/**
 * A `provider_txn_id` nothing else will collide with.
 *
 * `payments_provider_txn_uk` is unique on (org, provider, txn), so without one
 * of these the second cash payment of the day is refused as a duplicate of the
 * first. A collision here costs a retry rather than a wrong number, which is
 * why the fallback is allowed to exist at all -- a join code, where a
 * collision is a stranger in the office, refuses to run without a CSPRNG.
 */
function manualTxnId(receivedAt: string): string {
  return `${MANUAL_PROVIDER}-${receivedAt.replace(/[^0-9]/g, "")}-${randomSuffix()}`;
}

function randomSuffix(): string {
  const rng = globalThis.crypto;
  if (typeof rng?.getRandomValues === "function") {
    return [...rng.getRandomValues(new Uint8Array(5))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return Math.random().toString(16).slice(2, 12).padEnd(10, "0");
}

/**
 * Record money that arrived. The only write that moves a statement.
 *
 * Every credit goes in as a row here rather than as an UPDATE to
 * `billing_statements`, so `payments_apply_on_insert` does the arithmetic and
 * decides the status whether the money came from the bank webhook or from an
 * admin who was handed cash. One path, one audit trail, one set of rules.
 *
 * IRREVERSIBLE, and the interface has to say so. The trigger is AFTER INSERT
 * only: nothing decrements `paid_minor` on update or delete, and
 * `amount_minor > 0` blocks a corrective negative row. A payment recorded in
 * error can only be fixed in the database by hand.
 */
export async function recordPayment(args: {
  orgId: number;
  amountMinor: number;
  /**
   * The bank memo. The trigger folds it to A-Z0-9 and matches the statement
   * whose `payment_ref` appears inside it, so a person's reference is enough.
   */
  memo: string;
  recordedBy: string;
  /** When the money arrived, not when it was typed in. Both are NOT NULL here. */
  receivedAt: string;
  /** The unmatched payment this one is being recorded on behalf of, if any. */
  resolvesPaymentId?: number;
}): Promise<RecordedPayment> {
  const { data: inserted, error } = await supabase
    .from("payments")
    .insert({
      org_id: args.orgId,
      provider: MANUAL_PROVIDER,
      provider_txn_id: manualTxnId(args.receivedAt),
      amount_minor: args.amountMinor,
      memo: args.memo,
      received_at: args.receivedAt,
      // `raw` is NOT NULL with no default, and it is the only place the reason
      // for a hand-recorded payment can live. A bank row holds the webhook
      // body here; this one holds who said the money came in.
      raw: {
        source: "admin",
        recorded_by: args.recordedBy,
        ...(args.resolvesPaymentId === undefined
          ? {}
          : { resolves_payment_id: args.resolvesPaymentId }),
      },
    })
    .select("id, amount_minor")
    .single();
  if (error) throw error;

  // Read back rather than trust the insert's own RETURNING. RETURNING is
  // evaluated before AFTER triggers run, so `matched_statement_id` in the
  // inserted row is null no matter what the trigger went on to do with it.
  const { data: applied, error: readError } = await supabase
    .from("payments")
    .select("matched_statement_id")
    .eq("id", inserted.id)
    .single();
  if (readError) throw readError;

  const recorded: RecordedPayment = {
    id: inserted.id,
    amountMinor: inserted.amount_minor,
    matchedStatementId: applied.matched_statement_id,
  };

  // Point the original at the statement its money turned out to belong to.
  // The trigger credits only on INSERT, so the money had to come in as the new
  // row above; this update moves no money and exists so the payment stops
  // appearing as unreconciled work for ever. The cost is that one arrival is
  // now two rows, and summing `payments` by `matched_statement_id` would
  // double count it -- `billing_statements.paid_minor` is the credited total.
  if (args.resolvesPaymentId !== undefined && recorded.matchedStatementId !== null) {
    const { error: linkError } = await supabase
      .from("payments")
      .update({ matched_statement_id: recorded.matchedStatementId })
      .eq("id", args.resolvesPaymentId)
      .eq("org_id", args.orgId);
    if (linkError) throw linkError;
  }

  return recorded;
}

/**
 * Stop asking somebody for a week. Not a payment, and never counted as one.
 *
 * `paid_at` is set back to null explicitly because `billing_statements_paid_ck`
 * asserts `(status = 'paid') = (paid_at is not null)`: a statement that was
 * paid and is now waived keeps a stamp the constraint refuses.
 *
 * `paid_minor` is deliberately untouched. Waiving says nobody is being asked
 * for the money, not that the money arrived.
 */
export async function waiveStatement(args: {
  orgId: number;
  statementId: number;
  waivedBy: string;
}): Promise<void> {
  const { data, error } = await supabase
    .from("billing_statements")
    .update({ status: "waived", paid_at: null, marked_paid_by: args.waivedBy })
    .eq("id", args.statementId)
    .eq("org_id", args.orgId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  // RLS refuses an UPDATE by matching no rows rather than by raising, so a
  // demoted admin gets a silent success. Say what happened instead.
  if (!data) {
    throw new Error("That week was not waived. You may no longer be an admin of this office.");
  }
}
