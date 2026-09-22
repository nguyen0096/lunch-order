import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
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
import {
  cellMark,
  cellReason,
  columnLabel,
  passOnReason,
  pickDish,
  visibleDays,
  weekRangeLabel,
  type Dish,
  type Mark,
} from "./boardModel.js";
import { now as appNow } from "../../shared/clock.js";
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
 * caterer. Today is a rule down the column edge rather than a colour, since
 * "ordered" already owns the accent and one hue cannot carry two meanings.
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
      existing: MyOrder | null;
      randomised: boolean;
    }) => {
      await setOrder({
        orgId: org.id,
        menuId: a.day.menuId!,
        serviceDate: a.day.serviceDate,
        profileId: a.profileId,
        itemId: a.itemId,
        existing: a.existing,
      });
      return a;
    },
    {
      success: (a) => (a.randomised ? `Ordered ${a.dishName} · tap to change` : `Ordered ${a.dishName}`),
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
    async (a: { orderId: number; toProfileId: string; toName: string; note: string | null }) => {
      await createTransfer({
        orgId: org.id,
        orderId: a.orderId,
        toProfileId: a.toProfileId,
        createdBy: me.profileId,
        reason: a.note,
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
    (day: BoardDay, member: BoardMember, cell: BoardCell | null, dish: Dish, randomised: boolean) => {
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
        dishName: dish.name,
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
            existing,
            randomised,
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
  // you discover a horizontal scroll. Bring that column into view instead.
  // Keyed on the week rather than on `days`, which is rebuilt on every fetch,
  // and on `now`, which changes every render.
  const gridRef = useRef<HTMLElement>(null);
  // Once per week shown, and only after the board has arrived: on the first
  // render there is a skeleton rather than a table, so there is no column to
  // scroll to yet. Tracking which week has been handled keeps a later optimistic
  // update, which also replaces `board`, from yanking the grid out from under
  // somebody who has scrolled it themselves.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (board === null || scrolledFor.current === from) return;
    const target =
      days.find(
        (d) => cellReason({ day: d, isAdminHere: admin, now: appNow(), timeZone: org.timezone }) === null,
      ) ?? days.find((d) => d.serviceDate === today);
    if (target === undefined) return;

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
      const sticky = gridRef.current?.querySelector<HTMLElement>("thead th:first-child");
      scroller.scrollLeft = Math.max(0, column.offsetLeft - (sticky?.offsetWidth ?? 0) - 8);
      scrolledFor.current = from;
    });
    return () => cancelAnimationFrame(frame);
  }, [board, days, from, admin, org.timezone, today]);

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
              return (
                <TableHead
                  key={d.serviceDate}
                  scope="col"
                  data-service-date={d.serviceDate}
                  aria-current={isToday ? "date" : undefined}
                  className={cn("min-w-28 text-center", isToday && "border-l-2 border-l-accent")}
                >
                  <span className="block text-xs font-semibold text-muted">{dow}</span>
                  <span className="block text-base font-semibold text-text tabular">{dom}</span>
                  {isToday && <span className="sr-only">Today</span>}
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
                const passReason = passOnReason({
                  cell: live,
                  serviceDate: day.serviceDate,
                  openWeekStart: thisWeek,
                  offeredTo: offer?.toName ?? null,
                  mayAct: member.isMe || admin,
                });

                return (
                  <TableCell
                    key={day.serviceDate}
                    className={cn(
                      "p-1 text-center",
                      day.serviceDate === today && "border-l-2 border-l-accent",
                    )}
                  >
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
                        reason={orderReason !== null && passReason !== null ? orderReason : null}
                        pending={busy}
                        onTap={() => {
                          if (live !== null || orderReason !== null) {
                            setFocus({ profileId: member.profileId, serviceDate: day.serviceDate });
                            return;
                          }
                          const dish = pickDish(day.dishes);
                          if (dish === null) return;
                          order(day, member, cell, dish, day.dishes.length > 1);
                        }}
                      />
                    ) : (
                      <TheirCell
                        member={member}
                        day={day}
                        cell={live}
                        offeredTo={offer?.toName ?? null}
                        // Ordering for somebody else is not on offer here; an
                        // admin's business with a colleague's cell is the swap,
                        // and a cell with no meal in it has no swap to record.
                        reason={admin && live !== null ? passReason : null}
                        interactive={admin && live !== null}
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
              <TableCell
                key={d.serviceDate}
                className={cn(
                  "text-center font-medium tabular",
                  d.serviceDate === today && "border-l-2 border-l-accent",
                )}
              >
                {totals.get(d.serviceDate) ?? 0}
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </Table>

      {days.every((d) => d.menuId === null) && (
        <EmptyState heading="No menus this week">
          An admin pastes the caterer's message on the Menu screen and publishes it, and these
          columns fill in.
        </EmptyState>
      )}

      {focused?.member && focused.day && (
        <DishDialog
          // Remounted per cell, so the pass-on form starts empty on each one
          // rather than carrying a name over to the wrong meal.
          key={`${focus?.profileId}|${focus?.serviceDate}`}
          open
          onOpenChange={(open) => !open && setFocus(null)}
          org={org}
          day={focused.day}
          member={focused.member}
          cell={focusedCell?.status === "placed" ? focusedCell : null}
          orderReason={cellReason({ day: focused.day, isAdminHere: admin, now, timeZone: org.timezone })}
          passReason={passOnReason({
            cell: focusedCell?.status === "placed" ? focusedCell : null,
            serviceDate: focused.day.serviceDate,
            openWeekStart: thisWeek,
            offeredTo: focusedCell ? transfers?.live.get(focusedCell.orderId)?.toName ?? null : null,
            mayAct: focused.member.isMe || admin,
          })}
          colleagues={board.members.filter((m) => m.profileId !== focused.member?.profileId)}
          offer={
            focusedCell && focusedCell.transferredToName === null
              ? transfers?.live.get(focusedCell.orderId) ?? null
              : null
          }
          recording={!focused.member.isMe}
          pending={busy}
          onPick={(itemId) => {
            const day = focused.day;
            const member = focused.member;
            const dish = day?.dishes.find((x) => x.id === itemId);
            if (!day || !member || !dish) return;
            setFocus(null);
            order(day, member, focusedCell, dish, false);
          }}
          onSurprise={() => {
            const day = focused.day;
            const member = focused.member;
            if (!day || !member) return;
            const dish = pickDish(day.dishes, {
              excludeId: day.dishes.find((x) => x.name === focusedCell?.dishName)?.id ?? null,
            });
            if (!dish) return;
            setFocus(null);
            order(day, member, focusedCell, dish, true);
          }}
          onNotEating={() => {
            if (focused.day && focused.member && focusedCell) {
              notEating(focused.day, focused.member, focusedCell);
            }
          }}
          onPassOn={(toProfileId, toName, note) => {
            if (!focusedCell) return;
            void enqueue(() => pass.run({ orderId: focusedCell.orderId, toProfileId, toName, note }));
          }}
          onWithdraw={(id) => void enqueue(() => decide.run({ id, status: "cancelled" }))}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ pieces */

function WeekNav({
  label,
  away,
  onPrev,
  onNext,
  onReset,
}: {
  label: string;
  away: boolean;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" aria-label="Previous week" onClick={onPrev}>
        <ChevronLeftIcon />
      </Button>
      <h1 className="min-w-32 text-center text-lg font-semibold tabular">{label}</h1>
      <Button variant="ghost" size="icon" aria-label="Next week" onClick={onNext}>
        <ChevronRightIcon />
      </Button>
      {/* Only once you have left, because a reset to where you already are is a
          control that does nothing, and the column rule already says which day
          is today. */}
      {away && (
        <Button variant="link" className="ml-1" onClick={onReset}>
          This week
        </Button>
      )}
    </div>
  );
}

function MyCell({
  day,
  cell,
  projected,
  offeredTo,
  reason,
  pending,
  onTap,
}: {
  day: BoardDay;
  cell: BoardCell | null;
  projected: boolean;
  offeredTo: string | null;
  reason: string | null;
  pending: boolean;
  onTap: () => void;
}) {
  const label = cell
    ? cell.dishName ?? "Dish to follow"
    : projected
      ? "Standing"
      : "Order lunch";

  return (
    <Action
      reason={reason}
      pending={pending}
      variant="ghost"
      aria-label={`${formatDay(day.serviceDate)}: ${cell ? cell.dishName ?? "eating, no dish chosen" : projected ? "from your standing order" : "not eating"}`}
      className={cn(
        "h-auto w-full min-w-24 flex-col items-center gap-0.5 px-2 py-2 text-xs font-medium whitespace-normal",
        cell
          ? "bg-accent-subtle text-accent-subtle-fg hover:bg-accent-subtle/70"
          : reason === null
            // An empty cell you can use has to outweigh one you cannot. Action
            // draws unavailable as a dashed border-strong edge, which is right
            // for a button standing on its own and wrong in a grid: against
            // cells that are only a glyph, the days you CANNOT order on became
            // the loudest thing on the screen. Measured before this: disabled
            // cells bordered #9E8363, the one open day #E6DED0.
            ? "border border-border-strong text-muted hover:bg-accent-subtle hover:text-text"
            : "border-border text-subtle",
        projected && !cell && "border border-dashed border-border-strong",
      )}
      onClick={onTap}
    >
      {cell ? (
        <>
          <span className={cn("block max-w-full truncate", offeredTo !== null && "line-through")}>
            {label}
          </span>
          {offeredTo !== null && (
            <span className="block max-w-full truncate text-xs font-normal">→ {offeredTo}</span>
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

function TheirCell({
  member,
  day,
  cell,
  offeredTo,
  reason,
  interactive,
  onTap,
}: {
  member: BoardMember;
  day: BoardDay;
  cell: BoardCell | null;
  offeredTo: string | null;
  reason: string | null;
  interactive: boolean;
  onTap: () => void;
}) {
  const mark = cellMark(cell, false);
  const described = `${member.name}, ${formatDay(day.serviceDate)}: ${MARK_LABEL[mark]}`;

  if (!interactive) {
    return (
      <span className="flex h-9 items-center justify-center" title={described}>
        <MarkGlyph mark={mark} />
        <span className="sr-only">{described}</span>
      </span>
    );
  }

  return (
    <Action
      reason={reason}
      variant="ghost"
      aria-label={`${described}. Pass it on`}
      className="h-9 w-full min-w-16"
      onClick={onTap}
    >
      <MarkGlyph mark={mark} />
      {offeredTo !== null && <span className="text-xs font-normal text-muted">→</span>}
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

/** Fill means ordered; the today rule is a stroke. Two states, one hue. */
function MarkGlyph({ mark }: { mark: Mark }) {
  if (mark === "ordered") {
    return <span aria-hidden="true" className="block size-2.5 rounded-full bg-accent" />;
  }
  if (mark === "eating") {
    return (
      <span aria-hidden="true" className="block size-2.5 rounded-full border-2 border-accent" />
    );
  }
  if (mark === "passed") {
    return <ArrowRightIcon aria-hidden="true" className="size-3.5 text-muted" />;
  }
  if (mark === "projected") {
    return (
      <span
        aria-hidden="true"
        className="block size-2.5 rounded-full border border-dashed border-border-strong"
      />
    );
  }
  return <span aria-hidden="true" className="block size-1 rounded-full bg-border-strong" />;
}

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
