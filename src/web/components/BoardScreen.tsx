import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dice5Icon, PlusIcon } from "lucide-react";
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
  setOrder,
  type Board,
  type BoardCell,
  type BoardDay,
  type BoardMember,
  type TransferRow,
} from "../api.js";
import { DishDialog } from "./DishDialog.js";
import { WeekNav } from "./WeekNav.js";
import { HandoverDialog } from "./HandoverDialog.js";
import {
  cellMark,
  cellReason,
  columnTag,
  columnLabel,
  cutoffLabel,
  longDayLabel,
  nextOrderableDay,
  passOnReason,
  pickDish,
  visibleDays,
  weekRangeLabel,
  type Dish,
  type Mark,
} from "./boardModel.js";
import { now as appNow } from "../../shared/clock.js";
import { formatPrice } from "../../shared/money.js";
import { addDays, formatDay, todayIn, weekStart } from "../../shared/dates.js";
import { isAdmin, type Me, type MyOrder, type Org, type Role } from "../../shared/types.js";

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
export function BoardScreen({ me, org, role }: { me: Me; org: Org; role: Role }) {
  const admin = isAdmin(role);
  const today = todayIn(org.timezone, appNow());
  const thisWeek = weekStart(today, org.billingWeekStartsOn);

  const [weekOf, setWeekOf] = useState(thisWeek);
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

  const load = useCallback(async () => {
    try {
      const [nextBoard, nextTransfers] = await Promise.all([
        fetchBoard({ orgId: org.id, from, to, meProfileId: me.profileId, today }),
        // The open billing week, not today onward: a Tuesday meal can still be
        // handed over on Thursday, which is what the database allows and what
        // people actually remember to do.
        fetchTransfers({ orgId: org.id, meProfileId: me.profileId, openPeriodStart: thisWeek }),
      ]);
      setBoard(nextBoard);
      setTransfers(nextTransfers);
      setLoadError(null);
    } catch (e) {
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

  const busy = place.pending || stop.pending || pass.pending || decide.pending;

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
          board.projected.has(d),
    );
  }, [board, from]);

  // The days this reader cannot act on. One rule feeds the recessive column,
  // the panel's opening day and the column the grid scrolls to, so the three
  // cannot drift apart. An admin is inside the window on every day, so for
  // them nothing recedes.
  const closedDays = useMemo(
    () =>
      new Set(
        days
          .filter(
            (d) => cellReason({ day: d, isAdminHere: admin, now, timeZone: org.timezone }) !== null,
          )
          .map((d) => d.serviceDate),
      ),
    [days, admin, now, org.timezone],
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

      <Table containerClassName="bg-surface-raised">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-3 bg-surface-raised">Who</TableHead>
            {days.map((d) => {
              const { dow, dom } = columnLabel(d.serviceDate);
              const isToday = d.serviceDate === today;
              const tag = columnTag({ day: d, isAdminHere: admin, now });
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
              <TableCell className="sticky left-0 z-2 max-w-40 truncate bg-surface-raised font-medium">
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
                  isAdminHere: admin,
                  now,
                  timeZone: org.timezone,
                });

                return (
                  <TableCell key={day.serviceDate} className="p-1 text-center">
                    {incoming !== null ? (
                      <IncomingOffer
                        offer={incoming}
                        pending={busy}
                        onDecide={(status) => void enqueue(() => decide.run({ id: incoming.id, status }))}
                      />
                    ) : member.isMe ? (
                      <MyCell
                        day={day}
                        cell={live}
                        projected={board.projected.has(day.serviceDate)}
                        offeredTo={offer?.toName ?? null}
                        // A meal is always worth opening, to read the note or
                        // take an offer back, whatever the ordering window says.
                        reason={live !== null ? null : orderReason}
                        pending={busy}
                        onOpen={() =>
                          setFocus({ profileId: member.profileId, serviceDate: day.serviceDate })
                        }
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
            reason={cellReason({ day: panelDay, isAdminHere: admin, now, timeZone: org.timezone })}
          />
        )
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
          orderReason={cellReason({ day: focused.day, isAdminHere: admin, now, timeZone: org.timezone })}
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
          // Remounted per cell, so a half-made choice cannot follow you to the
          // next colleague.
          key={`${focus?.profileId}|${focus?.serviceDate}`}
          open
          onOpenChange={(open) => !open && setFocus(null)}
          org={org}
          day={focused.day}
          member={focused.member}
          theirCell={focusedLive}
          myCell={focusedMine}
          admin={admin}
          giveReason={
            focusedMine === null
              ? `You have nothing ordered on ${formatDay(focused.day.serviceDate)}`
              : passOnReason({
                  cell: focusedMine,
                  serviceDate: focused.day.serviceDate,
                  openWeekStart: thisWeek,
                  offeredTo: transfers?.live.get(focusedMine.orderId)?.toName ?? null,
                  mayAct: true,
                })
          }
          passReason={passOnReason({
            cell: focusedLive,
            serviceDate: focused.day.serviceDate,
            openWeekStart: thisWeek,
            offeredTo: focusedLive ? transfers?.live.get(focusedLive.orderId)?.toName ?? null : null,
            mayAct: admin,
          })}
          colleagues={board.members.filter((m) => m.profileId !== focused.member?.profileId)}
          offer={
            focusedLive && focusedLive.transferredToName === null
              ? transfers?.live.get(focusedLive.orderId) ?? null
              : null
          }
          mayWithdraw={
            admin ||
            (focusedLive
              ? transfers?.live.get(focusedLive.orderId)?.fromProfileId === me.profileId
              : false)
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
          onPassOn={(toProfileId, toName) => {
            if (!focusedLive) return;
            void enqueue(() => pass.run({ orderId: focusedLive.orderId, toProfileId, toName }));
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
function MenuPanel({ day, org, reason }: { day: BoardDay; org: Org; reason: string | null }) {
  // The reason, when there is one, already says the window is shut and when it
  // shut, in the database's own words.
  const when =
    reason ??
    (day.orderCutoffAt === null ? null : `Closes ${cutoffLabel(day.orderCutoffAt, org.timezone)}`);

  return (
    <section
      aria-label={`Menu for ${longDayLabel(day.serviceDate)}`}
      className="rounded-lg border border-border bg-surface-raised p-4 md:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border pb-3">
        <h2 className="text-lg font-semibold">{longDayLabel(day.serviceDate)}</h2>
        {when !== null && <p className="text-sm text-muted">{when}</p>}
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
              <span className="min-w-0 truncate font-medium">{dish.name}</span>
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
  projected,
  offeredTo,
  reason,
  pending,
  onOpen,
  onOrder,
}: {
  day: BoardDay;
  cell: BoardCell | null;
  projected: boolean;
  offeredTo: string | null;
  reason: string | null;
  pending: boolean;
  /** Open the dish dialog on this cell. */
  onOpen: () => void;
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
          <span className={cn("block max-w-full truncate", offeredTo !== null && "line-through")}>
            {label}
          </span>
          {cell.note !== null && (
            <span className="block max-w-full truncate text-xs font-normal text-muted">
              {cell.note}
            </span>
          )}
          {offeredTo !== null && (
            <span className="block max-w-full truncate text-xs font-normal">to {offeredTo}</span>
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
 * A colleague's day.
 *
 * Always a control, empty or not: you hand a meal over by tapping the person
 * you are giving it to, and "I am out, you have mine" is usually said to
 * somebody who was not already eating. An empty cell therefore has to look
 * empty and still read as tappable, which is what the hairline is for.
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
  const described = `${member.name}, ${formatDay(day.serviceDate)}: ${MARK_LABEL[mark]}`;
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
        "h-9 w-full min-w-16 rounded-md px-1 text-xs font-medium",
        MARK_FILL[mark],
        pendingWith !== null && "border border-dashed border-accent",
      )}
      onClick={onTap}
    >
      {gone !== null || pendingWith !== null ? (
        <span className="block max-w-full truncate">to {gone ?? pendingWith}</span>
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
 * The headcount, read as blocks of colour rather than counted as dots.
 *
 * Fill carries it, because fill is the channel that survives being scanned a
 * whole week at a time. Size does not: five sizes of dot is four too many, and
 * the reader ends up looking for a legend that should not need to exist.
 */
const MARK_FILL: Record<Mark, string> = {
  ordered: "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/70",
  // A real headcount with an unresolved dish, so filled, but visibly unfinished.
  eating: "border border-dashed border-border-strong bg-accent-subtle/50 text-accent-subtle-fg",
  // Spent: the meal is on somebody else's bill now.
  passed: "bg-surface-sunken text-subtle",
  projected: "border border-dashed border-border text-subtle",
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
  pending,
  onDecide,
}: {
  offer: TransferRow;
  pending: boolean;
  onDecide: (status: "accepted" | "declined") => void;
}) {
  return (
    <div className="flex min-w-32 flex-col items-stretch gap-1 rounded-md border border-accent bg-accent-subtle p-1.5">
      <span className="text-xs text-accent-subtle-fg">
        {offer.fromName} offers you {offer.dishName ?? "their lunch"}
      </span>
      <div className="flex gap-1">
        <Action
          reason={null}
          pending={pending}
          size="sm"
          className="flex-1"
          onClick={() => onDecide("accepted")}
        >
          Accept
        </Action>
        <Action
          reason={null}
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
