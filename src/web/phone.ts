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

/**
 * Sends the phone to a bank app link. A module function so a test can stand
 * in for it.
 *
 * On iOS the redirector is a page that tries the app's scheme and, if the
 * page still has focus a few seconds later, moves on to the App Store; in
 * this tab that would take the bill with it. A new tab keeps the bill where
 * the member left it. Android's redirector is a 301 to an `intent://` URL,
 * which hands off to the app and leaves the tab alone.
 *
 * Must be called in the tap's own tick: Safari blocks a `window.open` that
 * comes after an await.
 */
export function openUrl(url: string, platform: BankAppPlatform): void {
  if (platform === "ios") window.open(url, "_blank", "noopener");
  else window.location.assign(url);
}

/** Whether a tap on this device is a finger. */
export function coarsePointer(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
