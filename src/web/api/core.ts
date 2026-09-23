/**
 * Identity, the org row shape, and the one error translator every screen
 * shares. Nothing here belongs to a single screen.
 */

import { supabase } from "../supabase.js";
import type { Me, Org, Role } from "../../shared/types.js";

type OrgRow = {
  id: number; slug: string; name: string; timezone: string;
  currency: string; currency_minor_units: number; locale: string;
  default_cutoff_local_time: string; billing_week_starts_on: number;
};

function toOrg(r: OrgRow): Org {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    timezone: r.timezone,
    currency: { code: r.currency, minorUnits: r.currency_minor_units, locale: r.locale },
    defaultCutoffLocalTime: r.default_cutoff_local_time,
    billingWeekStartsOn: r.billing_week_starts_on,
  };
}

/**
 * Who am I and which orgs do I belong to. RLS means this returns only the
 * caller's own memberships, so no filter is needed or wanted here: adding one
 * would imply the security lives in the query, which it does not.
 */
export async function fetchMe(): Promise<Me | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  // profile_id must be filtered explicitly. memberships is readable org-wide
  // so the board can show colleagues' names, which means an unfiltered query
  // returns EVERY member's row -- and orgs[0] could then be the owner's,
  // rendering a plain member with admin privileges in the UI.
  const { data, error } = await supabase
    .from("memberships")
    .select(
      `role, short_code, display_name,
       organizations ( id, slug, name, timezone, currency, currency_minor_units,
                       locale, default_cutoff_local_time, billing_week_starts_on )`,
    )
    .eq("profile_id", auth.user.id)
    .eq("status", "active");
  if (error) throw error;

  const { data: profile } = await supabase
    .from("profiles").select("full_name, email").eq("id", auth.user.id).single();

  return {
    profileId: auth.user.id,
    fullName: profile?.full_name ?? auth.user.email ?? "",
    email: profile?.email ?? auth.user.email ?? "",
    orgs: (data ?? []).flatMap((row) => {
      const org = row.organizations as unknown as OrgRow | null;
      if (!org) return [];
      return [{
        org: toOrg(org),
        role: row.role as Role,
        shortCode: row.short_code,
        displayName: row.display_name ?? profile?.full_name ?? auth.user.email ?? "",
      }];
    }),
  };
}

/**
 * Postgres error messages from our triggers are written for people -- "ordering
 * for 2026-09-14 closed at 16:00 13/09" -- so show them as they are. Anything
 * else gets a generic line rather than leaking a constraint name at a member.
 */
export function humanError(e: unknown): string {
  const err = e as { message?: string; code?: string } | null;
  if (!err?.message) return "Something went wrong. Try again.";
  if (/permission denied for function/i.test(err.message)) {
    return `Server misconfiguration: ${err.message}. This is not something you did.`;
  }
  if (err.code === "42501" || /row-level security/i.test(err.message)) {
    return "You don't have permission to do that.";
  }
  // The office address is the one unique key somebody types by hand, so it is
  // the one duplicate that deserves a sentence instead of the generic one.
  if (/organizations_slug_uk/i.test(err.message)) {
    return "That web address is already taken by another office. Try a different one.";
  }
  if (/violates|constraint|duplicate key/i.test(err.message)) {
    return "That change conflicts with something else. Reload and try again.";
  }
  return err.message;
}

/* ------------------------------------------------------------ a new office */

/** The database's own limits, mirrored so a person hears them before a round trip. */
const NAME_MAX = 120;
const SLUG_MIN = 3;
const SLUG_MAX = 40;

export type OfficeDraft = { name: string; slug: string };

/**
 * A web address guessed from the office name, so nobody has to invent a URL
 * fragment. The names are Vietnamese and the constraint is ASCII, so the
 * diacritics come off the way the database's own short-code helper takes them
 * off. `đ` has no canonical decomposition and has to be mapped by hand.
 *
 * May return something the constraint still rejects -- "Ăn" gives "an", two
 * characters -- which `officeProblem` then explains. Guessing short is better
 * than padding a name nobody typed.
 */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/**
 * `null` when the draft can be sent, otherwise the sentence saying what to fix.
 *
 * Every rule here is one the database enforces anyway. Checking first is what
 * turns `violates check constraint "organizations_slug_check"` into something a
 * person can act on; uniqueness is the one rule only the server can answer.
 */
export function officeProblem(draft: OfficeDraft): string | null {
  const name = draft.name.trim();
  if (name === "") return "Give the office a name first.";
  if (name.length > NAME_MAX) {
    return `The name can be ${NAME_MAX} characters at most, and this one is ${name.length}.`;
  }

  const slug = draft.slug.trim().toLowerCase();
  if (slug === "") return "The office needs a web address.";
  if (slug.length < SLUG_MIN) return `The web address needs ${SLUG_MIN} characters at least.`;
  if (slug.length > SLUG_MAX) {
    return `The web address can be ${SLUG_MAX} characters at most, and this one is ${slug.length}.`;
  }
  if (/[^a-z0-9-]/.test(slug)) {
    return "The web address can use lowercase letters, numbers and hyphens only.";
  }
  if (!/^[a-z0-9]/.test(slug) || !/[a-z0-9]$/.test(slug)) {
    return "The web address has to start and end with a letter or a number.";
  }
  return null;
}

/**
 * Creates the office and makes the caller its owner in one transaction, so
 * there is no moment where an office exists that nobody can administer.
 *
 * Timezone, currency and locale are left at the function's defaults. A new
 * office is Vietnamese until somebody says otherwise, and asking on the way in
 * for the things nobody knows yet is how a two-field form becomes six.
 */
export async function createOffice(draft: OfficeDraft): Promise<Org> {
  const { data, error } = await supabase.rpc("create_organization", {
    p_slug: draft.slug.trim().toLowerCase(),
    p_name: draft.name.trim(),
  });
  if (error) throw error;

  // `returns public.organizations` is a composite rather than a set, so the row
  // arrives as an object; unwrap an array too rather than depend on that.
  const row = (Array.isArray(data) ? data[0] : data) as OrgRow | null | undefined;
  if (!row) throw new Error("The office was created but did not come back. Reload to find it.");
  return toOrg(row);
}
