import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, Dice5Icon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Action,
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  useAction,
} from "@/ui";
import {
  cancelOrder,
  cellKey,
  createTransfer,
  decideTransfer,
  fetchBoard,
  fetchTransfers,
  humanError,
  projectBoard,
  setOrder,
  setStandingException,
  type Board,
  type BoardCell,
  type BoardDay,
  type BoardMember,
  type StandingException,
  type TransferRow,
} from "../api.js";
import { DishDialog } from "./DishDialog.js";
import { WeekNav } from "./WeekNav.js";
import { DayStages } from "./DayStages.js";
import { HandoverDialog } from "./HandoverDialog.js";
import {
  cellMark,
  cellReason,
  columnTag,
  columnLabel,
  cutoffLabel,
  longDayLabel,
  lunchIsOver,
  nextOrderableDay,
  passOnReason,
  pickDish,
  planMessage,
  planRefusal,
  planState,
  planToggle,
  visibleDays,
  weekFromParam,
  weekRangeLabel,
  type Dish,
  type Mark,
  type PlanState,
} from "./boardModel.js";
import { allParams } from "../useHashRoute.js";
import { now as appNow } from "../../shared/clock.js";
import { formatPrice } from "../../shared/money.js";
import { addDays, formatDay, todayIn, weekNumberOf, weekStart } from "../../shared/dates.js";
import type { MyOrder, Org } from "../../shared/types.js";
import type { ScreenProps } from "./screenProps.js";

type Transfers = Awaited<ReturnType<typeof fetchTransfers>>;
type Focus = { profileId: string; serviceDate: string };

/**
 * The week, everyone, tap to order.
 *
 * Asymmetric on purpose: your own row shows dish names, everyone else's shows a
 * mark. You care *what* you are eating; you only need to know *whether*
 * colleagues are, because that is the headcount an admin defends to the
 * caterer.
 *
 * The grid answers "which days can I act on" before it answers anything else,
 * so a day you cannot order on recedes into `surface-sunken` and today is a
 * word in the column head. Colour is spent on ordered cells alone.
 *
 * What is on the menu lives in the panel below the grid, not in the cells: a
 * week of people by days cannot also carry five days of dish lists, and a cell
 * that shows the menu is a cell that cannot show the order.
 */
export function BoardScreen({ me, org }: ScreenProps) {
  const today = todayIn(org.timezone, appNow());
  const thisWeek = weekStart(today, org.billingWeekStartsOn);

  // `?week=` is how Settings links to the week of a skipped day.
  const [weekOf, setWeekOf] = useState(
    () => weekFromParam(allParams().get("week"), org.billingWeekStartsOn) ?? thisWeek,
  );
  const [board, setBoard] = useState<Board | null>(null);
  const [transfers, setTransfers] = useState<Transfers | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  // Null follows the next orderable day. Once a column head is tapped it holds
  // that day, and falls back on its own when the week changes under it.
  const [panelDate, setPanelDate] = useState<string | null>(null);
  const [now, setNow] = useState(() => appNow());

  // The board as it stands, for the optimistic snapshot. Reading it inside a
  // state updater would capture whatever React chose to replay.
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;

  const from = weekOf;
  const to = addDays(weekOf, 6);

  // The cutoff is a wall-clock event, so cells have to close themselves for
  // anyone who left the tab open over lunch.
  useEffect(() => {
    const t = setInterval(() => setNow(appNow()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Only the newest load may write, so paging weeks faster than the network
  // answers cannot draw last week's orders under this week's dates.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const [nextBoard, nextTransfers] = await Promise.all([
        fetchBoard({ orgId: org.id, from, to, meProfileId: me.profileId, today }),
        // The open billing week, not today onward: a Tuesday meal can still be
        // handed over on Thursday, which is what the database allows and what
        // people actually remember to do.
        fetchTransfers({ orgId: org.id, meProfileId: me.profileId, openPeriodStart: thisWeek }),
      ]);
      if (mine !== latest.current) return;
      setBoard(nextBoard);
      setTransfers(nextTransfers);
      setLoadError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      // useAction covers every write. A read has no toast to fire and nothing
      // to revert, so its failure is a state the screen renders instead.
      setLoadError(humanError(e));
    }
  }, [org.id, from, to, me.profileId, today, thisWeek]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------------------------------------- mutations */

  const place = useAction(
    async (a: {
      day: BoardDay;
      profileId: string;
      itemId: number;
      dishName: string;
      note: string | null;
      existing: MyOrder | null;
      randomised: boolean;
      /** The dish is unchanged and only the note is being written. */
      noteOnly: boolean;
    }) => {
      await setOrder({
        orgId: org.id,
        menuId: a.day.menuId!,
        serviceDate: a.day.serviceDate,
        profileId: a.profileId,
        itemId: a.itemId,
        note: a.note,
        existing: a.existing,
      });
      return a;
    },
    {
      success: (a) =>
        a.noteOnly
          ? a.note === null
            ? "Note removed"
            : "Note saved"
          : a.randomised
            ? `Ordered ${a.dishName} · tap to change`
            : `Ordered ${a.dishName}`,
      onSuccess: () => void load(),
    },
  );

  const stop = useAction(
    async (a: { orderId: number; serviceDate: string }) => {
      await cancelOrder(a.orderId);
      return a;
    },
    {
      success: (a) => `Not eating ${formatDay(a.serviceDate)}`,
      onSuccess: () => void load(),
    },
  );

  const pass = useAction(
    async (a: { orderId: number; toProfileId: string; toName: string }) => {
      await createTransfer({
        orgId: org.id,
        orderId: a.orderId,
        toProfileId: a.toProfileId,
        createdBy: me.profileId,
      });
      return a;
    },
    {
      success: (a) => `Passed on to ${a.toName}`,
      onSuccess: () => {
        setFocus(null);
        void load();
      },
    },
  );

  const decide = useAction(
    async (a: { id: number; status: "accepted" | "declined" | "cancelled" }) => {
      await decideTransfer(a.id, a.status);
      return a;
    },
    {
      success: (a) =>
        a.status === "accepted" ? "Accepted" : a.status === "declined" ? "Declined" : "Withdrawn",
      onSuccess: () => {
        setFocus(null);
        void load();
      },
    },
  );

  const plan = useAction(
    async (a: {
      serviceDate: string;
      action: StandingException | null;
      before: StandingException | null;
      state: PlanState;
      /** False for an undo, which has nothing further to undo. */
      undoable: boolean;
    }) => {
      await setStandingException({ orgId: org.id, serviceDate: a.serviceDate, action: a.action });
      return a;
    },
    {
      // Not `success`: the toast carries an Undo, which useAction's string does not.
      onSuccess: (a) => {
        const message = planMessage(a.state, a.serviceDate);
        if (a.undoable) {
          toast.success(message, {
            action: {
              label: "Undo",
              onClick: () => setExceptionRef.current(a.serviceDate, a.before, false),
            },
          });
        } else {
          toast.success(message);
        }
        void load();
      },
    },
  );

  const busy = place.pending || stop.pending || pass.pending || decide.pending || plan.pending;

  // useAction drops a call made while another is in flight, which is right for
  // a double click and wrong for a grid: two cells tapped in quick succession
  // are two intentions. Queueing keeps both.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  /**
   * Fill the cell now and put it back if the database refuses, so the refusal
   * the person reads is the database's own sentence rather than a spinner
   * followed by nothing. `useAction` raises it through `humanError`, unedited.
   */
  const optimistically = useCallback(
    async (key: string, next: BoardCell | null, run: () => Promise<{ ok: boolean }>) => {
      const before = boardRef.current?.cells ?? null;
      setBoard((b) => {
        if (!b) return b;
        const cells = new Map(b.cells);
        if (next === null) cells.delete(key);
        else cells.set(key, next);
        return { ...b, cells };
      });
      const result = await run();
      if (!result.ok && before !== null) {
        setBoard((b) => (b ? { ...b, cells: before } : b));
      }
    },
    [],
  );

  const order = useCallback(
    (
      day: BoardDay,
      member: BoardMember,
      cell: BoardCell | null,
      dish: Dish,
      opts: { randomised?: boolean; note?: string | null; noteOnly?: boolean } = {},
    ) => {
      const note = opts.note ?? null;
      const existing: MyOrder | null = cell
        ? {
            id: cell.orderId,
            status: cell.status,
            source: cell.source,
            itemId: null,
            itemName: cell.dishName,
            unitPriceMinor: null,
          }
        : null;
      const next: BoardCell = {
        // Zero until the insert returns one. `passOnReason` refuses to offer a
        // meal with no id rather than sending a transfer into the void.
        orderId: cell?.orderId ?? 0,
        status: "placed",
        source: cell?.source ?? "member",
        itemId: dish.id,
        dishName: dish.name,
        note,
        amountMinor: dish.priceMinor,
        transferredToName: null,
      };
      void enqueue(() =>
        optimistically(cellKey(member.profileId, day.serviceDate), next, () =>
          place.run({
            day,
            profileId: member.profileId,
            itemId: dish.id,
            dishName: dish.name,
            note,
            existing,
            randomised: opts.randomised ?? false,
            noteOnly: opts.noteOnly ?? false,
          }),
        ),
      );
    },
    [enqueue, optimistically, place],
  );

  const notEating = useCallback(
    (day: BoardDay, member: BoardMember, cell: BoardCell) => {
      setFocus(null);
      void enqueue(() =>
        optimistically(cellKey(member.profileId, day.serviceDate), null, () =>
          stop.run({ orderId: cell.orderId, serviceDate: day.serviceDate }),
        ),
      );
    },
    [enqueue, optimistically, stop],
  );

  /**
   * Write MY exception for a day ahead of its menu, drawn at once. On a
   * refusal only that day is put back, since other days may have moved since.
   */
  const setException = useCallback(
    (serviceDate: string, action: StandingException | null, undoable: boolean) => {
      const b = boardRef.current;
      if (!b) return;
      const before = b.exceptions.get(serviceDate) ?? null;
      // An Undo can arrive after the week has been paged away. The database
      // still judges the day; this only decides what the toast says.
      const day = b.days.find((d) => d.serviceDate === serviceDate) ?? {
        serviceDate,
        menuId: null,
        status: null,
        orderCutoffAt: null,
        dishes: [],
      };
      const hasOrderRow = b.cells.has(cellKey(me.profileId, serviceDate));
      const state = planState({ day, today, hasOrderRow, weekdays: b.weekdays, exception: action });
      if (state === null) {
        // Reached only by an Undo whose day has moved on since, typically
        // because its menu was published in the meantime.
        toast.error(planRefusal({ serviceDate, today, hasOrderRow }));
        return;
      }

      const put = (x: StandingException | null) =>
        setBoard((cur) => {
          if (!cur) return cur;
          const exceptions = new Map(cur.exceptions);
          if (x === null) exceptions.delete(serviceDate);
          else exceptions.set(serviceDate, x);
          const next = { ...cur, exceptions };
          return { ...next, projected: projectBoard(next, { meProfileId: me.profileId, today }) };
        });

      put(action);
      void enqueue(async () => {
        const result = await plan.run({ serviceDate, action, before, state, undoable });
        if (!result.ok) put(before);
        return result;
      });
    },
    [enqueue, plan, today, me.profileId],
  );
  // The Undo in a toast outlives the render that made it.
  const setExceptionRef = useRef(setException);
  setExceptionRef.current = setException;

  /* ------------------------------------------------------------- rendering */

  const days = useMemo(() => {
    // While the board loads, the same rule runs over a bare week, so the range
    // in the heading does not shift under the reader when the data lands.
    const source =
      board?.days ??
      Array.from({ length: 7 }, (_, i): BoardDay => ({
        serviceDate: addDays(from, i),
        menuId: null,
        status: null,
        orderCutoffAt: null,
        dishes: [],
      }));
    return visibleDays(source, (d) =>
      board === null
        ? false
        : board.days.some((x) => x.serviceDate === d && x.menuId !== null) ||
          board.members.some((m) => board.cells.has(cellKey(m.profileId, d))) ||
          board.projected.has(d) ||
          // A skipped weekend day is no longer projected, and the column has
          // to stay for the skip to be taken back.
          board.exceptions.has(d),
    );
  }, [board, from]);

  // The days this reader cannot act on. One rule feeds the recessive column,
  // the panel's opening day and the column the grid scrolls to, so the three
  // cannot drift apart. The rule is the same for everybody: this board is
  // where an admin orders their own lunch, so the clock binds them too.
  const closedDays = useMemo(
    () =>
      new Set(
        days
          .filter((d) => cellReason({ day: d, now, timeZone: org.timezone }) !== null)
          .map((d) => d.serviceDate),
      ),
    [days, now, org.timezone],
  );

  const panelDay = useMemo(
    () =>
      days.find((d) => d.serviceDate === panelDate) ??
      nextOrderableDay(days, (d) => !closedDays.has(d.serviceDate), today),
    [days, panelDate, closedDays, today],
  );

  const totals = useMemo(() => {
    const perDay = new Map<string, number>();
    if (!board) return perDay;
    for (const [key, cell] of board.cells) {
      if (cell.status !== "placed") continue;
      const date = key.slice(key.indexOf("|") + 1);
      perDay.set(date, (perDay.get(date) ?? 0) + 1);
    }
    return perDay;
  }, [board]);

  const incomingByOrder = useMemo(() => {
    const out = new Map<number, TransferRow>();
    for (const t of transfers?.incoming ?? []) out.set(t.orderId, t);
    return out;
  }, [transfers]);

  // Meals handed to me and accepted, by day. The order row stays on the
  // giver's line, so my own cell would otherwise look empty and offer me a
  // second lunch.
  const receivedByDate = useMemo(() => {
    const out = new Map<string, TransferRow>();
    for (const t of transfers?.live.values() ?? []) {
      if (t.status === "accepted" && t.toProfileId === me.profileId) out.set(t.serviceDate, t);
    }
    return out;
  }, [transfers, me.profileId]);

  // On a narrow screen the board opens on Monday and the only day you can act
  // on is usually off the right edge, so it looks like a week of nothing until
  // you discover a horizontal scroll. Bring that column into view instead, the
  // one the menu panel is already showing.
  const gridRef = useRef<HTMLElement>(null);
  // Once per week shown, and only after the board has arrived: on the first
  // render there is a skeleton rather than a table, so there is no column to
  // scroll to yet. Tracking which week has been handled keeps a later optimistic
  // update, which also replaces `board`, from yanking the grid out from under
  // somebody who has scrolled it themselves.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (board === null || scrolledFor.current === from || panelDay === null) return;
    const target = panelDay;

    // A frame later, not immediately: the table is laid out in this commit but
    // offsetLeft is only meaningful once it has been painted, and a width read
    // before that returns the pre-layout value and scrolls to the wrong place.
    const frame = requestAnimationFrame(() => {
      const column = gridRef.current?.querySelector<HTMLElement>(
        `[data-service-date="${target.serviceDate}"]`,
      );
      const scroller = column?.closest<HTMLElement>("[data-slot='table-container']");
      if (!column || !scroller) return;
      // Not scrollIntoView: the Who column is sticky and sits *over* the scroll
      // area, so centring the target leaves its left edge underneath it and
      // clips the dish name. Park it just clear of that column instead.
      //
      // Measured as a delta between two rects rather than from `offsetLeft`,
      // which is relative to the nearest positioned ancestor. That is not the
      // scroller here, so any page padding or offset ancestor between them was
      // being added to scrollLeft and the grid overshot the target day.
      const sticky = gridRef.current?.querySelector<HTMLElement>("thead th:first-child");
      const gap = (sticky?.getBoundingClientRect().width ?? 0) + 8;
      const delta =
        column.getBoundingClientRect().left - scroller.getBoundingClientRect().left - gap;
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
      scrolledFor.current = from;
    });
    return () => cancelAnimationFrame(frame);
  }, [board, from, panelDay]);

  const nav = (
    <WeekNav
      label={weekRangeLabel(days[0]?.serviceDate ?? from, days[days.length - 1]?.serviceDate ?? to)}
      weekNumber={weekNumberOf(weekOf)}
      away={weekOf !== thisWeek}
      onPrev={() => setWeekOf(addDays(weekOf, -7))}
      onNext={() => setWeekOf(addDays(weekOf, 7))}
      onReset={() => setWeekOf(thisWeek)}
    />
  );

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-4">
        {nav}
        <EmptyState
          heading="The board did not load"
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

  if (board === null) {
    return (
      <section className="flex flex-col gap-4">
        {nav}
        <BoardSkeleton />
      </section>
    );
  }

  const focused = focus
    ? {
        member: board.members.find((m) => m.profileId === focus.profileId) ?? null,
        day: days.find((d) => d.serviceDate === focus.serviceDate) ?? null,
      }
    : null;
  const focusedCell =
    focus && focused?.member && focused.day
      ? board.cells.get(cellKey(focus.profileId, focus.serviceDate)) ?? null
      : null;
  // A cancelled row is still the row to reopen, so `order` keeps the raw cell
  // while everything that asks "is there a meal here" reads this one.
  const focusedLive = focusedCell?.status === "placed" ? focusedCell : null;
  const focusedMine = focus
    ? (() => {
        const mine = board.cells.get(cellKey(me.profileId, focus.serviceDate)) ?? null;
        return mine?.status === "placed" ? mine : null;
      })()
    : null;

  return (
    <section ref={gridRef} className="flex flex-col gap-4">
      {nav}

      {/* Above the grid, not below it. The grid is the thing that grows: every
          colleague costs 49.3px and a menu of two to five dishes costs nothing
          extra, so putting the bounded thing after the unbounded one meant
          scrolling past the whole office to find out what was for lunch.
          Measured at 390 with eight people, the first dish sat 13.9px below
          the tab bar: you could not see a single dish without scrolling, and
          tapping a column head moved a panel that was entirely off screen.

          The alternative was to hide colleagues behind a button, which costs
          345px of the screen's stated purpose to relocate a 242px panel, and
          makes the board's own hero depend on a setting. */}
      {days.every((d) => d.menuId === null) ? (
        <EmptyState heading="No menus this week">
          An admin pastes the caterer's message on the Menu screen and publishes it, and these
          columns fill in.
        </EmptyState>
      ) : (
        panelDay && (
          <MenuPanel
            day={panelDay}
            org={org}
            now={now}
            reason={cellReason({ day: panelDay, now, timeZone: org.timezone })}
          />
        )
      )}


      <Table containerClassName="bg-surface-raised">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-3 bg-surface-raised">Who</TableHead>
            {days.map((d) => {
              const { dow, dom } = columnLabel(d.serviceDate);
              const isToday = d.serviceDate === today;
              const tag = columnTag({ day: d, org, now });
              // Today and the day's state are different axes and both can hold
              // at once, which by mid-afternoon they usually do.
              const tags = [isToday ? "Today" : null, tag].filter((t) => t !== null);
              return (
                <TableHead
                  key={d.serviceDate}
                  scope="col"
                  data-service-date={d.serviceDate}
                  aria-current={isToday ? "date" : undefined}
                  className={cn(
                    "min-w-28 p-0 text-center",
                    // Which column the menu below is describing. A neutral rule
                    // rather than a tint: the accent is spoken for by ordered.
                    panelDay?.serviceDate === d.serviceDate && "border-b-2 border-b-border-strong",
                  )}
                >
                  {/* Available on every day, including one with no menu: the
                      panel then says so, which teaches more than a refusal.

                      `h-full` and a line that is always rendered: with neither,
                      only the column carrying a third line filled its cell, so
                      hovering the head moved the highlight around by a few
                      pixels from one day to the next. */}
                  <Button
                    variant="ghost"
                    aria-pressed={panelDay?.serviceDate === d.serviceDate}
                    aria-label={`${dow} ${dom}${tags
                      .map((t) => `, ${t.toLowerCase()}`)
                      .join("")}: show this day's menu`}
                    className="h-full w-full flex-col gap-0 rounded-none px-3 py-2 text-muted"
                    onClick={() => setPanelDate(d.serviceDate)}
                  >
                    <span className="block text-xs font-semibold">{dow}</span>
                    <span className="block text-base font-semibold text-text tabular">{dom}</span>
                    {/* A word, not a colour. One grey stood for "no menu",
                        "closed" and "cancelled" at once, and read as none of
                        them. The non-breaking space keeps every head the same
                        height when a day has nothing to say. */}
                    <span className="block text-xs font-medium">
                      {tags.length === 0 ? "\u00A0" : tags.join(" · ")}
                    </span>
                  </Button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {board.members.map((member) => (
            <TableRow key={member.profileId}>
              <TableCell className="sticky left-0 z-2 max-w-40 truncate bg-surface-raised py-3 align-top font-medium">
                {member.name}
                {member.isMe && <span className="text-muted"> (you)</span>}
              </TableCell>

              {days.map((day) => {
                const key = cellKey(member.profileId, day.serviceDate);
                const cell = board.cells.get(key) ?? null;
                const live = cell?.status === "placed" ? cell : null;
                const offer = live ? transfers?.live.get(live.orderId) ?? null : null;
                const incoming = live ? incomingByOrder.get(live.orderId) ?? null : null;
                const orderReason = cellReason({
                  day,
                  now,
                  timeZone: org.timezone,
                });
                const over = lunchIsOver({ day, org, now });
                const planned = member.isMe
                  ? planState({
                      day,
                      today,
                      hasOrderRow: cell !== null,
                      weekdays: board.weekdays,
                      exception: board.exceptions.get(day.serviceDate) ?? null,
                    })
                  : null;

                return (
                  <TableCell key={day.serviceDate} className="p-1 text-center align-top">
                    {incoming !== null ? (
                      <IncomingOffer
                        offer={incoming}
                        reason={
                          over
                            ? `Lunch on ${formatDay(day.serviceDate)} is over, so this offer can no longer be answered`
                            : null
                        }
                        pending={busy}
                        onDecide={(status) => void enqueue(() => decide.run({ id: incoming.id, status }))}
                      />
                    ) : member.isMe ? (
                      <MyCell
                        day={day}
                        cell={live}
                        received={receivedByDate.get(day.serviceDate) ?? null}
                        projected={board.projected.has(day.serviceDate)}
                        plan={planned}
                        offeredTo={offer?.toName ?? null}
                        // A meal is always worth opening, to read the note or
                        // take an offer back, whatever the ordering window says.
                        reason={live !== null || planned !== null ? null : orderReason}
                        pending={busy}
                        onOpen={() =>
                          setFocus({ profileId: member.profileId, serviceDate: day.serviceDate })
                        }
                        onPlan={() => {
                          if (planned !== null) {
                            setException(day.serviceDate, planToggle(planned), true);
                          }
                        }}
                        onOrder={() => {
                          const dish = pickDish(day.dishes);
                          if (dish === null) return;
                          order(day, member, cell, dish, { randomised: day.dishes.length > 1 });
                        }}
                      />
                    ) : (
                      // Empty or not: an empty cell is where "I am out, you
                      // have mine" usually lands, so it can never be inert.
                      <TheirCell
                        member={member}
                        day={day}
                        cell={live}
                        offeredTo={offer?.toName ?? null}
                        onTap={() =>
                          setFocus({ profileId: member.profileId, serviceDate: day.serviceDate })
                        }
                      />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>

        <TableFooter>
          <TableRow>
            <TableCell className="sticky left-0 z-2 bg-surface-raised font-medium">
              Total
            </TableCell>
            {days.map((d) => (
              <TableCell key={d.serviceDate} className="text-center font-medium tabular">
                {totals.get(d.serviceDate) ?? 0}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </Table>

      {focused?.member && focused.day && focused.member.isMe && (
        <DishDialog
          // Remounted per cell, so the note field starts on that cell's note
          // rather than carrying one over to the wrong meal.
          key={`${focus?.profileId}|${focus?.serviceDate}`}
          open
          onOpenChange={(open) => !open && setFocus(null)}
          org={org}
          day={focused.day}
          cell={focusedLive}
          orderReason={cellReason({ day: focused.day, now, timeZone: org.timezone })}
          offer={
            focusedLive && focusedLive.transferredToName === null
              ? transfers?.live.get(focusedLive.orderId) ?? null
              : null
          }
          pending={busy}
          onPick={(itemId, note) => {
            const day = focused.day;
            const member = focused.member;
            const dish = day?.dishes.find((x) => x.id === itemId);
            if (!day || !member || !dish) return;
            setFocus(null);
            order(day, member, focusedCell, dish, { note });
          }}
          onSurprise={(note) => {
            const day = focused.day;
            const member = focused.member;
            if (!day || !member) return;
            const dish = pickDish(day.dishes, {
              excludeId: day.dishes.find((x) => x.name === focusedCell?.dishName)?.id ?? null,
            });
            if (!dish) return;
            setFocus(null);
            order(day, member, focusedCell, dish, { randomised: true, note });
          }}
          onSaveNote={(note) => {
            const day = focused.day;
            const member = focused.member;
            if (!day || !member || !focusedLive || focusedLive.itemId === null) return;
            setFocus(null);
            order(
              day,
              member,
              focusedLive,
              {
                id: focusedLive.itemId,
                name: focusedLive.dishName ?? "",
                priceMinor: focusedLive.amountMinor ?? 0,
              },
              { note, noteOnly: true },
            );
          }}
          onNotEating={() => {
            if (focused.day && focused.member && focusedCell) {
              notEating(focused.day, focused.member, focusedCell);
            }
          }}
          onWithdraw={(id) => void enqueue(() => decide.run({ id, status: "cancelled" }))}
        />
      )}

      {focused?.member && focused.day && !focused.member.isMe && (
        <HandoverDialog
          key={`${focus?.profileId}|${focus?.serviceDate}`}
          open
          onOpenChange={(open) => !open && setFocus(null)}
          org={org}
          day={focused.day}
          member={focused.member}
          theirCell={focusedLive}
          myCell={focusedMine}
          giveReason={
            focusedMine === null
              ? `You have nothing ordered on ${formatDay(focused.day.serviceDate)}`
              : passOnReason({
                  cell: focusedMine,
                  serviceDate: focused.day.serviceDate,
                  openWeekStart: thisWeek,
                  offeredTo: transfers?.live.get(focusedMine.orderId)?.toName ?? null,
                  over: lunchIsOver({ day: focused.day, org, now }),
                })
          }
          offer={
            focusedLive && focusedLive.transferredToName === null
              ? transfers?.live.get(focusedLive.orderId) ?? null
              : null
          }
          mayWithdraw={
            focusedLive
              ? transfers?.live.get(focusedLive.orderId)?.fromProfileId === me.profileId
              : false
          }
          pending={busy}
          onGive={() => {
            const member = focused.member;
            if (!member || focusedMine === null) return;
            void enqueue(() =>
              pass.run({
                orderId: focusedMine.orderId,
                toProfileId: member.profileId,
                toName: member.name,
              }),
            );
          }}
          onWithdraw={(id) => void enqueue(() => decide.run({ id, status: "cancelled" }))}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * What is on offer that day, without a tap.
 *
 * The grid answers who is eating and cannot also carry five days of dish
 * lists, so the menu lives under it, in the room the desktop board was
 * wasting. The column heads switch which day it shows. With this here, a cell
 * can go back to being nothing but an action.
 */
function MenuPanel({
  day,
  org,
  now,
  reason,
}: {
  day: BoardDay;
  org: Org;
  now: Date;
  reason: string | null;
}) {
  // The reason, when there is one, already says the window is shut and when it
  // shut, in the database's own words.
  //
  // A day with no menu, or one still open, gets no reason at all, so without
  // the tense this panel told somebody that a day "closes" at a time that went
  // by this morning.
  const shut = day.orderCutoffAt !== null && now.getTime() >= Date.parse(day.orderCutoffAt);
  const when =
    reason ??
    (day.orderCutoffAt === null
      ? null
      : `${shut ? "Closed" : "Closes"} ${cutoffLabel(day.orderCutoffAt, org.timezone)}`);

  return (
    <section
      aria-label={`Menu for ${longDayLabel(day.serviceDate)}`}
      className="rounded-lg border border-border bg-surface-raised p-4 md:p-6"
    >
      <div className="flex flex-col gap-3 border-b border-border pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold">{longDayLabel(day.serviceDate)}</h2>
          {when !== null && <p className="text-sm text-muted">{when}</p>}
        </div>
        {/* Under the day it describes, above the dishes it governs. Somebody
            looking at a cell they cannot use looks here next. */}
        <DayStages
          serviceDate={day.serviceDate}
          status={day.status}
          orderCutoffAt={day.orderCutoffAt}
          org={org}
          now={now}
          className="max-w-md"
        />
      </div>

      {day.dishes.length === 0 ? (
        <p className="pt-3 text-sm text-muted">
          Nothing on the menu for this day. An admin pastes the caterer's message on the Menu
          screen and publishes it.
        </p>
      ) : (
        <ul className="grid gap-x-10 pt-1 sm:grid-cols-2 xl:grid-cols-3">
          {day.dishes.map((dish) => (
            <li
              key={dish.id}
              className="flex items-baseline justify-between gap-4 border-b border-border py-2"
            >
              <span className="min-w-0 font-medium wrap-anywhere">{dish.name}</span>
              <span className="shrink-0 text-sm text-muted tabular">
                {formatPrice(dish.priceMinor, org.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Everything a cell says wraps, even inside one long word, because a dish name
// has to be read whole. The row grows to fit instead. The 12rem cap is what
// makes it wrap on a wide screen too: uncapped, one long name set its whole
// column to the name's length.
const CELL_TEXT = "block max-w-[min(100%,12rem)] wrap-anywhere";

// An empty cell you can use has to outweigh one you cannot. Action draws
// unavailable as a dashed border-strong edge, which is right for a button
// standing on its own and wrong in a grid: against cells that are only a
// glyph, the days you CANNOT order on became the loudest thing on the screen.
// Measured before this: disabled cells bordered #9E8363, the one open day
// #E6DED0.
const OPEN_CELL = "border border-border-strong text-muted hover:bg-accent-subtle hover:text-text";

/**
 * One of my days, and nothing but an action.
 *
 * The menu panel says what is on offer, so the cell does not repeat it. The
 * dice appears only where there is something to randomise: with two dishes or
 * more the `+` opens the chooser and the dice commits to one, and with a
 * single dish there is nothing to choose, so `+` orders it outright.
 */
function MyCell({
  day,
  cell,
  received,
  projected,
  plan,
  offeredTo,
  reason,
  pending,
  onOpen,
  onPlan,
  onOrder,
}: {
  day: BoardDay;
  cell: BoardCell | null;
  /** A colleague's meal I accepted for this day. */
  received: TransferRow | null;
  projected: boolean;
  /** Set on a day ahead of its menu, where a tap skips or plans instead. */
  plan: PlanState | null;
  offeredTo: string | null;
  reason: string | null;
  pending: boolean;
  /** Open the dish dialog on this cell. */
  onOpen: () => void;
  /** Flip this day between the rule and an exception to it. */
  onPlan: () => void;
  /** Order a dish from this day's menu, chosen at random. */
  onOrder: () => void;
}) {
  const label = cell
    ? cell.dishName ?? "Dish to follow"
    : projected
      ? "Standing"
      : "Order lunch";
  const state = cell
    ? `${cell.dishName ?? "eating, no dish chosen"}${cell.note !== null ? `, ${cell.note}` : ""}`
    : projected
      ? "from your standing order"
      : "not eating";
  const described =
    `${formatDay(day.serviceDate)}: ${state}` + (offeredTo !== null ? `. Offered to ${offeredTo}` : "");

  if (cell === null && received !== null) {
    return (
      <Action
        reason={`${received.fromName} gave you this lunch, so there is nothing to order`}
        variant="ghost"
        aria-label={`${formatDay(day.serviceDate)}: ${received.dishName ?? "eating"}, from ${received.fromName}`}
        className="h-auto w-full min-w-24 cursor-default flex-col items-center gap-0.5 border-solid border-transparent bg-accent-subtle px-2 py-2 text-xs font-medium whitespace-normal text-accent-subtle-fg hover:bg-accent-subtle hover:text-accent-subtle-fg"
      >
        <span className={CELL_TEXT}>{received.dishName ?? "Lunch"}</span>
        <span className={cn(CELL_TEXT, "text-xs font-normal")}>
          from {received.fromName}
        </span>
      </Action>
    );
  }

  if (plan !== null) {
    const p = PLAN_CELL[plan];
    return (
      <Action
        reason={null}
        pending={pending}
        variant="ghost"
        title={p.verb}
        aria-label={`${formatDay(day.serviceDate)}: ${p.state}. ${p.verb}`}
        className={cn(
          "h-auto min-h-9 w-full min-w-24 flex-col items-center gap-0.5 px-2 py-2 text-xs font-medium whitespace-normal",
          p.className,
        )}
        onClick={onPlan}
      >
        {p.label === null ? (
          <PlusIcon className="size-4" aria-hidden="true" />
        ) : (
          <span className={cn("block", plan === "skipped" && "line-through")}>{p.label}</span>
        )}
      </Action>
    );
  }

  // An empty cell inside the window: tapping it orders rather than opens.
  const orders = cell === null && reason === null;

  if (orders && !projected && day.dishes.length > 1) {
    // Two targets of equal weight, filling the cell between them: a dice drawn
    // as an afterthought beside a bordered plus reads as one control with a
    // smudge next to it. A phone has no hover, so each carries its own title
    // for the pointer and its own label for everything else.
    return (
      <div className="flex w-full min-w-24 items-center gap-1">
        <Action
          reason={null}
          pending={pending}
          variant="ghost"
          title="Choose a dish"
          aria-label={`${described}. Choose a dish`}
          className={cn("h-9 flex-1 px-0", OPEN_CELL)}
          onClick={onOpen}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
        </Action>
        <Action
          reason={null}
          pending={pending}
          variant="ghost"
          title="Order a random dish"
          aria-label={`${described}. Order a dish at random`}
          className={cn("h-9 flex-1 px-0", OPEN_CELL)}
          onClick={onOrder}
        >
          <Dice5Icon className="size-5" aria-hidden="true" />
        </Action>
      </div>
    );
  }

  return (
    <Action
      reason={reason}
      pending={pending}
      variant="ghost"
      title={orders ? "Order lunch" : undefined}
      aria-label={orders ? `${described}. Order lunch` : described}
      className={cn(
        "h-auto w-full min-w-24 flex-col items-center gap-0.5 px-2 py-2 text-xs font-medium whitespace-normal",
        cell
          ? "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/70"
          : reason === null
            ? OPEN_CELL
            : "border-border text-subtle",
        projected && !cell && "border border-dashed border-border-strong",
      )}
      onClick={orders ? onOrder : onOpen}
    >
      {cell ? (
        <>
          <span className={cn(CELL_TEXT, offeredTo !== null && "line-through")}>
            {label}
          </span>
          {cell.note !== null && (
            <span className={cn(CELL_TEXT, "text-xs font-normal text-muted")}>
              {cell.note}
            </span>
          )}
          {offeredTo !== null && (
            <span className={cn(CELL_TEXT, "text-xs font-normal")}>to {offeredTo}</span>
          )}
        </>
      ) : projected ? (
        <span className="block">{label}</span>
      ) : (
        <PlusIcon className="size-4" aria-hidden="true" />
      )}
    </Action>
  );
}

/**
 * My day ahead of its menu. Dashed, because each of these is a prediction
 * until a menu is published: the accent fill stays with real orders.
 */
const PLAN_CELL: Record<
  PlanState,
  { label: string | null; state: string; verb: string; className: string }
> = {
  standing: {
    label: "Standing",
    state: "from your standing order",
    verb: "Skip this day",
    className: "border border-dashed border-border-strong text-muted hover:bg-surface-sunken",
  },
  skipped: {
    label: "Skipped",
    state: "skipped",
    verb: "Take the skip back",
    className: "border border-dashed border-border text-subtle hover:bg-surface-sunken",
  },
  planned: {
    label: "Planned",
    state: "planned",
    verb: "Take the plan back",
    className: "border border-dashed border-border-strong text-text hover:bg-surface-sunken",
  },
  empty: {
    label: null,
    state: "not eating",
    verb: "Plan to eat",
    className: "border border-border text-subtle hover:bg-surface-sunken hover:text-text",
  },
};

/**
 * A colleague's day.
 *
 * Always a control, empty or not: you hand a meal over by tapping the person
 * you are giving it to, and "I am out, you have mine" is usually said to
 * somebody who was not already eating. An empty cell therefore has to look
 * empty and still read as tappable, which is what the hairline is for.
 *
 * It names the dish. It used to show an anonymous fill, on the reasoning that
 * you care what YOU are eating and only whether a colleague is. That was wrong
 * about the day the food arrives: somebody has to hand the right box to the
 * right person, and a wall of identical blocks cannot tell them which.
 *
 * On a day with one dish the name is on every row and says nothing, so a check
 * mark carries it instead.
 */
function TheirCell({
  member,
  day,
  cell,
  offeredTo,
  onTap,
}: {
  member: BoardMember;
  day: BoardDay;
  cell: BoardCell | null;
  offeredTo: string | null;
  onTap: () => void;
}) {
  const mark = cellMark(cell, false);
  // An offer that has not been answered yet sits on a meal they still hold.
  const pendingWith = mark !== "passed" ? offeredTo : null;
  const gone = cell?.transferredToName ?? null;
  const dish = day.dishes.find((d) => d.id === cell?.itemId)?.name ?? null;
  const onlyDish = day.dishes.length === 1;
  // The dish is always spoken, even where a check mark is all that is drawn:
  // a check is only legible next to a column head naming the one dish, and a
  // screen reader is not reading the column head.
  const described = `${member.name}, ${formatDay(day.serviceDate)}: ${
    dish !== null && gone === null ? `eating ${dish}` : MARK_LABEL[mark]
  }`;
  const spoken =
    gone !== null
      ? `${described} to ${gone}`
      : pendingWith !== null
        ? `${described}. Offered to ${pendingWith}`
        : described;

  return (
    <Action
      reason={null}
      variant="ghost"
      aria-label={`${spoken}. Hand a meal over`}
      className={cn(
        // `flex`, not the Button's default `inline-flex`. An inline box sits
        // on a line box, where its baseline is the text baseline when it
        // names a dish and the bottom margin edge when it is empty: measured,
        // every filled chip sat 2.15px below the empty targets in the same
        // row, which is what made the grid read as jittery across a week.
        "flex h-auto min-h-9 w-full min-w-16 rounded-md px-1 py-1.5 text-xs font-medium whitespace-normal",
        MARK_FILL[mark],
        pendingWith !== null && "border border-dashed border-accent",
      )}
      onClick={onTap}
    >
      {gone !== null || pendingWith !== null ? (
        <span className={CELL_TEXT}>to {gone ?? pendingWith}</span>
      ) : dish !== null ? (
        onlyDish ? (
          <CheckIcon className="size-4" aria-hidden="true" />
        ) : (
          <span className={CELL_TEXT}>{dish}</span>
        )
      ) : mark === "eating" ? (
        <span className={cn(CELL_TEXT, "font-normal")}>no dish yet</span>
      ) : mark === "projected" ? (
        <CheckIcon className="size-4 opacity-60" aria-hidden="true" />
      ) : null}
    </Action>
  );
}

const MARK_LABEL: Record<Mark, string> = {
  ordered: "ordered",
  eating: "eating, no dish chosen",
  passed: "passed on",
  projected: "from a standing order",
  none: "not eating",
};

/**
 * What a cell looks like, now that the words carry the meaning.
 *
 * The headcount used to be blocks of colour, read down a column. It scanned
 * well and said too little: one fill stood for "eating" whatever they were
 * eating, and on the day the food arrives that is the question. The dish name
 * says it, so the fill is gone and what is left is the outline that makes an
 * empty cell read as tappable.
 */
const MARK_FILL: Record<Mark, string> = {
  ordered: "border border-border-strong text-text hover:bg-surface-sunken",
  // A real headcount with an unresolved dish, so outlined but visibly unfinished.
  eating: "border border-dashed border-border-strong text-muted hover:bg-surface-sunken",
  // Spent: the meal is on somebody else's bill now.
  passed: "text-subtle hover:bg-surface-sunken",
  projected: "border border-dashed border-border text-subtle hover:bg-surface-sunken",
  // Empty, and still a target. `border` is the decorative hairline, which is
  // the faintest thing the tokens can say and still say something.
  none: "border border-border hover:bg-surface-sunken",
};

/**
 * An offer appears on the cell it concerns, with both answers next to it. A
 * separate destination would mean leaving the grid that is already showing the
 * meal, the day and the person, to find all three again in a list.
 */
function IncomingOffer({
  offer,
  reason,
  pending,
  onDecide,
}: {
  offer: TransferRow;
  /** Why neither answer can be given any more, once the day is over. */
  reason: string | null;
  pending: boolean;
  onDecide: (status: "accepted" | "declined") => void;
}) {
  return (
    <div className="mx-auto flex max-w-52 min-w-32 flex-col items-stretch gap-1 rounded-md border border-accent bg-accent-subtle p-1.5">
      <span className="text-xs text-accent-subtle-fg wrap-anywhere">
        {offer.fromName} offers you {offer.dishName ?? "their lunch"}
      </span>
      <div className="flex gap-1">
        <Action
          reason={reason}
          pending={pending}
          size="sm"
          className="flex-1"
          onClick={() => onDecide("accepted")}
        >
          Accept
        </Action>
        <Action
          reason={reason}
          pending={pending}
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => onDecide("declined")}
        >
          Decline
        </Action>
      </div>
    </div>
  );
}

/** Shaped like the grid, so nothing jumps when the data lands. */
function BoardSkeleton() {
  return (
    <Table containerClassName="bg-surface-raised">
      <TableHeader>
        <TableRow>
          <TableHead className="w-40">Who</TableHead>
          {Array.from({ length: 5 }, (_, i) => (
            <TableHead key={i} className="min-w-28">
              <Skeleton className="mx-auto h-8 w-10" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 4 }, (_, row) => (
          <TableRow key={row}>
            <TableCell>
              <Skeleton className="h-4 w-24" />
            </TableCell>
            {Array.from({ length: 5 }, (_, col) => (
              <TableCell key={col} className="p-1">
                <Skeleton className="h-9 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
