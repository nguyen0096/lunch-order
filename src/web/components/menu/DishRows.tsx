import { Trash2Icon } from "lucide-react";
import { Button, cn } from "@/ui";
import type { DraftDish } from "../../api.js";
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

export type Flag = { level: "warn" | "error"; text: string };

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
    out.push({ level: "error", text: "This dish needs a name." });
  } else if (rows.some((other) => other.key !== row.key && sameName(other.name, row.name))) {
    out.push({ level: "error", text: "Another row has this name, and a menu cannot hold two." });
  }

  // Not a flag at all. An empty box publishes, the dish reads as unpriced
  // everywhere, and the row already says so under the box.
  if (unpriced(row)) return out;

  const read = reading(row);
  if (read === null) {
    out.push({ level: "error", text: "No price read here. Write it as 45k or 45.000." });
    return out;
  }

  if (read.inferredThousands) {
    out.push({ level: "warn", text: `No thousands written, so read as ${formatMoney(read.minor, c)}.` });
  }
  if (read.ambiguousDecimal) {
    out.push({ level: "warn", text: `Comma read as a decimal point: ${formatMoney(read.minor, c)}.` });
  }

  // Retired the moment the price changes: these describe what arrived, not
  // what the box now holds.
  if (row.price === row.seededPrice) {
    for (const w of row.seeded) {
      if (w === "price_inferred_thousands" && !read.inferredThousands) {
        out.push({ level: "warn", text: `The message wrote no thousands, so this is read as ${formatMoney(read.minor, c)}.` });
      }
      if (w === "price_ambiguous_decimal" && !read.ambiguousDecimal) {
        out.push({ level: "warn", text: `The message used a comma as a decimal point, so this is read as ${formatMoney(read.minor, c)}.` });
      }
      if (w === "price_out_of_range") {
        out.push({ level: "warn", text: "Unusual for a lunch. Check the price against the message." });
      }
      if (w === "duplicate_name") {
        out.push({ level: "warn", text: "The message listed this dish twice. The first price was kept." });
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
 */
export function DishRows({
  rows,
  currency,
  readOnlyReason,
  onChange,
  onRemove,
}: {
  rows: DishRow[];
  currency: Currency;
  /** Null when the menu can be edited, otherwise the sentence saying why not. */
  readOnlyReason: string | null;
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
              <span className="font-medium">{row.name}</span>
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

  return (
    <div className="flex flex-col gap-3">
      {/* Where the decision is made, not in a help page. Without it the only
          way to find out that empty is allowed is to clear a box and notice
          Publish stayed enabled, so a careful admin invents a number instead
          -- which is the mistake nullable prices exist to prevent. */}
      <p className="text-sm text-muted">
        Leave a price empty when the caterer has not said yet. The dish still publishes and people
        can order it; it is billed once you set the price.
      </p>

      <div
        aria-hidden="true"
        className="hidden gap-3 px-1 text-xs font-semibold text-subtle sm:grid sm:grid-cols-[minmax(0,1fr)_10rem_2.75rem]"
      >
        <span>Dish</span>
        <span>Price</span>
        <span />
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const flags = flagsFor(row, rows, currency);
          const read = reading(row);
          const pending = unpriced(row);
          const label = rowLabel(row, i);
          return (
            <li
              key={row.key}
              className={cn(
                "rounded-lg border border-border bg-surface-raised p-3 sm:border-0 sm:bg-transparent sm:p-0",
                "grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_2.75rem] sm:items-start",
              )}
            >
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
                  value={row.name}
                  onChange={(e) => onChange(row.key, { name: e.target.value })}
                  className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base"
                />
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
              </div>

              <div className="flex justify-end sm:block">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={`Remove ${label}`}
                  aria-label={`Remove ${label}`}
                  onClick={() => onRemove(row.key)}
                >
                  <Trash2Icon />
                </Button>
              </div>

              {(flags.length > 0 || row.source !== null) && (
                <div className="flex flex-col gap-1 sm:col-span-3 sm:-mt-1 sm:pl-1">
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
                  {row.source !== null && (
                    <p className="text-xs text-subtle">{`From the message: ${row.source}`}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
