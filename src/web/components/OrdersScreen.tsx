import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  Action,
  Badge,
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
  answerPass,
  cellKey,
  correctMeal,
  correctMealOffMenu,
  fetchOrdersWeek,
  humanError,
  recordPass,
  removeMeal,
  repriceDish,
  undoPass,
  type BoardDay,
  type CorrectionEntry,
  type OrdersMember,
  type OrdersWeek,
  type PassAnswer,
  type PassRecord,
  type RecordedMeal,
} from "../api.js";
import { WeekNav } from "./WeekNav.js";
import { BoardSkeleton, CELL_TEXT, CellNote, DayStrip, WHO_WIDTH, useNarrow } from "./BoardScreen.js";
import {
  columnLabel,
  columnTag,
  longDayLabel,
  visibleDays,
  weekFromParam,
  weekRangeLabel,
} from "./boardModel.js";
import { OrderDialog, type MealCorrection } from "./orders/OrderDialog.js";
import { RepriceDialog } from "./orders/RepriceDialog.js";
import {
  balanceNow,
  dayAccess,
  dayWords,
  isOver,
  kindWord,
  lastFinishedDay,
  openingDay,
  peopleWord,
  portions as portionsWord,
  provenanceWord,
  settledNotice,
  stagePhrase,
  stageSentence,
  type DayAccess,
} from "./orders/model.js";
import { arrivedLabel } from "./payments/labels.js";
import { allParams } from "../useHashRoute.js";
import type { ScreenProps } from "./screenProps.js";
import { now as appNow } from "../../shared/clock.js";
import { PRICE_PENDING, formatMoney } from "../../shared/money.js";
import { addDays, todayIn, weekNumberOf, weekStart } from "../../shared/dates.js";

type Focus = { profileId: string; serviceDate: string };
type Received = PassRecord & { portions: number };

/**
 * Everyone's lunch for one week, for an admin to order or put right on their
 * behalf.
 *
 * The Board's frame, turned to a different job: the panel is the day's
 * prices, every cell is a record rather than the reader's own action, and no
 * cell wears the accent fill, the admin's own included. A tap never writes;
 * it opens one dialog for that person and that day, which says in figures
 * what a save would do to whose money before it does it. The database writes,
 * bills, audits and tells the member; the balance it hands back is the only
 * figure this screen states as fact.
 *
 * The Board keeps the member's clock for admins too. This is where an admin
 * steps outside it, and every such step is on the record.
 */
export function OrdersScreen({ me, org }: ScreenProps) {
  const today = todayIn(org.timezone, appNow());
  const thisWeek = weekStart(today, org.billingWeekStartsOn);

  // `?week=` is how Payments opens the week being settled.
  const [weekOf, setWeekOf] = useState(
    () => weekFromParam(allParams().get("week"), org.billingWeekStartsOn) ?? thisWeek,
  );
  const [week, setWeek] = useState<OrdersWeek | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelDate, setPanelDate] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [repricingId, setRepricingId] = useState<number | null>(null);
  const [now, setNow] = useState(() => appNow());
  const narrow = useNarrow();

  const from = weekOf;
  const to = addDays(weekOf, 6);

  // The cutoff and the end of the day are wall-clock events, and the warning
  // and the day words follow them for anybody who leaves the tab open.
  useEffect(() => {
    const t = setInterval(() => setNow(appNow()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Only the newest load may draw, so paging weeks faster than the network
  // answers never shows one week's meals under another week's dates.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const next = await fetchOrdersWeek({ orgId: org.id, from, to, meProfileId: me.profileId, today });
      if (mine !== latest.current) return;
      setWeek(next);
      setLoadError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      setLoadError(humanError(e));
    }
  }, [org.id, from, to, me.profileId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  function goToWeek(start: string) {
    setWeekOf(start);
    setPanelDate(null);
    setFocus(null);
  }

  // A `?week=` edited or followed while this screen is already open moves it
  // too: the screen stays mounted across a hash change within the page.
  const shown = useRef(weekOf);
  shown.current = weekOf;
  useEffect(() => {
    const follow = () => {
      const asked = weekFromParam(allParams().get("week"), org.billingWeekStartsOn);
      if (asked === null || asked === shown.current) return;
      setWeekOf(asked);
      setPanelDate(null);
      setFocus(null);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [org.billingWeekStartsOn]);

  /* ------------------------------------------------------------- mutations */

  const nameOf = useCallback(
    (profileId: string) => week?.members.find((m) => m.profileId === profileId)?.name ?? "A colleague",
    [week],
  );
  const done = () => {
    setFocus(null);
    void load();
  };

  const correct = useAction(
    async (a: { person: OrdersMember; serviceDate: string; correction: MealCorrection }) => {
      const { correction: c } = a;
      if (c.menuItemId === null) {
        // Never a price of zero: an off-menu dish with no price is a free
        // lunch on somebody's bill, and the dialog refuses to send one.
        if (c.priceMinor === null) throw new Error("Say what the dish cost before saving.");
        const saved = await correctMealOffMenu({
          orgId: org.id,
          serviceDate: a.serviceDate,
          profileId: a.person.profileId,
          dishName: c.dishName,
          priceMinor: c.priceMinor,
          quantity: c.quantity,
          note: c.note,
          reason: c.reason,
        });
        return { name: a.person.name, balanceMinor: saved.balanceMinor };
      }
      const saved = await correctMeal({
        orgId: org.id,
        serviceDate: a.serviceDate,
        profileId: a.person.profileId,
        menuItemId: c.menuItemId,
        quantity: c.quantity,
        note: c.note,
        reason: c.reason,
      });
      return { name: a.person.name, balanceMinor: saved.balanceMinor };
    },
    {
      success: (r) => `Saved ${r.name}'s meal. ${r.name} ${balanceNow(r.balanceMinor, org.currency)}.`,
      onSuccess: done,
    },
  );

  const remove = useAction(
    async (a: { person: OrdersMember; meal: RecordedMeal; reason: string | null }) => {
      const removed = await removeMeal({ orderId: a.meal.orderId, reason: a.reason });
      return { name: a.person.name, balanceMinor: removed.balanceMinor };
    },
    {
      success: (r) => `Removed ${r.name}'s meal. ${r.name} ${balanceNow(r.balanceMinor, org.currency)}.`,
      onSuccess: done,
    },
  );

  const pass = useAction(
    async (a: { person: OrdersMember; meal: RecordedMeal; toProfileId: string; reason: string | null }) => {
      await recordPass({ orderId: a.meal.orderId, toProfileId: a.toProfileId, reason: a.reason });
      return { from: a.person.name, dish: a.meal.dishName ?? "meal", to: nameOf(a.toProfileId) };
    },
    {
      success: (r) => `Passed ${r.from}'s ${r.dish} to ${r.to}.`,
      onSuccess: done,
    },
  );

  const undo = useAction(
    async (a: { person: OrdersMember; meal: RecordedMeal; pass: PassRecord; reason: string | null }) => {
      await undoPass({ transferId: a.pass.id, reason: a.reason });
      return { name: a.person.name, dish: a.meal.dishName ?? "this meal" };
    },
    {
      success: (r) => `Undid the pass. ${r.name} pays for ${r.dish} again.`,
      onSuccess: done,
    },
  );

  const answer = useAction(
    async (a: { person: OrdersMember; pass: PassRecord; answer: PassAnswer; reason: string | null }) => {
      await answerPass({ transferId: a.pass.id, answer: a.answer, reason: a.reason });
      return { answer: a.answer, from: a.person.name, to: nameOf(a.pass.toProfileId) };
    },
    {
      success: (r) =>
        r.answer === "accept"
          ? `Accepted ${r.from}'s offer for ${r.to}.`
          : r.answer === "decline"
            ? `Declined ${r.from}'s offer for ${r.to}.`
            : `Withdrew ${r.from}'s offer.`,
      onSuccess: done,
    },
  );

  const reprice = useAction(
    async (a: { dish: { id: number; name: string }; priceMinor: number; reason: string | null }) => {
      const r = await repriceDish({ menuItemId: a.dish.id, priceMinor: a.priceMinor, reason: a.reason });
      return { name: a.dish.name, ...r };
    },
    {
      success: (r) =>
        r.lines === 0
          ? `${r.name} repriced. No meal on this day was on it.`
          : `${r.name} repriced on ${r.lines === 1 ? "1 meal" : `${r.lines} meals`}, across ${peopleWord(r.people)}.`,
      onSuccess: () => {
        setRepricingId(null);
        void load();
      },
    },
  );

  const busy = correct.pending || remove.pending || pass.pending || undo.pending || answer.pending;

  // A refusal usually means the week moved under the dialog (somebody else's
  // change, a settle, the cutoff), so it is read again. The dialog stays open
  // with the database's sentence, as Payments does.
  const reloadIfRefused = (write: Promise<{ ok: boolean }>) => {
    void write.then((r) => {
      if (!r.ok) void load();
    });
  };
  const resetErrors = () => {
    correct.reset();
    remove.reset();
    pass.reset();
    undo.reset();
    answer.reset();
  };

  /* ------------------------------------------------------------- rendering */

  const days = useMemo(() => {
    const source =
      week?.days ??
      Array.from({ length: 7 }, (_, i): BoardDay => ({
        serviceDate: addDays(from, i),
        menuId: null,
        status: null,
        orderCutoffAt: null,
        dishes: [],
      }));
    return visibleDays(source, (d) => source.some((x) => x.serviceDate === d && x.menuId !== null));
  }, [week, from]);

  const settled = week?.period?.status === "closed";
  const access = useMemo(() => {
    const out = new Map<string, DayAccess>();
    for (const d of days) out.set(d.serviceDate, dayAccess({ day: d, org, now, settled }));
    return out;
  }, [days, org, now, settled]);

  const panelDay = useMemo(() => {
    const chosen = days.find((d) => d.serviceDate === panelDate);
    if (chosen) return chosen;
    const opening = openingDay({ days, lastFinished: lastFinishedDay({ today, now, org }), today, org, now });
    return days.find((d) => d.serviceDate === opening) ?? days[0] ?? null;
  }, [days, panelDate, today, now, org]);

  const perDay = useMemo(() => {
    const out = new Map<string, { portions: number; money: number; people: number }>();
    for (const meal of week?.meals.values() ?? []) {
      const t = out.get(meal.serviceDate) ?? { portions: 0, money: 0, people: 0 };
      // An order with no dish is still somebody eating, so it counts as one.
      t.portions += Math.max(meal.quantity, 1);
      t.money += meal.amountMinor ?? 0;
      t.people += 1;
      out.set(meal.serviceDate, t);
    }
    return out;
  }, [week]);

  // Meals passed to somebody and accepted, on the recipient's row by day,
  // with the portions of the meal each one moved.
  const received = useMemo(() => {
    const out = new Map<string, Received[]>();
    if (week === null) return out;
    for (const p of week.passes.values()) {
      if (p.status !== "accepted") continue;
      const meal = [...week.meals.values()].find((m) => m.orderId === p.orderId);
      if (!meal) continue;
      const key = cellKey(p.toProfileId, meal.serviceDate);
      out.set(key, [...(out.get(key) ?? []), { ...p, portions: Math.max(1, meal.quantity) }]);
    }
    return out;
  }, [week]);

  const nav = (
    <WeekNav
      label={weekRangeLabel(days[0]?.serviceDate ?? from, days[days.length - 1]?.serviceDate ?? to)}
      weekNumber={weekNumberOf(weekOf)}
      away={weekOf !== thisWeek}
      onPrev={() => goToWeek(addDays(weekOf, -7))}
      onNext={() => goToWeek(addDays(weekOf, 7))}
      onReset={() => goToWeek(thisWeek)}
    />
  );

  if (loadError !== null) {
    return (
      <section className="flex flex-col gap-4">
        {nav}
        <EmptyState
          heading="The week did not load"
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

  if (week === null) {
    return (
      <section className="flex flex-col gap-4">
        {nav}
        <Skeleton className="h-40 w-full" />
        <BoardSkeleton narrow={narrow} days={days.length} />
      </section>
    );
  }

  const notice = settledNotice(week.period, org.timezone);
  const dayEntries = (date: string) => week.entries.filter((e) => e.serviceDate === date);
  const hasLunchOn = (date: string) => (profileId: string) =>
    week.meals.has(cellKey(profileId, date)) || received.has(cellKey(profileId, date));

  const renderCell = (member: OrdersMember, day: BoardDay, wide = false) => {
    const key = cellKey(member.profileId, day.serviceDate);
    const meal = week.meals.get(key) ?? null;
    return (
      <OrderCell
        member={member}
        day={day}
        meal={meal}
        pass={meal ? week.passes.get(meal.orderId) ?? null : null}
        received={received.get(key) ?? []}
        access={access.get(day.serviceDate) ?? { mode: "read" }}
        provenance={meal ? provenanceWord(meal, week.entries) : null}
        nameOf={nameOf}
        wide={wide}
        onOpen={() => {
          resetErrors();
          setFocus({ profileId: member.profileId, serviceDate: day.serviceDate });
        }}
      />
    );
  };

  const focusDay = focus ? days.find((d) => d.serviceDate === focus.serviceDate) ?? null : null;
  const focusPerson = focus ? week.members.find((m) => m.profileId === focus.profileId) ?? null : null;
  const focusMeal = focus ? week.meals.get(cellKey(focus.profileId, focus.serviceDate)) ?? null : null;
  const focusAccess = focusDay ? access.get(focusDay.serviceDate) ?? null : null;
  const repricingDish = panelDay?.dishes.find((d) => d.id === repricingId) ?? null;
  const panelMeals = panelDay
    ? [...week.meals.values()].filter((m) => m.serviceDate === panelDay.serviceDate)
    : [];

  return (
    <section className="flex flex-col gap-4">
      {nav}

      {notice !== null ? (
        <p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-muted">{notice}</p>
      ) : (
        <p className="max-w-prose text-sm text-muted">
          Everyone&rsquo;s lunch, for you to order or put right on their behalf. Each save goes on
          that person&rsquo;s bill at once, and they get a message saying what changed.
        </p>
      )}

      {narrow && panelDay && (
        <DayStrip
          days={days}
          today={today}
          selected={panelDay.serviceDate}
          count={(d) => {
            const n = perDay.get(d.serviceDate)?.portions ?? 0;
            return { value: n, said: portionsWord(n) };
          }}
          tag={(d) => columnTag({ day: d, org, now })}
          onSelect={setPanelDate}
        />
      )}

      {days.every((d) => d.menuId === null) && (
        <EmptyState heading="No menus this week">
          Publish a day on the Menu screen and its column fills in here. A past day can be added there
          too.
        </EmptyState>
      )}

      {panelDay && (
        <PricesPanel
          day={panelDay}
          meals={panelMeals}
          sentence={stageSentence(panelDay, org, now, settled)}
          access={access.get(panelDay.serviceDate) ?? { mode: "read" }}
          slug={org.slug}
          currency={org.currency}
          pending={reprice.pending}
          onReprice={(id) => {
            reprice.reset();
            setRepricingId(id);
          }}
        />
      )}

      {narrow && panelDay ? (
        <section
          aria-label={`Everyone on ${longDayLabel(panelDay.serviceDate)}`}
          className="overflow-hidden rounded-lg border border-border bg-surface-raised"
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2 text-xs font-semibold text-muted">
            <span>
              {`${columnLabel(panelDay.serviceDate).dow} ${columnLabel(panelDay.serviceDate).dom}`}
              {[panelDay.serviceDate === today ? "Today" : null, columnTag({ day: panelDay, org, now })]
                .filter((t) => t !== null)
                .map((t) => (
                  <span key={t} className="font-medium">
                    {` · ${t}`}
                  </span>
                ))}
            </span>
            <span className="tabular">{portionsWord(perDay.get(panelDay.serviceDate)?.portions ?? 0)}</span>
          </div>
          <ul>
            {week.members.map((member) => (
              <li
                key={member.profileId}
                className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
              >
                <Who member={member} currency={org.currency} className="py-1.5" />
                <div className="text-center">{renderCell(member, panelDay, true)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Table containerClassName="max-h-[calc(100dvh-8rem)] bg-surface-raised md:max-h-[calc(100dvh-4rem)]">
          <TableHeader>
            <TableRow>
              <TableHead className={cn("sticky left-0 z-3 bg-surface-raised", WHO_WIDTH)}>Who</TableHead>
              {days.map((d) => {
                const { dow, dom } = columnLabel(d.serviceDate);
                const isToday = d.serviceDate === today;
                const tags = [isToday ? "Today" : null, columnTag({ day: d, org, now })].filter(
                  (t) => t !== null,
                );
                const on = panelDay?.serviceDate === d.serviceDate;
                return (
                  <TableHead
                    key={d.serviceDate}
                    scope="col"
                    aria-current={isToday ? "date" : undefined}
                    className={cn("min-w-19 p-0 text-center lg:min-w-28", on && "border-b-2 border-b-border-strong")}
                  >
                    <Button
                      variant="ghost"
                      aria-pressed={on}
                      aria-label={`${dow} ${dom}${tags.map((t) => `, ${t.toLowerCase()}`).join("")}: show this day's prices`}
                      className="h-full w-full flex-col gap-0 rounded-none px-1 py-2 whitespace-normal text-muted lg:px-3"
                      onClick={() => setPanelDate(d.serviceDate)}
                    >
                      <span className="flex items-baseline gap-1 lg:flex-col lg:items-center lg:gap-0">
                        <span className="block text-xs font-semibold">{dow}</span>
                        <span className="block text-base font-semibold text-text tabular">{dom}</span>
                      </span>
                      <span className="block min-h-8 text-xs font-medium lg:min-h-0 lg:whitespace-nowrap">
                        {tags.length === 0
                          ? " "
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
            {week.members.map((member) => (
              <TableRow key={member.profileId}>
                <TableCell className={cn("sticky left-0 z-2 bg-surface-raised py-2 align-top", WHO_WIDTH)}>
                  <Who member={member} currency={org.currency} />
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
              {days.map((d) => {
                const t = perDay.get(d.serviceDate);
                return (
                  <TableCell key={d.serviceDate} className="text-center tabular">
                    <span className="block font-medium">{t?.portions ?? 0}</span>
                    <span className="block text-xs text-muted">
                      {t && t.money > 0 ? formatMoney(t.money, org.currency) : " "}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          </TableFooter>
        </Table>
      )}

      {panelDay && (
        <History
          date={panelDay.serviceDate}
          entries={dayEntries(panelDay.serviceDate)}
          nameOf={nameOf}
          timeZone={org.timezone}
        />
      )}

      {focus && focusDay && focusPerson && focusAccess && focusAccess.mode !== "inert" && (
        <OrderDialog
          // Remounted per cell, so it never opens on the last cell's dish or note.
          key={`${focus.profileId}|${focus.serviceDate}`}
          person={focusPerson}
          day={focusDay}
          meal={focusMeal}
          pass={focusMeal ? week.passes.get(focusMeal.orderId) ?? null : null}
          received={received.get(cellKey(focus.profileId, focus.serviceDate)) ?? []}
          access={focusAccess}
          members={week.members}
          hasLunch={hasLunchOn(focus.serviceDate)}
          entries={dayEntries(focus.serviceDate)}
          timeZone={org.timezone}
          stage={stagePhrase(focusDay, org, now)}
          over={isOver(focusDay, org, now)}
          currency={org.currency}
          pending={busy}
          error={correct.error ?? remove.error ?? pass.error ?? undo.error ?? answer.error}
          onClose={() => setFocus(null)}
          onStep={resetErrors}
          onSave={(correction) =>
            reloadIfRefused(correct.run({ person: focusPerson, serviceDate: focusDay.serviceDate, correction }))
          }
          onRemove={(reason) => {
            if (focusMeal) reloadIfRefused(remove.run({ person: focusPerson, meal: focusMeal, reason }));
          }}
          onPass={(toProfileId, reason) => {
            if (focusMeal) reloadIfRefused(pass.run({ person: focusPerson, meal: focusMeal, toProfileId, reason }));
          }}
          onUndo={(reason) => {
            const p = focusMeal ? week.passes.get(focusMeal.orderId) : undefined;
            if (focusMeal && p) reloadIfRefused(undo.run({ person: focusPerson, meal: focusMeal, pass: p, reason }));
          }}
          onAnswer={(a, reason) => {
            const p = focusMeal ? week.passes.get(focusMeal.orderId) : undefined;
            if (p) reloadIfRefused(answer.run({ person: focusPerson, pass: p, answer: a, reason }));
          }}
        />
      )}

      {repricingDish && panelDay && (
        <RepriceDialog
          key={`${repricingDish.id}|${panelDay.serviceDate}`}
          open
          serviceDate={panelDay.serviceDate}
          dish={repricingDish}
          meals={panelMeals}
          ahead={!isOver(panelDay, org, now)}
          currency={org.currency}
          pending={reprice.pending}
          error={reprice.error}
          onOpenChange={(open) => !open && setRepricingId(null)}
          onReprice={(priceMinor, reason) =>
            reloadIfRefused(reprice.run({ dish: repricingDish, priceMinor, reason }))
          }
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ pieces */

function Who({
  member,
  currency,
  className,
}: {
  member: OrdersMember;
  currency: ScreenProps["org"]["currency"];
  className?: string;
}) {
  return (
    <span className={cn("block text-sm leading-5 wrap-break-word", className)}>
      <span className="block font-medium">
        {member.name}
        {member.isMe && <span className="text-muted"> (you)</span>}
      </span>
      <span className="block text-xs text-muted tabular">{balanceNow(member.balanceMinor, currency)}</span>
    </span>
  );
}

/**
 * The day's prices, and the one control that reaches several people at once,
 * kept apart from the cells so it is never mistaken for one person's change.
 */
function PricesPanel({
  day,
  meals,
  sentence,
  access,
  slug,
  currency,
  pending,
  onReprice,
}: {
  day: BoardDay;
  meals: RecordedMeal[];
  sentence: string;
  access: DayAccess;
  slug: string;
  currency: ScreenProps["org"]["currency"];
  pending: boolean;
  onReprice: (dishId: number) => void;
}) {
  const writable = access.mode === "write";
  return (
    <section
      aria-label={`Prices for ${longDayLabel(day.serviceDate)}`}
      className="rounded-lg border border-border bg-surface-raised p-4 md:p-6"
    >
      <div className="flex flex-col gap-1 border-b border-border pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="text-lg font-semibold">{longDayLabel(day.serviceDate)}</h2>
          <p className="text-sm text-muted">{sentence}</p>
        </div>
        {writable && day.dishes.length > 0 && (
          <p className="max-w-prose text-sm text-muted">
            A new price here is for this day only, and reaches everybody who has the dish.
          </p>
        )}
      </div>

      {access.mode === "inert" ? (
        <p className="pt-3 text-sm text-muted">
          {`${access.reason}${access.reason.endsWith(".") ? "" : "."} `}
          {access.toMenu && (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <a href={`#/o/${slug}/menu?date=${day.serviceDate}`}>Open the Menu screen</a>
            </Button>
          )}
        </p>
      ) : (
        <ul className="grid gap-x-10 pt-1 sm:grid-cols-2 xl:grid-cols-3">
          {day.dishes.map((dish) => {
            const on = meals.filter((m) => m.menuItemId === dish.id);
            const count = on.reduce((n, m) => n + m.quantity, 0);
            return (
              <li key={dish.id} className="flex items-center justify-between gap-4 border-b border-border py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium wrap-anywhere">{dish.name}</span>
                  <span className="text-xs text-muted">
                    {on.length === 0 ? "Nobody has it" : `${peopleWord(on.length)}, ${portionsWord(count)}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className={cn(
                      "text-sm tabular",
                      dish.priceMinor === null ? "rounded-sm bg-warn-subtle px-1 text-warn-subtle-fg" : "text-muted",
                    )}
                  >
                    {dish.priceMinor === null ? "Price to come" : formatMoney(dish.priceMinor, currency)}
                  </span>
                  {writable && (
                    <Action
                      reason={null}
                      pending={pending}
                      size="sm"
                      variant="outline"
                      aria-label={`Reprice ${dish.name}`}
                      onClick={() => onReprice(dish.id)}
                    >
                      Reprice
                    </Action>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Everything a cell says, spoken: the whole state, then what a tap does. */
function cellLabel(args: {
  member: OrdersMember;
  day: BoardDay;
  meal: RecordedMeal | null;
  pass: PassRecord | null;
  received: PassRecord[];
  provenance: string | null;
  nameOf: (id: string) => string;
  verb: string;
}): string {
  const { member, day, meal, pass, received, provenance, nameOf, verb } = args;
  const who = `${member.name}, ${columnLabel(day.serviceDate).dow} ${columnLabel(day.serviceDate).dom}`;
  const parts: string[] = [];
  if (meal === null) parts.push("nothing recorded");
  else {
    parts.push(meal.dishName ?? "eating, no dish chosen");
    if (meal.quantity > 1) parts.push(`${meal.quantity} portions`);
    if (meal.note !== null) parts.push(meal.note);
    if (meal.dishName !== null && meal.unitPriceMinor === null) parts.push("price to come");
    if (provenance === "recorded") parts.push("recorded by an admin");
    if (provenance === "corrected") parts.push("corrected by an admin");
    if (pass?.status === "accepted") parts.push(`passed to ${nameOf(pass.toProfileId)}, who pays`);
    if (pass?.status === "pending") parts.push(`offered to ${nameOf(pass.toProfileId)}, not answered`);
  }
  for (const r of received) parts.push(`also has ${nameOf(r.fromProfileId)}'s meal`);
  return `${who}: ${parts.join(", ")}. ${verb}`;
}

/**
 * One person on one day. Every cell is a record, so none wears the accent
 * fill; the words under the dish carry where it came from.
 */
function OrderCell({
  member,
  day,
  meal,
  pass,
  received,
  access,
  provenance,
  nameOf,
  wide,
  onOpen,
}: {
  member: OrdersMember;
  day: BoardDay;
  meal: RecordedMeal | null;
  pass: PassRecord | null;
  received: Received[];
  access: DayAccess;
  provenance: string | null;
  nameOf: (id: string) => string;
  wide: boolean;
  onOpen: () => void;
}) {
  const passed = pass?.status === "accepted" ? pass : null;
  const offered = pass?.status === "pending" ? pass : null;
  const readOnly = access.mode === "read";
  const base = cn(
    "flex h-auto min-h-9 w-full min-w-16 flex-col gap-0.5 rounded-md px-1 py-1.5 text-xs font-medium whitespace-normal",
    wide && "min-h-11 px-2",
  );

  if (access.mode === "inert") {
    return (
      <Action
        reason={access.reason}
        variant="ghost"
        aria-label={cellLabel({ member, day, meal, pass, received, provenance, nameOf, verb: "" }).trim()}
        className={cn(base, "border-transparent bg-transparent hover:bg-transparent")}
      >
        <span className="sr-only">{access.reason}</span>
      </Action>
    );
  }

  if (meal === null && received.length === 0 && readOnly) {
    // A settled week offers nothing on an empty cell, and the notice says why.
    return <div className={cn(base, "border border-transparent")} aria-hidden="true" />;
  }

  const verb = readOnly ? "Open" : meal === null ? "Add a meal" : passed ? "Open" : "Change";
  const tone =
    meal === null
      ? readOnly
        ? "border border-transparent text-muted"
        : "border border-border text-subtle hover:bg-surface-sunken"
      : passed
        ? "bg-surface-sunken text-subtle"
        : offered
          ? "border border-dashed border-accent text-text"
          : meal.dishName === null
            ? "border border-dashed border-border-strong text-muted"
            : "border border-border-strong text-text";

  return (
    <Button
      variant="ghost"
      aria-label={cellLabel({ member, day, meal, pass, received, provenance, nameOf, verb })}
      title={meal?.note ?? undefined}
      className={cn(base, tone, readOnly ? "hover:bg-transparent" : meal !== null && "hover:bg-surface-sunken")}
      onClick={onOpen}
    >
      {meal === null ? (
        received.length === 0 ? (
          <PlusIcon className="size-4 opacity-60" aria-hidden="true" />
        ) : null
      ) : passed ? (
        <>
          <span className={cn(CELL_TEXT, "font-normal line-through")}>
            {meal.dishName ?? "Lunch"}
            {meal.quantity > 1 && <span className="tabular">{` × ${meal.quantity}`}</span>}
          </span>
          <span className={CELL_TEXT}>{`to ${nameOf(passed.toProfileId)}`}</span>
        </>
      ) : (
        <>
          <span className={cn(CELL_TEXT, meal.dishName === null && "font-normal")}>
            {meal.dishName === null ? "no dish yet" : meal.dishName}
            {meal.quantity > 1 && <span className="tabular">{` × ${meal.quantity}`}</span>}
          </span>
          {meal.note !== null && <CellNote note={meal.note} />}
          {meal.dishName !== null && meal.unitPriceMinor === null && (
            <span className="rounded-sm bg-warn-subtle px-1 text-xs font-normal text-warn-subtle-fg">
              {PRICE_PENDING}
            </span>
          )}
          {offered && (
            <span className={cn(CELL_TEXT, "font-normal text-muted")}>{`offered to ${nameOf(offered.toProfileId)}`}</span>
          )}
          {provenance !== null && <span className="text-xs font-normal text-subtle">{provenance}</span>}
        </>
      )}
      {received.map((r) => (
        <span key={r.id} className={cn(CELL_TEXT, "font-normal text-muted")}>
          {`+ ${r.portions} from ${nameOf(r.fromProfileId)}`}
        </span>
      ))}
    </Button>
  );
}

function History({
  date,
  entries,
  nameOf,
  timeZone,
}: {
  date: string;
  entries: CorrectionEntry[];
  nameOf: (id: string) => string;
  timeZone: string;
}) {
  return (
    <section aria-labelledby="orders-history" className="flex flex-col gap-2">
      <h3 id="orders-history" className="text-sm font-semibold">
        {`Changed by an admin on ${dayWords(date)}`}
      </h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing on this day has been changed by an admin.</p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Badge variant="neutral">{kindWord(e.kind)}</Badge>
                <span className="min-w-0 text-sm break-words">{e.summary}</span>
              </span>
              <span className="text-xs text-subtle">{`${nameOf(e.madeBy)} · ${arrivedLabel(e.madeAt, timeZone)}`}</span>
              {e.reason !== null && <span className="text-sm text-muted break-words">{`Why: ${e.reason}`}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

