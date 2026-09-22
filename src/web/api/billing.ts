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
