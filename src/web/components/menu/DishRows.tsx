import { Trash2Icon } from "lucide-react";
import { Action, Badge, Button, cn } from "@/ui";
import type { DishTakers, DraftDish } from "../../api.js";
import type { ItemWarning, ParsedItem } from "../../../shared/menuParser.js";
import { dishName } from "../../../shared/dishName.js";
import {
  PRICE_PENDING,
  formatAmount,
  formatMoney,
  parseVietnamesePrice,
  type Currency,
  type PriceReading,
} from "../../../shared/money.js";

/**
 * One line of the menu as the admin is checking it.
 *
 * The price is held as TEXT, not as a number, because the box is where the
 * uncertainty lives: `45k`, `45.000` and `45,5k` are three different readings
 * of the same keystrokes and the person has to be able to see which one we
 * took. The resolved amount is shown beside it, never instead of it.
 */
export type DishRow = {
  /** Stable across edits, so React keeps the caret where the person left it. */
  key: string;
  /** The `menu_items` row this stands for; null for a dish not yet written. */
  id: number | null;
  name: string;
  price: string;
  /** The evidence: the line this was read from, or what the model noted. */
  source: string | null;
  /**
   * Flags the parse raised that re-reading a tidied price box cannot
   * reproduce, kept only while the box still holds what the parse put there.
   */
  seeded: ItemWarning[];
  seededPrice: string;
  /**
   * The id came from typing a removed dish's exact name, so typing on lets it
   * go again. A parse's match, a pick and a saved row keep theirs: editing
   * those is a rename.
   */
  typedMatch?: boolean;
};

let sequence = 0;
function nextKey(): string {
  sequence += 1;
  return `row-${sequence}`;
}

export function blankRow(): DishRow {
  return { key: nextKey(), id: null, name: "", price: "", source: null, seeded: [], seededPrice: "" };
}

/** A dish already on the menu. It carries its id, so publishing updates in place. */
export function rowFromMenu(
  item: { id: number; name: string; priceMinor: number | null },
  c: Currency,
): DishRow {
  // An empty box is how "the caterer has not said" looks in a text field, and
  // it is the same shape a brand new row arrives in.
  const price = item.priceMinor === null ? "" : formatAmount(item.priceMinor, c);
  return { key: nextKey(), id: item.id, name: item.name, price, source: null, seeded: [], seededPrice: price };
}

export function rowFromParsed(item: ParsedItem, c: Currency): DishRow {
  const price = formatAmount(item.priceMinor, c);
  return {
    key: nextKey(),
    id: null,
    name: item.name,
    price,
    source: item.raw,
    seeded: item.warnings,
    seededPrice: price,
  };
}

export function rowFromAssist(
  item: { name: string; priceMinor: number; note: string | null },
  c: Currency,
): DishRow {
  const price = formatAmount(item.priceMinor, c);
  // Capitalised here rather than in toDrafts, so the admin reads the name the
  // database will get and can still lower-case it back if they meant to. The
  // model is no better at this than the caterer: both send what chat sends.
  return {
    key: nextKey(),
    id: null,
    name: dishName(item.name),
    price,
    source: item.note,
    seeded: [],
    seededPrice: price,
  };
}

/**
 * A line the parser could not read, taken on as a dish with the price still to
 * set. The list marker comes off because a dish is not called `- Cơm gà`; the
 * whole line is kept underneath as the source, and the box is editable anyway.
 */
export function rowFromLine(line: string): DishRow {
  const name = line.replace(/^[\s\-*•·–—+>»]+/u, "").trim();
  return { key: nextKey(), id: null, name, price: "", source: line.trim(), seeded: [], seededPrice: "" };
}

/** What the price box currently says, read by the same function the parser uses. */
export function reading(row: DishRow): PriceReading | null {
  return parseVietnamesePrice(row.price);
}

/**
 * An empty box, which is how "the caterer has not said yet" is written.
 *
 * The distinction `reading()` alone cannot draw: it returns null both for a box
 * left empty on purpose and for one holding `abc`. Those are the two different
 * states toDrafts() encodes, and telling them apart is what stops a deliberate
 * choice being reported as a mistake.
 */
export function unpriced(row: DishRow): boolean {
  return row.price.trim() === "";
}

/**
 * Mirrors `menu_items_name_uk`, which is unique on `lower(btrim(name))`. NFC
 * first for the same reason the parser normalises: chat apps on iOS emit
 * decomposed Vietnamese, and two spellings of `Cơm` would otherwise look
 * different here and identical to Postgres.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/** The first name used twice, or null. The database would refuse the second. */
export function duplicateName(rows: DishRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = nameKey(row.name);
    if (key === "") continue;
    if (seen.has(key)) return row.name.trim();
    seen.add(key);
  }
  return null;
}

/**
 * `field` is which box the message belongs under.
 *
 * Every one of these used to render in a full-width strip below the row, which
 * put "This dish needs a name." under the price column and three lines below
 * the empty box it was about. A message about a field belongs against that
 * field; that is most of what makes it readable.
 */
export type Flag = { level: "warn" | "error"; field: "name" | "price"; text: string };

/**
 * The uncertainty shown against one row.
 *
 * All of it comes from `parseVietnamesePrice`'s own `PriceReading` and from the
 * parse's `ItemWarning`s. Nothing here invents a second opinion about a price:
 * the reading is re-taken from the box on every keystroke, so correcting a
 * price clears its flag without anybody having to remember to.
 */
export function flagsFor(row: DishRow, rows: DishRow[], c: Currency): Flag[] {
  const out: Flag[] = [];

  if (row.name.trim() === "") {
    out.push({ level: "error", field: "name", text: "This dish needs a name." });
  } else if (rows.some((other) => other.key !== row.key && sameName(other.name, row.name))) {
    out.push({
      level: "error",
      field: "name",
      text: "Another row has this name, and a menu cannot hold two.",
    });
  }

  // Not a flag at all. An empty box publishes, the dish reads as unpriced
  // everywhere, and the row already says so under the box.
  if (unpriced(row)) return out;

  const read = reading(row);
  if (read === null) {
    out.push({
      level: "error",
      field: "price",
      text: "No price read here. Write it as 45k or 45.000.",
    });
    return out;
  }

  if (read.inferredThousands) {
    out.push({
      level: "warn",
      field: "price",
      text: `No thousands written, so read as ${formatMoney(read.minor, c)}.`,
    });
  }
  if (read.ambiguousDecimal) {
    out.push({
      level: "warn",
      field: "price",
      text: `Comma read as a decimal point: ${formatMoney(read.minor, c)}.`,
    });
  }

  // Retired the moment the price changes: these describe what arrived, not
  // what the box now holds.
  if (row.price === row.seededPrice) {
    for (const w of row.seeded) {
      if (w === "price_inferred_thousands" && !read.inferredThousands) {
        out.push({
          level: "warn",
          field: "price",
          text: `The message wrote no thousands, so this is read as ${formatMoney(read.minor, c)}.`,
        });
      }
      if (w === "price_ambiguous_decimal" && !read.ambiguousDecimal) {
        out.push({
          level: "warn",
          field: "price",
          text: `The message used a comma as a decimal point, so this is read as ${formatMoney(read.minor, c)}.`,
        });
      }
      if (w === "price_out_of_range") {
        out.push({
          level: "warn",
          field: "price",
          text: "Unusual for a lunch. Check the price against the message.",
        });
      }
      if (w === "duplicate_name") {
        out.push({
          level: "warn",
          field: "price",
          text: "The message listed this dish twice. The first price was kept.",
        });
      }
    }
  }

  return out;
}

/**
 * What goes to the database. An unreadable price becomes NaN rather than zero,
 * so `publishDisabledReason` catches it and says "Every dish needs a valid
 * price" instead of a free lunch reaching a bill.
 */
export function toDrafts(rows: DishRow[]): DraftDish[] {
  return rows.map((r) => {
    const read = reading(r);
    // Three states, not two. Empty means the caterer has not priced it and the
    // menu publishes anyway; unreadable means somebody typed something that is
    // not money, which NaN carries into publishDisabledReason; otherwise the
    // number. Collapsing the first two would either block a whole week on a
    // price nobody has, or let "abc" reach a bill as zero.
    const blank = r.price.trim() === "";
    return {
      id: r.id ?? undefined,
      // NFC only, never re-cased: `menu_items` is unique on
      // `lower(btrim(name))` and a phone keyboard's decomposed `Cơm` would
      // slip past that index as a second row. Capitalising is done where a
      // row is built from a parse, where the admin can see and undo it.
      name: r.name.normalize("NFC").trim(),
      priceMinor: blank ? null : read === null ? Number.NaN : read.minor,
    };
  });
}

/** A dish as the database holds it now, before anything on screen is published. */
export type SavedDish = { id: number; name: string; priceMinor: number | null; position: number };

/**
 * Carry the ids of dishes already on the menu across a re-parse.
 *
 * Without this, re-pasting a corrected message over a published menu turns
 * every dish into a delete-and-reinsert, which the FK from `order_items`
 * refuses the moment anybody has chosen one. Matching on the name is what the
 * database's own unique index matches on.
 *
 * The rows on screen are asked first, so a dish the admin renamed by hand
 * keeps its id under the new name; the saved menu second, so a dish that an
 * earlier parse dropped is recognised when a later one brings it back. Each id
 * goes to one row at most: two rows with one id would be one dish updated
 * twice.
 */
export function adoptIds(next: DishRow[], previous: DishRow[], saved: SavedDish[]): DishRow[] {
  const known = new Map<string, number>();
  for (const row of previous) {
    const key = nameKey(row.name);
    if (row.id !== null && !known.has(key)) known.set(key, row.id);
  }
  for (const dish of saved) {
    const key = nameKey(dish.name);
    if (!known.has(key)) known.set(key, dish.id);
  }
  const taken = new Set<number>();
  for (const row of next) if (row.id !== null) taken.add(row.id);
  return next.map((row) => {
    if (row.id !== null) return row;
    const id = known.get(nameKey(row.name));
    if (id === undefined || taken.has(id)) return row;
    taken.add(id);
    return { ...row, id };
  });
}

/**
 * What publishing the rows would do to the saved menu: which dishes it updates
 * in place, how many it adds, and which it deletes. `publish_menu` decides the
 * same thing from the same ids, so this is a prediction, not a second rule.
 */
export function dishChanges(
  rows: DishRow[],
  saved: SavedDish[],
): { updated: number; added: number; removed: SavedDish[] } {
  const savedIds = new Set(saved.map((d) => d.id));
  const kept = new Set<number>();
  let added = 0;
  for (const row of rows) {
    if (row.id !== null && savedIds.has(row.id)) kept.add(row.id);
    else added += 1;
  }
  return { updated: kept.size, added, removed: saved.filter((d) => !kept.has(d.id)) };
}

/**
 * `2 dishes updated, 1 new, 1 removed`. Only the parts that happen, and the
 * noun goes on whichever comes first so a single count still agrees.
 */
export function changeSummary(c: { updated: number; added: number; removed: number }): string {
  const noun = (n: number) => (n === 1 ? "dish" : "dishes");
  const parts: string[] = [];
  if (c.updated > 0) parts.push(`${c.updated} ${noun(c.updated)} updated`);
  if (c.added > 0) {
    parts.push(parts.length === 0 ? `${c.added} new ${noun(c.added)}` : `${c.added} new`);
  }
  if (c.removed > 0) {
    parts.push(parts.length === 0 ? `${c.removed} ${noun(c.removed)} removed` : `${c.removed} removed`);
  }
  return parts.length === 0 ? "No dishes" : parts.join(", ");
}

/**
 * Who is having this dish, as a sentence.
 *
 * Null for a dish that nobody has chosen, and for a row that has not been
 * saved yet: a dish being typed has no id and therefore no orders, which is
 * not the same fact as a saved dish nobody wanted.
 */
function takerNote(id: number | null, holds: DishTakers): string | null {
  if (id === null) return null;
  const names = holds.chosen.get(id);
  if (names === undefined || names.length === 0) return null;
  if (names.length <= 3) return `Ordered by ${listNames(names)}`;
  return `Ordered by ${listNames(names.slice(0, 3))} and ${names.length - 3} more`;
}

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Null when the dish can go; otherwise why the database will refuse it.
 *
 * A dish in `chosen` with no names was chosen on orders since cancelled: the
 * lines stay on the record, and the foreign key refuses the delete just the
 * same. A dish in `system` is the one a one-dish menu gave somebody, which the
 * caller puts there only once the day is past open, when the trigger no
 * longer clears those lines.
 */
function removeReason(id: number | null, holds: DishTakers): string | null {
  if (id === null) return null;
  if (holds.chosen.has(id)) {
    const note = takerNote(id, holds);
    return note === null
      ? "Was ordered and cancelled; it stays on the record, so removing it will be refused"
      : `${note}. Removing a dish somebody chose will be refused`;
  }
  if (holds.system.has(id)) {
    return "Somebody is down for it as the day's only dish, and ordering has closed, so removing it will be refused";
  }
  return null;
}

/**
 * Why Publish would be refused, or null: a dish with an order on it is no
 * longer in the list. The same fact the remove button refuses on, reached by
 * a re-parse instead of a press.
 */
export function removedOrderedReason(
  removed: SavedDish[],
  holds: DishTakers,
): string | null {
  const held = removed.find((d) => holds.chosen.has(d.id) || holds.system.has(d.id));
  if (held === undefined) return null;
  const then = "Keep it, or mark its new row as the same dish";
  if (!holds.chosen.has(held.id)) {
    return `"${held.name}" is down for somebody as the day's only dish, and ordering has closed, so it cannot be removed. ${then}`;
  }
  return takerNote(held.id, holds) === null
    ? `"${held.name}" was ordered and cancelled; it stays on the record, so it cannot be removed. ${then}`
    : `"${held.name}" would be removed, and somebody chose it. ${then}`;
}

/**
 * A name typed into a row. A row with no dish yet takes the id of a saved
 * dish no other row carries whose name it now matches, by the same rule a
 * parse matches on; one that took an id that way gives it back when the name
 * stops matching. Every other row just changes its name.
 */
export function renameRow(
  row: DishRow,
  name: string,
  rows: DishRow[],
  saved: SavedDish[],
): DishRow {
  const next = { ...row, name };
  if (row.id !== null && row.typedMatch !== true) return next;
  const claimed = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.id));
  const match = saved.find((d) => nameKey(d.name) === nameKey(name) && !claimed.has(d.id));
  if (match !== undefined) return { ...next, id: match.id, typedMatch: true };
  return row.typedMatch === true ? { ...next, id: null, typedMatch: false } : next;
}

/**
 * Why Publish would be refused, or null: a kept dish takes a name another kept
 * dish only gives up later in the same publish.
 *
 * `publish_menu` renames kept dishes one at a time in list order, and
 * `menu_items_name_uk` is checked on each, so the first of a swap, or of a
 * chain where the later row gives the name up, meets the name still in use.
 * A removed dish's name is free (removals go first), and so is any name for a
 * new row (additions go last).
 */
export function renameClash(rows: DishRow[], saved: SavedDish[]): string | null {
  const savedById = new Map(saved.map((d) => [d.id, d]));
  const holder = new Map<string, { id: number; index: number }>();
  rows.forEach((r, index) => {
    const was = r.id === null ? undefined : savedById.get(r.id);
    if (was !== undefined) holder.set(nameKey(was.name), { id: was.id, index });
  });
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    if (r.id === null || !savedById.has(r.id)) continue;
    const h = holder.get(nameKey(r.name));
    if (h !== undefined && h.id !== r.id && h.index > i) {
      return `"${r.name.trim()}" passes from #${h.id} to #${r.id} in one publish, which the database refuses. Publish one of the renames first, then the other`;
    }
  }
  return null;
}

/** The messages for one field, rendered under it. */
function FieldFlags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => (
        <p
          key={f.text}
          className={cn(
            "text-xs",
            f.level === "error" ? "text-danger-subtle-fg" : "text-warn-subtle-fg",
          )}
        >
          {f.text}
        </p>
      ))}
    </>
  );
}

function rowLabel(row: DishRow, index: number): string {
  return row.name.trim() === "" ? `dish ${index + 1}` : row.name.trim();
}

/**
 * The editable table, which is a grid rather than a `<table>`.
 *
 * A real table cannot stack: at 390px a week of dish-and-price columns either
 * scrolls sideways or squeezes the price box down to four characters, and both
 * are worse than the same information in one column per row. The grid is a
 * table on a monitor and a stack of cards on a phone, with the same labels in
 * both, so nothing is only discoverable by scrolling.
 *
 * Once the day has saved dishes, each row also says which one it is: `#101`
 * for a dish publishing updates in place, `New` for one it inserts. With
 * nothing saved every row would say `New`, which tells nobody anything, so the
 * column is not drawn.
 */
export function DishRows({
  rows,
  saved,
  currency,
  readOnlyReason,
  holds,
  onChange,
  onRemove,
}: {
  rows: DishRow[];
  /** The day's dishes as last loaded; empty when nothing is saved yet. */
  saved: SavedDish[];
  currency: Currency;
  /** Null when the menu can be edited, otherwise the sentence saying why not. */
  readOnlyReason: string | null;
  /** What holds each dish on the record, by `menu_items.id`. Empty until it loads. */
  holds: DishTakers;
  onChange: (key: string, patch: Partial<DishRow>) => void;
  onRemove: (key: string) => void;
}) {
  if (readOnlyReason !== null) {
    return (
      <ul className="flex flex-col gap-px overflow-hidden rounded-lg border border-border">
        {rows.map((row) => {
          const read = reading(row);
          return (
            <li
              key={row.key}
              className="flex items-baseline justify-between gap-4 bg-surface-raised px-4 py-3"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{row.name}</span>
                {takerNote(row.id, holds) !== null && (
                  <span className="text-xs text-muted">{takerNote(row.id, holds)}</span>
                )}
              </span>
              {/* Not `formatMoney(x ?? 0)`: on a frozen menu a zero would read
                  as a meal the office got for nothing. */}
              <span className={cn("text-muted", read !== null && "tabular")}>
                {unpriced(row)
                  ? PRICE_PENDING
                  : read === null
                    ? "No price read"
                    : formatMoney(read.minor, currency)}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  const identity = saved.length > 0;
  const savedById = new Map(saved.map((d) => [d.id, d]));
  const { removed } = dishChanges(rows, saved);

  return (
    <div className="flex flex-col gap-3">
      {/* Where the decision is made, not in a help page. Without it the only
          way to find out that empty is allowed is to clear a box and notice
          Publish stayed enabled, so a careful admin invents a number instead
          -- which is the mistake nullable prices exist to prevent. */}
      <p className="text-sm text-muted">
        Leave a price empty when the caterer has not said yet. The dish still publishes and people
        can order it; it is billed once you set the price.
        {identity &&
          " A number is a dish already saved: publishing updates it in place and its orders stay. New is added."}
      </p>

      <div
        aria-hidden="true"
        className={cn(
          "hidden gap-3 px-1 text-xs font-semibold text-subtle sm:grid",
          identity
            ? "sm:grid-cols-[3.5rem_minmax(0,1fr)_10rem_2.75rem]"
            : "sm:grid-cols-[minmax(0,1fr)_10rem_2.75rem]",
        )}
      >
        {identity && <span />}
        <span>Dish</span>
        <span>Price</span>
        <span />
      </div>

      <ul className="flex flex-col gap-3 sm:gap-5">
        {rows.map((row, i) => {
          const flags = flagsFor(row, rows, currency);
          const read = reading(row);
          const pending = unpriced(row);
          const label = rowLabel(row, i);
          const was = row.id === null ? undefined : savedById.get(row.id);
          // Offered where the name alone does not say which dish this is: a
          // new row while something is about to be removed, and a row whose
          // name no longer matches the dish it updates.
          const renamed = was !== undefined && nameKey(was.name) !== nameKey(row.name);
          const sameAs = identity && ((was === undefined && removed.length > 0) || renamed);
          return (
            <li
              key={row.key}
              className={cn(
                "rounded-lg border border-border bg-surface-raised p-3 sm:border-0 sm:bg-transparent sm:p-0",
                "grid grid-cols-1 gap-3 sm:items-start",
                identity
                  ? "sm:grid-cols-[3.5rem_minmax(0,1fr)_10rem_2.75rem]"
                  : "sm:grid-cols-[minmax(0,1fr)_10rem_2.75rem]",
              )}
            >
              {identity && (
                <div className="-mb-1 flex items-center sm:mb-0 sm:h-11">
                  {was === undefined ? (
                    <Badge id={`${row.key}-identity`} variant="outline">
                      New
                      <span className="sr-only"> dish, added when you publish</span>
                    </Badge>
                  ) : (
                    <span id={`${row.key}-identity`} className="tabular text-xs text-muted">
                      <span className="sr-only">Saved dish </span>
                      {`#${was.id}`}
                      <span className="sr-only">, updated in place</span>
                    </span>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`${row.key}-name`}
                  className="text-xs font-medium text-subtle sm:sr-only"
                >
                  Dish
                </label>
                <input
                  id={`${row.key}-name`}
                  aria-label={`Dish ${i + 1} name`}
                  aria-describedby={identity ? `${row.key}-identity` : undefined}
                  value={row.name}
                  onChange={(e) => onChange(row.key, { name: e.target.value })}
                  className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base"
                />
                <FieldFlags flags={flags.filter((f) => f.field === "name")} />
                {sameAs && (
                  <SameDishAs
                    row={row}
                    label={label}
                    current={renamed ? was : undefined}
                    removed={removed}
                    onPick={(id) => onChange(row.key, { id, typedMatch: false })}
                  />
                )}
                {takerNote(row.id, holds) !== null && (
                  <p className="text-xs text-muted">{takerNote(row.id, holds)}</p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`${row.key}-price`}
                  className="text-xs font-medium text-subtle sm:sr-only"
                >
                  Price
                </label>
                <input
                  id={`${row.key}-price`}
                  aria-label={`Price of ${label}`}
                  aria-describedby={pending ? `${row.key}-pending` : undefined}
                  value={row.price}
                  inputMode="numeric"
                  onChange={(e) => onChange(row.key, { price: e.target.value })}
                  className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base tabular"
                />
                {/* The slot the amount occupies, occupied either way, so a dish
                    reopened with an empty box reads as unpriced rather than as
                    a blank nobody can tell from a price of zero. */}
                {pending ? (
                  <p id={`${row.key}-pending`} className="text-xs text-muted">
                    {PRICE_PENDING}
                  </p>
                ) : read !== null ? (
                  <p className="tabular text-xs text-muted">{formatMoney(read.minor, currency)}</p>
                ) : null}
                <FieldFlags flags={flags.filter((f) => f.field === "price")} />
              </div>

              <div className="flex justify-end sm:block">
                <Action
                  variant="ghost"
                  size="icon-sm"
                  title={`Remove ${label}`}
                  aria-label={`Remove ${label}`}
                  // The trigger refuses this anyway. Saying so here, with the
                  // names, turns a refusal somebody has to read twice into the
                  // list of people they now have to ring.
                  reason={removeReason(row.id, holds)}
                  onClick={() => onRemove(row.key)}
                >
                  <Trash2Icon />
                </Action>
              </div>

              {/* Only what is about the row as a whole. Everything that is
                  about one box now renders under that box. */}
              {row.source !== null && (
                <p
                  className={cn(
                    "text-xs text-subtle sm:-mt-1 sm:pl-1",
                    identity ? "sm:col-span-3 sm:col-start-2" : "sm:col-span-3",
                  )}
                >
                  {`From the message: ${row.source}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Which saved dish a row stands for, when its name does not say.
 *
 * A native select: the choices are the handful of dishes about to be removed,
 * too few to search, and a phone's own picker is the best one there is.
 * Picking one turns a delete-and-insert into a rename, so the orders on the
 * old dish stay with it.
 */
function SameDishAs({
  row,
  label,
  current,
  removed,
  onPick,
}: {
  row: DishRow;
  label: string;
  /** The saved dish this row already renames, if any. */
  current: SavedDish | undefined;
  removed: SavedDish[];
  onPick: (id: number | null) => void;
}) {
  const options = current === undefined ? removed : [current, ...removed];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={`${row.key}-same`} className="text-xs text-muted">
        Same dish as
      </label>
      <select
        id={`${row.key}-same`}
        aria-label={`${label} is the same dish as`}
        value={row.id === null ? "" : String(row.id)}
        onChange={(e) => onPick(e.target.value === "" ? null : Number(e.target.value))}
        className="h-11 min-w-0 max-w-full rounded-md border border-border bg-surface-raised px-2 text-sm text-text sm:h-9"
      >
        <option value="">None, a new dish</option>
        {options.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Saved dishes that are no longer in the list, which publishing deletes.
 *
 * Listed rather than implied, because a re-parse removes a dish by leaving it
 * out, and nothing on the rows can show an absence. Struck through, as a
 * skipped day is on the board: the strike says "not this one".
 */
export function RemovedDishes({
  removed,
  holds,
  currency,
  onKeep,
}: {
  removed: SavedDish[];
  holds: DishTakers;
  currency: Currency;
  onKeep: (dish: SavedDish) => void;
}) {
  if (removed.length === 0) return null;
  return (
    <section aria-labelledby="removed-heading" className="flex flex-col gap-2">
      <h3 id="removed-heading" className="text-sm font-semibold">
        Will be removed
      </h3>
      <p className="text-sm text-muted">
        {removed.length === 1
          ? "Saved, but not in the list above, so publishing deletes it."
          : "Saved, but not in the list above, so publishing deletes them."}
      </p>
      <ul
        aria-labelledby="removed-heading"
        className="divide-y divide-border rounded-lg border border-border bg-surface-raised"
      >
        {removed.map((dish) => {
          const reason = removeReason(dish.id, holds);
          return (
            <li key={dish.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">
                  <span className="text-muted line-through">{dish.name}</span>
                  <span className="tabular text-xs text-subtle">
                    {` #${dish.id} · ${
                      dish.priceMinor === null ? PRICE_PENDING : formatMoney(dish.priceMinor, currency)
                    }`}
                  </span>
                </span>
                {reason !== null && (
                  <span className="text-xs text-danger-subtle-fg">{`${reason}.`}</span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-11 shrink-0 sm:h-9"
                aria-label={`Keep ${dish.name}`}
                onClick={() => onKeep(dish)}
              >
                Keep
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
