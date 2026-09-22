import { parseVietnamesePrice } from "./money.js";

export type ItemWarning =
  | "price_out_of_range"
  | "price_inferred_thousands"
  | "price_ambiguous_decimal"
  | "duplicate_name";

export type ParsedItem = {
  /** Stable within one parse, so manual edits survive a small re-paste. */
  id: string;
  name: string;
  priceMinor: number;
  sourceLine: number;
  raw: string;
  warnings: ItemWarning[];
};

export type ParsedMenu = {
  /** YYYY-MM-DD, or null when nothing date-like was found. Always confirmed by a human. */
  serviceDateGuess: string | null;
  items: ParsedItem[];
  /** Headers and notes. Kept and shown, never silently dropped. */
  notes: string[];
  /** Lines we could not classify. The UI offers "add as item" for each. */
  unparsed: { line: number; raw: string }[];
};

export type ParseOptions = {
  /** Today in the org's timezone, YYYY-MM-DD. Injected so tests never touch the clock. */
  today: string;
  /** Plausible price band in minor units. Outside it, flag rather than discard. */
  minPrice?: number;
  maxPrice?: number;
};

const DEFAULT_MIN = 15_000;
const DEFAULT_MAX = 500_000;

// Numbered, dashed, bulleted, and emoji-prefixed list markers.
const LEADER =
  /^\s*(?:\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*\s*)*(?:[-*•·–—+>»]+|\(?\d{1,2}[.)\/]|\d{1,2}\s*[-–])?\s*/u;

const HEADER = /^(thực đơn|thuc don|menu|ngày|ngay|thứ|thu\s*[2-7]\b|t[2-7]\b|cn\b)/i;
const NOTE = /^(note|lưu ý|luu y|ghi chú|ghi chu|đặt|dat |deadline|free|miễn phí|mien phi|liên hệ|lien he)/i;

/**
 * Parse a caterer's pasted chat message into draft menu items.
 *
 * Pure and framework-free: this is the single highest-risk piece of logic in
 * the app and it must be testable without a database or a browser. The admin
 * reviews and can edit everything before anything is written, so a miss is an
 * annoyance rather than a wrong order.
 */
export function parseMenu(text: string, opts: ParseOptions): ParsedMenu {
  const min = opts.minPrice ?? DEFAULT_MIN;
  const max = opts.maxPrice ?? DEFAULT_MAX;

  // NFC first. Chat apps on iOS emit decomposed Vietnamese (`Cơ` as C + o +
  // U+031B + U+0301). Without normalising, dedup silently fails and the same
  // dish appears twice.
  const lines = text.normalize("NFC").split(/\r?\n/);

  const items: ParsedItem[] = [];
  const notes: string[] = [];
  const unparsed: { line: number; raw: string }[] = [];
  const seen = new Map<string, ParsedItem>();
  let serviceDateGuess: string | null = null;

  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;

    if (i < 3 && serviceDateGuess === null) {
      serviceDateGuess = guessDate(trimmed, opts.today);
    }

    const body = trimmed.replace(LEADER, "").trim();
    if (body === "") {
      notes.push(trimmed);
      return;
    }

    // A note is a note even if it contains a number: "đặt trước 9h sáng" must
    // not become a 9000d dish.
    if (NOTE.test(body)) {
      notes.push(trimmed);
      return;
    }

    const reading = parseVietnamesePrice(body);
    if (reading === null) {
      if (HEADER.test(body)) notes.push(trimmed);
      else unparsed.push({ line: i, raw: trimmed });
      return;
    }

    // Strip the matched price off the end; what remains is the dish name.
    const name = body
      .replace(
        /\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(k|nghìn|ngàn|nghin|ngan|đ|d|vnd|vnđ|₫)?\s*[.…]*\s*$/iu,
        "",
      )
      .replace(/[\s\-–—:·.]+$/u, "")
      .replace(/\s+/g, " ")
      .trim();

    if (name === "") {
      // A price with no dish attached is not an item priced 0.
      unparsed.push({ line: i, raw: trimmed });
      return;
    }
    if (HEADER.test(name)) {
      notes.push(trimmed);
      return;
    }

    const warnings: ItemWarning[] = [];
    if (reading.inferredThousands) warnings.push("price_inferred_thousands");
    if (reading.ambiguousDecimal) warnings.push("price_ambiguous_decimal");
    if (reading.minor < min || reading.minor > max) warnings.push("price_out_of_range");

    const key = name.toLowerCase();
    const prior = seen.get(key);
    if (prior) {
      // Keep the first price; flag rather than guess which was intended.
      if (!prior.warnings.includes("duplicate_name")) prior.warnings.push("duplicate_name");
      return;
    }

    const item: ParsedItem = {
      id: `l${i}`,
      name,
      priceMinor: reading.minor,
      sourceLine: i,
      raw: trimmed,
      warnings,
    };
    items.push(item);
    seen.set(key, item);
  });

  return { serviceDateGuess, items, notes, unparsed };
}

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/\b(thứ\s*2|thu\s*2|t2)\b/i, 1],
  [/\b(thứ\s*3|thu\s*3|t3)\b/i, 2],
  [/\b(thứ\s*4|thu\s*4|t4)\b/i, 3],
  [/\b(thứ\s*5|thu\s*5|t5)\b/i, 4],
  [/\b(thứ\s*6|thu\s*6|t6)\b/i, 5],
  [/\b(thứ\s*7|thu\s*7|t7)\b/i, 6],
  [/\b(chủ nhật|chu nhat|cn)\b/i, 7],
];

/** Best effort only: the admin always confirms with a date picker. */
function guessDate(line: string, today: string): string | null {
  const dm = line.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (dm) {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // A late-December paste naming a January date means next year.
      if (!dm[3] && daysBetween(today, iso) < -180) {
        iso = `${y + 1}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
      return iso;
    }
  }
  for (const [re, target] of WEEKDAY_WORDS) {
    if (re.test(line)) return nextWeekday(today, target);
  }
  return null;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/** The next occurrence of `target`, never today: menus are published ahead. */
function nextWeekday(today: string, target: number): string {
  const base = Date.parse(`${today}T00:00:00Z`);
  const current = new Date(base).getUTCDay() || 7;
  const shift = ((target - current + 7) % 7) || 7;
  return new Date(base + shift * 86_400_000).toISOString().slice(0, 10);
}
