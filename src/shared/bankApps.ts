/**
 * Banking apps a phone can be sent to, and the link that sends it there.
 *
 * The link goes through VietQR's redirector, `https://dl.vietqr.io/pay`, which
 * reads the phone's user agent and answers with the app's own scheme: an
 * Android `intent://` URL, or an iOS page that tries `<scheme>://` and falls
 * back to the App Store. The app list is a vendored snapshot of VietQR's two
 * published lists (see `bankApps.snapshot.json` and
 * `scripts/refresh-bank-apps.mjs`), so drawing the bill never waits on a third
 * party. Following the link does.
 *
 * What the link does NOT do, checked against the redirector on the snapshot
 * date: fill the transfer in. The source lists mark five apps `autofill: 1`,
 * but for every one of them the redirector's target is the bare scheme, with
 * the account, amount and memo dropped. VietQR's own page says the same thing
 * ("chưa thể tự động điền"). So `autofill` is kept as the source's claim and
 * nothing on screen promises it.
 *
 * So the link carries the app id and nothing else. VietQR documents `ba`,
 * `am` and `tn` for the account, amount and memo, but the redirector answers
 * the same with or without them, so sending them would only hand the bill to a
 * third party for no effect. The QR is built locally for the same reason (see
 * `vietqr.ts`). If VietQR ever fills the transfer in, adding them back here is
 * the change.
 */
import snapshot from "./bankApps.snapshot.json";
import type { Currency } from "./money.js";

export type BankAppPlatform = "android" | "ios";

export type BankApp = {
  /** VietQR's id, the `app` parameter: "acb", "vib-2". */
  appId: string;
  /** The store name: "ACB One". */
  appName: string;
  bankName: string;
  /** What the source list claims. Not observed to happen; see above. */
  autofill: boolean;
};

export const BANK_APPS_FETCHED_ON: string = snapshot.fetchedOn;

const LISTS: Record<BankAppPlatform, readonly BankApp[]> = {
  android: snapshot.android,
  ios: snapshot.ios,
};

/** In the source's order, which is by installs, most first. */
export function bankAppsFor(platform: BankAppPlatform): readonly BankApp[] {
  return LISTS[platform];
}

export function bankAppById(platform: BankAppPlatform, appId: string): BankApp | undefined {
  return LISTS[platform].find((a) => a.appId === appId);
}

export const BANK_APP_REDIRECTOR = "https://dl.vietqr.io/pay";

export type BankAppLinkRequest = {
  platform: BankAppPlatform;
  appId: string;
  /** What is still owed. Zero or less means there is nothing to send. */
  owedMinor: number;
  currency: Currency;
};

/**
 * The link that opens `appId`, or null when there is no transfer to make.
 *
 * Null for anything but VND, the only money a Vietnamese bank app transfers.
 * Null for a member in credit or settled, and for an app the platform's list
 * does not carry, because the redirector answers an unknown app with a JSON
 * error page.
 */
export function bankAppLink(req: BankAppLinkRequest): string | null {
  if (req.currency.code !== "VND" || req.currency.minorUnits !== 0) return null;
  if (!Number.isInteger(req.owedMinor) || req.owedMinor <= 0) return null;
  if (!bankAppById(req.platform, req.appId)) return null;
  return `${BANK_APP_REDIRECTOR}?app=${encodeURIComponent(req.appId)}`;
}
