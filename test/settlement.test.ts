import {
  dishKey,
  parseSettlement,
  reconcile,
  type ParsedSettlement,
  type ServedDish,
} from "../src/shared/settlement.js";

/**
 * The settlement parser and the reconciliation it feeds.
 *
 * Both are pure, so these tests are the whole of the evidence: there is no
 * screen to look at that would show a misread price, and by the time one
 * reaches a bill somebody has already been asked for the wrong money.
 *
 * The messages here are written the way a caterer writes them -- one
 * paragraph, several dishes to a line, no list markers, a count in the middle
 * of a sentence -- rather than the way a menu is written.
 */

/** The message the whole feature exists for, in its real shape. */
const REAL = "cơm tấm 50k, tuần rồi em ăn 5 phần, bún bò 60k, tổng cộng là 550k";

function names(parsed: ParsedSettlement): string[] {
  return parsed.dishes.map((d) => d.name);
}

describe("Reading the caterer's weekend message", () => {
  it("reads the real message: a price, their count, another dish and a total", () => {
    const parsed = parseSettlement(REAL);

    expect(parsed.dishes).toHaveLength(2);
    expect(parsed.dishes[0]).toMatchObject({
      name: "cơm tấm",
      priceMinor: 50_000,
      theirCount: 5,
    });
    // The conversation between the price and the count -- "tuần rồi em ăn" --
    // must not become part of the next dish's name.
    expect(parsed.dishes[1]).toMatchObject({
      name: "bún bò",
      priceMinor: 60_000,
      theirCount: null,
    });
    expect(parsed.statedTotalMinor).toBe(550_000);
    expect(parsed.unparsed).toEqual([]);
  });

  it("reads several dishes from one line, which is how they are written", () => {
    const parsed = parseSettlement("Cơm tấm 50k, Bún bò 60k, Phở bò 45k, Cơm gà 40k");

    expect(names(parsed)).toEqual(["Cơm tấm", "Bún bò", "Phở bò", "Cơm gà"]);
    expect(parsed.dishes.map((d) => d.priceMinor)).toEqual([50_000, 60_000, 45_000, 40_000]);
  });

  it("reads 50k, 50.000 and 50000 as the same price", () => {
    const parsed = parseSettlement("Cơm tấm 50k, Bún bò 50.000, Phở bò 50000, Cơm gà 50,000");

    expect(parsed.dishes.map((d) => d.priceMinor)).toEqual([50_000, 50_000, 50_000, 50_000]);
  });

  it("reads đ, ₫ and nghìn as well", () => {
    const parsed = parseSettlement("Cơm tấm 50.000đ, Bún bò 60.000 ₫, Phở bò 45 nghìn");

    expect(parsed.dishes.map((d) => d.priceMinor)).toEqual([50_000, 60_000, 45_000]);
  });

  it("leaves the count null when the caterer does not give one", () => {
    const parsed = parseSettlement("cơm tấm 50k, bún bò 60k");

    expect(parsed.dishes.map((d) => d.theirCount)).toEqual([null, null]);
  });

  it("takes a count written before the dish, and one written as x5", () => {
    const parsed = parseSettlement("5 suất cơm tấm 50k\nbún bò 60k x3");

    expect(parsed.dishes[0]).toMatchObject({ name: "cơm tấm", theirCount: 5 });
    expect(parsed.dishes[1]).toMatchObject({ name: "bún bò", theirCount: 3 });
  });

  it("reads phần and suất, accented or not", () => {
    const parsed = parseSettlement("cơm tấm 50k 5 phan\nbún bò 60k 3 suất");

    expect(parsed.dishes.map((d) => d.theirCount)).toEqual([5, 3]);
  });

  it("takes the stated total from tổng cộng without making a dish of it", () => {
    const parsed = parseSettlement("cơm tấm 50k\nbún bò 60k\ntổng cộng 550.000");

    expect(names(parsed)).toEqual(["cơm tấm", "bún bò"]);
    expect(parsed.statedTotalMinor).toBe(550_000);
  });

  it("does not read a number that is not a price as one", () => {
    // "2 miếng" is a dish size. Reading the 2 as the price and leaving "miếng"
    // on the name is how a 50.000 ₫ lunch becomes a 2.000 ₫ one.
    const parsed = parseSettlement("Cơm gà 2 miếng 50k");

    expect(parsed.dishes).toHaveLength(1);
    expect(parsed.dishes[0]).toMatchObject({ name: "Cơm gà 2 miếng", priceMinor: 50_000 });
  });

  it("keeps a line it could not read rather than dropping it", () => {
    const parsed = parseSettlement("cơm tấm 50k\nbún bò hôm qua hết hàng");

    expect(names(parsed)).toEqual(["cơm tấm"]);
    expect(parsed.unparsed).toEqual([{ line: 1, raw: "bún bò hôm qua hết hàng" }]);
  });

  it("keeps the first price when the caterer prices a dish twice, and says so", () => {
    const parsed = parseSettlement("cơm tấm 50k, bún bò 60k, cơm tấm 55k");

    expect(parsed.dishes).toHaveLength(2);
    expect(parsed.dishes[0]).toMatchObject({ name: "cơm tấm", priceMinor: 50_000 });
    expect(parsed.dishes[0]?.warnings).toContain("duplicate_name");
  });

  it("flags a bare number read as thousands, and a comma read as a decimal point", () => {
    const parsed = parseSettlement("cơm tấm 45\nbún bò 45,5k");

    expect(parsed.dishes[0]).toMatchObject({ priceMinor: 45_000 });
    expect(parsed.dishes[0]?.warnings).toContain("price_inferred_thousands");
    expect(parsed.dishes[1]).toMatchObject({ priceMinor: 45_500 });
    expect(parsed.dishes[1]?.warnings).toContain("price_ambiguous_decimal");
  });

  it("flags a price outside what a lunch costs rather than discarding it", () => {
    const parsed = parseSettlement("cơm tấm 900.000");

    expect(parsed.dishes[0]).toMatchObject({ priceMinor: 900_000 });
    expect(parsed.dishes[0]?.warnings).toContain("price_out_of_range");
  });

  it("keeps a greeting as a note and not as a dish", () => {
    const parsed = parseSettlement("em gửi anh\ncơm tấm 50k");

    expect(parsed.notes).toEqual(["em gửi anh"]);
    expect(names(parsed)).toEqual(["cơm tấm"]);
  });

  it("folds a dish name the way the database folds it", () => {
    expect(dishKey("Cơm Tấm")).toBe(dishKey("com tam"));
    expect(dishKey("Bánh mì đặc biệt")).toBe("banh mi dac biet");
    // NFD input, as chat apps on iOS emit it.
    expect(dishKey("Cơm tấm".normalize("NFD"))).toBe(dishKey("Cơm tấm"));
  });
});

/* ------------------------------------------------------------ reconciliation */

const SERVED: ServedDish[] = [
  { name: "Cơm tấm", count: 4 },
  { name: "Bún bò", count: 3 },
];

describe("Checking the message against the board", () => {
  it("puts their count beside ours and flags the one that disagrees", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 5 phần, bún bò 60k 3 phần"), SERVED);

    expect(r.dishes[0]).toMatchObject({
      name: "Cơm tấm",
      theirCount: 5,
      ourCount: 4,
      issue: "counts_differ",
    });
    expect(r.dishes[1]).toMatchObject({ theirCount: 3, ourCount: 3, issue: "agreed" });
    expect(r.disagreements).toBe(1);
  });

  it("matches a dish across spelling, case and accents", () => {
    const r = reconcile(parseSettlement("COM TAM 50k 4 phần"), SERVED);

    // Our spelling wins for display: it is the one on the board.
    expect(r.dishes[0]).toMatchObject({ name: "Cơm tấm", priceMinor: 50_000, issue: "agreed" });
  });

  it("says a count is missing rather than reading it as nobody ate it", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k"), SERVED);

    expect(r.dishes[0]).toMatchObject({ theirCount: null, ourCount: 4, issue: "no_count" });
    expect(r.theirTotalComplete).toBe(false);
  });

  it("keeps a dish the caterer names that we never served", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần, phở gà 45k 2 phần"), SERVED);

    const stray = r.dishes.find((d) => d.name === "phở gà");
    expect(stray).toMatchObject({ ourCount: null, theirCount: 2, issue: "not_on_our_board" });
  });

  it("keeps a dish we served that their message omits", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), SERVED);

    expect(r.dishes[1]).toMatchObject({
      name: "Bún bò",
      priceMinor: null,
      theirCount: null,
      ourCount: 3,
      issue: "not_in_message",
    });
  });

  it("totals their prices at their counts and at ours, and keeps them apart", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 5 phần, bún bò 60k 3 phần"), SERVED);

    // Theirs: 5 x 50.000 + 3 x 60.000. Ours: 4 x 50.000 + 3 x 60.000.
    expect(r.theirTotalMinor).toBe(430_000);
    expect(r.theirTotalComplete).toBe(true);
    expect(r.ourTotalMinor).toBe(380_000);
  });

  it("carries the total they stated through, so it can be checked against both", () => {
    const r = reconcile(parseSettlement(`cơm tấm 50k 4 phần, bún bò 60k 3 phần, tổng cộng 500k`), SERVED);

    expect(r.statedTotalMinor).toBe(500_000);
    // Their own arithmetic says 380.000. Their stated total says 500.000.
    expect(r.theirTotalMinor).toBe(380_000);
  });

  it("flags a price the board has already settled differently", () => {
    // The late-price exemption covers NULL becoming a value and nothing
    // wider, so this one cannot be re-priced. It is also a disagreement about
    // money, which is the reason it is surfaced rather than swallowed.
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), [
      { name: "Cơm tấm", count: 4, waitingCount: 0, pricedAtMinor: [45_000] },
      { name: "Bún bò", count: 3, waitingCount: 3, pricedAtMinor: [] },
    ]);

    expect(r.dishes[0]).toMatchObject({ contradictsMinor: [45_000], waitingCount: 0 });
    expect(r.contradictions).toBe(1);
  });

  it("does not call it a contradiction when the board agrees with the price", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), [
      { name: "Cơm tấm", count: 4, waitingCount: 0, pricedAtMinor: [50_000] },
    ]);

    expect(r.dishes[0]?.contradictsMinor).toEqual([]);
    expect(r.contradictions).toBe(0);
  });

  it("carries the count still waiting, so a part-priced dish is not all-or-nothing", () => {
    // Priced on Monday, unpriced on Tuesday: only Tuesday's two portions can
    // take the caterer's price.
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), [
      { name: "Cơm tấm", count: 4, waitingCount: 2, pricedAtMinor: [45_000] },
    ]);

    expect(r.dishes[0]).toMatchObject({ ourCount: 4, waitingCount: 2, contradictsMinor: [45_000] });
  });

  it("never contradicts a dish the message does not mention", () => {
    const r = reconcile(parseSettlement("bún bò 60k 3 phần"), [
      { name: "Cơm tấm", count: 4, waitingCount: 0, pricedAtMinor: [45_000] },
      { name: "Bún bò", count: 3, waitingCount: 3, pricedAtMinor: [] },
    ]);

    expect(r.dishes[0]).toMatchObject({ issue: "not_in_message", contradictsMinor: [] });
    expect(r.contradictions).toBe(0);
  });

  it("treats every portion as waiting when the caller does not say otherwise", () => {
    // The ordinary settlement week: nothing is priced, so nothing is excluded.
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), SERVED);

    expect(r.dishes[0]).toMatchObject({ ourCount: 4, waitingCount: 4, contradictsMinor: [] });
  });

  it("counts a dish nobody ordered as zero, never as missing", () => {
    const r = reconcile(parseSettlement("cơm tấm 50k 4 phần"), [
      { name: "Cơm tấm", count: 4 },
      { name: "Bún bò", count: 0 },
    ]);

    expect(r.dishes[1]).toMatchObject({ ourCount: 0, issue: "not_in_message" });
  });
});
