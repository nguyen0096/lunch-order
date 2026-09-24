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
import { dishKey } from "../../shared/settlement.js";

export type BillStatementStatus = "unpaid" | "partial" | "paid" | "waived";
export type BillPeriodStatus = "open" | "computing" | "closed" | "void";

export type BillStatement = {
  id: number;
  mealCount: number;
  mealsMinor: number;
  /**
   * Always 0 since `money_belongs_to_a_person`. Kept on the type because
   * `total_due_minor` is generated from it and still selected; nothing should
   * read it. What an earlier week left unpaid lives on the account.
   */
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

/**
 * What this person owes the office, or the office owes them.
 *
 * The weeks below are a history of charges; this is the one number that
 * settles up. Negative means they are in credit -- a top-up, or an
 * overpayment that used to be silently destroyed.
 */
export type Account = {
  chargedMinor: number;
  creditedMinor: number;
  /** Positive is a debt, negative is credit. */
  balanceMinor: number;
};

export type Bill = {
  /** Newest week first. */
  weeks: BillWeek[];
  account: Account;
  payment: PaymentConfig;
};

/** What is still to pay across every week. Zero when in credit. */
export function owedMinor(a: Account): number {
  return Math.max(a.balanceMinor, 0);
}

/** Money in hand, if any. Zero when something is still owed. */
export function creditMinor(a: Account): number {
  return Math.max(-a.balanceMinor, 0);
}

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

  const [periodsRes, statementsRes, orgRes, accountRes] = await Promise.all([
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
    supabase
      .from("v_account_balance")
      .select("charged_minor, credited_minor, balance_minor")
      .eq("org_id", args.orgId)
      .eq("profile_id", args.profileId)
      .maybeSingle(),
  ]);

  if (periodsRes.error) throw periodsRes.error;
  if (statementsRes.error) throw statementsRes.error;
  if (orgRes.error) throw orgRes.error;
  if (accountRes.error) throw accountRes.error;

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
    // A person with no membership row here cannot happen, but a zeroed
    // account is the right answer for "nothing charged, nothing paid"
    // whatever the reason.
    // Coerced, not trusted. These are `sum(bigint)`, which Postgres types as
    // `numeric`, and PostgREST sends numeric as a JSON string to keep the
    // precision. Left alone, `charged - credited` would concatenate.
    account: {
      chargedMinor: Number(accountRes.data?.charged_minor ?? 0),
      creditedMinor: Number(accountRes.data?.credited_minor ?? 0),
      balanceMinor: Number(accountRes.data?.balance_minor ?? 0),
    },
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

/**
 * One member and where their account stands, which is what an admin chases.
 *
 * A week says what was eaten. Only the account says whether anybody is behind,
 * because a person's weeks no longer carry each other: three unpaid weeks are
 * three statements and one balance.
 */
export type PaymentsPerson = {
  profileId: string;
  name: string;
  /** The short code. It is what a bank memo usually carries. */
  shortCode: string;
  /** `LUNCH` + the short code, with no week in it, so a saved transfer keeps working. */
  paymentRef: string;
  /** Somebody deactivated still appears: leaving does not settle what is owed. */
  active: boolean;
  account: Account;
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
  /** Everybody in the office, by name, with their account. */
  people: PaymentsPerson[];
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

type MembershipRow = {
  profile_id: string;
  short_code: string;
  display_name: string | null;
  payment_ref: string;
  status: string;
  profiles: unknown;
};

type AccountRow = {
  profile_id: string;
  charged_minor: number | null;
  credited_minor: number | null;
  balance_minor: number | null;
};

type StrayRow = {
  id: number;
  amount_minor: number;
  memo: string | null;
  received_at: string;
  provider: string;
};

/**
 * Everything the payments screen needs that is not tied to one week.
 *
 * Periods bound the query rather than time does: the screen shows a dozen
 * weeks, so the statements are fetched for exactly those periods. Fetching
 * every statement the org has ever had would grow without limit and answer no
 * question the screen asks. Accounts are not bounded that way, because a debt
 * older than the weeks on screen is still a debt and the person carrying it
 * has to be reachable.
 */
export async function fetchPayments(args: {
  orgId: number;
  /** How many weeks back the period picker reaches. */
  limit?: number;
}): Promise<PaymentsData> {
  const limit = args.limit ?? 12;

  const [periodsRes, membersRes, accountsRes, strayRes] = await Promise.all([
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
      .select("profile_id, short_code, display_name, payment_ref, status, profiles ( full_name )")
      .eq("org_id", args.orgId),
    supabase
      .from("v_account_balance")
      .select("profile_id, charged_minor, credited_minor, balance_minor")
      .eq("org_id", args.orgId),
    supabase
      .from("payments")
      .select("id, amount_minor, memo, received_at, provider")
      .eq("org_id", args.orgId)
      // Whose money it is, not which week it hit. A top-up lands on a person
      // and touches no statement, so `matched_statement_id` is null on money
      // that found its owner perfectly well, and asking that column would put
      // every top-up back at the top of the screen as a failure.
      .is("profile_id", null)
      .order("received_at", { ascending: false })
      .limit(50),
  ]);

  if (periodsRes.error) throw periodsRes.error;
  if (membersRes.error) throw membersRes.error;
  if (accountsRes.error) throw accountsRes.error;
  if (strayRes.error) throw strayRes.error;

  const periods: PaymentsPeriod[] = ((periodsRes.data ?? []) as AdminPeriodRow[]).map((p) => ({
    periodId: p.id,
    periodStart: p.period_start,
    periodEnd: p.period_end,
    periodStatus: p.status as BillPeriodStatus,
    lineCount: p.line_count,
    totalMinor: p.total_minor,
  }));

  const accountOf = new Map<string, Account>();
  for (const a of (accountsRes.data ?? []) as AccountRow[]) {
    accountOf.set(a.profile_id, toAccount(a));
  }

  const nameOf = new Map<string, string>();
  const codeOf = new Map<string, string>();
  const people: PaymentsPerson[] = ((membersRes.data ?? []) as MembershipRow[])
    .map((m) => {
      const prof = m.profiles as { full_name: string } | null;
      const name = m.display_name ?? prof?.full_name ?? m.short_code;
      nameOf.set(m.profile_id, name);
      codeOf.set(m.profile_id, m.short_code);
      return {
        profileId: m.profile_id,
        name,
        shortCode: m.short_code,
        paymentRef: m.payment_ref,
        active: m.status === "active",
        account: accountOf.get(m.profile_id) ?? ZERO_ACCOUNT,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));

  const strays = (strayRes.data ?? []) as StrayRow[];
  const resolved = await resolvedStrayIds(args.orgId, strays);

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
    people,
    unmatched: strays
      .filter((p) => !resolved.has(p.id))
      .map((p) => ({
        id: p.id,
        amountMinor: p.amount_minor,
        memo: p.memo,
        receivedAt: p.received_at,
        provider: p.provider,
      })),
  };
}

const ZERO_ACCOUNT: Account = { chargedMinor: 0, creditedMinor: 0, balanceMinor: 0 };

/**
 * `sum()` over a bigint column comes back as numeric, which PostgREST is
 * entitled to send as a string, and a string would concatenate downstream.
 */
function toAccount(row: AccountRow): Account {
  return {
    chargedMinor: Number(row.charged_minor ?? 0),
    creditedMinor: Number(row.credited_minor ?? 0),
    balanceMinor: Number(row.balance_minor ?? 0),
  };
}

/**
 * Strays an admin has already dealt with.
 *
 * A stray keeps its null `profile_id` for good once it has been applied: the
 * money went in as a second row carrying the person's reference, and naming an
 * owner on this one as well would count a single arrival twice on that
 * person's account. The row that took the money names this one in `raw`, and
 * that pointer is what retires it here.
 */
async function resolvedStrayIds(orgId: number, strays: StrayRow[]): Promise<Set<number>> {
  // Ordered newest first, so the last one bounds the search. An applied row
  // copies the arrival it stands in for, so no resolver is older than that.
  const oldest = strays.at(-1)?.received_at;
  if (oldest === undefined) return new Set();

  const { data, error } = await supabase
    .from("payments")
    .select("raw")
    .eq("org_id", orgId)
    .eq("provider", MANUAL_PROVIDER)
    .gte("received_at", oldest);
  if (error) throw error;

  const ids = new Set<number>();
  for (const row of data ?? []) {
    const raw = row.raw as { resolves_payment_id?: number } | null;
    if (typeof raw?.resolves_payment_id === "number") ids.add(raw.resolves_payment_id);
  }
  return ids;
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
   * Whose the database decided it was, read back rather than assumed. The memo
   * overrules the `profile_id` the insert named, so a memo carrying somebody
   * else's reference moves the money to them, silently -- it is the normal
   * webhook case -- and this is how the screen finds out.
   */
  profileId: string | null;
  /**
   * How far the money got: the newest week it reached. Null means it touched
   * no week at all, which is no longer a failure -- a top-up is exactly that.
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
 * Record money that arrived. The one write that moves an account.
 *
 * Every credit goes in as a row here rather than as an UPDATE to
 * `billing_statements`, so `payments_apply_on_insert` does the arithmetic and
 * decides the status whether the money came from the bank webhook or from an
 * admin who was handed cash. One path, one audit trail, one set of rules --
 * and since `money_belongs_to_a_person` that trigger is also the only thing
 * that redraws the allocation across somebody's weeks, which is why applying a
 * stray payment still records a new row rather than renaming the old one.
 *
 * A top-up is this same write against somebody who owes nothing. Nothing
 * special happens: the money sits on their account as credit and next week's
 * meals eat into it.
 *
 * IRREVERSIBLE, and the interface has to say so. The trigger is AFTER INSERT
 * only: nothing takes a credit back on update or delete, and
 * `amount_minor > 0` blocks a corrective negative row. A payment recorded in
 * error can only be fixed in the database by hand.
 */
export async function recordPayment(args: {
  orgId: number;
  /**
   * Whose money it is, named on the row rather than left to the memo alone.
   * The trigger overwrites it from the memo when the memo carries a
   * reference; this is what the money falls back to when it does not.
   */
  profileId: string;
  amountMinor: number;
  /**
   * The bank memo. The trigger folds it to A-Z0-9 and looks for the person
   * whose `payment_ref` appears inside it, so a person's reference is enough
   * -- and it is also what makes the trigger reallocate their weeks.
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
      profile_id: args.profileId,
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
  // evaluated before AFTER triggers run, so both columns below are whatever
  // the insert sent, no matter what the trigger went on to do with them.
  const { data: applied, error: readError } = await supabase
    .from("payments")
    .select("profile_id, matched_statement_id")
    .eq("id", inserted.id)
    .single();
  if (readError) throw readError;

  const recorded: RecordedPayment = {
    id: inserted.id,
    amountMinor: inserted.amount_minor,
    profileId: applied.profile_id,
    matchedStatementId: applied.matched_statement_id,
  };

  // Point the original at how far its money got. It moves
  // no money: the trigger credits only on INSERT, so the money had to come in
  // as the new row above, and this one is left with no `profile_id` for ever
  // so that a single arrival is counted once on the account. What takes it off
  // the unmatched list is the `resolves_payment_id` the new row carries; this
  // is the annotation that makes the pair legible in the database.
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

/* ========================================================================= */
/* Settling the week: the caterer's prices, applied                          */
/* ========================================================================= */

/**
 * The caterer prices at the weekend, so a week is lived through unpriced and
 * settled afterwards. Everything below is the admin's side of that: what the
 * board recorded, writing the prices the caterer finally gave, and asking the
 * database to bill the week.
 */

/** One dish across a whole week's menus, with what the board recorded for it. */
export type SettlementDish = {
  /** Folded the way the database folds it, so two spellings are one dish. */
  key: string;
  /** The board's spelling, from the first menu the dish appears on. */
  name: string;
  /** Portions the board recorded: the sum of the quantities on placed orders. */
  ourCount: number;
  /**
   * Portions of those still carrying no price, and so held off the bill. These
   * are the meals a late price reaches and the only ones it moves money onto.
   */
  waitingCount: number;
  /**
   * What this dish already bills, from the snapshots on the orders themselves
   * rather than from the menu. A price that arrived before the orders did is
   * on those rows already, and it is not going to change.
   */
  pricedTotalMinor: number;
  /** Every `menu_items` row in the week carrying this name. */
  menuItemIds: number[];
  /**
   * The rows a late price can be written to: the ones still holding NULL.
   *
   * `enforce_menu_item_frozen` exempts exactly one change on a locked menu --
   * `price_minor` going from NULL to a value, with the name, menu, position
   * and availability untouched -- which is why this is the id list the apply
   * is built from. A dish that already carries a price cannot be re-priced
   * there, so those rows are not in here and must be reported rather than
   * attempted. A cancelled menu is not exempted at all.
   */
  unpricedMenuItemIds: number[];
  /** Distinct prices already on the board for this dish, in board order. */
  existingPricesMinor: number[];
  /** Service dates this dish was on a menu for. */
  days: string[];
  /** Days whose menu is cancelled, which takes no price at all. */
  cancelledDays: string[];
  /** True when at least one menu row for this dish is still waiting on a price. */
  unpriced: boolean;
};

export type SettlementWeek = {
  periodId: number;
  periodStart: string;
  /** Inclusive. */
  periodEnd: string;
  /** Board order: first the day a dish appears, then its position on that menu. */
  dishes: SettlementDish[];
  /**
   * Placed orders in the week whose dish has no price. This is the number that
   * holds the week open: `hold_period_open_while_unpriced` refuses to close a
   * period while any of them exists, and `run_billing` leaves them off the bill
   * rather than charging them at zero.
   */
  unpricedOrders: number;
  /** Placed orders with no dish chosen at all. They bill at nothing regardless. */
  ordersWithoutDish: number;
};

type MenuRow = { id: number; service_date: string; status: string };
type MenuItemRow = { id: number; menu_id: number; name: string; price_minor: number | null; position: number };
type OrderRow = { id: number; menu_id: number; service_date: string };
type OrderItemRow = { order_id: number; menu_item_id: number; quantity: number; unit_price_minor: number | null };

/**
 * What the office actually ate in one week, dish by dish.
 *
 * Four flat queries rather than one embedded select. `order_items` reaches
 * `orders` through a four-column composite foreign key, and asking PostgREST
 * to embed across one is how this stopped working the last time; a week is at
 * most a few hundred rows either way.
 */
export async function fetchSettlementWeek(args: {
  orgId: number;
  periodId: number;
  periodStart: string;
  /** Inclusive. */
  periodEnd: string;
}): Promise<SettlementWeek> {
  const [menusRes, ordersRes] = await Promise.all([
    supabase
      .from("menus")
      .select("id, service_date, status")
      .eq("org_id", args.orgId)
      .gte("service_date", args.periodStart)
      .lte("service_date", args.periodEnd)
      .order("service_date", { ascending: true }),
    supabase
      .from("orders")
      .select("id, menu_id, service_date")
      .eq("org_id", args.orgId)
      .eq("status", "placed")
      .gte("service_date", args.periodStart)
      .lte("service_date", args.periodEnd),
  ]);
  if (menusRes.error) throw menusRes.error;
  if (ordersRes.error) throw ordersRes.error;

  const menus = (menusRes.data ?? []) as MenuRow[];
  const orders = (ordersRes.data ?? []) as OrderRow[];

  const [itemsRes, orderItemsRes] = await Promise.all([
    menus.length === 0
      ? Promise.resolve({ data: [] as MenuItemRow[], error: null })
      : supabase
          .from("menu_items")
          .select("id, menu_id, name, price_minor, position")
          .eq("org_id", args.orgId)
          .in("menu_id", menus.map((m) => m.id))
          .order("position", { ascending: true })
          .order("id", { ascending: true }),
    orders.length === 0
      ? Promise.resolve({ data: [] as OrderItemRow[], error: null })
      : supabase
          .from("order_items")
          .select("order_id, menu_item_id, quantity, unit_price_minor")
          .eq("org_id", args.orgId)
          .in("order_id", orders.map((o) => o.id)),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (orderItemsRes.error) throw orderItemsRes.error;

  const menuItems = (itemsRes.data ?? []) as MenuItemRow[];
  const orderItems = (orderItemsRes.data ?? []) as OrderItemRow[];

  const dayOf = new Map(menus.map((m) => [m.id, m.service_date]));
  // A cancelled menu is the one state the late-price exemption does not cover.
  // A day that did not happen has no price to arrive for.
  const cancelled = new Set(menus.filter((m) => m.status === "cancelled").map((m) => m.id));

  // Counted off the order rows rather than the menu, because the snapshot is
  // what bills. A portion whose `unit_price_minor` is null is a meal currently
  // held off the bill, and the rest are money the week already owes.
  const waiting = new Map<number, number>();
  const portions = new Map<number, number>();
  const billed = new Map<number, number>();
  for (const oi of orderItems) {
    portions.set(oi.menu_item_id, (portions.get(oi.menu_item_id) ?? 0) + oi.quantity);
    if (oi.unit_price_minor === null) {
      waiting.set(oi.menu_item_id, (waiting.get(oi.menu_item_id) ?? 0) + oi.quantity);
    } else {
      billed.set(
        oi.menu_item_id,
        (billed.get(oi.menu_item_id) ?? 0) + oi.unit_price_minor * oi.quantity,
      );
    }
  }

  const byKey = new Map<string, SettlementDish>();
  // Sorted by day first so the board's own order decides the display name and
  // the row order, rather than whichever menu PostgREST returned first.
  const ordered = [...menuItems].sort(
    (a, b) =>
      (dayOf.get(a.menu_id) ?? "").localeCompare(dayOf.get(b.menu_id) ?? "") ||
      a.position - b.position ||
      a.id - b.id,
  );
  for (const mi of ordered) {
    const key = dishKey(mi.name);
    const day = dayOf.get(mi.menu_id) ?? "";
    const dish = byKey.get(key) ?? {
      key,
      name: mi.name,
      ourCount: 0,
      waitingCount: 0,
      pricedTotalMinor: 0,
      menuItemIds: [],
      unpricedMenuItemIds: [],
      existingPricesMinor: [],
      days: [],
      cancelledDays: [],
      unpriced: false,
    };
    byKey.set(key, dish);

    dish.menuItemIds.push(mi.id);
    if (!dish.days.includes(day)) dish.days.push(day);
    dish.ourCount += portions.get(mi.id) ?? 0;
    dish.waitingCount += waiting.get(mi.id) ?? 0;
    dish.pricedTotalMinor += billed.get(mi.id) ?? 0;

    if (cancelled.has(mi.menu_id)) {
      if (!dish.cancelledDays.includes(day)) dish.cancelledDays.push(day);
    } else if (mi.price_minor === null) {
      dish.unpricedMenuItemIds.push(mi.id);
    }

    if (mi.price_minor === null) dish.unpriced = true;
    else if (!dish.existingPricesMinor.includes(mi.price_minor)) {
      dish.existingPricesMinor.push(mi.price_minor);
    }
  }

  const itemsByOrder = new Map<number, OrderItemRow[]>();
  for (const oi of orderItems) {
    const list = itemsByOrder.get(oi.order_id) ?? [];
    list.push(oi);
    itemsByOrder.set(oi.order_id, list);
  }

  let unpricedOrders = 0;
  let ordersWithoutDish = 0;
  for (const o of orders) {
    const items = itemsByOrder.get(o.id) ?? [];
    if (items.length === 0) ordersWithoutDish += 1;
    else if (items.some((i) => i.unit_price_minor === null)) unpricedOrders += 1;
  }

  return {
    periodId: args.periodId,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    dishes: [...byKey.values()],
    unpricedOrders,
    ordersWithoutDish,
  };
}

/** One dish's price, and the exact menu rows it is to be written to. */
export type PriceApplication = {
  name: string;
  priceMinor: number;
  /**
   * `SettlementDish.unpricedMenuItemIds`, never `menuItemIds`. The exemption
   * covers a price going from NULL to a value and nothing else, so a row that
   * already carries a price raises on a locked menu -- and because each dish
   * is its own statement, that would leave the dishes before it priced and the
   * rest not.
   */
  menuItemIds: number[];
};

export type AppliedPrices = {
  dishes: number;
  menuItems: number;
  /** Orders the new price was copied onto. This is what moves the money. */
  orderItems: number;
};

/**
 * Write the caterer's prices onto the week, and onto the orders already placed.
 *
 * Every menu of the week being settled is `locked` by then -- the hourly tick
 * locks a menu the moment its cutoff passes -- and that is the ordinary case,
 * not an obstacle. `enforce_menu_item_frozen` exempts exactly one change
 * there: `price_minor` going from NULL to a value with the name, menu,
 * position and availability all unchanged. Both writes below stay inside it.
 *
 * Two writes per dish, and the second is the one that is easy to leave out.
 * `menu_items.price_minor` is only what the dish costs from now on; every
 * `order_items` row snapshotted its price when the dish was chosen, and those
 * snapshots are what billing reads. A week priced without the second write
 * bills exactly nothing.
 *
 * The re-snapshot is `update order_items set menu_item_id = menu_item_id`.
 * `order_items_snapshot` is `BEFORE INSERT OR UPDATE **OF menu_item_id**`, so
 * naming that column in the SET list re-fires it and `snapshot_order_item`
 * copies the new price across. Touching any other column does nothing at all,
 * verified both ways. PostgREST sends a value rather than a column reference,
 * so this runs one id at a time: the value written and the row filtered are
 * then the same number, which is what makes it a no-op to the data.
 *
 * No new grant is needed. `authenticated` holds UPDATE on
 * `menu_items.price_minor` and on `order_items.menu_item_id`, and
 * `menu_items_admin_all` and `order_items_admin_all` cover the rows. The
 * trigger deliberately does not repeat that check: policies answer who, it
 * answers whether the change is a legal one.
 */
export async function applyCatererPrices(args: {
  orgId: number;
  prices: PriceApplication[];
}): Promise<AppliedPrices> {
  let dishes = 0;
  let menuItems = 0;
  let orderItems = 0;

  for (const p of args.prices) {
    if (p.menuItemIds.length === 0) continue;

    const priced = await supabase
      .from("menu_items")
      .update({ price_minor: p.priceMinor })
      .in("id", p.menuItemIds)
      // RLS is a permission, not a filter: an admin of two offices would
      // otherwise be trusting the caller's id list alone.
      .eq("org_id", args.orgId)
      .select("id");
    if (priced.error) throw priced.error;
    menuItems += priced.data?.length ?? 0;
    dishes += 1;

    for (const id of p.menuItemIds) {
      const resnapshot = await supabase
        .from("order_items")
        .update({ menu_item_id: id })
        .eq("menu_item_id", id)
        .eq("org_id", args.orgId)
        .select("id");
      if (resnapshot.error) throw resnapshot.error;
      orderItems += resnapshot.data?.length ?? 0;
    }
  }

  return { dishes, menuItems, orderItems };
}

export type SettledPeriod = {
  /** Billing lines the run wrote: one per placed, priced order. */
  lines: number;
  statements: number;
  /** The week's food total. Not what anybody owes: that carries debt forward. */
  totalMinor: number;
};

/**
 * Bill the week.
 *
 * `settle_period` is the only way a browser can run billing at all:
 * `run_billing` takes a period id and is revoked from every browser role,
 * because it would otherwise let any signed-in person recompute another
 * office's bill. The wrapper checks `private.my_admin_org_ids()` first, so a
 * member is refused here rather than silently reading zero rows.
 *
 * It does not pass `p_force`, so a week that has already closed stays closed
 * and the database says so in a sentence.
 */
export async function settlePeriod(periodId: number): Promise<SettledPeriod> {
  const { data, error } = await supabase.rpc("settle_period", { p_period_id: periodId });
  if (error) throw error;

  // `returns table (...)` reaches PostgREST as an array of rows, and an empty
  // one would mean the run produced nothing to report -- worth a sentence
  // rather than a zero somebody would read as "billed nothing".
  const row = (data as Array<{ lines: number; statements: number; total_minor: number }> | null)?.[0];
  if (!row) throw new Error("The week was not billed. Reload the screen and try again.");

  return {
    lines: row.lines,
    statements: row.statements,
    // bigint: PostgREST sends it as a JSON number here and as a string once it
    // outgrows one, and a string would silently concatenate downstream.
    totalMinor: Number(row.total_minor),
  };
}

/* ------------------------------------------------ what a member is still owed */

/** A meal that has been eaten and cannot be billed yet. */
export type UnpricedMeal = {
  orderId: number;
  serviceDate: string;
  /** The dishes on that order, as they were named on the day. */
  description: string;
};

/**
 * The meals a person will be charged for once the caterer says what they cost.
 *
 * Read from `v_order_charges` rather than rebuilt from orders, deliberately:
 * that view is what `run_billing` itself excludes on, `unpriced` and all, and
 * it resolves a transferred meal to whoever now pays for it. Counting orders
 * directly would tell somebody they are waiting on a price for a lunch they
 * gave away.
 *
 * This is the difference between a bill that is wrong and a bill that is
 * explained. The total on the Bill screen leaves these out, because a meal
 * billed at zero reads as a free meal; the person still has to be told they
 * are coming.
 */
export async function fetchUnpricedMeals(args: {
  orgId: number;
  profileId: string;
  from: string;
  /** Inclusive. */
  to: string;
}): Promise<UnpricedMeal[]> {
  const { data, error } = await supabase
    .from("v_order_charges")
    .select("order_id, service_date, description")
    .eq("org_id", args.orgId)
    .eq("payer_profile_id", args.profileId)
    .eq("order_status", "placed")
    .eq("unpriced", true)
    .gte("service_date", args.from)
    .lte("service_date", args.to)
    .order("service_date", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((r) => ({
    orderId: r.order_id,
    serviceDate: r.service_date,
    description: r.description ?? "",
  }));
}
