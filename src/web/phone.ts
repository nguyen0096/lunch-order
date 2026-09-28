import type { BankAppPlatform } from "../shared/bankApps.js";

/**
 * Which phone this is, or null for anything that is not one.
 *
 * The user agent, because the two platforms have different app lists and
 * nothing else tells them apart. iPadOS reports itself as a Mac, so a "Mac"
 * with a touch screen is taken for an iPad. A laptop with a touch screen
 * reports Windows or Linux and stays null, which is right: it has no bank app
 * to open.
 */
export function phonePlatform(
  nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator,
): BankAppPlatform | null {
  if (!nav) return null;
  const ua = nav.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return "ios";
  return null;
}

export const BANK_APP_KEY = "lunch.bankApp";

/** Per device, because it is this phone's app, not the person's. */
export function rememberedBankApp(): string | null {
  try {
    return localStorage.getItem(BANK_APP_KEY);
  } catch {
    return null;
  }
}

export function rememberBankApp(appId: string): void {
  try {
    localStorage.setItem(BANK_APP_KEY, appId);
  } catch {
    // Storage refused: the picker simply asks again next time.
  }
}

/** Leaves the page. A module function so a test can stand in for it. */
export function openUrl(url: string): void {
  window.location.assign(url);
}
