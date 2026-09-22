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
  if (/violates|constraint|duplicate key/i.test(err.message)) {
    return "That change conflicts with something else. Reload and try again.";
  }
  return err.message;
}
