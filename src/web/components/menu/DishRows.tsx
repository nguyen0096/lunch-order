import { Trash2Icon } from "lucide-react";
import { Button, cn } from "@/ui";
import type { DraftDish } from "../../api.js";
import type { ItemWarning, ParsedItem } from "../../../shared/menuParser.js";
import {
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
  item: { id: number; name: string; priceMinor: number },
  c: Currency,
): DishRow {
  const price = formatAmount(item.priceMinor, c);
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
  return { key: nextKey(), id: null, name: item.name, price, source: item.note, seeded: [], seededPrice: price };
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
    return {
      id: r.id ?? undefined,
      name: r.name.trim(),
      priceMinor: read === null ? Number.NaN : read.minor,
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
              <span className="tabular text-muted">
                {read === null ? "No price" : formatMoney(read.minor, currency)}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
                  value={row.price}
                  inputMode="numeric"
                  onChange={(e) => onChange(row.key, { price: e.target.value })}
                  className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-base tabular"
                />
                {read !== null && (
                  <p className="tabular text-xs text-muted">{formatMoney(read.minor, currency)}</p>
                )}
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
