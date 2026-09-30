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
 * What is on the menu lives in the panel above the grid, not in the cells: a
 * week of people by days cannot also carry five days of dish lists, and a cell
 * that shows the menu is a cell that cannot show the order.
 *
 * Below 640px the grid gives way to one day at a time: a strip of the week, that
 * day's menu, and a list of everyone. Both draw their cells with `renderCell`.
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
  const narrow = useNarrow();
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  const listRef = useRef<HTMLElement>(null);

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
      // Portions, because portions are what the caterer delivers; an admin
      // can record more than one on somebody's order.
      perDay.set(date, (perDay.get(date) ?? 0) + (cell.portions ?? 1));
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
    // The list has no columns. Forgetting the week means the grid, once the
    // screen widens again, opens on the day the list was showing.
    if (narrow) {
      scrolledFor.current = null;
      return;
    }
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
      //
      // Flush against it: the 8px of breathing room this used to leave was an
      // unreadable sliver of the day before.
      const sticky = gridRef.current?.querySelector<HTMLElement>("thead th:first-child");
      const gap = sticky?.getBoundingClientRect().width ?? 0;
      const origin = scroller.getBoundingClientRect().left + gap;
      // Today first when today and the target both fit: on a narrow grid that
      // is the day being handed out and the day being ordered, side by side.
      const todayColumn =
        target.serviceDate > today
          ? gridRef.current?.querySelector<HTMLElement>(`[data-service-date="${today}"]`)
          : null;
      const fromToday =
        todayColumn &&
        column.getBoundingClientRect().right - todayColumn.getBoundingClientRect().left <=
          scroller.clientWidth - gap;
      const lead = fromToday ? todayColumn : column;
      const delta = lead.getBoundingClientRect().left - origin;
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
      scrolledFor.current = from;
    });
    return () => cancelAnimationFrame(frame);
  }, [board, from, panelDay, today, narrow]);

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
        <BoardSkeleton narrow={narrow} days={days.length} />
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

  // What my own row says about a day, reduced to what a strip chip can carry.
  const myMark = (d: BoardDay): StripMark => {
    const mine = board.cells.get(cellKey(me.profileId, d.serviceDate)) ?? null;
    if (mine?.status === "placed" || receivedByDate.has(d.serviceDate)) return "ordered";
    const p = planState({
      day: d,
      today,
      hasOrderRow: mine !== null,
      weekdays: board.weekdays,
      exception: board.exceptions.get(d.serviceDate) ?? null,
    });
    if (p === "skipped") return "skipped";
    if (p === "standing" || p === "planned") return "predicted";
    if (mine === null && board.projected.has(d.serviceDate)) return "predicted";
    return "none";
  };

  // A sideways swipe on the list moves one day, which is what the grid's
  // horizontal scroll was for. It is an enhancement only: the strip is how a
  // keyboard or a screen reader changes day.
  const step = (day: BoardDay, by: number) => {
    const at = days.findIndex((d) => d.serviceDate === day.serviceDate);
    const next = days[at + by];
    if (!next) return;
    setPanelDate(next.serviceDate);
    // A cell that had focus may not exist on the next day, so focus moves to
    // the list, whose name is the day it now shows.
    if (listRef.current?.contains(document.activeElement)) listRef.current.focus();
  };

  /**
   * The phone's Board: one day, everybody in it, a row each. The grid turned
   * on its side, so a name and a dish both get the width of the screen
   * instead of 88px and 76px.
   */
  const dayList = (day: BoardDay) => {
    const tag = columnTag({ day, org, now });
    const tags = [day.serviceDate === today ? "Today" : null, tag].filter((t) => t !== null);
    return (
      <section
        ref={listRef}
        data-board-list
        tabIndex={-1}
        aria-label={`Who is eating on ${longDayLabel(day.serviceDate)}`}
        className="overflow-hidden rounded-lg border border-border bg-surface-raised outline-none"
        onTouchStart={(e) => {
          const t = e.touches[0];
          // One finger, on the list itself: a pinch is a zoom, and React
          // bubbles touches out of a portalled tooltip into this handler too.
          const own = e.currentTarget.contains(e.target as Node);
          swipeFrom.current = t && own && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchCancel={() => {
          swipeFrom.current = null;
        }}
        onTouchEnd={(e) => {
          const from = swipeFrom.current;
          const t = e.changedTouches[0];
          swipeFrom.current = null;
          if (!from || !t) return;
          const dx = t.clientX - from.x;
          // Mostly sideways and deliberate, so a vertical scroll never pages.
          if (Math.abs(dx) < 60 || Math.abs(t.clientY - from.y) > Math.abs(dx) / 2) return;
          step(day, dx < 0 ? 1 : -1);
        }}
      >
        <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2 text-xs font-semibold text-muted">
          <span>
            {columnLabel(day.serviceDate).dow} {columnLabel(day.serviceDate).dom}
            {tags.map((t) => (
              <span key={t} className="font-medium">
                {" \u00B7 "}
                {t}
              </span>
            ))}
          </span>
          <span className="tabular">{portionsWord(totals.get(day.serviceDate) ?? 0)}</span>
        </div>
        <ul>
          {board.members.map((member) => (
            <li
              key={member.profileId}
              className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <span className="py-2.5 text-sm leading-5 font-medium wrap-break-word">
                {member.name}
                {member.isMe && <span className="text-muted"> (you)</span>}
              </span>
              <div className="text-center">{renderCell(member, day, true)}</div>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  // One cell, drawn the same in the grid and in the phone's day list. `wide`
  // is the list, where a cell has room to lay its controls side by side.
  const renderCell = (member: BoardMember, day: BoardDay, wide = false) => {
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
      incoming !== null ? (
        <IncomingOffer
          wide={wide}
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
          wide={wide}
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
          wide={wide}
          member={member}
          day={day}
          cell={live}
          offeredTo={offer?.toName ?? null}
          toMe={offer?.toProfileId === me.profileId}
          onTap={() =>
            setFocus({ profileId: member.profileId, serviceDate: day.serviceDate })
          }
        />
      )
    );
  };

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
      {narrow && panelDay && (
        <DayStrip
          days={days}
          today={today}
          selected={panelDay.serviceDate}
          mine={(d) => myMark(d)}
          tag={(d) => columnTag({ day: d, org, now })}
          onSelect={setPanelDate}
        />
      )}

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

      {/* Capped at the screen, so the heads can stick. A container that
          scrolls sideways also becomes the one `sticky top-0` is measured
          against, and an uncapped one never scrolls vertically, so the heads
          rode off the top with the page and the columns lost their dates.
          Below 768px the cap leaves room for the header and the tab bar. */}
      {narrow && panelDay ? (
        dayList(panelDay)
      ) : (
        <Table containerClassName="max-h-[calc(100dvh-8rem)] bg-surface-raised md:max-h-[calc(100dvh-4rem)]">
          <TableHeader>
            <TableRow>
              <TableHead className={cn("sticky left-0 z-3 bg-surface-raised", WHO_WIDTH)}>Who</TableHead>
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
                      // 76px below 1024px, so a tablet shows most of the week.
                      // The floor is what holds it: every cell wraps, so
                      // without one a column shrinks to a single letter.
                      "min-w-19 p-0 text-center lg:min-w-28",
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
                      className="h-full w-full flex-col gap-0 rounded-none px-1 py-2 whitespace-normal text-muted lg:px-3"
                      onClick={() => setPanelDate(d.serviceDate)}
                    >
                      {/* One line below 1024px, so the two tag words below can
                          have a line each without the head growing taller. */}
                      <span className="flex items-baseline gap-1 lg:flex-col lg:items-center lg:gap-0">
                        <span className="block text-xs font-semibold">{dow}</span>
                        <span className="block text-base font-semibold text-text tabular">{dom}</span>
                      </span>
                      {/* A word, not a colour. One grey stood for "no menu",
                          "closed" and "cancelled" at once, and read as none of
                          them. The non-breaking space keeps every head the same
                          height when a day has nothing to say. Below 1024px
                          each word takes a line: `Today · Cooking` on one line was
                          what set the column's width. */}
                      <span className="block min-h-8 text-xs font-medium lg:min-h-0 lg:whitespace-nowrap">
                        {tags.length === 0
                          ? "\u00A0"
                          : tags.map((t, i) => (
                              <span key={t} className="block lg:inline">
                                {i > 0 && <span className="hidden lg:inline"> · </span>}
                                {t}
                              </span>
                            ))}
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
                <TableCell
                  className={cn(
                    "sticky left-0 z-2 bg-surface-raised py-3 align-top font-medium wrap-break-word",
                    WHO_WIDTH,
                  )}
                >
                  {member.name}
                  {member.isMe && <span className="text-muted"> (you)</span>}
                </TableCell>

                {days.map((day) => (
                  <TableCell key={day.serviceDate} className="p-1 text-center align-top">
                    {renderCell(member, day)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>

          <TableFooter>
            <TableRow>
              <TableCell className={cn("sticky left-0 z-2 bg-surface-raised font-medium", WHO_WIDTH)}>
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
      )}

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
          passedToMe={
            focusedLive !== null &&
            focusedLive.transferredToName !== null &&
            transfers?.live.get(focusedLive.orderId)?.toProfileId === me.profileId
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

// Narrower than Tailwind's `sm`, where the grid cannot show a day beside the
// names at a width a dish name can be read in. Off where there is no
// matchMedia, which keeps the grid under test.
const NARROW = "(max-width: 39.99rem)";
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW);
    const on = () => setNarrow(query.matches);
    on();
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return narrow;
}

type StripMark = "ordered" | "predicted" | "skipped" | "none";

/**
 * The week, as the day picker for the phone. Each day carries my own state in
 * the same language as my row on the grid: the accent fill for an order, a
 * dashed edge for a prediction, a strike for a skip.
 *
 * Only the selected day shows its stage word. Seven of them do not fit at 320,
 * and the chip that has one is the chip whose list is on screen. `Today` takes
 * the weekday's place, so it never competes with the stage for the same line.
 */
export function DayStrip({
  days,
  today,
  selected,
  mine,
  count,
  tag,
  onSelect,
}: {
  days: BoardDay[];
  today: string;
  selected: string;
  /** My own state per day, in my row's language. */
  mine?: (day: BoardDay) => StripMark;
  /** A count per day instead, for a screen that has no "my row". */
  count?: (day: BoardDay) => { value: number; said: string };
  tag: (day: BoardDay) => string | null;
  onSelect: (serviceDate: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Only a seven-day week at 320 overflows. Scrolled by hand rather than with
  // scrollIntoView, which would also scroll the page back up to the strip.
  useEffect(() => {
    const box = strip.current;
    const chip = box?.querySelector<HTMLElement>(`[data-strip-date="${selected}"]`);
    if (!box || !chip || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < b.left) box.scrollLeft -= b.left - c.left;
    else if (c.right > b.right) box.scrollLeft += c.right - b.right;
  }, [selected]);

  return (
    // The padding is room for the focus outline, which a scrolling box clips.
    <div ref={strip} role="group" aria-label="Day" className="-m-1 flex gap-0.5 overflow-x-auto p-1">
      {days.map((d) => {
        const { dow, dom } = columnLabel(d.serviceDate);
        const mark = mine?.(d) ?? "none";
        const counted = count?.(d) ?? null;
        const isToday = d.serviceDate === today;
        const on = d.serviceDate === selected;
        const stage = tag(d);
        return (
          <Button
            key={d.serviceDate}
            variant="ghost"
            data-strip-date={d.serviceDate}
            aria-pressed={on}
            aria-current={isToday ? "date" : undefined}
            aria-label={[
              `${dow} ${dom}`,
              isToday ? "today" : null,
              stage?.toLowerCase(),
              counted === null ? STRIP_SAID[mark] : counted.said,
            ]
              .filter((x) => x != null)
              .join(", ")}
            className={cn(
              "h-auto min-w-11 flex-1 flex-col gap-0 rounded-md border px-0 py-1.5 text-muted",
              STRIP_FILL[mark],
              on && "border-2 border-border-strong text-text",
              // Tapping the picked day again does nothing, so it does not
              // answer a hover either, which a mouse left on it after a click
              // read as a second state.
              on && (mark === "ordered" ? "hover:bg-accent-subtle" : "hover:bg-transparent"),
              // As wide as its stage word and never under 44px, which the
              // date's own floor below guarantees.
              on && stage !== null && counted === null && "min-w-fit",
            )}
            onClick={() => onSelect(d.serviceDate)}
          >
            <span className={cn("block text-xs font-semibold", isToday && "text-text")}>
              {isToday ? "Today" : dow}
            </span>
            <span
              className={cn(
                "block min-w-10 text-base font-semibold text-text tabular",
                mark === "skipped" && "line-through",
              )}
            >
              {dom}
            </span>
            {counted === null ? (
              <span className="block text-xs font-medium">{on && stage !== null ? stage : "\u00A0"}</span>
            ) : (
              <span className="block text-xs text-muted tabular">{counted.value}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}

const STRIP_FILL: Record<StripMark, string> = {
  ordered: "border-transparent bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/70",
  predicted: "border-dashed border-border-strong",
  skipped: "border-dashed border-border text-subtle",
  none: "border-border",
};

const STRIP_SAID: Record<StripMark, string> = {
  ordered: "you are eating",
  predicted: "from your standing order",
  skipped: "skipped",
  none: "not eating",
};

/**
 * What is on offer that day, without a tap.
 *
 * The grid answers who is eating and cannot also carry five days of dish
 * lists, so the menu lives beside it, above the grid. The column heads, or the
 * strip on a phone, switch which day it shows. With this here, a cell
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
export const CELL_TEXT = "block max-w-[min(100%,12rem)] wrap-anywhere";

/** `6 portions`, `1 portion`: what a day's heading and total count. */
export function portionsWord(n: number): string {
  return `${n} ${n === 1 ? "portion" : "portions"}`;
}

/** ` × 2` after a dish, only where somebody has more than one portion. */
function Times({ n }: { n: number | undefined }) {
  return n !== undefined && n > 1 ? <span className="tabular">{` × ${n}`}</span> : null;
}

function portionsSaid(n: number | undefined): string {
  return n !== undefined && n > 1 ? `, ${n} portions` : "";
}

/**
 * How someone wants their dish, under the dish in their cell.
 *
 * Unlike the dish, a note is held to two lines: it runs to 120 characters and
 * a grid column can be 76px wide, so in full it would set the height of every
 * row it sits on. Two lines hold `ít cơm, không trứng` whole, the ellipsis
 * says there is more, and the rest is never out of reach: the cell's label
 * speaks the note whole, the title shows it to a pointer, and the cell's
 * dialog prints it.
 */
export function CellNote({ note }: { note: string }) {
  return (
    <span
      title={note}
      className="line-clamp-2 max-w-[min(100%,12rem)] text-xs font-normal text-muted wrap-anywhere"
    >
      {note}
    </span>
  );
}

// Names wrap rather than truncate, inside a cap that keeps the days in view.
export const WHO_WIDTH = "max-w-40";

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
  wide = false,
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
  /** Laid out for the phone's day list, where the cell is a row's width. */
  wide?: boolean;
}) {
  const label = cell
    ? cell.dishName ?? "Dish to follow"
    : projected
      ? "Standing"
      : "Order lunch";
  const state = cell
    ? `${cell.dishName ?? "eating, no dish chosen"}${portionsSaid(cell.portions)}${cell.note !== null ? `, ${cell.note}` : ""}`
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
        className={cn(
          "h-auto min-h-10 w-full cursor-default flex-col items-center gap-0.5 border-solid border-transparent bg-accent-subtle px-2 py-2 text-xs font-medium whitespace-normal text-accent-subtle-fg hover:bg-accent-subtle hover:text-accent-subtle-fg lg:min-w-24",
          wide && "min-h-11",
        )}
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
          "h-auto min-h-10 w-full flex-col items-center gap-0.5 px-2 py-2 text-xs font-medium whitespace-normal has-[>svg]:px-2 lg:min-h-9 lg:min-w-24",
          wide && "min-h-11",
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
      <div
        className={cn(
          "flex w-full gap-1",
          wide ? "items-center" : "flex-col items-stretch lg:min-w-24 lg:flex-row lg:items-center",
        )}
      >
        <Action
          reason={null}
          pending={pending}
          variant="ghost"
          title="Choose a dish"
          aria-label={`${described}. Choose a dish`}
          className={cn(wide ? SPLIT_HALF_WIDE : SPLIT_HALF, OPEN_CELL)}
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
          className={cn(wide ? SPLIT_HALF_WIDE : SPLIT_HALF, OPEN_CELL)}
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
        "h-auto min-h-10 w-full flex-col items-center gap-0.5 px-2 py-2 text-xs font-medium whitespace-normal has-[>svg]:px-2 lg:min-h-0 lg:min-w-24",
        wide && "min-h-11",
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
            <Times n={cell.portions} />
          </span>
          {cell.note !== null && <CellNote note={cell.note} />}
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

// Stacked below 1024px, where side by side would make each half 32px wide.
// `has-[>svg]:px-0` because Button's own `has-[>svg]:px-3.5` is a different
// variant from `px-0`, so it survived the merge and held the cell at 108px.
const SPLIT_HALF = "h-10 flex-none px-0 has-[>svg]:px-0 lg:h-9 lg:flex-1";
const SPLIT_HALF_WIDE = "h-11 flex-1 px-0 has-[>svg]:px-0";

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
  toMe,
  onTap,
  wide = false,
}: {
  member: BoardMember;
  day: BoardDay;
  cell: BoardCell | null;
  offeredTo: string | null;
  /** The meal is handed, or on offer, to the reader. */
  toMe: boolean;
  onTap: () => void;
  /** Laid out for the phone's day list, where the cell is a row's width. */
  wide?: boolean;
}) {
  const mark = cellMark(cell, false);
  // An offer that has not been answered yet sits on a meal they still hold.
  // Your own name on somebody else's cell reads as a stranger's.
  const pendingWith = mark !== "passed" && offeredTo !== null ? (toMe ? "you" : offeredTo) : null;
  const gone = cell?.transferredToName != null && toMe ? "you" : cell?.transferredToName ?? null;
  const dish = day.dishes.find((d) => d.id === cell?.itemId)?.name ?? null;
  const onlyDish = day.dishes.length === 1;
  // The note travels with the dish: where the cell names no dish, because the
  // meal is passed or on offer, it names no note either, and the dialog has it.
  const note = dish !== null && gone === null ? cell?.note ?? null : null;
  const showNote = note !== null && pendingWith === null;
  // The dish is always spoken, even where a check mark is all that is drawn:
  // a check is only legible next to a column head naming the one dish, and a
  // screen reader is not reading the column head.
  const described = `${member.name}, ${formatDay(day.serviceDate)}: ${
    dish !== null && gone === null
      ? `eating ${dish}${portionsSaid(cell?.portions)}${note !== null ? `, ${note}` : ""}`
      : MARK_LABEL[mark]
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
        "flex h-auto min-h-9 w-full min-w-16 flex-col gap-0.5 rounded-md px-1 py-1.5 text-xs font-medium whitespace-normal",
        wide && "min-h-11 px-2",
        MARK_FILL[mark],
        pendingWith !== null && "border border-dashed border-accent",
      )}
      onClick={onTap}
    >
      {gone !== null || pendingWith !== null ? (
        <span className={CELL_TEXT}>to {gone ?? pendingWith}</span>
      ) : dish !== null ? (
        <>
          {onlyDish ? (
            <span className="flex items-center gap-0.5">
              <CheckIcon className="size-4" aria-hidden="true" />
              <Times n={cell?.portions} />
            </span>
          ) : (
            <span className={CELL_TEXT}>
              {dish}
              <Times n={cell?.portions} />
            </span>
          )}
          {showNote && <CellNote note={note} />}
        </>
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
  wide = false,
}: {
  offer: TransferRow;
  /** Why neither answer can be given any more, once the day is over. */
  reason: string | null;
  pending: boolean;
  onDecide: (status: "accepted" | "declined") => void;
  /** Laid out for the phone's day list, where the cell is a row's width. */
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-stretch gap-1 rounded-md border border-accent bg-accent-subtle p-1.5",
        wide ? "w-full" : "mx-auto max-w-52 lg:min-w-32",
      )}
    >
      <span className="text-xs text-accent-subtle-fg wrap-anywhere">
        {offer.fromName} offers you {offer.dishName ?? "their lunch"}
      </span>
      {/* A grid in the list, because Button will not shrink and two of them
          overflowed the cell at 320. */}
      <div className={cn("gap-1", wide ? "grid grid-cols-2" : "flex flex-col lg:flex-row")}>
        <Action
          reason={reason}
          pending={pending}
          size="sm"
          className={cn("px-2 lg:flex-1 lg:px-3", wide ? "h-11 min-w-0 px-1" : "flex-none")}
          onClick={() => onDecide("accepted")}
        >
          Accept
        </Action>
        <Action
          reason={reason}
          pending={pending}
          size="sm"
          variant="outline"
          className={cn("px-2 lg:flex-1 lg:px-3", wide ? "h-11 min-w-0 px-1" : "flex-none")}
          onClick={() => onDecide("declined")}
        >
          Decline
        </Action>
      </div>
    </div>
  );
}

/** Shaped like the layout it stands in for, so nothing jumps when the data lands. */
export function BoardSkeleton({ narrow, days }: { narrow: boolean; days: number }) {
  if (narrow) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex gap-0.5">
          {Array.from({ length: days }, (_, i) => (
            <Skeleton key={i} className="h-17 flex-1" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-3">
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-11 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <Table containerClassName="bg-surface-raised">
      <TableHeader>
        <TableRow>
          <TableHead className={WHO_WIDTH}>Who</TableHead>
          {Array.from({ length: 5 }, (_, i) => (
            <TableHead key={i} className="min-w-19 lg:min-w-28">
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
