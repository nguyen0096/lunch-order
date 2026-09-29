import {
  BANK_APPS_FETCHED_ON,
  bankAppById,
  bankAppLink,
  bankAppsFor,
  type BankAppLinkRequest,
} from "../src/shared/bankApps.js";
import { VND } from "../src/shared/money.js";
import {
  BANK_APP_KEY,
  openUrl,
  phonePlatform,
  rememberBankApp,
  rememberedBankApp,
} from "../src/web/phone.js";

const REQ: BankAppLinkRequest = {
  platform: "android",
  appId: "acb",
  bankBin: "970416",
  accountNumber: "0123456789",
  owedMinor: 180_000,
  currency: VND,
  paymentRef: "TEST LUNCH NEYU",
};

describe("bankAppLink", () => {
  it("builds the dl.vietqr.io link VietQR documents", () => {
    expect(bankAppLink(REQ)).toBe(
      "https://dl.vietqr.io/pay?app=acb&ba=0123456789@970416&am=180000&tn=TEST%20LUNCH%20NEYU",
    );
  });

  it("carries the memo exactly, spaces as %20 and never as +", () => {
    const link = bankAppLink(REQ)!;
    const tn = new URL(link).search.match(/[?&]tn=([^&]*)/)![1]!;
    expect(tn).not.toContain("+");
    expect(decodeURIComponent(tn)).toBe("TEST LUNCH NEYU");
  });

  it("carries the amount as whole dong digits", () => {
    expect(new URL(bankAppLink({ ...REQ, owedMinor: 45_000 })!).searchParams.get("am")).toBe("45000");
  });

  it("trims what an admin may have typed around the account", () => {
    expect(bankAppLink({ ...REQ, accountNumber: " 0123456789 " })).toContain("ba=0123456789@970416");
  });

  it("refuses an account a bank would not accept rather than encoding it", () => {
    expect(bankAppLink({ ...REQ, accountNumber: "0123 456" })).toBeNull();
    expect(bankAppLink({ ...REQ, accountNumber: "01&am=1" })).toBeNull();
    expect(bankAppLink({ ...REQ, bankBin: "97041" })).toBeNull();
    expect(bankAppLink({ ...REQ, paymentRef: "  " })).toBeNull();
  });

  it("offers nothing to somebody settled or in credit", () => {
    expect(bankAppLink({ ...REQ, owedMinor: 0 })).toBeNull();
    expect(bankAppLink({ ...REQ, owedMinor: -20_000 })).toBeNull();
  });

  it("is VND only", () => {
    expect(bankAppLink({ ...REQ, currency: { code: "USD", minorUnits: 2, locale: "en-US" } })).toBeNull();
  });

  it("refuses an app the platform's list does not carry", () => {
    expect(bankAppLink({ ...REQ, appId: "not-a-bank" })).toBeNull();
  });
});

describe("the vendored app lists", () => {
  it.each(["android", "ios"] as const)("has a %s list of unique, link-safe ids", (platform) => {
    const apps = bankAppsFor(platform);
    expect(apps.length).toBeGreaterThan(20);
    const ids = apps.map((a) => a.appId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of apps) {
      expect(a.appId).toMatch(/^[a-z0-9-]+$/);
      for (const name of [a.appName, a.bankName]) {
        expect(name).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
        expect(name).toBe(name.normalize("NFC"));
        expect(name.trim()).not.toBe("");
      }
    }
  });

  it("picks the list by platform", () => {
    expect(bankAppById("android", "acb")?.appName).toBe("ACB One");
    expect(bankAppById("ios", "acb")?.appName).toBe("ACB One");
    expect(bankAppById("android", "bidv")?.appName).not.toBe(bankAppById("ios", "bidv")?.appName);
  });

  it("is dated", () => {
    expect(BANK_APPS_FETCHED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("phonePlatform", () => {
  const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints });

  it("tells the two phones apart", () => {
    expect(
      phonePlatform(nav("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile", 5)),
    ).toBe("android");
    expect(
      phonePlatform(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", 5)),
    ).toBe("ios");
  });

  it("takes a touch-screen Mac for the iPad it is", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(phonePlatform(nav(ua, 5))).toBe("ios");
    expect(phonePlatform(nav(ua, 0))).toBeNull();
  });

  it("is null on a desktop, touch screen or not", () => {
    expect(phonePlatform(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", 10))).toBeNull();
    expect(phonePlatform(undefined)).toBeNull();
  });
});

describe("openUrl", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens iOS in a new tab, so the redirector's App Store fallback cannot take the bill", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openUrl("https://dl.vietqr.io/pay?app=acb", "ios");
    expect(open).toHaveBeenCalledWith("https://dl.vietqr.io/pay?app=acb", "_blank", "noopener");
  });

  it("stays in the tab on Android, where the redirect is an intent", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    const location = window.location;
    Object.defineProperty(window, "location", { value: { ...location, assign }, configurable: true });
    try {
      openUrl("https://dl.vietqr.io/pay?app=acb", "android");
      expect(assign).toHaveBeenCalledWith("https://dl.vietqr.io/pay?app=acb");
      expect(open).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { value: location, configurable: true });
    }
  });
});

describe("the remembered app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is kept per device", () => {
    expect(rememberedBankApp()).toBeNull();
    rememberBankApp("mb");
    expect(localStorage.getItem(BANK_APP_KEY)).toBe("mb");
    expect(rememberedBankApp()).toBe("mb");
  });

  it("survives storage that refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "QuotaExceededError");
    });
    expect(() => rememberBankApp("mb")).not.toThrow();
    expect(rememberedBankApp()).toBeNull();
  });
});
