import { useCallback, useEffect, useState } from "react";
import { Action, Badge, Button, EmptyState, Skeleton, useAction } from "@/ui";
import type { ScreenProps } from "./screenProps.js";
import { fetchBugReports, humanError, setBugReportResolved, type BugReport } from "../api.js";

/**
 * Every bug report sent from this office, for its owner.
 *
 * Shown to an owner whether or not their Telegram is connected. Telegram is
 * where a report arrives; this is where it is kept, and where it is marked
 * resolved, which a chat message cannot be.
 */
export function BugReportsScreen({ me, org }: ScreenProps) {
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReports(await fetchBugReports({ orgId: org.id, meProfileId: me.profileId }));
      setLoadError(null);
    } catch (e) {
      setLoadError(humanError(e));
    }
  }, [org.id, me.profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const heading = (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">Bug reports</h1>
      <p className="max-w-prose text-sm text-muted">
        {`What people in ${org.name} reported from the app, newest first. Each one also reaches your Telegram once you connect it in Settings.`}
      </p>
    </header>
  );

  let body;
  if (loadError !== null) {
    body = (
      <EmptyState
        heading="Bug reports did not load"
        action={
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {loadError}
      </EmptyState>
    );
  } else if (reports === null) {
    body = <BugReportsSkeleton />;
  } else if (reports.length === 0) {
    body = (
      <EmptyState heading="Nothing reported yet">
        When somebody chooses Report a bug from their account menu, it appears here.
      </EmptyState>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-4">
        {reports.map((r) => (
          <li key={r.id}>
            <ReportCard
              report={r}
              timeZone={org.timezone}
              onChanged={(resolvedAt) =>
                setReports((all) =>
                  (all ?? []).map((x) => (x.id === r.id ? { ...x, resolvedAt } : x)),
                )
              }
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {heading}
      {body}
    </div>
  );
}

function ReportCard({
  report,
  timeZone,
  onChanged,
}: {
  report: BugReport;
  timeZone: string;
  onChanged: (resolvedAt: string | null) => void;
}) {
  const resolved = report.resolvedAt !== null;
  const toggle = useAction(setBugReportResolved, {
    success: (r) => (r.resolvedAt === null ? "Reopened" : "Resolved"),
    onSuccess: (r) => onChanged(r.resolvedAt),
  });

  const context: Array<[string, string | null]> = [
    ["Page", report.route],
    ["Version", report.appVersion],
    ["Browser", report.userAgent],
    ["Screen", report.viewport],
  ];

  return (
    <article
      aria-label={`Report #${report.id}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 md:p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{report.reporterName}</p>
        <p className="text-sm text-muted">{sentLabel(report.createdAt, timeZone)}</p>
        {resolved && <Badge variant="success">Resolved</Badge>}
      </div>

      <p className={`whitespace-pre-wrap break-words ${resolved ? "text-muted" : "text-text"}`}>
        {report.description}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {context.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-subtle">{label}</dt>
            <dd className="min-w-0 break-all text-muted">{value ?? "Not recorded"}</dd>
          </div>
        ))}
      </dl>

      <div>
        <Action
          reason={null}
          variant="outline"
          pending={toggle.pending}
          onClick={() => void toggle.run({ id: report.id, resolved: !resolved })}
        >
          {resolved ? "Reopen" : "Resolve"}
        </Action>
      </div>
    </article>
  );
}

/** An instant, in the office's zone: "28 Sept 2026, 09:30". */
export function sentLabel(iso: string, timeZone: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(at));
}

function BugReportsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-surface-raised p-4 md:p-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-3 h-4 w-full max-w-prose" />
          <Skeleton className="mt-2 h-4 w-2/3" />
          <Skeleton className="mt-4 h-11 w-28" />
        </div>
      ))}
    </div>
  );
}
