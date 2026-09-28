/**
 * Identity, the org row shape, and the one error translator every screen
 * shares. Nothing here belongs to a single screen.
 */

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import type { Me, Org, Role } from "../../shared/types.js";

type OrgRow = {
  id: number; slug: string; name: string; timezone: string;
  currency: string; currency_minor_units: number; locale: string;
  default_cutoff_local_time: string; billing_week_starts_on: number;
  business_day_starts_at: string; business_day_ends_at: string;
  short_code: string | null;
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
    // Defaulted here as well as in the column: an office created before the
    // stages existed reads back null until it is next written.
    businessDayStartsAt: (r.business_day_starts_at ?? "08:30").slice(0, 5),
    businessDayEndsAt: (r.business_day_ends_at ?? "17:30").slice(0, 5),
    // Null only for a row written before the trigger existed. The reference
    // drops the segment rather than guessing, and still matches.
    shortCode: r.short_code ?? undefined,
  };
}

/**
 * Who am I and which orgs do I belong to. RLS means this returns only the
 * caller's own memberships, so no filter is needed or wanted here: adding one
 * would imply the security lives in the query, which it does not.
 */
export async function fetchMe(): Promise<Me | null> {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  // A dropped connection also comes back with no user. It is not a sign-out,
  // and must not put somebody with a good session on the sign-in page.
  if (authError && isAuthRetryableFetchError(authError)) throw authError;
  if (!auth.user) return null;

  // profile_id must be filtered explicitly. memberships is readable org-wide
  // so the board can show colleagues' names, which means an unfiltered query
  // returns EVERY member's row -- and orgs[0] could then be the owner's,
  // rendering a plain member with admin privileges in the UI.
  const { data, error } = await supabase
    .from("memberships")
    .select(
      `role, short_code, short_code_changes, display_name, payment_ref,
       organizations ( id, slug, name, timezone, currency, currency_minor_units,
                       locale, default_cutoff_local_time, billing_week_starts_on,
                       business_day_starts_at, business_day_ends_at, short_code )`,
    )
    .eq("profile_id", auth.user.id)
    .eq("status", "active");
  if (error) throw error;

  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("full_name, email").eq("id", auth.user.id).single(),
    supabase.from("app_settings").select("enabled").eq("key", "office_creation").maybeSingle(),
  ]);

  return {
    profileId: auth.user.id,
    // Missing row means a database that predates the switch, and the function
    // treats that as allowed too, so the screen and the server agree.
    mayFoundOffice: settings?.enabled ?? true,
    fullName: profile?.full_name ?? auth.user.email ?? "",
    email: profile?.email ?? auth.user.email ?? "",
    orgs: (data ?? []).flatMap((row) => {
      const org = row.organizations as unknown as OrgRow | null;
      if (!org) return [];
      return [{
        org: toOrg(org),
        role: row.role as Role,
        shortCode: row.short_code,
        // Defaulted rather than assumed: the column arrived with
        // `money_belongs_to_a_person` and a stale row would render an empty
        // reference, which is the one thing on this screen that must not be
        // wrong.
        paymentRef: row.payment_ref ?? `LUNCH${row.short_code}`,
        shortCodeChangesLeft: Math.max(1 - (row.short_code_changes ?? 0), 0),
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
  if (/organizations_account_number_uk/i.test(err.message)) {
    return "Another office already receives its lunch payments into that account. One bank account can serve one office.";
  }
  if (/memberships_code_uk/i.test(err.message)) {
    return "Somebody in this office already uses that short code. Pick a different one.";
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

export type OfficeDraft = {
  name: string;
  slug: string;
  /** Blank means "make one from my name". */
  shortCode?: string;
};

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
    p_short_code: draft.shortCode?.trim().toUpperCase() || null,
  });
  if (error) throw error;

  // `returns public.organizations` is a composite rather than a set, so the row
  // arrives as an object; unwrap an array too rather than depend on that.
  const row = (Array.isArray(data) ? data[0] : data) as OrgRow | null | undefined;
  if (!row) throw new Error("The office was created but did not come back. Reload to find it.");
  return toOrg(row);
}

/** A join code as the office prints it: the constraint is `^[A-Z0-9]{6,12}$`. */
export function joinCodeProblem(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (c === "") return "Paste the join code your colleague gave you";
  if (!/^[A-Z0-9]{6,12}$/.test(c)) {
    return "A join code is 6 to 12 letters and digits, and never uses O, I, 0 or 1";
  }
  return null;
}

/**
 * Join an office with the code from a colleague.
 *
 * The same RPC the Telegram bot calls, with `p_chat_id` left null: that
 * argument is the only Telegram-shaped thing about it, and skipping it skips
 * every branch that touches a chat. The code has always worked for somebody
 * signed in with Google; until now the web simply never asked for one, so a
 * person was told to get a code and then had nowhere on the page to put it.
 *
 * The name is sent because `join_with_code` refuses a blank one and writes it
 * to `profiles.full_name` before allocating the short code -- the code comes
 * from the name, and it is what appears in a bank transfer memo, so a
 * placeholder here would be stamped on somebody's payments.
 */
export async function joinWithCode(args: {
  code: string;
  displayName: string;
  /** Blank means "make one from my name". Ignored when coming back to an office. */
  shortCode?: string;
}): Promise<{ slug: string; name: string }> {
  const { data, error } = await supabase.rpc("join_with_code", {
    p_code: args.code.trim().toUpperCase(),
    p_display_name: args.displayName.trim(),
    p_chat_id: null,
    p_short_code: args.shortCode?.trim().toUpperCase() || null,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { org_slug: string; org_name: string }
    | null
    | undefined;
  if (!row) throw new Error("You joined, but the office did not come back. Reload to find it.");
  return { slug: row.org_slug, name: row.org_name };
}

/**
 * The invitation token inside whatever somebody pasted.
 *
 * An invitation is a uuid, and nobody types a uuid -- they paste the whole
 * link. Pulling the token out of it means one field can take a join code or an
 * invitation without asking the person which kind of thing they were sent,
 * which they have no reason to know.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function invitationToken(pasted: string): string | null {
  return pasted.trim().match(UUID)?.[0]?.toLowerCase() ?? null;
}
