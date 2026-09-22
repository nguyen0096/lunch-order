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
  isLinkToken,
  nextOrderableDay,
  orderingClosedReason,
  parseCommand,
  todayIn,
  vietQrLink,
  type CallbackAction,
} from "../src/shared/telegram.js";
import { orderDisabledReason } from "../src/shared/gating.js";
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
  ];

  it("round-trips and stays inside Telegram's 64-byte limit", () => {
    for (const a of actions) {
      const encoded = encodeCallback(a);
      expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(64);
      expect(decodeCallback(encoded)).toEqual(a);
    }
  });

  it("rejects anything it did not write", () => {
    for (const bad of ["", "p", "p:1", "p:1:2:3", "p:0:1", "p:-1:2", "p:a:b", "z:1:2", "c:", "t:1:x"]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });
});

describe("command parsing", () => {
  it("reads the name, the bot suffix and the argument", () => {
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

describe("nextOrderableDay", () => {
  const args = { today: "2026-09-22", isAdmin: false, now: BEFORE, timeZone: TZ };
  const closed = { serviceDate: "2026-09-22", status: "locked", orderCutoffAt: CUTOFF };
  const open = { serviceDate: "2026-09-23", status: "published", orderCutoffAt: CUTOFF };

  it("prefers the soonest day still open", () => {
    expect(nextOrderableDay([closed, open], args)).toEqual({ menu: open, closedReason: null });
  });

  it("falls back to the soonest day with a menu and says why it is shut", () => {
    const got = nextOrderableDay([closed], args);
    expect(got?.menu).toEqual(closed);
    expect(got?.closedReason).toContain("gone to the caterer");
  });

  it("ignores days already past", () => {
    expect(nextOrderableDay([{ ...open, serviceDate: "2026-09-01" }], args)).toBeNull();
  });

  it("is null when there is nothing at all", () => {
    expect(nextOrderableDay([], args)).toBeNull();
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
