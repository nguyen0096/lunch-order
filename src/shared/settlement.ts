/**
 * Read the caterer's weekend settlement message, and check it against the board.
 *
 * A menu message and a settlement message are not the same document. A menu is
 * a list of dishes written one per line before anybody has eaten; a settlement
 * is one paragraph written afterwards -- `cơm tấm 50k, tuần rồi em ăn 5 phần,
 * bún bò 60k, tổng cộng là 550k` -- carrying one price per dish for the whole
 * week, sometimes the caterer's own portion count, and usually a grand total.
 * So this parses by scanning tokens across a line rather than by classifying
 * lines, because several dishes routinely share one.
 *
 * Pure and framework-free, like `menuParser`, and for the same reason: it is
 * the piece most likely to be wrong and it has to be testable without a
 * database. Nothing here decides anything. The admin sees every number beside
 * ours and presses the button.
 *
 * Reading the number itself is `parseVietnamesePrice`'s job and is not redone
 * here: this locates the span, that reads it.
 */

import { parseVietnamesePrice } from "./money.js";

export type SettlementWarning =
  | "price_out_of_range"
  | "price_inferred_thousands"
  | "price_ambiguous_decimal"
  | "duplicate_name";

export type ParsedDish = {
  /** Stable within one parse, so an edit survives a small re-paste. */
  id: string;
  name: string;
  priceMinor: number;
  /**
   * The caterer's own count of portions, or null when they gave none. Null is
   * never 0: "they did not say" and "they say nobody ate it" are different
   * pieces of news and only one of them is a disagreement.
   */
  theirCount: number | null;
  sourceLine: number;
  raw: string;
  warnings: SettlementWarning[];
};

export type ParsedSettlement = {
  dishes: ParsedDish[];
  /** The grand total the caterer stated, when the message carries one. */
  statedTotalMinor: number | null;
  /** Greetings and headers. Kept and shown, never silently dropped. */
  notes: string[];
  /** Lines carrying something we could not read. Shown, so a miss is visible. */
  unparsed: { line: number; raw: string }[];
};

export type ParseSettlementOptions = {
  /** Plausible per-portion band in minor units. Outside it, flag rather than drop. */
  minPrice?: number;
  maxPrice?: number;
};

const DEFAULT_MIN = 15_000;
const DEFAULT_MAX = 500_000;

/**
 * One left-to-right pass over a line, counts before prices.
 *
 * The order of the alternatives is the whole trick: `5 phần` has to be read as
 * five portions, and a price scanner that ran first would take the 5 and leave
 * `phần` as part of the next dish's name.
 *
 * A bare number with no thousand or currency word is deliberately still
 * matched here and rejected below, rather than left unmatched: `Cơm gà 2 miếng
 * 50k` has to keep `2 miếng` in the name, and the only way to know the 2 is
 * not the price is to look at it.
 */
const TOKEN = new RegExp(
  [
    String.raw`(?<cnum>\d{1,3})\s*(?<cword>phần|phan|suất|suat|xuất|xuat)(?![\p{L}])`,
    String.raw`(?<![\p{L}\d])x\s*(?<xnum>\d{1,2})(?![\d.,])`,
    // No bare `d` in the suffix list, unlike the menu parser. That one anchors
    // to the end of a line where `d` can only be đồng; here it would read the
    // 50 of "50 dĩa" as fifty dong.
    String.raw`(?<pnum>\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(?<psuf>k|nghìn|ngàn|nghin|ngan|đ|vnđ|vnd|₫)?(?![\p{L}])`,
  ].join("|"),
  "giu",
);

/** The grand total, in the forms a caterer actually writes it. */
const TOTAL = /(?<![\p{L}])(tổng cộng|tong cong|tổng tiền|tong tien|tổng|tong|tất cả|tat ca|thành tiền|thanh tien|cộng lại|cong lai|total)(?![\p{L}])/iu;

// Numbered, dashed, bulleted and emoji-prefixed list markers, as the menu parser has.
const LEADER =
  /^\s*(?:\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*\s*)*(?:[-*•·–—+>»]+|\(?\d{1,2}[.)/]|\d{1,2}\s*[-–])?\s*/u;

const HEADER = /^(thực đơn|thuc don|menu|tuần|tuan|tuần rồi|tuan roi|chào|chao|hi|hello|em gửi|em gui)/i;

/** Words that only ever join a dish to its price, never name one. */
const LEADING_FILLER = /^(?:và|va|còn|con|rồi|roi|thêm|them|với|voi|em|anh|chị|chi|ạ|a)\b[\s,.:;-]*/iu;
const TRAILING_FILLER = /[\s,.:;-]*\b(?:là|la|giá|gia|tiền|tien|ăn|an|hết|het|mỗi|moi|suất|suat|phần|phan)$/iu;

export function parseSettlement(
  text: string,
  opts: ParseSettlementOptions = {},
): ParsedSettlement {
  const min = opts.minPrice ?? DEFAULT_MIN;
  const max = opts.maxPrice ?? DEFAULT_MAX;

  // NFC first, as the menu parser does. Chat apps on iOS emit decomposed
  // Vietnamese, and without normalising, two spellings of `Cơm` never match.
  const lines = text.normalize("NFC").split(/\r?\n/);

  const dishes: ParsedDish[] = [];
  const notes: string[] = [];
  const unparsed: { line: number; raw: string }[] = [];
  const seen = new Map<string, ParsedDish>();
  let statedTotalMinor: number | null = null;

  lines.forEach((raw, lineNo) => {
    const line = raw.trim();
    if (line === "") return;

    let pendingName = "";
    let pendingCount: number | null = null;
    /** The dish this line priced most recently, still open to a trailing count. */
    let openDish: ParsedDish | null = null;
    let cursor = 0;
    let sawAnything = false;

    TOKEN.lastIndex = 0;
    for (let m = TOKEN.exec(line); m !== null; m = TOKEN.exec(line)) {
      const gap = line.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      const g = m.groups ?? {};

      const count = g.cnum ?? g.xnum;
      if (count !== undefined) {
        const n = Number(count);
        if (openDish !== null && openDish.theirCount === null) {
          // "cơm tấm 50k, tuần rồi em ăn 5 phần": the count belongs to the
          // dish just priced, and the words between the two are conversation,
          // not the beginning of the next dish's name.
          openDish.theirCount = n;
          pendingName = "";
        } else {
          // "5 phần cơm tấm 50k": the count arrives first, so the name is
          // still being accumulated and must survive.
          pendingName += gap;
          pendingCount = n;
        }
        sawAnything = true;
        continue;
      }

      const digits = g.pnum;
      if (digits === undefined) continue;
      const token = m[0];
      const reading = parseVietnamesePrice(token);
      // A bare two-digit number mid-line is a quantity, a dish size or noise:
      // only a thousand or currency word, a separator group, or a number
      // already in the thousands makes it a price. Ending the line is the one
      // place a bare number is unambiguous, because there is nothing after it
      // for it to be the quantity of -- which is the rule the menu parser gets
      // for free by anchoring to `$`, and this one has to ask for.
      const endsLine = /^[\s.,;:!…)\]]*$/u.test(line.slice(cursor));
      const isPrice =
        reading !== null &&
        (g.psuf !== undefined ||
          /[.,\s]\d{3}/.test(digits) ||
          Number(digits) >= 1000 ||
          (endsLine && (pendingName + gap).trim() !== ""));
      if (!isPrice || reading === null) {
        pendingName += gap + token;
        continue;
      }

      sawAnything = true;

      if (TOTAL.test(pendingName + gap)) {
        // Last one wins: a caterer who restates the total has corrected it.
        statedTotalMinor = reading.minor;
        pendingName = "";
        pendingCount = null;
        openDish = null;
        continue;
      }

      const name = cleanName(pendingName + gap);
      pendingName = "";
      if (name === "") {
        // A price with no dish attached is not a dish priced at nothing.
        unparsed.push({ line: lineNo, raw: line });
        pendingCount = null;
        openDish = null;
        continue;
      }

      const warnings: SettlementWarning[] = [];
      if (reading.inferredThousands) warnings.push("price_inferred_thousands");
      if (reading.ambiguousDecimal) warnings.push("price_ambiguous_decimal");
      if (reading.minor < min || reading.minor > max) warnings.push("price_out_of_range");

      const key = dishKey(name);
      const prior = seen.get(key);
      if (prior) {
        // Keep the first price and flag it, rather than guessing which of two
        // prices for one dish the caterer meant.
        if (!prior.warnings.includes("duplicate_name")) prior.warnings.push("duplicate_name");
        if (prior.theirCount === null && pendingCount !== null) prior.theirCount = pendingCount;
        pendingCount = null;
        openDish = prior;
        continue;
      }

      const dish: ParsedDish = {
        id: `l${lineNo}i${dishes.length}`,
        name,
        priceMinor: reading.minor,
        theirCount: pendingCount,
        sourceLine: lineNo,
        raw: line,
        warnings,
      };
      dishes.push(dish);
      seen.set(key, dish);
      pendingCount = null;
      openDish = dish;
    }

    if (sawAnything) return;

    // Nothing numeric on the line at all: a greeting, a header, or a miss.
    const body = line.replace(LEADER, "").trim();
    if (body === "" || HEADER.test(body)) notes.push(line);
    else unparsed.push({ line: lineNo, raw: line });
  });

  return { dishes, statedTotalMinor, notes, unparsed };
}

function cleanName(raw: string): string {
  let name = raw.replace(LEADER, "").trim();
  // Repeated because a message runs several together: ", và còn bún bò".
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(/^[\s,.:;•·\-–—]+/u, "").replace(LEADING_FILLER, "");
    if (next === name) break;
    name = next;
  }
  for (let i = 0; i < 3; i += 1) {
    const next = name.replace(TRAILING_FILLER, "").replace(/[\s,.:;·\-–—]+$/u, "");
    if (next === name) break;
    name = next;
  }
  return name.replace(/\s+/g, " ").trim();
}

/**
 * The key two spellings of one dish have to share.
 *
 * Mirrors what the database itself does: `menu_items_name_uk` is unique on
 * `lower(btrim(name))`, and `unaccent_fallback` folds the Vietnamese diacritics
 * by hand because the `unaccent` extension is not enabled on this project. `đ`
 * is the one letter with no canonical decomposition, so it is mapped
 * separately here the same way it is mapped there.
 */
export function dishKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------ reconciliation */

/** A dish the board recorded for the week being settled. */
export type ServedDish = {
  /** As it is spelled on the menu. */
  name: string;
  /** Portions the board recorded: the sum of the quantities on placed orders. */
  count: number;
  /**
   * Portions of those still carrying no price. These are the meals a late
   * price reaches: `enforce_menu_item_frozen` exempts a price going from NULL
   * to a value on a locked menu, and nothing wider.
   */
  waitingCount?: number;
  /**
   * Prices already on the board for this dish, distinct. Empty is the ordinary
   * state at settlement time, because the caterer prices afterwards.
   */
  pricedAtMinor?: number[];
};

export type ReconciledIssue =
  /** Both counts are known and they are the same number. */
  | "agreed"
  /** Both counts are known and they are not. The reason this is a screen. */
  | "counts_differ"
  /** They priced it and did not say how many. */
  | "no_count"
  /** They named a dish that was never on one of our menus this week. */
  | "not_on_our_board"
  /** We served it and their message does not mention it. */
  | "not_in_message";

export type ReconciledDish = {
  key: string;
  /** The board's spelling where we served it, the caterer's where we did not. */
  name: string;
  /** Their price per portion, or null when their message does not price it. */
  priceMinor: number | null;
  theirCount: number | null;
  /** Null means this dish was never on one of our menus that week. */
  ourCount: number | null;
  /** How many of ours are still waiting on a price. */
  waitingCount: number;
  /**
   * Prices already on the board that the caterer's message contradicts. Empty
   * is the ordinary case.
   *
   * A second axis, not a variety of `issue`, because the two genuinely
   * co-occur: the caterer can miscount a dish and quote a different price for
   * it in the same sentence, and folding one into the other would hide
   * whichever came second.
   */
  contradictsMinor: number[];
  issue: ReconciledIssue;
  warnings: SettlementWarning[];
};

export type Reconciliation = {
  /** Our board's dishes in board order, then the ones only they named. */
  dishes: ReconciledDish[];
  /** Their prices at their counts, over the dishes where they gave both. */
  theirTotalMinor: number;
  /** False when at least one dish they priced carries no count of theirs. */
  theirTotalComplete: boolean;
  /** Their prices at our counts. This is what applying them would bill. */
  ourTotalMinor: number;
  /** The total they stated in the message, when they stated one. */
  statedTotalMinor: number | null;
  /** How many dishes the two counts disagree on. */
  disagreements: number;
  /** How many dishes the caterer prices differently from the board. */
  contradictions: number;
};

/**
 * Put the caterer's message beside the board, dish by dish.
 *
 * Neither count is preferred and neither is quietly dropped. The caterer
 * saying five when the board recorded four is the thing an admin has to catch
 * before paying, so every row carries both numbers and says which is which,
 * and a dish that appears on only one side is a row of its own rather than an
 * omission.
 */
export function reconcile(parsed: ParsedSettlement, served: ServedDish[]): Reconciliation {
  const theirs = new Map<string, ParsedDish>();
  for (const d of parsed.dishes) theirs.set(dishKey(d.name), d);

  const dishes: ReconciledDish[] = [];
  const matched = new Set<string>();

  for (const s of served) {
    const key = dishKey(s.name);
    const mine = theirs.get(key);
    if (mine) matched.add(key);
    dishes.push({
      key,
      name: s.name,
      priceMinor: mine?.priceMinor ?? null,
      theirCount: mine?.theirCount ?? null,
      ourCount: s.count,
      waitingCount: s.waitingCount ?? s.count,
      // Only a price already on the board can be contradicted. A dish still
      // waiting on one agrees with whatever the caterer now says, because
      // nobody had agreed to anything.
      contradictsMinor:
        mine === undefined
          ? []
          : (s.pricedAtMinor ?? []).filter((p) => p !== mine.priceMinor),
      issue:
        mine === undefined
          ? "not_in_message"
          : mine.theirCount === null
            ? "no_count"
            : mine.theirCount === s.count
              ? "agreed"
              : "counts_differ",
      warnings: mine?.warnings ?? [],
    });
  }

  for (const d of parsed.dishes) {
    const key = dishKey(d.name);
    if (matched.has(key)) continue;
    dishes.push({
      key,
      name: d.name,
      priceMinor: d.priceMinor,
      theirCount: d.theirCount,
      ourCount: null,
      waitingCount: 0,
      contradictsMinor: [],
      issue: "not_on_our_board",
      warnings: d.warnings,
    });
  }

  let theirTotalMinor = 0;
  let theirTotalComplete = true;
  let ourTotalMinor = 0;
  let disagreements = 0;

  let contradictions = 0;

  for (const d of dishes) {
    if (d.issue === "counts_differ") disagreements += 1;
    if (d.contradictsMinor.length > 0) contradictions += 1;
    if (d.priceMinor === null) continue;
    if (d.theirCount === null) theirTotalComplete = false;
    else theirTotalMinor += d.priceMinor * d.theirCount;
    if (d.ourCount !== null) ourTotalMinor += d.priceMinor * d.ourCount;
  }

  return {
    dishes,
    theirTotalMinor,
    theirTotalComplete,
    ourTotalMinor,
    statedTotalMinor: parsed.statedTotalMinor,
    disagreements,
    contradictions,
  };
}
