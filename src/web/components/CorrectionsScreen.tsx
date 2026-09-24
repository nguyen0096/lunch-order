import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon } from "lucide-react";
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
  TableNumericCell,
  TableRow,
  cn,
  useAction,
} from "@/ui";
import {
  cellKey,
  correctMeal,
  correctMealOffMenu,
  fetchCorrectionsWeek,
  humanError,
  removeMeal,
  repriceDish,
  type CorrectionsMember,
  type CorrectionsWeek,
  type RecordedMeal,
} from "../api.js";
import { WeekNav } from "./WeekNav.js";
import { MealDialog, type MealCorrection } from "./corrections/MealDialog.js";
import { RepriceDialog } from "./corrections/RepriceDialog.js";
import {
  SETTLED_REASON,
  balanceNow,
  kindWord,
  lastFinishedDay,
  peopleWord,
  portions as portionsWord,
  settledNotice,
} from "./corrections/model.js";
import { longDay, shortDay } from "./menu/labels.js";
import { arrivedLabel, weekLabel } from "./payments/labels.js";
import { weekRangeLabel } from "./boardModel.js";
import type { ScreenProps } from "./screenProps.js";
import { now as appNow } from "../../shared/clock.js";
import { PRICE_PENDING, formatMoney } from "../../shared/money.js";
import { addDays, daysApart, isoWeekday, todayIn, weekNumberOf, weekStart } from "../../shared/dates.js";

/**
 * The door an admin walks through to fix what the app recorded for a day that
 * is already over.
 *
 * It exists because the record and the lunch disagree often enough to matter:
 * somebody ordered verbally and the caterer delivered one more portion than
 * the app knows about, somebody was marked down for a lunch they did not eat,
 * a dish was served that was never on the menu, the caterer charged a price
 * the menu did not say. None of that belongs on the Board, which is where
 * everybody orders their own lunch and where the clock binds an admin exactly
 * as it binds a member.
 *
 * Nothing here is a draft. Every control writes the moment it is confirmed,
 * lands on somebody's bill, and tells them, so every one of them says in
 * figures what it is about to do before it does it. What it says beforehand is
 * a preview of arithmetic; what the database hands back afterwards is the
 * balance, and that is the only figure this screen reports as fact.
 */
export function CorrectionsScreen({ me, org }: ScreenProps) {
  const today = todayIn(org.timezone, appNow());
  const thisWeek = weekStart(today, org.billingWeekStartsOn);

  const [serviceDate, setServiceDate] = useState(() =>
    lastFinishedDay({ today, now: appNow(), org }),
  );
  const weekOf = weekStart(serviceDate, org.billingWeekStartsOn);

  const [week, setWeek] = useState<CorrectionsWeek | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [repricingId, setRepricingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setWeek(
        await fetchCorrectionsWeek({
          orgId: org.id,
          from: weekOf,
          to: addDays(weekOf, 6),
          meProfileId: me.profileId,
          today,
        }),
      );
      setLoadError(null);
    } catch (e) {
      // `useAction` owns every write. A read has no toast to fire and nothing
      // to put back, so its failure is a state the screen renders instead.
      setLoadError(humanError(e));
    }
  }, [org.id, weekOf, me.profileId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Paging lands on the same weekday, so the arrows read as "this day, last
   * week" rather than shuffling the reader to a Monday each time.
   */
  function goToWeek(start: string) {
    const offset = Math.min(6, Math.max(0, daysApart(weekOf, serviceDate)));
    setServiceDate(addDays(start, offset));
  }

  /* ------------------------------------------------------------- mutations */

  const correct = useAction(
    async (a: { person: CorrectionsMember; correction: MealCorrection }) => {
      const { correction: c } = a;
      if (c.menuItemId === null) {
        // Never a price of zero. An off-menu dish with no price is a free
        // lunch on somebody's bill, and the dialog refuses to send one.
        if (c.priceMinor === null) throw new Error("Say what the dish cost before saving.");
        const saved = await correctMealOffMenu({
          orgId: org.id,
          serviceDate,
          profileId: a.person.profileId,
          dishName: c.dishName,
          priceMinor: c.priceMinor,
          quantity: c.quantity,
          note: c.note,
          reason: c.reason,
        });
        return { name: a.person.name, dishName: c.dishName, balanceMinor: saved.balanceMinor };
      }
      const saved = await correctMeal({
        orgId: org.id,
        serviceDate,
        profileId: a.person.profileId,
        menuItemId: c.menuItemId,
        quantity: c.quantity,
        note: c.note,
        reason: c.reason,
      });
      return { name: a.person.name, dishName: c.dishName, balanceMinor: saved.balanceMinor };
    },
    {
      // The balance comes back from the write, so the sentence reports the
      // ledger rather than the arithmetic the dialog previewed.
      success: (r) =>
        `${r.name} now has ${r.dishName}. ${r.name} ${balanceNow(r.balanceMinor, org.currency)}.`,
      onSuccess: () => {
        setEditing(null);
        void load();
      },
    },
  );

  const remove = useAction(
    async (a: { person: CorrectionsMember; meal: RecordedMeal; reason: string | null }) => {
      const removed = await removeMeal({ orderId: a.meal.orderId, reason: a.reason });
      return { name: a.person.name, balanceMinor: removed.balanceMinor };
    },
    {
      success: (r) =>
        `Meal removed. ${r.name} ${balanceNow(r.balanceMinor, org.currency)}.`,
      onSuccess: () => {
        setEditing(null);
        void load();
      },
    },
  );

  const reprice = useAction(
    async (a: { dish: { id: number; name: string }; priceMinor: number; reason: string | null }) => {
      const done = await repriceDish({
        menuItemId: a.dish.id,
        priceMinor: a.priceMinor,
        reason: a.reason,
      });
      return { name: a.dish.name, ...done };
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

  /* ------------------------------------------------------------- rendering */

  const day = week?.days.find((d) => d.serviceDate === serviceDate) ?? null;
  const dayMeals = useMemo(() => {
    if (week === null) return [];
    return week.members
      .map((m) => week.meals.get(cellKey(m.profileId, serviceDate)) ?? null)
      .filter((m): m is RecordedMeal => m !== null);
  }, [week, serviceDate]);

  const strip = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(weekOf, i);
      const entry = week?.days.find((d) => d.serviceDate === date) ?? null;
      // Weekends only when lunch happened on them, the same rule the board and
      // the menu editor use. A day with a menu is a day that can be corrected.
      if (isoWeekday(date) <= 5 || entry?.menuId != null) out.push(date);
    }
    if (!out.includes(serviceDate)) out.push(serviceDate);
    return out.sort();
  }, [week, weekOf, serviceDate]);

  const mealsPerDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [key, meal] of week?.meals ?? []) {
      const date = key.slice(key.indexOf("|") + 1);
      // Portions, because portions are what the caterer delivers. An order
      // with no dish on it is still one person eating, so it counts as one.
      counts.set(date, (counts.get(date) ?? 0) + Math.max(meal.quantity, 1));
    }
    return counts;
  }, [week]);

  const settled = settledNotice(week?.period ?? null, org.timezone);
  const entries = (week?.entries ?? []).filter((e) => e.serviceDate === serviceDate);
  const correctedOrders = new Set(
    entries.map((e) => e.orderId).filter((id): id is number => id !== null),
  );
  const nameOf = new Map((week?.members ?? []).map((m) => [m.profileId, m.name]));

  const editingPerson = week?.members.find((m) => m.profileId === editing) ?? null;
  const editingMeal =
    editingPerson === null
      ? null
      : week?.meals.get(cellKey(editingPerson.profileId, serviceDate)) ?? null;
  const repricingDish = day?.dishes.find((d) => d.id === repricingId) ?? null;

  function openMeal(profileId: string) {
    correct.reset();
    remove.reset();
    setEditing(profileId);
  }

  const header = (
    <header className="flex flex-col gap-4">
      {/* There is no nav entry for this screen, so the way back is part of it. */}
      <Button asChild variant="link" size="sm" className="h-auto self-start px-0">
        <a href={`#/o/${org.slug}/payments`}>
          <ChevronLeftIcon aria-hidden="true" />
          Back to Payments
        </a>
      </Button>

      <div>
        <h1 className="text-xl font-semibold">Corrections</h1>
        <p className="max-w-prose text-muted">
          Put right what a day recorded once it is over: a meal nobody ordered in the app, one that
          did not happen, a dish that was never on the menu, a price the caterer changed. It stays
          open until the week is settled.
        </p>
      </div>

      <WeekNav
        label={weekRangeLabel(strip[0] ?? weekOf, strip[strip.length - 1] ?? weekOf)}
        weekNumber={weekNumberOf(weekOf)}
        away={weekOf !== thisWeek}
        onPrev={() => goToWeek(addDays(weekOf, -7))}
        onNext={() => goToWeek(addDays(weekOf, 7))}
        onReset={() => goToWeek(thisWeek)}
      />

      <ul className="flex flex-wrap gap-2">
        {strip.map((date) => {
          const entry = week?.days.find((d) => d.serviceDate === date) ?? null;
          const count = mealsPerDay.get(date) ?? 0;
          // What the caterer delivered is the number an admin is checking, so
          // the strip carries it rather than the day's stage. A day with no
          // menu says so: there is nothing recorded on it to disagree with.
          const word = entry?.menuId == null ? "No menu" : `${count} recorded`;
          const selected = date === serviceDate;
          return (
            <li key={date}>
              <button
                type="button"
                aria-current={selected ? "date" : undefined}
                aria-label={`${shortDay(date)}, ${entry?.menuId == null ? "no menu" : `${count} recorded`}`}
                onClick={() => setServiceDate(date)}
                className={cn(
                  "flex min-w-24 flex-col rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "border-border-strong bg-accent-subtle text-accent-subtle-fg"
                    : "border-border bg-surface-raised hover:bg-surface-sunken",
                )}
              >
                <span className="font-medium">{shortDay(date)}</span>
                <span className="text-xs">{word}</span>
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
          heading="The day did not load"
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
      <section className="flex flex-col gap-6">
        {header}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-56" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      </section>
    );
  }

  const weekName = weekLabel(
    week.period?.periodStart ?? weekOf,
    week.period?.periodEnd ?? addDays(weekOf, 6),
  );
  const busy = correct.pending || remove.pending;
  const dayTotalMinor = dayMeals.reduce((sum, m) => sum + (m.amountMinor ?? 0), 0);
  const waiting = dayMeals.filter((m) => m.dishName !== null && m.amountMinor === null).length;

  return (
    <section className="flex flex-col gap-6">
      {header}

      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">{longDay(serviceDate)}</h2>
          <p className="text-sm text-muted">{`In the week of ${weekName}.`}</p>
        </div>

        {settled !== null ? (
          <p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-muted">{settled}</p>
        ) : (
          /* Said once, here, rather than on every control: it is true of all
             of them and repeating it turns a fact into noise. */
          <p className="rounded-lg bg-warn-subtle px-4 py-3 text-sm text-warn-subtle-fg">
            Everything on this day is written the moment you confirm it. It goes on that person's
            bill straight away, and they get a message saying what changed.
          </p>
        )}

        <Table aria-label={`What ${longDay(serviceDate)} records`}>
          <TableHeader>
            <TableRow>
              <TableHead className="px-2 md:px-3">Person</TableHead>
              <TableHead className="px-2 md:px-3">What the day records</TableHead>
              <TableHead className="px-2 text-right md:px-3">Amount</TableHead>
              <TableHead className="px-2 md:px-3">
                <span className="sr-only">Correct</span>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {week.members.map((member) => {
              const meal = week.meals.get(cellKey(member.profileId, serviceDate)) ?? null;
              const passedOn = meal?.transferredToName ?? null;
              const reason =
                settled !== null
                  ? SETTLED_REASON
                  : passedOn !== null
                    ? `This meal was passed to ${passedOn}, who pays for it now. Correcting a meal that changed hands is not something this screen does.`
                    : null;
              return (
                <TableRow key={member.profileId}>
                  <TableCell className="px-2 md:px-3">
                    <span className="font-medium break-words">{member.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {balanceNow(member.balanceMinor, org.currency)}
                    </span>
                  </TableCell>

                  <TableCell className="px-2 md:px-3">
                    {meal === null ? (
                      <span className="text-muted">Nothing recorded</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="break-words">
                            {meal.dishName ?? "Eating, no dish recorded"}
                            {meal.quantity > 1 ? ` × ${meal.quantity}` : ""}
                          </span>
                          {correctedOrders.has(meal.orderId) && (
                            <Badge variant="neutral">Corrected</Badge>
                          )}
                        </span>
                        {meal.note !== null && (
                          <span className="text-xs text-muted break-words">{meal.note}</span>
                        )}
                        {passedOn !== null && (
                          <span className="text-xs text-muted">{`Passed to ${passedOn}`}</span>
                        )}
                      </span>
                    )}
                  </TableCell>

                  <TableNumericCell className="px-2 whitespace-nowrap md:px-3">
                    {meal === null ? (
                      ""
                    ) : meal.amountMinor === null ? (
                      <span className="text-muted">{PRICE_PENDING}</span>
                    ) : (
                      <span className="tabular">{formatMoney(meal.amountMinor, org.currency)}</span>
                    )}
                  </TableNumericCell>

                  <TableCell className="px-2 text-right md:px-3">
                    {/* Named per person: a column of buttons all called
                        "Change" is one button read four times to anybody who
                        cannot see which row they are on. */}
                    <Action
                      reason={reason}
                      pending={busy}
                      size="sm"
                      variant="outline"
                      aria-label={
                        meal === null
                          ? `Add a meal for ${member.name}`
                          : `Change what ${member.name} had`
                      }
                      onClick={() => openMeal(member.profileId)}
                    >
                      {meal === null ? "Add a meal" : "Change"}
                    </Action>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>

          <TableFooter>
            <TableRow>
              <TableCell className="px-2 font-medium md:px-3">The day</TableCell>
              <TableCell className="px-2 md:px-3">
                {`${peopleWord(dayMeals.length)}, ${portionsWord(
                  dayMeals.reduce((sum, m) => sum + m.quantity, 0),
                )}`}
                {waiting > 0 && (
                  <span className="mt-0.5 block text-xs">
                    {`${waiting === 1 ? "One meal is" : `${waiting} meals are`} waiting on a price, so the total leaves ${waiting === 1 ? "it" : "them"} out.`}
                  </span>
                )}
              </TableCell>
              <TableNumericCell className="px-2 tabular whitespace-nowrap md:px-3">
                {formatMoney(dayTotalMinor, org.currency)}
              </TableNumericCell>
              <TableCell className="px-2 md:px-3" />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* The one control here that reaches several people at once, kept apart
          from the rows so it cannot be mistaken for one person's correction. */}
      <section
        aria-labelledby="dish-prices-heading"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 md:p-6"
      >
        <div>
          <h3 id="dish-prices-heading" className="text-sm font-semibold">
            Prices for this day
          </h3>
          <p className="max-w-prose text-sm text-muted">
            A price here is what the caterer charged on this day alone. Changing one changes every
            meal on that dish, for everybody who had it, in one press.
          </p>
        </div>

        {day === null || day.dishes.length === 0 ? (
          <p className="text-sm text-muted">
            No menu was published for this day, so there is no price to change. A dish that was
            served anyway is recorded against a person, with its own price.
          </p>
        ) : (
          <ul className="flex flex-col">
            {day.dishes.map((dish) => {
              const on = dayMeals.filter((m) => m.menuItemId === dish.id);
              const count = on.reduce((sum, m) => sum + m.quantity, 0);
              return (
                <li
                  key={dish.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium break-words">{dish.name}</span>
                    <span className="text-xs text-muted">
                      {on.length === 0
                        ? "Nobody had it"
                        : `${peopleWord(on.length)}, ${portionsWord(count)}`}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className={cn("text-sm", dish.priceMinor !== null && "tabular")}>
                      {dish.priceMinor === null
                        ? PRICE_PENDING
                        : formatMoney(dish.priceMinor, org.currency)}
                    </span>
                    <Action
                      reason={settled === null ? null : SETTLED_REASON}
                      pending={reprice.pending}
                      size="sm"
                      variant="outline"
                      aria-label={`Reprice ${dish.name}`}
                      onClick={() => {
                        reprice.reset();
                        setRepricingId(dish.id);
                      }}
                    >
                      Reprice
                    </Action>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h3 id="history-heading" className="text-sm font-semibold">
          What has already been corrected on this day
        </h3>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">Nothing on this day has been corrected.</p>
        ) : (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0"
              >
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Badge variant="neutral">{kindWord(entry.kind)}</Badge>
                  <span className="min-w-0 text-sm break-words">{entry.summary}</span>
                </span>
                <span className="text-xs text-subtle">
                  {`${nameOf.get(entry.madeBy) ?? "An admin"} · ${arrivedLabel(entry.madeAt, org.timezone)}`}
                </span>
                {entry.reason !== null && (
                  <span className="text-sm text-muted break-words">{`Why: ${entry.reason}`}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editingPerson !== null && (
        <MealDialog
          // Remounted per person and per day, so a dialog never opens on the
          // dish or the note belonging to the row opened before it.
          key={`${editingPerson.profileId}|${serviceDate}`}
          open
          serviceDate={serviceDate}
          person={editingPerson}
          meal={editingMeal}
          dishes={day?.dishes ?? []}
          currency={org.currency}
          pending={busy}
          error={correct.error ?? remove.error}
          onOpenChange={(open) => !open && setEditing(null)}
          onSave={(correction) => void correct.run({ person: editingPerson, correction })}
          onRemove={(reason) => {
            if (editingMeal === null) return;
            void remove.run({ person: editingPerson, meal: editingMeal, reason });
          }}
        />
      )}

      {repricingDish !== null && (
        <RepriceDialog
          key={`${repricingDish.id}|${serviceDate}`}
          open
          serviceDate={serviceDate}
          dish={repricingDish}
          meals={dayMeals}
          currency={org.currency}
          pending={reprice.pending}
          error={reprice.error}
          onOpenChange={(open) => !open && setRepricingId(null)}
          onReprice={(priceMinor, reason) =>
            void reprice.run({ dish: repricingDish, priceMinor, reason })
          }
        />
      )}
    </section>
  );
}
