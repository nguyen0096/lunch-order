/**
 * Bug reports: anybody signed in sends one, an owner of the office reads them.
 *
 * Both halves are plain table access under RLS. Whether a report also reached
 * the owner's Telegram is decided by a trigger in the database, which the
 * reporter cannot see and does not need to.
 */

import { supabase } from "../supabase.js";
import { fetchOrgMembers } from "./people.js";

/** The database's own cap, mirrored so a person hears it before a round trip. */
export const BUG_REPORT_MAX = 2000;

/** What the browser can say about itself, attached to every report. */
export type BugReportContext = {
  route: string;
  appVersion: string;
  userAgent: string;
  viewport: string;
};

/**
 * Read at the moment of sending rather than when the dialog opened, so the
 * route is the page the report is about even if the dialog sat open a while.
 * Each field is cut to the column's limit: none of them is typed by the
 * reporter, and a refusal over a user agent string would lose the report.
 */
export function bugReportContext(
  win: Pick<Window, "location" | "navigator" | "innerWidth" | "innerHeight"> = window,
): BugReportContext {
  return {
    route: (win.location.hash || "#/").slice(0, 500),
    appVersion: __APP_VERSION__.slice(0, 100),
    userAgent: win.navigator.userAgent.slice(0, 500),
    viewport: `${win.innerWidth}x${win.innerHeight}`.slice(0, 40),
  };
}

export function bugReportProblem(description: string): string | null {
  const text = description.trim();
  if (text === "") return "Say what went wrong first";
  if (text.length > BUG_REPORT_MAX) {
    return `A report can be ${BUG_REPORT_MAX} characters at most, and this one is ${text.length}`;
  }
  return null;
}

/**
 * No `.select()` after the insert, deliberately: the reporter may write a
 * report and may not read one, their own included, so asking for the row back
 * would turn a successful insert into a permission error.
 */
export async function sendBugReport(args: {
  orgId: number;
  description: string;
  context: BugReportContext;
}): Promise<void> {
  const { error } = await supabase.from("bug_reports").insert({
    org_id: args.orgId,
    description: args.description.trim(),
    route: args.context.route,
    app_version: args.context.appVersion,
    user_agent: args.context.userAgent,
    viewport: args.context.viewport,
  });
  if (error) throw error;
}

export type BugReport = {
  id: number;
  reporterName: string;
  description: string;
  route: string | null;
  appVersion: string | null;
  userAgent: string | null;
  viewport: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

type BugReportRow = {
  id: number;
  reporter_id: string;
  description: string;
  route: string | null;
  app_version: string | null;
  user_agent: string | null;
  viewport: string | null;
  created_at: string;
  resolved_at: string | null;
};

/** Newest first. An empty list for anybody who is not an owner, by RLS. */
export async function fetchBugReports(args: {
  orgId: number;
  meProfileId: string;
}): Promise<BugReport[]> {
  const [reports, members] = await Promise.all([
    supabase
      .from("bug_reports")
      .select(
        "id, reporter_id, description, route, app_version, user_agent, viewport, created_at, resolved_at",
      )
      .eq("org_id", args.orgId)
      .order("created_at", { ascending: false })
      .limit(200),
    fetchOrgMembers(args),
  ]);
  if (reports.error) throw reports.error;

  const nameOf = new Map(members.map((m) => [m.profileId, m.name]));
  return ((reports.data ?? []) as BugReportRow[]).map((r) => ({
    id: r.id,
    reporterName: nameOf.get(r.reporter_id) ?? "Somebody who has left",
    description: r.description,
    route: r.route,
    appVersion: r.app_version,
    userAgent: r.user_agent,
    viewport: r.viewport,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

/** Resolving and reopening are one column, so they are one call. */
export async function setBugReportResolved(args: {
  id: number;
  resolved: boolean;
}): Promise<{ resolvedAt: string | null }> {
  const { data, error } = await supabase
    .from("bug_reports")
    .update({ resolved_at: args.resolved ? new Date().toISOString() : null })
    .eq("id", args.id)
    .select("resolved_at")
    .maybeSingle();
  if (error) throw error;
  // RLS declines an update by matching no rows rather than by raising.
  if (!data) throw new Error("That did not save. Only an owner of this office can resolve a report.");
  return { resolvedAt: (data as { resolved_at: string | null }).resolved_at };
}
