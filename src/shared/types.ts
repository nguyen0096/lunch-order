/**
 * Domain types the UI works in. Deliberately narrower than the generated
 * `database.types.ts` (run `npm run gen:types`), which mirrors every column of
 * every table; these are the shapes the screens actually pass around.
 */
import type { Currency } from "./money.js";

export type Role = "member" | "admin" | "owner";
export type MenuStatus = "draft" | "published" | "locked" | "cancelled";
export type TransferStatus = "pending" | "accepted" | "declined" | "cancelled";

export type Org = {
  id: number;
  slug: string;
  name: string;
  timezone: string;
  currency: Currency;
  defaultCutoffLocalTime: string;
  billingWeekStartsOn: number;
  /**
   * Four characters from the slug, the office's half of a payment reference.
   * Optional because a payload written before the column existed has none, and
   * a reference simply drops the segment rather than inventing one.
   */
  shortCode?: string;
  /** HH:MM. When the kitchen starts cooking, so the day reads as Cooking. */
  businessDayStartsAt: string;
  /** HH:MM. When lunch is over, after which a member cannot pass a meal on. */
  businessDayEndsAt: string;
};

export type Me = {
  profileId: string;
  fullName: string;
  email: string;
  /**
   * `app_settings.office_creation`, which is off while the app lives inside one
   * company. Carried here rather than fetched on its own because the screens
   * that offer to found an office already wait for this call, and a second
   * round trip would make the button appear a moment after the page.
   *
   * The database refuses it either way: this only decides whether somebody is
   * offered a door that would not open.
   */
  mayFoundOffice: boolean;
  orgs: Array<{
    org: Org;
    role: Role;
    shortCode: string;
    /**
     * `LUNCH` + the short code, exactly as the database matches on it. What a
     * member is shown is composed from it by `composePaymentRef`, and what
     * arrives back from the bank is folded down to this.
     */
    paymentRef: string;
    displayName: string;
    /**
     * How many more times this member may change their own short code: one
     * after joining, then none. Enforced by `enforce_short_code`; an admin's
     * changes are not counted and an admin is never out of them. Absent when
     * not loaded, which a screen reads as one.
     */
    shortCodeChangesLeft?: number;
  }>;
};

export type MenuItem = {
  id: number;
  name: string;
  /**
   * Null when the caterer has not said yet, which is most of the week when
   * they price on Saturday. An order for an unpriced dish is held out of the
   * bill entirely rather than billed as zero, so this is never coalesced.
   */
  priceMinor: number | null;
  position: number;
  isAvailable: boolean;
};

export type Menu = {
  id: number;
  orgId: number;
  serviceDate: string;
  status: MenuStatus;
  orderCutoffAt: string;
  items: MenuItem[];
};

/** An order with no chosen dish is an intent to eat: `itemId` is null. */
export type MyOrder = {
  id: number;
  status: "placed" | "cancelled";
  source: "member" | "standing" | "admin";
  itemId: number | null;
  itemName: string | null;
  unitPriceMinor: number | null;
};

export function isAdmin(role: Role): boolean {
  return role === "admin" || role === "owner";
}
