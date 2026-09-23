import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  botDeepLink,
  decodeCallback,
  encodeCallback,
  escapeHtml,
  formatCutoffIn,
  formatServiceDate,
  humanError as botHumanError,
  isJoinCode,
  isLinkToken,
  joinCodeInPrompt,
  namePrompt,
  normalizeJoinCode,
  orderingClosedReason,
  parseCommand,
  priceText,
  renderDayText,
  renderExitCancelledText,
  renderExitRefusedText,
  renderLeaveConfirmText,
  renderLeftText,
  renderNothingBilledText,
  renderOfferText,
  renderStatementText,
  renderUnlinkConfirmText,
  renderUnlinkedText,
  targetMenu,
  todayIn,
  unpricedMealsNote,
  vietQrLink,
  NOTHING_TO_LEAVE,
  PAYMENT_REF_REQUIRED,
  PRICE_TO_COME,
  type CallbackAction,
  type DayMessage,
  type StatementMessage,
} from "../src/shared/telegram.js";
import { orderDisabledReason } from "../src/shared/gating.js";
import { PRICE_PENDING, VND, formatMoney } from "../src/shared/money.js";
import type { Menu, MenuStatus } from "../src/shared/types.js";
import { humanError as webHumanError } from "../src/web/api.js";

const TZ = "Asia/Ho_Chi_Minh";
const CUTOFF = "2026-09-22T14:00:00.000Z"; // 21:00 on 22/09 in ICT
const BEFORE = new Date("2026-09-22T13:00:00.000Z");
const AFTER = new Date("2026-09-22T15:00:00.000Z");

function menu(over: Partial<Menu> = {}): Menu {
  return {
    id: 1,
    orgId: 7,
    serviceDate: "2026-09-23",
    status: "published",
    orderCutoffAt: CUTOFF,
    items: [],
    ...over,
  };
}

describe("orderingClosedReason agrees with the web app's gating", () => {
  const statuses: MenuStatus[] = ["draft", "published", "locked", "cancelled"];

  for (const status of statuses) {
    for (const [when, now] of [["before cutoff", BEFORE], ["after cutoff", AFTER]] as const) {
      for (const isAdmin of [false, true]) {
        it(`${status}, ${when}, ${isAdmin ? "admin" : "member"}`, () => {
          const m = menu({ status });
          const web = orderDisabledReason(m, isAdmin, now, TZ);
          const bot = orderingClosedReason({
            menu: { serviceDate: m.serviceDate, status: m.status, orderCutoffAt: m.orderCutoffAt },
            isAdmin,
            now,
            timeZone: TZ,
          });
          expect(bot === null).toBe(web === null);
        });
      }
    }
  }

  it("a missing menu closes ordering on both surfaces", () => {
    expect(orderDisabledReason(null, false, BEFORE, TZ)).not.toBeNull();
    expect(orderingClosedReason({ menu: null, isAdmin: false, now: BEFORE, timeZone: TZ }))
      .not.toBeNull();
  });

  it("names the day and repeats the cutoff exactly as the trigger does", () => {
    const reason = orderingClosedReason({
      menu: { serviceDate: "2026-09-23", status: "published", orderCutoffAt: CUTOFF },
      isAdmin: false,
      now: AFTER,
      timeZone: TZ,
    });
    expect(reason).toBe("Ordering for Wed 23/09 closed at 21:00 22/09.");
  });
});

describe("humanError is the same function on both surfaces", () => {
  const cases: unknown[] = [
    null,
    {},
    { message: "ordering for 2026-09-23 closed at 21:00 22/09" },
    { message: "permission denied for function claim_outbox" },
    { message: "new row violates row-level security policy for table \"orders\"" },
    { code: "42501", message: "nope" },
    { message: "duplicate key value violates unique constraint \"orders_menu_profile_uk\"" },
    { message: "\"Cơm gà\" is not available today" },
  ];

  for (const [i, e] of cases.entries()) {
    it(`case ${i}`, () => {
      expect(botHumanError(e)).toBe(webHumanError(e));
    });
  }
});

describe("callback payloads", () => {
  const actions: CallbackAction[] = [
    { kind: "pick", menuId: 1, itemId: 2 },
    { kind: "pick", menuId: 987654, itemId: 123456 },
    { kind: "clear", menuId: 42 },
    { kind: "transfer", transferId: 9, decision: "accepted" },
    { kind: "transfer", transferId: 9, decision: "declined" },
    { kind: "leave", orgId: 7, confirmed: true },
    { kind: "leave", orgId: 987654321, confirmed: false },
    { kind: "unlink", orgId: 7, confirmed: true },
    { kind: "unlink", orgId: 987654321, confirmed: false },
  ];

  it("round-trips and stays inside Telegram's 64-byte limit", () => {
    for (const a of actions) {
      const encoded = encodeCallback(a);
      expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(64);
      expect(decodeCallback(encoded)).toEqual(a);
    }
  });

  // Leaving and disconnecting are the two taps nothing undoes, so a payload
  // that is nearly one of them is not read as one.
  it("never turns a malformed leave or unlink into a yes", () => {
    for (const bad of ["l:7", "l:7:", "l:7:x", "l:7:y:y", "l:0:y", "l:-1:y", "l:a:y", "u:7:x", "u::y"]) {
      expect(decodeCallback(bad)).toBeNull();
    }
    expect(decodeCallback("l:7:n")).toEqual({ kind: "leave", orgId: 7, confirmed: false });
    expect(decodeCallback("u:7:n")).toEqual({ kind: "unlink", orgId: 7, confirmed: false });
  });

  it("rejects anything it did not write", () => {
    for (const bad of ["", "p", "p:1", "p:1:2:3", "p:0:1", "p:-1:2", "p:a:b", "z:1:2", "c:", "t:1:x"]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });
});

describe("command parsing", () => {
  it("reads the name, the bot suffix and the argument", () => {
    expect(parseCommand("/order")).toEqual({ name: "order", arg: "" });
    expect(parseCommand("/today")).toEqual({ name: "today", arg: "" });
    expect(parseCommand("  /Today  ")).toEqual({ name: "today", arg: "" });
    expect(parseCommand("/start@LunchBot abc-def")).toEqual({ name: "start", arg: "abc-def" });
    expect(parseCommand("/start   token  ")).toEqual({ name: "start", arg: "token" });
  });

  it("is null for anything that is not a command", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });
});

describe("link tokens and deep links", () => {
  const token = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("builds the deep link", () => {
    expect(botDeepLink("LunchBot", token)).toBe(`https://t.me/LunchBot/?start=${token}`);
    expect(botDeepLink("@LunchBot", token)).toBe(`https://t.me/LunchBot/?start=${token}`);
  });

  it("degrades to null when the bot username is not configured", () => {
    expect(botDeepLink("", token)).toBeNull();
    expect(botDeepLink("   ", token)).toBeNull();
  });

  it("only accepts a uuid as a /start argument", () => {
    expect(isLinkToken(token)).toBe(true);
    expect(isLinkToken("' or 1=1--")).toBe(false);
    expect(isLinkToken("")).toBe(false);
  });
});

describe("join codes", () => {
  it("matches organizations_telegram_join_code_check, case-insensitively", () => {
    expect(isJoinCode("LUNCH7")).toBe(true);
    expect(isJoinCode(" lunch7 ")).toBe(true);
    expect(normalizeJoinCode(" lunch7 ")).toBe("LUNCH7");
    expect(isJoinCode("ABCDEFGHJKLM")).toBe(true); // 12, the maximum
  });

  it("rejects the characters the alphabet leaves out, and the wrong lengths", () => {
    for (const bad of ["LUNCH0", "LUNCHO", "LUNCH1", "LUNCHI", "LUNC7", "ABCDEFGHJKLMN", ""]) {
      expect(isJoinCode(bad)).toBe(false);
    }
  });

  // The bot tells the two kinds of /start argument apart by shape alone, so an
  // overlap would silently send somebody down the wrong door.
  it("never collides with a link token", () => {
    const linkToken = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(isJoinCode(linkToken)).toBe(false);
    expect(isLinkToken("LUNCH7")).toBe(false);
  });
});

describe("the name prompt carries the join code back", () => {
  it("round-trips through the text Telegram hands back", () => {
    expect(joinCodeInPrompt(namePrompt("Test Office", "lunch7"))).toBe("LUNCH7");
  });

  it("is null for anything that is not one of our prompts", () => {
    expect(joinCodeInPrompt(undefined)).toBeNull();
    expect(joinCodeInPrompt("What's for lunch?")).toBeNull();
    expect(joinCodeInPrompt("Join code: nope")).toBeNull();
    expect(joinCodeInPrompt("Join code: LUNCH7 and then some")).toBeNull();
  });

  // organizations.name allows newlines, so an org can put a whole line of its
  // own choosing into this prompt. Reading the code anchored to the END means
  // the worst it can do is be ignored.
  it("reads the last line, not an org name imitating one", () => {
    const prompt = namePrompt("Acme\nJoin code: EVILAA", "LUNCH7");
    expect(prompt).toContain("Join code: EVILAA");
    expect(joinCodeInPrompt(prompt)).toBe("LUNCH7");
  });

  it("escapes the org name, which reaches Telegram as HTML", () => {
    expect(namePrompt("A & <b>B</b>", "LUNCH7")).toContain("A &amp; &lt;b&gt;B&lt;/b&gt;");
  });
});

describe("dates in the org's timezone", () => {
  it("todayIn matches private.today_in, not the UTC date", () => {
    // 18:30 UTC is already the next day in Ho Chi Minh City.
    expect(todayIn(TZ, new Date("2026-09-22T18:30:00Z"))).toBe("2026-09-23");
    expect(todayIn("UTC", new Date("2026-09-22T18:30:00Z"))).toBe("2026-09-22");
  });

  it("formats a cutoff and a service date", () => {
    expect(formatCutoffIn(CUTOFF, TZ)).toBe("21:00 22/09");
    expect(formatCutoffIn(CUTOFF, "UTC")).toBe("14:00 22/09");
    expect(formatServiceDate("2026-09-23")).toBe("Wed 23/09");
  });

  it("adds days without drifting across a DST-free zone", () => {
    expect(addDaysIso("2026-09-30", 1)).toBe("2026-10-01");
  });
});

describe("targetMenu picks the day every command without a menu id is about", () => {
  const TODAY = "2026-09-22";
  const TOMORROW = "2026-09-23";
  // Two consecutive evening cutoffs: today's menu shuts at 21:00 on 22/09,
  // tomorrow's at 21:00 on 23/09. BEFORE and AFTER straddle the first.
  const TOMORROW_CUTOFF = "2026-09-23T14:00:00.000Z";
  const base = { today: TODAY, isAdmin: false, timeZone: TZ };

  const openToday = { serviceDate: TODAY, status: "published", orderCutoffAt: CUTOFF };
  const openTomorrow = {
    serviceDate: TOMORROW, status: "published", orderCutoffAt: TOMORROW_CUTOFF,
  };

  it("picks today while today is still open", () => {
    expect(targetMenu([openToday, openTomorrow], { ...base, now: BEFORE }))
      .toEqual({ menu: openToday, closedReason: null });
  });

  // The reason the command could not keep being called /today: for most of the
  // day the answer is tomorrow, because ordering closes the night before.
  it("picks tomorrow once today's cutoff has passed", () => {
    expect(targetMenu([openToday, openTomorrow], { ...base, now: AFTER }))
      .toEqual({ menu: openTomorrow, closedReason: null });
  });

  it("skips a cancelled day", () => {
    const cancelled = { ...openToday, status: "cancelled" };
    expect(targetMenu([cancelled, openTomorrow], { ...base, now: BEFORE }))
      .toEqual({ menu: openTomorrow, closedReason: null });
  });

  it("skips a locked day", () => {
    const locked = { ...openToday, status: "locked" };
    expect(targetMenu([locked, openTomorrow], { ...base, now: BEFORE }))
      .toEqual({ menu: openTomorrow, closedReason: null });
  });

  it("falls back to the soonest menu with a reason when none is open", () => {
    const locked = { ...openToday, status: "locked" };
    const got = targetMenu([locked, { ...openTomorrow, status: "cancelled" }],
      { ...base, now: BEFORE });
    expect(got?.menu).toEqual(locked);
    expect(got?.closedReason).toContain("gone to the caterer");
  });

  it("is null when there is no menu at all", () => {
    expect(targetMenu([], { ...base, now: BEFORE })).toBeNull();
  });

  it("ignores days already past", () => {
    expect(targetMenu([{ ...openTomorrow, serviceDate: "2026-09-01" }],
      { ...base, now: BEFORE })).toBeNull();
  });
});

describe("escaping and VietQR", () => {
  it("escapes what Telegram's HTML parser would choke on", () => {
    expect(escapeHtml("Cơm gà & <b>rau</b>")).toBe("Cơm gà &amp; &lt;b&gt;rau&lt;/b&gt;");
  });

  it("builds a quick link from either spelling of the config", () => {
    const a = vietQrLink(
      { bank_bin: "970415", account_number: "0123456789", account_name: "CONG TY ABC" },
      { amountMinor: 225_000, minorUnits: 0, addInfo: "L39NEIL" },
    );
    expect(a).toContain("https://img.vietqr.io/image/970415-0123456789-compact2.png");
    expect(a).toContain("amount=225000");
    expect(a).toContain("addInfo=L39NEIL");

    const b = vietQrLink(
      { bankBin: "970415", accountNumber: "0123456789" },
      { amountMinor: 0, minorUnits: 0, addInfo: "" },
    );
    expect(b).toBe("https://img.vietqr.io/image/970415-0123456789-compact2.png?");
  });

  it("is null when the org has not configured one, or the currency has sub-units", () => {
    // What the Settings screen actually writes. The bot read the top level
    // only, so a configured office got a QR on the web and none in Telegram.
    expect(
      vietQrLink(
        {
          vietqr: { bankBin: "970436", accountNumber: "0123456789", accountName: "Chi Le" },
          note: "cash is fine too",
        },
        { amountMinor: 45000, minorUnits: 0, addInfo: "L39NGUY" },
      ),
    ).toBe(
      "https://img.vietqr.io/image/970436-0123456789-compact2.png?" +
        "amount=45000&addInfo=L39NGUY&accountName=Chi+Le",
    );

    // A half-filled nested account is no account, not a fall-through to the
    // top level, which would silently pay whatever the old row said.
    expect(
      vietQrLink(
        { vietqr: { bankBin: "970436" }, bank_bin: "970415", account_number: "999" },
        { amountMinor: 1, minorUnits: 0, addInfo: "X" },
      ),
    ).toBeNull();

    expect(vietQrLink({}, { amountMinor: 1, minorUnits: 0, addInfo: "X" })).toBeNull();
    expect(vietQrLink(null, { amountMinor: 1, minorUnits: 0, addInfo: "X" })).toBeNull();
    expect(vietQrLink({ bank_bin: "970415" }, { amountMinor: 1, minorUnits: 0, addInfo: "X" }))
      .toBeNull();
    expect(vietQrLink(
      { bank_bin: "970415", account_number: "1" },
      { amountMinor: 1, minorUnits: 2, addInfo: "X" },
    )).toBeNull();
  });
});

/* ------------------------------------------------- a price nobody has yet */

const money = (minor: number) => formatMoney(minor, VND);

function day(over: Partial<DayMessage> = {}): DayMessage {
  return {
    orgName: null,
    serviceDate: "2026-09-23",
    closedReason: null,
    orderCutoffAt: CUTOFF,
    timeZone: TZ,
    dishes: [{ name: "Cơm gà", priceMinor: 45_000 }],
    order: null,
    ...over,
  };
}

const QR = "https://img.vietqr.io/image/970415-1-compact2.png?amount=75000";

function statement(over: Partial<StatementMessage> = {}): StatementMessage {
  return {
    periodStart: "2026-09-21",
    periodEnd: "2026-09-25",
    mealCount: 2,
    mealsMinor: 95_000,
    carriedInMinor: 0,
    totalDueMinor: 95_000,
    paidMinor: 0,
    status: "open",
    paymentRef: "L39NEIL",
    unpricedMeals: 0,
    ...over,
  };
}

describe("a price the caterer has not given", () => {
  it("is the same words the app uses, so the two surfaces do not drift", () => {
    expect(PRICE_TO_COME.toLowerCase()).toBe(PRICE_PENDING.toLowerCase());
  });

  it("reads as words, and zero still reads as zero", () => {
    expect(priceText(null, money)).toBe(PRICE_TO_COME);
    // The whole point: a free meal and an unknown price are different claims.
    expect(priceText(0, money)).toBe(formatMoney(0, VND));
    expect(priceText(45_000, money)).toBe(money(45_000));
  });
});

describe("the day's menu message", () => {
  it("prices a dish the caterer has priced", () => {
    expect(renderDayText(day(), money)).toContain(`- Cơm gà  ${money(45_000)}`);
  });

  it("does not quote 0 ₫ for a dish with no price, and does not throw", () => {
    const text = renderDayText(
      day({ dishes: [{ name: "Cơm gà", priceMinor: null }] }),
      money,
    );
    expect(text).toContain(`- Cơm gà  ${PRICE_TO_COME}`);
    expect(text).not.toContain("₫");
  });

  it("prices what it can on a half-priced menu and says so for the rest", () => {
    const text = renderDayText(
      day({
        dishes: [
          { name: "Cơm gà", priceMinor: null },
          { name: "Bún bò", priceMinor: 50_000 },
        ],
      }),
      money,
    );
    expect(text).toContain(`- Cơm gà  ${PRICE_TO_COME}`);
    expect(text).toContain(`- Bún bò  ${money(50_000)}`);
  });

  it("escapes a dish name, priced or not", () => {
    const text = renderDayText(
      day({ dishes: [{ name: "Cơm <b>gà</b>", priceMinor: null }] }),
      money,
    );
    expect(text).toContain("Cơm &lt;b&gt;gà&lt;/b&gt;");
    expect(text).not.toContain("<b>gà</b>");
  });

  it("shows what a member's own priced order cost", () => {
    const text = renderDayText(
      day({ order: { status: "placed", dishName: "Cơm gà", amountMinor: 45_000 } }),
      money,
    );
    expect(text).toContain(`You: <b>Cơm gà</b> (${money(45_000)})`);
  });

  it("says what an unpriced order will do rather than going quiet about it", () => {
    const text = renderDayText(
      day({
        dishes: [{ name: "Cơm gà", priceMinor: null }],
        order: { status: "placed", dishName: "Cơm gà", amountMinor: null },
      }),
      money,
    );
    expect(text).toContain(`You: <b>Cơm gà</b> (${PRICE_TO_COME})`);
    expect(text).toContain("It goes on your bill once the caterer prices it.");
    expect(text).not.toContain("₫");
  });

  it("leaves the rest of the message exactly as it was", () => {
    expect(renderDayText(day({ orgName: "Test Office" }), money)).toBe(
      [
        "<b>Test Office</b>",
        "<b>Wed 23/09</b>",
        "Orders close 21:00 22/09.",
        "",
        `- Cơm gà  ${money(45_000)}`,
        "",
        "You're <b>not</b> down as eating.",
      ].join("\n"),
    );
  });

  it("still says why ordering is shut, and lists no dish twice", () => {
    const text = renderDayText(day({ closedReason: "Lunch on Wed 23/09 is cancelled." }), money);
    expect(text).toContain("Lunch on Wed 23/09 is cancelled.");
    expect(text).not.toContain("Orders close");
  });
});

describe("a meal a colleague is handing over", () => {
  it("names the cost when there is one", () => {
    expect(
      renderOfferText(
        { fromName: "Chi Le", serviceDate: "2026-09-23", dishName: "Cơm gà", amountMinor: 45_000 },
        money,
      ),
    ).toBe(
      `Chi Le is offering you Cơm gà (${money(45_000)}) on <b>Wed 23/09</b>.\n` +
        "If you accept, the cost moves to your bill.",
    );
  });

  it("does not hide an unpriced meal behind a bare dish name", () => {
    const text = renderOfferText(
      { fromName: "Chi Le", serviceDate: "2026-09-23", dishName: "Cơm gà", amountMinor: null },
      money,
    );
    expect(text).toContain(`Cơm gà (${PRICE_TO_COME})`);
    expect(text).toContain("If you accept, it goes on your bill once the caterer prices it.");
    expect(text).not.toContain("₫");
  });
});

describe("what /me owes", () => {
  it("says nothing about prices when every meal has one", () => {
    const text = renderStatementText(statement(), money, null);
    expect(text).toContain(`2 meals: ${money(95_000)}`);
    expect(text).toContain(`<b>Total due: ${money(95_000)}</b>`);
    expect(text).not.toMatch(/waiting on the caterer/);
  });

  it("says a total is incomplete rather than letting it read as the final word", () => {
    const text = renderStatementText(statement({ unpricedMeals: 1 }), money, null);
    expect(text).toContain(
      "One meal is still waiting on the caterer's price, so it is not counted here. " +
        "It goes on your bill once the price arrives.",
    );
    // Directly under the total it qualifies.
    const lines = text.split("\n");
    expect(lines[lines.findIndex((l) => l.startsWith("<b>Total due:")) + 1]).toMatch(
      /^One meal is still waiting/,
    );
  });

  it("agrees with the count when more than one meal is waiting", () => {
    expect(renderStatementText(statement({ unpricedMeals: 3 }), money, null)).toContain(
      "3 meals are still waiting on the caterer's price, so they are not counted here. " +
        "They go on your bill once the price arrives.",
    );
  });

  it("keeps the payment reference and the QR link", () => {
    const text = renderStatementText(
      statement({ paidMinor: 20_000, carriedInMinor: 5_000, unpricedMeals: 1 }),
      money,
      "https://img.vietqr.io/image/970415-1-compact2.png?amount=75000",
    );
    expect(text).toContain(`Owed from before: ${money(5_000)}`);
    expect(text).toContain(`Paid so far: ${money(20_000)}`);
    expect(text).toContain("Put <code>L39NEIL</code> in the transfer message.");
    expect(text).toContain('<a href="https://img.vietqr.io/image/970415-1-compact2.png?amount=75000">Pay by QR</a>');
  });

  /**
   * SePay syncs only transactions whose memo carries LUNCH, so a transfer sent
   * without the reference never reaches the app: no admin sees it, and nobody
   * can chase what nobody can see. Every bot message that hands somebody the
   * means to pay has to say that.
   */
  describe("the reference as a requirement", () => {
    it("says it is required and what a transfer without it costs", () => {
      const text = renderStatementText(statement(), money, null);
      expect(text).toContain(
        "Put <code>L39NEIL</code> in the transfer message. It is required: only " +
          "transfers carrying it reach the lunch app, so one sent without it leaves " +
          "your bill unpaid with nothing for an admin to find.",
      );
    });

    it("says it with the QR as well, and names the QR as the way it is filled in", () => {
      const text = renderStatementText(statement(), money, QR);
      expect(text).toContain(PAYMENT_REF_REQUIRED);
      expect(text).toContain(`<a href="${QR}">Pay by QR</a> fills it in for you.`);
    });

    it("never offers the reference as merely helpful", () => {
      for (const qr of [null, QR]) {
        const text = renderStatementText(statement(), money, qr);
        expect(text).toContain("L39NEIL");
        expect(text).toContain("It is required:");
        expect(text).not.toMatch(/sort .* out by hand|helps|so an admin can/i);
      }
    });

    /**
     * The one message in the bot that hands out a reference or a QR, so this
     * one sentence covers the bot. A second such message fails here rather than
     * waiting for a reviewer to notice it. Comments are stripped first, because
     * the Edge Function names both functions in its own prose; the imports name
     * them without parentheses, so only call sites are left.
     */
    it("is the only message in the Edge Function that offers either", () => {
      const code = readFileSync(
        join(import.meta.dirname, "..", "supabase", "functions", "telegram", "index.ts"),
        "utf8",
      ).replace(/\/\/.*$/gm, "");
      expect(code.match(/vietQrLink\(/g)).toHaveLength(1);
      expect(code.match(/renderStatementText\(/g)).toHaveLength(1);
    });
  });

  it("does not call an unbilled week nothing when a meal is waiting on a price", () => {
    expect(renderNothingBilledText(null, 0)).toBe("Nothing billed to you yet.");

    const waiting = renderNothingBilledText("Test Office", 2);
    expect(waiting).toContain("<b>Test Office</b>");
    expect(waiting).toContain("Nothing billed to you yet.");
    expect(waiting).toContain("2 meals are still waiting on the caterer's price");
  });

  it("has nothing to say about zero meals waiting", () => {
    expect(unpricedMealsNote(0)).toBeNull();
    expect(unpricedMealsNote(-1)).toBeNull();
  });
});

/* ------------------------------------------------- leaving and disconnecting */

/**
 * A member who joined through Telegram has no web session anywhere, so these
 * two messages are the whole of their Settings screen: what is said here is
 * everything they are ever told about either decision.
 */
describe("/leave and /unlink", () => {
  const CODE = "LUNCH7";

  describe("the questions asked before anything happens", () => {
    it("asks rather than acts, and says leaving deletes nothing", () => {
      const text = renderLeaveConfirmText({ orgName: null, joinCode: CODE });
      expect(text).toContain("<b>Leave this office?</b>");
      expect(text).toContain("Nothing is deleted");
      expect(text).toContain("same membership rather than a new one");
      expect(text).toContain(`send me the join code <code>${CODE}</code>`);
    });

    it("says what /unlink stops and what it leaves alone", () => {
      const text = renderUnlinkConfirmText({ orgName: null, joinCode: CODE });
      expect(text).toContain("<b>Disconnect this chat?</b>");
      expect(text).toContain("stop asking what you want for lunch");
      expect(text).toContain("stay a member");
      expect(text).toContain("anything you owe are untouched");
      expect(text).toContain(`send me the join code <code>${CODE}</code>`);
    });

    it("names the way back even when the office has no join code to give", () => {
      for (const text of [
        renderLeaveConfirmText({ orgName: null, joinCode: null }),
        renderUnlinkConfirmText({ orgName: null, joinCode: null }),
      ]) {
        expect(text).toContain("ask your office for its join code");
        expect(text).not.toContain("<code>");
      }
    });
  });

  describe("which office it is talking about", () => {
    // The heading is how every other message in this file tells two offices
    // apart, and these are the two messages where being wrong about which
    // office is meant costs the most.
    it("names the office when the chat has two", () => {
      const m = { orgName: "Test Office", joinCode: CODE };
      for (const text of [
        renderLeaveConfirmText(m),
        renderUnlinkConfirmText(m),
        renderLeftText(m),
        renderUnlinkedText(m),
        renderExitCancelledText(m.orgName, "leave"),
        renderExitRefusedText(m.orgName, "leave", "you are the only owner"),
      ]) {
        expect(text).toContain("<b>Test Office</b>\n");
      }
    });

    it("says nothing about an office when the chat has only one", () => {
      const m = { orgName: null, joinCode: CODE };
      for (const text of [
        renderLeaveConfirmText(m),
        renderUnlinkConfirmText(m),
        renderLeftText(m),
        renderUnlinkedText(m),
        renderExitCancelledText(null, "unlink"),
        renderExitRefusedText(null, "unlink", "nope"),
      ]) {
        expect(text).not.toContain("Test Office");
      }
    });

    it("escapes an office name, which reaches Telegram as HTML", () => {
      expect(renderLeaveConfirmText({ orgName: "A & <b>B</b>", joinCode: CODE }))
        .toContain("<b>A &amp; &lt;b&gt;B&lt;/b&gt;</b>");
    });
  });

  describe("what is true afterwards", () => {
    it("says leaving kept the record, and how to come back", () => {
      const text = renderLeftText({ orgName: null, joinCode: CODE });
      expect(text).toContain("<b>You've left this office.</b>");
      expect(text).toContain("Nothing was deleted");
      expect(text).toContain("deactivated rather than removed");
      expect(text).toContain(`send me the join code <code>${CODE}</code>`);
    });

    it("says disconnecting kept the membership, and how to come back", () => {
      const text = renderUnlinkedText({ orgName: null, joinCode: CODE });
      expect(text).toContain("<b>Disconnected.</b>");
      expect(text).toContain("You're still a member");
      expect(text).toContain("anything you owe are unchanged");
      expect(text).toContain(`send me the join code <code>${CODE}</code>`);
    });

    it("says what is still true when the question is answered with no", () => {
      expect(renderExitCancelledText(null, "leave"))
        .toBe("Nothing changed, so you're still a member of this office.");
      expect(renderExitCancelledText(null, "unlink"))
        .toBe("Nothing changed, so this chat is still connected.");
    });
  });

  /**
   * leave_office() refuses in sentences written for people. Both surfaces show
   * them unchanged, so the test reads them out of the migration rather than
   * trusting a copy: a rule reworded in SQL and not in the bot is exactly the
   * drift this is here to catch.
   */
  describe("a refusal from leave_office", () => {
    const sql = readFileSync(
      join(import.meta.dirname, "..", "supabase", "migrations",
        "20260929100000_leaving_and_deleting_an_office.sql"),
      "utf8",
    );
    const OWES = "you still owe this office money; settle up before you leave";
    const SOLE_OWNER =
      "you are the only owner; make somebody else an owner first, or delete the office";

    it("is still the sentence the function raises", () => {
      expect(sql).toContain(`raise exception '${OWES}'`);
      expect(sql).toContain(`raise exception '${SOLE_OWNER}'`);
    });

    it.each([OWES, SOLE_OWNER])("reaches the member as written: %s", (reason) => {
      // 55000 is object_not_in_prerequisite_state, which is what the function
      // raises with. humanError must pass a refusal like this through whole.
      const surfaced = botHumanError({ message: reason, code: "55000" });
      expect(surfaced).toBe(reason);
      expect(webHumanError({ message: reason, code: "55000" })).toBe(reason);

      const text = renderExitRefusedText(null, "leave", surfaced);
      expect(text).toContain(reason);
      // And says the refusal left them where they were, which the database
      // sentence on its own does not.
      expect(text).toContain("Nothing changed, so you're still a member of this office.");
    });

    it("escapes a refusal before it reaches Telegram's HTML parser", () => {
      expect(renderExitRefusedText(null, "leave", "you owe 1 & 2 <b>now</b>"))
        .toContain("you owe 1 &amp; 2 &lt;b&gt;now&lt;/b&gt;");
    });
  });

  it("answers /unlink from a chat that is already disconnected", () => {
    // NOT_CONNECTED's "I don't know who you are yet" reads as a refusal of what
    // was asked for, when in fact it has already happened.
    expect(NOTHING_TO_LEAVE).toContain("nothing to leave or disconnect");
    expect(NOTHING_TO_LEAVE).toContain("<b>join code</b>");
    expect(NOTHING_TO_LEAVE).not.toContain("I don't know who you are");
  });
});
