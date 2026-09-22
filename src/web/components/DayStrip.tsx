/**
 * The next fortnight at a glance, so setting menus ahead is a visible workflow
 * rather than something you discover by typing dates into a field.
 *
 * The date input was always unconstrained -- future days worked -- but nothing
 * showed which days already had a menu, so the admin had to guess.
 */
export type DayStatus = { status: string; dishes: number };

const LABEL: Record<string, string> = {
  published: "live",
  draft: "draft",
  locked: "closed",
  cancelled: "off",
};

export function DayStrip({ days, statuses, selected, today, onSelect }: {
  days: string[];
  statuses: Map<string, DayStatus>;
  selected: string;
  today: string;
  onSelect: (d: string) => void;
}) {
  return (
    <ol className="day-strip">
      {days.map((d) => {
        const s = statuses.get(d);
        const classes = [
          "day-chip",
          d === selected ? "is-selected" : "",
          d === today ? "is-today" : "",
          d < today ? "is-past" : "",
          s ? `is-${s.status}` : "is-none",
        ].filter(Boolean).join(" ");
        return (
          <li key={d}>
            {/* Past days stay clickable: an admin may need to look at, or
                correct, what was served. What they cannot do is create a new
                menu there, which the editor states and the database enforces. */}
            <button className={classes} aria-pressed={d === selected}
                    title={d < today && !s ? "Already passed" : undefined}
                    onClick={() => onSelect(d)}>
              <span className="dow">{dow(d)}</span>
              <span className="dom">{Number(d.slice(8))}</span>
              <span className="state">
                {s ? `${LABEL[s.status] ?? s.status} · ${s.dishes}` : "—"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function dow(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "narrow", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00Z`));
}
