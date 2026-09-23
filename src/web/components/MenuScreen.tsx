import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Action, Badge, Button, EmptyState, Skeleton, cn, useAction } from "@/ui";
import {
  assistParse,
  fetchMenuCalendar,
  fetchMenuEditor,
  fetchPublishImpact,
  humanError,
  publishMenu,
  type EditableMenu,
  type PublishImpact,
} from "../api.js";
import {
  DishRows,
  blankRow,
  duplicateName,
  nameKey,
  rowFromAssist,
  rowFromLine,
  rowFromMenu,
  rowFromParsed,
  toDrafts,
  type DishRow,
} from "./menu/DishRows.js";
import { PublishDialog } from "./menu/PublishDialog.js";
import { StatusActions } from "./menu/StatusActions.js";
import { CutoffFields } from "./menu/CutoffFields.js";
import {
  cutoffInstant,
  cutoffProblem,
  defaultCutoff,
  localCutoff,
  type LocalCutoff,
} from "./menu/cutoff.js";
import {
  cutoffLabel,
  dishes as dishCount,
  frozenNotice,
  longDay,
  people,
  peopleHave,
  readOnlyReason,
  shortDay,
  statusWord,
} from "./menu/labels.js";
import type { ScreenProps } from "./screenProps.js";
import { parseMenu, type ParsedMenu } from "../../shared/menuParser.js";
import { publishDisabledReason } from "../../shared/gating.js";
import { addDays, isoWeekday, todayIn } from "../../shared/dates.js";
import { now as appNow } from "../../shared/clock.js";
import type { MenuStatus } from "../../shared/types.js";

/** How far ahead the day strip looks. Two working weeks is as far as a caterer plans. */
const STRIP_DAYS = 12;

/**
 * How far back the strip reaches.
 *
 * An office that starts on Wednesday wants Monday and Tuesday, and the only way
 * in was the date field, which is a worse way to pick a day than a row of days.
 * A week covers that; anything older is still reachable by typing the date.
 */
const STRIP_DAYS_BACK = 7;

/**
 * Turn the caterer's chat message into a published menu without retyping it.
 *
 * The shape of the screen is the shape of the job: the message on one side, the
 * list you are checking on the other. Two parse paths land in the same editable
 * rows -- the offline regex parser, which is free and instant, and the model,
 * which is neither but reads a message the regex cannot. Neither writes
 * anything. A price reaches a bill only because a person looked at it and
 * pressed Publish.
 *
 * Publishing is the highest-consequence action in the app: the materialize
 * trigger turns it into real orders for everybody with a standing day on that
 * weekday, and those people are then told lunch is on. So it is the one thing
 * here that confirms first, and the confirmation names the number.
 */
export function MenuScreen({ me, org }: ScreenProps) {
  const today = todayIn(org.timezone, appNow());

  const [serviceDate, setServiceDate] = useState(() => nextServiceDay(today));

  // The evening before at the org's own time, until either the day's stored
  // menu says otherwise or the admin does. `pinned` records the admin's hand:
  // without it, picking another service date would silently keep a cutoff that
  // belongs to the day they just left.
  const defaultCutoffTime = org.defaultCutoffLocalTime.slice(0, 5);
  const [cutoff, setCutoff] = useState<LocalCutoff & { pinned: boolean }>(() => ({
    ...defaultCutoff({
      serviceDate: nextServiceDay(today),
      defaultTime: defaultCutoffTime,
      timeZone: org.timezone,
      now: appNow(),
    }),
    pinned: false,
  }));

  const [menu, setMenu] = useState<EditableMenu | null>(null);
  const [impact, setImpact] = useState<PublishImpact | null>(null);
  const [calendar, setCalendar] = useState<Map<string, { status: string; dishes: number }>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [rows, setRows] = useState<DishRow[]>([]);
  const [parsed, setParsed] = useState<ParsedMenu | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [readBy, setReadBy] = useState<"manual" | "offline" | "ai">("manual");
  const [model, setModel] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // What the last load put in the textarea. Changing the date reloads that
  // day's dishes, but it must not swallow a message somebody has just pasted:
  // that is the one thing here a click cannot recreate.
  const loadedText = useRef("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [editable, cal] = await Promise.all([
        fetchMenuEditor(org.id, serviceDate),
        fetchMenuCalendar({
          orgId: org.id,
          from: addDays(today, -STRIP_DAYS_BACK),
          to: addDays(today, STRIP_DAYS),
        }),
      ]);
      const next = await fetchPublishImpact({
        orgId: org.id,
        serviceDate,
        menuId: editable?.id ?? null,
      });

      const incoming = editable?.sourceText ?? "";
      setText((current) => (current === loadedText.current ? incoming : current));
      loadedText.current = incoming;

      // The menu's STORED cutoff, never a default derived a second time:
      // re-deriving it would move, on the next republish, a cutoff nobody
      // touched. A day with no menu falls back to the evening before, which is
      // also what drops a pin left over from a day the admin did set by hand.
      setCutoff((c) => {
        if (editable !== null) {
          return { ...localCutoff(editable.orderCutoffAt, org.timezone), pinned: false };
        }
        if (c.pinned) return c;
        const next = defaultCutoff({
          serviceDate,
          defaultTime: defaultCutoffTime,
          timeZone: org.timezone,
          now: appNow(),
        });
        return c.date === next.date && c.time === next.time ? c : { ...next, pinned: false };
      });

      setMenu(editable);
      setCalendar(cal);
      setImpact(next);
      setRows((editable?.items ?? []).map((i) => rowFromMenu(i, org.currency)));
      setParsed(null);
      setNotes([]);
      setLoadError(null);
    } catch (e) {
      // A read has no toast to fire and nothing to revert, so its failure is a
      // state the screen renders. `useAction` covers every write instead.
      setLoadError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [org.id, org.currency, org.timezone, serviceDate, today]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Take the status the database just accepted, then reload.
   *
   * Not optimism: the write has already succeeded, and this is the only thing
   * standing between it and a badge that goes on saying "Published" over a
   * draft for as long as the reload takes. The day strip says the same word
   * about the same day, so it moves too. `applied` is null when the write was
   * refused, which still reloads: a refusal here usually means the day is no
   * longer what this screen thinks it is.
   */
  const statusSettled = useCallback(
    (applied: MenuStatus | null) => {
      if (applied !== null) {
        setMenu((m) => (m === null ? m : { ...m, status: applied }));
        setCalendar((c) => {
          const entry = c.get(serviceDate);
          if (entry === undefined) return c;
          return new Map(c).set(serviceDate, { ...entry, status: applied });
        });
      }
      void load();
    },
    [load, serviceDate],
  );

  // Moves with the service date at once, rather than waiting for that day's
  // load to land, so the sentence under Publish is never briefly about the day
  // that was on screen a moment ago.
  useEffect(() => {
    setCutoff((c) => {
      if (c.pinned) return c;
      const next = defaultCutoff({
        serviceDate,
        defaultTime: defaultCutoffTime,
        timeZone: org.timezone,
        now: appNow(),
      });
      return c.date === next.date && c.time === next.time ? c : { ...next, pinned: false };
    });
  }, [serviceDate, defaultCutoffTime, org.timezone]);

  const status: MenuStatus | null = menu?.status ?? null;
  const frozen = readOnlyReason(status);
  const frozenSentence = status === null ? null : frozenNotice(status);

  const cutoffAt = useMemo(
    () => cutoffInstant(cutoff, org.timezone),
    [cutoff, org.timezone],
  );

  const cutoffIssue = cutoffProblem({
    cutoff,
    serviceDate,
    storedAt: menu?.orderCutoffAt ?? null,
    timeZone: org.timezone,
    now: appNow(),
  });

  /* ------------------------------------------------------------- mutations */

  const publish = useAction(
    async () =>
      publishMenu({
        orgId: org.id,
        profileId: me.profileId,
        serviceDate,
        cutoffAt,
        dishes: toDrafts(rows),
        sourceText: text,
        // The evidence trail `parse_meta` exists for: which reader produced
        // this list, and how much of the message it could not place.
        parseMeta: {
          readBy,
          model,
          dishes: rows.length,
          unreadLines: parsed?.unparsed.length ?? 0,
          publishedFrom: "web",
        },
      }),
    {
      success: (r) =>
        r.standingOrders > 0 ? `Published · ordered for ${people(r.standingOrders)}` : "Published",
      onSuccess: () => {
        setConfirming(false);
        void load();
      },
    },
  );

  const readWithAi = useAction(async () => assistParse({ orgId: org.id, text, today }), {
    success: (r) =>
      r.items.length === 0
        ? "Read nothing that looks like a dish"
        : `Read ${dishCount(r.items.length)}`,
    onSuccess: (r) => {
      setRows((previous) =>
        adoptIds(r.items.map((i) => rowFromAssist(i, org.currency)), previous),
      );
      setParsed(null);
      setNotes(r.notes);
      setReadBy("ai");
      setModel(r.model);
    },
  });

  /* -------------------------------------------------------------- handlers */

  // Parsing writes nothing and touches no network, so it is not a mutation and
  // carries no toast: the table filling in front of you is the report.
  const runParse = useCallback(() => {
    const result = parseMenu(text, { today });
    setParsed(result);
    setNotes(result.notes);
    setRows((previous) =>
      adoptIds(result.items.map((i) => rowFromParsed(i, org.currency)), previous),
    );
    setReadBy("offline");
    setModel(null);
  }, [text, today, org.currency]);

  const patchRow = useCallback((key: string, patch: Partial<DishRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }, []);

  const takeLine = useCallback((line: number, raw: string) => {
    setRows((rs) => [...rs, rowFromLine(raw)]);
    setParsed((p) =>
      p === null ? p : { ...p, unparsed: p.unparsed.filter((u) => u.line !== line) },
    );
  }, []);

  const takeAllLines = useCallback(() => {
    setParsed((p) => {
      if (p === null) return p;
      setRows((rs) => [...rs, ...p.unparsed.map((u) => rowFromLine(u.raw))]);
      return { ...p, unparsed: [] };
    });
  }, []);

  /* ------------------------------------------------------------- rendering */

  const strip = useMemo(() => {
    const out: string[] = [];
    for (let i = -STRIP_DAYS_BACK; i < STRIP_DAYS; i += 1) {
      const day = addDays(today, i);
      // Weekends only when lunch actually happens on them, the same rule the
      // board uses: an always-empty Sunday is width spent on nothing.
      //
      // Past weekdays are offered whether or not anything is recorded on them.
      // Showing only the ones that already have a menu is circular: the reason
      // to reach a past day is that nothing is on it yet.
      if (isoWeekday(day) <= 5 || calendar.has(day)) out.push(day);
    }
    if (!out.includes(serviceDate)) out.unshift(serviceDate);
    return out;
  }, [today, calendar, serviceDate]);

  const drafts = toDrafts(rows);
  const duplicate = duplicateName(rows);
  const publishReason =
    frozen ??
    publishDisabledReason(drafts, serviceDate) ??
    (duplicate === null ? null : `Two rows are called "${duplicate}". Rename one`) ??
    cutoffIssue;

  const parseReason = frozen ?? (text.trim() === "" ? "Paste the caterer's message first" : null);

  const header = (
    <header className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Menu</h1>
        <p className="max-w-prose text-muted">
          Paste what the caterer sent, check the list, publish it. Nothing is written until you
          press Publish.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="service-date" className="text-xs font-medium text-subtle">
            Service date
          </label>
          <input
            id="service-date"
            type="date"
            value={serviceDate}
            onChange={(e) => e.target.value !== "" && setServiceDate(e.target.value)}
            className="h-11 rounded-md border border-border bg-surface-raised px-3 text-base"
          />
        </div>
        <p className="pb-3 text-sm text-muted">{longDay(serviceDate)}</p>

        {/* Beside the service date, because when orders close is one of the
            things that describes the day, not a detail of publishing it. */}
        <CutoffFields
          value={cutoff}
          label={cutoffLabel(cutoffAt, org.timezone)}
          problem={cutoffIssue}
          readOnlyReason={frozen}
          onChange={(next) => setCutoff({ ...next, pinned: true })}
        />

        {/* The status and the controls that change it, together: the status is
            already described here beside the date and the cutoff, and an action
            that changes it belongs with the thing it changes. */}
        {status !== null && menu !== null && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge
              variant={
                status === "published"
                  ? "success"
                  : status === "draft"
                    ? "accent"
                    : status === "locked"
                      ? "neutral"
                      : "danger"
              }
            >
              {statusWord(status)}
            </Badge>
            <StatusActions
              status={status}
              menuId={menu.id}
              serviceDate={serviceDate}
              orders={impact?.orders ?? null}
              cutoffAt={menu.orderCutoffAt}
              timeZone={org.timezone}
              onSettled={statusSettled}
            />
          </div>
        )}
      </div>

      <ul className="flex flex-wrap gap-2">
        {strip.map((day) => {
          const entry = calendar.get(day);
          const selected = day === serviceDate;
          const state = entry
            ? `${statusWord(entry.status as MenuStatus)}, ${dishCount(entry.dishes)}`
            : "no menu";
          return (
            <li key={day}>
              <button
                type="button"
                aria-current={selected ? "date" : undefined}
                aria-label={`${shortDay(day)}, ${state}`}
                onClick={() => setServiceDate(day)}
                className={cn(
                  "flex min-w-24 flex-col rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "border-border-strong bg-accent-subtle text-accent-subtle-fg"
                    : "border-border bg-surface-raised hover:bg-surface-sunken",
                )}
              >
                <span className="font-medium">{shortDay(day)}</span>
                <span className="text-xs">
                  {entry ? statusWord(entry.status as MenuStatus) : "No menu"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </header>
  );

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState
          heading="The menu did not load"
          action={
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </EmptyState>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EditorSkeleton />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      {header}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        <section className="flex flex-col gap-3">
          {/* A label rather than a heading: the textarea is the section, and two
              elements naming the same thing gives it two accessible names. */}
          <label htmlFor="caterer-message" className="text-sm font-semibold">
            The caterer&rsquo;s message
          </label>
          <textarea
            id="caterer-message"
            value={text}
            rows={10}
            placeholder={"Thực đơn thứ 4 24/09\n- Cơm gà 45k\n- Bún bò 50k"}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-raised p-3 text-base"
          />

          <div className="flex flex-wrap gap-2">
            <Action reason={parseReason} onClick={runParse}>
              Parse
            </Action>
            <Action
              reason={parseReason}
              pending={readWithAi.pending}
              variant="outline"
              onClick={() => void readWithAi.run()}
            >
              {readWithAi.pending ? "Reading…" : "Read with AI"}
            </Action>
          </div>

          <p className="text-xs text-subtle">
            Parse reads the message in this browser and costs nothing. Read with AI sends it to the
            parse-assist function, which is slower and is what to reach for when Parse misses.
            Neither writes anything.
          </p>

          {parsed?.serviceDateGuess != null && parsed.serviceDateGuess !== serviceDate && (
            <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
              {`The message looks like it is for ${longDay(parsed.serviceDateGuess)}. `}
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setServiceDate(parsed.serviceDateGuess ?? serviceDate)}
              >
                Use that date
              </Button>
            </p>
          )}

          {notes.length > 0 && (
            <section aria-labelledby="notes-heading" className="flex flex-col gap-1">
              <h3 id="notes-heading" className="text-xs font-semibold text-subtle">
                Not a dish, kept for reference
              </h3>
              <ul className="flex flex-col gap-1">
                {notes.map((n) => (
                  <li key={n} className="text-sm text-muted">
                    {n}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="dishes-heading">
          <h2 id="dishes-heading" className="text-sm font-semibold">
            Dishes and prices
          </h2>

          {frozenSentence !== null && <Notice level="info">{frozenSentence}</Notice>}

          {frozen === null && status === "draft" && (
            <Notice level="info">
              This menu is a draft. Nobody else can see it, and nobody can order from it, until you
              publish.
            </Notice>
          )}

          {frozen === null && status === "published" && impact !== null && impact.orders > 0 && (
            <Notice level="warn">
              {`${peopleHave(impact.orders)} already ordered for this day. Each order keeps the price it was placed at, so a change here sets what the next person pays, not what anybody owes.${
                impact.chosen > 0 ? " Removing a dish somebody chose will be refused." : ""
              }`}
            </Notice>
          )}

          {parsed !== null && parsed.unparsed.length > 0 && (
            <section
              aria-labelledby="unread-heading"
              className="flex flex-col gap-2 rounded-lg border border-dashed border-border-strong p-3"
            >
              <h3 id="unread-heading" className="text-sm font-semibold">
                {parsed.unparsed.length === 1
                  ? "One line had no price in it"
                  : `${parsed.unparsed.length} lines had no price in them`}
              </h3>
              <p className="text-sm text-muted">
                Add the ones that are dishes and set the price yourself. Leave the rest.
              </p>
              <ul className="flex flex-col gap-2">
                {parsed.unparsed.map((u) => (
                  <li key={u.line} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">{u.raw}</span>
                    {/* The line itself is already beside the button; repeating it
                        in a nowrap label would push the row off a phone. */}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Add ${u.raw} as a dish`}
                      onClick={() => takeLine(u.line, u.raw)}
                    >
                      Add as a dish
                    </Button>
                  </li>
                ))}
              </ul>
              {parsed.unparsed.length > 1 && (
                <div>
                  <Button variant="ghost" size="sm" onClick={takeAllLines}>
                    Add all as dishes
                  </Button>
                </div>
              )}
            </section>
          )}

          {rows.length === 0 ? (
            <EmptyState
              heading={emptyHeading({ parsed, frozen, hasMenu: menu !== null })}
              action={
                frozen === null ? (
                  <Button variant="outline" onClick={() => setRows([blankRow()])}>
                    Add a dish
                  </Button>
                ) : undefined
              }
            >
              {emptyBody({ parsed, frozen, hasMenu: menu !== null, date: serviceDate })}
            </EmptyState>
          ) : (
            <>
              <DishRows
                rows={rows}
                currency={org.currency}
                readOnlyReason={frozen}
                onChange={patchRow}
                onRemove={removeRow}
              />
              {frozen === null && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRows((rs) => [...rs, blankRow()])}
                  >
                    Add a dish
                  </Button>
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted">{`Orders close ${cutoffLabel(cutoffAt, org.timezone)}.`}</p>
            <Action
              reason={publishReason}
              pending={publish.pending}
              onClick={() => setConfirming(true)}
            >
              Publish
            </Action>
          </div>
        </section>
      </div>

      {confirming && (
        <PublishDialog
          open
          onOpenChange={setConfirming}
          org={org}
          serviceDate={serviceDate}
          status={status}
          dishes={rows.length}
          unpriced={drafts.filter((d) => d.priceMinor === null).length}
          impact={impact}
          cutoffAt={cutoffAt}
          pending={publish.pending}
          onConfirm={() => void publish.run()}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ pieces */

function Notice({ level, children }: { level: "info" | "warn"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-lg px-4 py-3 text-sm",
        level === "warn" ? "bg-warn-subtle text-warn-subtle-fg" : "bg-surface-sunken text-muted",
      )}
    >
      {children}
    </p>
  );
}

function EditorSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-36" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- rules */

/**
 * Where the editor opens.
 *
 * Tomorrow, not today: ordering closes the evening before, so a menu published
 * for today is one nobody can order from. Weekends are skipped for the same
 * reason the board hides them, and an office that does eat on Saturday reaches
 * it through the date field.
 */
function nextServiceDay(today: string): string {
  let day = addDays(today, 1);
  while (isoWeekday(day) > 5) day = addDays(day, 1);
  return day;
}

/**
 * Carry the ids of dishes already on the menu across a re-parse.
 *
 * Without this, re-pasting a corrected message over a published menu turns
 * every dish into a delete-and-reinsert, which the FK from `order_items`
 * refuses the moment anybody has chosen one. Matching on the name is what the
 * database's own unique index matches on.
 */
function adoptIds(next: DishRow[], previous: DishRow[]): DishRow[] {
  const known = new Map<string, number>();
  for (const row of previous) {
    if (row.id !== null) known.set(nameKey(row.name), row.id);
  }
  return next.map((row) => {
    const id = row.id ?? known.get(nameKey(row.name)) ?? null;
    return id === row.id ? row : { ...row, id };
  });
}

function emptyHeading(a: {
  parsed: ParsedMenu | null;
  frozen: string | null;
  hasMenu: boolean;
}): string {
  if (a.frozen !== null) return "No dishes on this menu";
  if (a.parsed !== null) return "Nothing in that message looked like a dish";
  if (a.hasMenu) return "This menu has no dishes yet";
  return "No menu for this day yet";
}

function emptyBody(a: {
  parsed: ParsedMenu | null;
  frozen: string | null;
  hasMenu: boolean;
  date: string;
}): string {
  if (a.frozen !== null) return `${a.frozen}, and it carries no dishes.`;
  if (a.parsed !== null) {
    return a.parsed.unparsed.length > 0
      ? "The lines it could not read are listed above. Add the ones that are dishes, or add one yourself."
      : "Try Read with AI, which copes with messages the offline parser cannot, or add the dishes yourself.";
  }
  if (a.hasMenu) return "Paste the caterer's message and press Parse, or add the dishes yourself.";
  return `Paste the caterer's message for ${longDay(a.date)} and press Parse. You check every price before anything is written.`;
}
