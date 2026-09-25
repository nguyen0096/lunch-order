import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  botDeepLink,
  commandsFor,
  decodeCallback,
  encodeCallback,
  escapeHtml,
  formatCutoffIn,
  formatServiceDate,
  helpFor,
  humanError as botHumanError,
  isJoinCode,
  isLinkToken,
  joinCodeInPrompt,
  namePrompt,
  normalizeJoinCode,
  orderingClosedReason,
  parseCommand,
  priceText,
  randomDish,
  renderAccountText,
  renderDayText,
  renderExitCancelledText,
  renderExitRefusedText,
  renderHandoverOfferedText,
  renderHandoverPickText,
  renderLeaveConfirmText,
  renderLeftText,
  renderOfferText,
  renderUnlinkConfirmText,
  renderUnlinkedText,
  targetMenu,
  todayIn,
  unpricedMealsNote,
  vietQrLink,
  NOBODY_TO_PASS_IT_TO,
  NOTHING_TO_LEAVE,
  NOTHING_TO_PASS_ON,
  PAYMENT_REF_REQUIRED,
  PRICE_TO_COME,
  type CallbackAction,
  type AccountMessage,
  type DayMessage,
  type MemberKind,
} from "../src/shared/telegram.js";
import { orderDisabledReason } from "../src/shared/gating.js";
import { PRICE_PENDING, VND, formatMoney } from "../src/shared/money.js";
import type { Menu, MenuStatus } from "../src/shared/types.js";
import { humanError as webHumanError } from "../src/web/api.js";
import { passOnReason, pickDish } from "../src/web/components/boardModel.js";

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

  // No admin axis any more. Both surfaces hold an admin to the same window as
  // everybody else, because the board and the bot are where somebody orders
  // their own lunch; correcting a finished day is a different job that the
  // trigger only permits to a write that says `source = 'admin'`.
  for (const status of statuses) {
    for (const [when, now] of [["before cutoff", BEFORE], ["after cutoff", AFTER]] as const) {
      it(`${status}, ${when}`, () => {
        const m = menu({ status });
        const web = orderDisabledReason(m, now, TZ);
        const bot = orderingClosedReason({
          menu: { serviceDate: m.serviceDate, status: m.status, orderCutoffAt: m.orderCutoffAt },
          now,
          timeZone: TZ,
        });
        expect(bot === null).toBe(web === null);
      });
    }
  }

  it("a missing menu closes ordering on both surfaces", () => {
    expect(orderDisabledReason(null, BEFORE, TZ)).not.toBeNull();
    expect(orderingClosedReason({ menu: null, now: BEFORE, timeZone: TZ })).not.toBeNull();
  });

  it("names the day and repeats the cutoff exactly as the trigger does", () => {
    const reason = orderingClosedReason({
      menu: { serviceDate: "2026-09-23", status: "published", orderCutoffAt: CUTOFF },
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
    { kind: "surprise", menuId: 42 },
    { kind: "day", menuId: 42 },
    { kind: "handover", menuId: 42 },
    { kind: "handTo", menuId: 987654, membershipId: 123456 },
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

  // Passing a meal on charges a colleague money, so a payload that is nearly
  // one of these is refused rather than read as the nearest thing it resembles.
  it("never turns a malformed handover into a colleague", () => {
    for (const bad of ["h", "h:", "h:0", "h:a", "h:1:0", "h:1:a", "h:1:2:3", "s:", "s:0", "d:a"]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });

  it("keeps the dice and the day apart from cancelling", () => {
    expect(decodeCallback("c:42")).toEqual({ kind: "clear", menuId: 42 });
    expect(decodeCallback("s:42")).toEqual({ kind: "surprise", menuId: 42 });
    expect(decodeCallback("d:42")).toEqual({ kind: "day", menuId: 42 });
  });
});

/* --------------------------------------------------------- the command menu */

/**
 * What each kind of member is offered, which is not the same as what each is
 * permitted. Both commands work when typed by hand whichever list a chat was
 * given; these tests are about the list.
 */
describe("the command menu a chat is given", () => {
  const names = (kind: MemberKind) => commandsFor(kind).map((c) => `/${c.command}`);

  it("offers a member with a web account the exits that suit an account", () => {
    expect(names("web")).toEqual(["/order", "/cancel", "/me", "/help", "/unlink"]);
  });

  it("never offers /leave to somebody whose account lives on the web", () => {
    // Ending a membership belongs in Settings, where the rest of their account
    // is. Typing /leave still works; it is simply not advertised here.
    expect(names("web")).not.toContain("/leave");
  });

  it("offers a member who exists only in Telegram the exit that leaves nothing behind", () => {
    expect(names("telegram-only")).toEqual(["/order", "/cancel", "/me", "/help", "/leave"]);
  });

  it("never offers /unlink to somebody it would strand", () => {
    // Disconnecting this chat would take away the only way they have of
    // reaching their own bill, because they have no web session anywhere.
    expect(names("telegram-only")).not.toContain("/unlink");
  });

  it("gives both kinds the same four ways of eating lunch", () => {
    for (const kind of ["web", "telegram-only"] as const) {
      expect(names(kind).slice(0, 4)).toEqual(["/order", "/cancel", "/me", "/help"]);
    }
  });

  // It shipped under the wrong name and shows the wrong day. The people who
  // have it in their fingers keep it; nobody else is taught it.
  it("teaches nobody /today", () => {
    for (const kind of ["web", "telegram-only"] as const) {
      expect(names(kind)).not.toContain("/today");
    }
  });

  it("says what each command does in words, within what setMyCommands accepts", () => {
    for (const kind of ["web", "telegram-only"] as const) {
      for (const c of commandsFor(kind)) {
        expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(c.description.length).toBeGreaterThan(0);
        expect(c.description.length).toBeLessThanOrEqual(256);
      }
    }
  });

  /**
   * The whole point of building the help out of the list: a static help string
   * was how the bot came to name /leave to a chat whose menu withheld it.
   */
  it("says in /help exactly what the menu says, line for line", () => {
    for (const kind of ["web", "telegram-only"] as const) {
      expect(helpFor(kind)).toBe(
        ["<b>What I can do</b>", ...commandsFor(kind).map((c) => `/${c.command} - ${c.description}`)]
          .join("\n"),
      );
    }
  });

  it("names in /help every command the menu offers and no other", () => {
    for (const kind of ["web", "telegram-only"] as const) {
      const listed = [...helpFor(kind).matchAll(/^\/(\w+)/gm)].map((m) => m[1]);
      expect(listed).toEqual(commandsFor(kind).map((c) => c.command));
    }
  });

  it("tells a Telegram-only member about leaving and a web member about disconnecting", () => {
    expect(helpFor("telegram-only")).toContain("/leave - leave your office");
    expect(helpFor("telegram-only")).not.toContain("/unlink");
    expect(helpFor("web")).toContain("/unlink - disconnect this chat, and stay a member");
    expect(helpFor("web")).not.toContain("/leave");
  });

  /**
   * The Edge Function builds its help from helpFor() and nowhere else. A
   * second copy written inline is what this catches, because it would be a
   * copy that no chat's menu agrees with. Comments are stripped first: the
   * file's own prose names these things.
   */
  it("is the only place the bot's command list is written down", () => {
    const code = readFileSync(
      join(import.meta.dirname, "..", "supabase", "functions", "telegram", "index.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("What I can do");
    expect(code).not.toMatch(/"\/order - /);
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

/* ------------------------------------------------------- a dish at random */

/**
 * The bot's dice and the board's dice are the same dice.
 *
 * randomDish() is a twin of pickDish() rather than a call to it, because the
 * bot cannot import a module that reaches the board's own types. So the two
 * are rolled here side by side: a rule changed in one of them fails this file
 * rather than letting the board and the bot disagree about what random means.
 */
describe("the dish Surprise me orders", () => {
  const DISHES = [
    { id: 5, name: "Cơm gà", priceMinor: 45_000 },
    { id: 6, name: "Bún bò", priceMinor: 50_000 },
    { id: 7, name: "Phở", priceMinor: null },
  ];

  it("lands where the board's dice lands, on every roll", () => {
    for (const excludeId of [null, 5, 6, 7, 99]) {
      for (const roll of [0, 0.01, 0.33, 0.5, 0.66, 0.99, 1]) {
        const random = () => roll;
        expect(randomDish(DISHES, { excludeId, random })?.id)
          .toBe(pickDish(DISHES, { excludeId, random })?.id);
      }
    }
  });

  it("agrees with the board on a menu of one, and on no menu at all", () => {
    const one = [DISHES[0]!];
    expect(randomDish(one)?.id).toBe(pickDish(one)?.id);
    expect(randomDish(one, { excludeId: 5 })?.id).toBe(pickDish(one, { excludeId: 5 })?.id);
    expect(randomDish([])).toBeNull();
    expect(pickDish([])).toBeNull();
  });

  it("does not hand back the dish already ordered, so a second tap moves you", () => {
    for (const roll of [0, 0.5, 0.99, 1]) {
      expect(randomDish(DISHES, { excludeId: 6, random: () => roll })?.id).not.toBe(6);
    }
  });

  // A menu of one dish, already ordered: re-offering it is right, and going
  // blank would read as "there is nothing here".
  it("re-offers the only dish rather than going blank", () => {
    expect(randomDish([DISHES[0]!], { excludeId: 5 })?.id).toBe(5);
  });

  it("reaches every dish, so the office is not funnelled onto the first", () => {
    expect(randomDish(DISHES, { random: () => 0 })?.id).toBe(5);
    expect(randomDish(DISHES, { random: () => 0.5 })?.id).toBe(6);
    expect(randomDish(DISHES, { random: () => 0.99 })?.id).toBe(7);
  });

  it("stays inside the menu on a random() of exactly 1", () => {
    expect(randomDish(DISHES, { random: () => 1 })?.id).toBe(7);
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
    handover: null,
    ...over,
  };
}

const QR ="https://img.vietqr.io/image/970415-1-compact2.png?amount=75000";

/** One week eaten, nothing paid: the commonest account there is. */
function account(over: Partial<AccountMessage> = {}): AccountMessage {
  return {
    balanceMinor: 95_000,
    chargedMinor: 95_000,
    creditedMinor: 0,
    weeksBehind: 1,
    paymentRef: "LUNCHNEIL",
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

/* ----------------------------------------------------- passing a meal on */

/**
 * The other side of the same row: what the person giving a meal away is told,
 * from the button on their own day through to the offer being out of their
 * hands.
 */
describe("passing your own meal on", () => {
  const eating = {
    order: { status: "placed", dishName: "Cơm gà", amountMinor: 45_000 },
  } satisfies Partial<DayMessage>;

  describe("what the day message says about a meal on its way out", () => {
    it("says an offer has not moved the cost yet, because it has not", () => {
      const text = renderDayText(
        day({ ...eating, handover: { status: "pending", toName: "Chi Le" } }),
        money,
      );
      expect(text).toContain("You've offered it to <b>Chi Le</b>.");
      expect(text).toContain("It stays yours, and on your bill, until they accept.");
    });

    it("says who is billed once somebody has accepted", () => {
      const text = renderDayText(
        day({ ...eating, handover: { status: "accepted", toName: "Chi Le" } }),
        money,
      );
      expect(text).toContain("<b>Chi Le</b> took this meal, so it is on their bill rather than yours.");
      expect(text).not.toContain("until they accept");
    });

    it("still says something when the colleague cannot be named", () => {
      expect(renderDayText(day({ ...eating, handover: { status: "pending", toName: null } }), money))
        .toContain("You've offered it to <b>a colleague</b>.");
      expect(renderDayText(day({ ...eating, handover: { status: "accepted", toName: null } }), money))
        .toContain("<b>A colleague</b> took this meal");
    });

    it("escapes a colleague's name, which reaches Telegram as HTML", () => {
      const text = renderDayText(
        day({ ...eating, handover: { status: "pending", toName: "Chi <b>Le</b>" } }),
        money,
      );
      expect(text).toContain("Chi &lt;b&gt;Le&lt;/b&gt;");
      expect(text).not.toContain("Chi <b>Le</b>");
    });

    // A line about somebody taking a lunch the reader is not down for reads as
    // a mistake, and it is: the handover belongs to an order they cancelled.
    it("says nothing about a handover on a meal the member no longer has", () => {
      const cancelled = day({
        order: { status: "cancelled", dishName: "Cơm gà", amountMinor: 45_000 },
        handover: { status: "pending", toName: "Chi Le" },
      });
      expect(renderDayText(cancelled, money)).not.toContain("Chi Le");
      const none = day({ handover: { status: "pending", toName: "Chi Le" } });
      expect(renderDayText(none, money)).not.toContain("Chi Le");
    });

    it("leaves the message exactly as it was when nothing is being passed on", () => {
      expect(renderDayText(day(eating), money)).toBe(
        [
          "<b>Wed 23/09</b>",
          "Orders close 21:00 22/09.",
          "",
          `- Cơm gà  ${money(45_000)}`,
          "",
          `You: <b>Cơm gà</b> (${money(45_000)})`,
        ].join("\n"),
      );
    });
  });

  describe("the question asked before a colleague is charged", () => {
    const meal = {
      orgName: null,
      serviceDate: "2026-09-23",
      dishName: "Cơm gà",
      amountMinor: 45_000,
    };

    it("names the meal and the day, and says nothing has happened yet", () => {
      const text = renderHandoverPickText(meal, money);
      expect(text).toContain("<b>Wed 23/09</b>");
      expect(text).toContain(`Who gets your <b>Cơm gà</b> (${money(45_000)})?`);
      expect(text).toContain("Nothing moves until they accept, and until then the meal is still yours.");
    });

    it("does not quote 0 ₫ for a meal the caterer has not priced", () => {
      const text = renderHandoverPickText({ ...meal, amountMinor: null }, money);
      expect(text).toContain(`your <b>Cơm gà</b> (${PRICE_TO_COME})`);
      expect(text).not.toContain("₫");
    });

    it("still asks when the member is down to eat but has chosen no dish", () => {
      expect(renderHandoverPickText({ ...meal, dishName: null }, money))
        .toContain("Who gets your lunch?");
    });

    it("names the office for a member who belongs to more than one", () => {
      expect(renderHandoverPickText({ ...meal, orgName: "Test Office" }, money))
        .toContain("<b>Test Office</b>\n");
      expect(renderHandoverPickText(meal, money)).not.toContain("Test Office");
    });

    it("escapes a dish name on its way to Telegram's HTML parser", () => {
      expect(renderHandoverPickText({ ...meal, dishName: "Cơm <b>gà</b>" }, money))
        .toContain("Cơm &lt;b&gt;gà&lt;/b&gt;");
    });
  });

  describe("what the member is told once it is offered", () => {
    const offered = {
      orgName: null,
      serviceDate: "2026-09-23",
      dishName: "Cơm gà",
      amountMinor: 45_000,
      toName: "Chi Le",
    };

    it("names who has it and says the bill has not moved", () => {
      const text = renderHandoverOfferedText(offered, money);
      expect(text).toContain("<b>Offered to Chi Le.</b>");
      expect(text).toContain(`They can take your <b>Cơm gà</b> (${money(45_000)}) on <b>Wed 23/09</b>.`);
      expect(text).toContain("It stays yours, and on your bill, until they accept.");
    });

    it("does not promise a price nobody has set", () => {
      const text = renderHandoverOfferedText({ ...offered, amountMinor: null }, money);
      expect(text).toContain(PRICE_TO_COME);
      expect(text).not.toContain("₫");
    });

    it("escapes a colleague's name and a dish name alike", () => {
      const text = renderHandoverOfferedText(
        { ...offered, toName: "Chi <b>Le</b>", dishName: "Cơm & Gà" }, money,
      );
      expect(text).toContain("Chi &lt;b&gt;Le&lt;/b&gt;");
      expect(text).toContain("Cơm &amp; Gà");
    });
  });

  describe("the two refusals with nothing to refuse", () => {
    /**
     * The board greys the control out with this claim; the bot has no control
     * to grey, so it says it. One sentence, so the two surfaces cannot come to
     * describe the same emptiness two different ways.
     */
    it("is the board's own sentence about a day with no meal on it", () => {
      const boardsWords = passOnReason({
        cell: null, serviceDate: "2026-09-23", openWeekStart: "2026-09-21", offeredTo: null,
      });
      expect(NOTHING_TO_PASS_ON).toBe(`${boardsWords}.`);
    });

    it("says an office of one has nobody to pass a meal to", () => {
      expect(NOBODY_TO_PASS_IT_TO).toContain("nobody else in this office");
    });
  });
});

describe("what /me owes", () => {
  it("answers with the account, not the newest week", () => {
    const text = renderAccountText(
      account({
        balanceMinor: 180_000, chargedMinor: 405_000, creditedMinor: 225_000,
        weeksBehind: 3,
      }),
      money,
      null,
    );
    expect(text).toContain(`<b>You owe ${money(180_000)}.</b>`);
    expect(text).toContain(
      `Across 3 weeks. ${money(405_000)} billed, ${money(225_000)} received.`,
    );
  });

  it("says nothing under the figure when nothing has been received", () => {
    // "0 d received" is not information, it is an accusation, and a meal
    // count answers a question nobody asked of a balance.
    const text = renderAccountText(account({ creditedMinor: 0 }), money, null);
    expect(text).toContain(`<b>You owe ${money(95_000)}.</b>`);
    expect(text).not.toContain("billed");
    expect(text).not.toContain("Across");
  });

  it("shows the arithmetic once something has been received", () => {
    const text = renderAccountText(
      account({ balanceMinor: 75_000, creditedMinor: 20_000 }), money, null,
    );
    expect(text).toContain(`${money(95_000)} billed, ${money(20_000)} received.`);
  });

  /**
   * The case the week could not express at all. `greatest(due - paid, 0)`
   * turned an overpayment into a zero and the money left the books, so there
   * was no state for this message to be in.
   */
  it("says somebody is in credit, and offers them nothing to pay", () => {
    const text = renderAccountText(
      account({
        balanceMinor: -50_000, chargedMinor: 405_000, creditedMinor: 455_000,
      }),
      money,
      QR,
    );
    expect(text).toContain(`<b>You are ${money(50_000)} in credit.</b>`);
    expect(text).toContain("You have paid ahead.");
    expect(text).not.toContain("LUNCHNEIL");
    expect(text).not.toContain("Pay by QR");
    expect(text).not.toContain(PAYMENT_REF_REQUIRED);
  });

  it("is settled rather than owing nothing, and still offers no way to pay", () => {
    const text = renderAccountText(
      account({ balanceMinor: 0, creditedMinor: 95_000 }),
      money,
      QR,
    );
    expect(text).toContain("<b>Nothing to pay.</b>");
    expect(text).toContain(`${money(95_000)} billed, all of it paid.`);
    expect(text).not.toContain("Pay by QR");
  });

  it("says a total is incomplete rather than letting it read as the final word", () => {
    const text = renderAccountText(
      account({ balanceMinor: 75_000, creditedMinor: 20_000, unpricedMeals: 1 }), money, null,
    );
    expect(text).toContain(
      "One meal is still waiting on the caterer's price, so it is not counted here. " +
        "It goes on your bill once the price arrives.",
    );
    // Under the number and the line that explains it, so the three read together.
    const lines = text.split("\n");
    expect(lines[lines.findIndex((l) => l.startsWith("<b>You owe")) + 2]).toMatch(
      /^One meal is still waiting/,
    );
  });

  it("agrees with the count when more than one meal is waiting", () => {
    expect(renderAccountText(account({ unpricedMeals: 3 }), money, null)).toContain(
      "3 meals are still waiting on the caterer's price, so they are not counted here. " +
        "They go on your bill once the price arrives.",
    );
  });

  it("does not call an empty account nothing when a meal is waiting on a price", () => {
    expect(
      renderAccountText(
        account({ balanceMinor: 0, chargedMinor: 0, weeksBehind: 0 }),
        money,
        null,
      ),
    ).toContain("Nothing has been billed to you yet.");

    const waiting = renderAccountText(
      account({
        balanceMinor: 0, chargedMinor: 0, weeksBehind: 0, unpricedMeals: 2,
      }),
      money,
      null,
    );
    expect(waiting).toContain("Nothing has been billed to you yet.");
    expect(waiting).toContain("2 meals are still waiting on the caterer's price");
  });

  it("keeps the payment reference and the QR link", () => {
    const text = renderAccountText(account({ creditedMinor: 20_000 }), money, QR);
    expect(text).toContain("Put <code>LUNCHNEIL</code> in the transfer message");
    expect(text).toContain(`<a href="${QR}">Pay by QR</a>`);
  });

  /**
   * SePay syncs only transactions whose memo carries LUNCH, so a transfer sent
   * without the reference never reaches the app: no admin sees it, and nobody
   * can chase what nobody can see. Every bot message that hands somebody the
   * means to pay has to say that.
   */
  describe("the reference as a requirement", () => {
    it("says it is required and what a transfer without it costs", () => {
      const text = renderAccountText(account(), money, null);
      expect(text).toContain(
        "Put <code>LUNCHNEIL</code> in the transfer message, the same one every " +
          "week. It is required: only transfers carrying it reach the lunch app, so " +
          "one sent without it leaves your bill unpaid with nothing for an admin to find.",
      );
    });

    /**
     * The reference no longer carries an ISO week, so it is the same string to
     * type every Monday. Said out loud, because everybody holding an old bill
     * has been taught the opposite.
     */
    it("says the reference does not change from week to week", () => {
      expect(renderAccountText(account(), money, null)).toContain("the same one every week");
    });

    it("says it with the QR as well, and names the QR as the way it is filled in", () => {
      const text = renderAccountText(account(), money, QR);
      expect(text).toContain(PAYMENT_REF_REQUIRED);
      expect(text).toContain(`<a href="${QR}">Pay by QR</a> fills it in for you.`);
    });

    it("never offers the reference as merely helpful", () => {
      for (const qr of [null, QR]) {
        const text = renderAccountText(account(), money, qr);
        expect(text).toContain("LUNCHNEIL");
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
      expect(code.match(/renderAccountText\(/g)).toHaveLength(1);
    });
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
